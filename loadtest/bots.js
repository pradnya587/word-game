#!/usr/bin/env node
/**
 * Load test: spawns N rooms x P bot players that play complete games over real WebSockets.
 *
 *   npm install
 *   node bots.js --url http://localhost --rooms 10 --players 6 --think 900
 *
 * --url      gateway URL (bots call /api/auth/guest and connect to /socket.io through it)
 * --rooms    number of rooms played in parallel          (default 5)
 * --players  players per room, 2-6                       (default 6)
 * --think    average ms a bot "thinks" between words     (default 900)
 * --ramp     ms between starting each room               (default 300)
 * --words    path to words.txt                           (default ../services/game-service/data/words.txt)
 * --json     write the result as JSON to this path       (used by scale.js)
 *
 * Prints throughput, accept/reject counts and ack latency percentiles. Watch Grafana while it runs.
 */
const fs = require('fs')
const path = require('path')
const { io } = require('socket.io-client')

const arg = (name, def) => { const i = process.argv.indexOf(`--${name}`); return i > -1 ? process.argv[i + 1] : def }
const URL_ = arg('url', 'http://localhost').replace(/\/$/, '')
const ROOMS = Number(arg('rooms', 5))
const PLAYERS = Math.min(6, Math.max(2, Number(arg('players', 6))))
const THINK = Number(arg('think', 900))
const RAMP = Number(arg('ramp', 300))
const JSON_OUT = arg('json', '')
const WORDS_PATH = arg('words', path.join(__dirname, '..', 'services', 'game-service', 'data', 'words.txt'))

const words = fs.readFileSync(WORDS_PATH, 'utf8').split(/\r?\n/).map((w) => w.trim().toLowerCase()).filter((w) => /^[a-z]{3,8}$/.test(w))
const byFirst = {}
for (const w of words) (byFirst[w[0]] ||= []).push(w)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const rand = (n) => Math.floor(Math.random() * n)
const pick = (arr) => arr[rand(arr.length)]
const jitter = (ms) => Math.max(50, ms * (0.5 + Math.random()))

const stats = { connected: 0, connectErrors: 0, submits: 0, accepted: 0, rejected: 0, errors: 0, gamesFinished: 0, roomsFailed: 0, latencies: [] }

const counts = (s) => { const m = {}; for (const c of s) m[c] = (m[c] || 0) + 1; return m }
const canBuild = (w, rack) => { const u = {}; for (const c of w) { u[c] = (u[c] || 0) + 1; if (u[c] > (rack[c] || 0)) return false } return true }

// A candidate word for the current round, or null if none can be found quickly.
function chooseWord(round, st) {
  const tries = 400
  for (let i = 0; i < tries; i++) {
    let w
    if (round.type === 'wordChain') { const list = byFirst[st.chainLetter]; if (!list) return null; w = pick(list) }
    else w = pick(words)
    if (st.used.has(w) || w.length < round.minLength) continue
    if (round.type === 'letterBuilder' && !canBuild(w, st.rack)) continue
    if (round.type === 'speedRound' && !w.includes(st.contains)) continue
    return w
  }
  return null
}

async function guestToken() {
  const res = await fetch(`${URL_}/api/auth/guest`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
  if (!res.ok) throw new Error(`guest token failed: ${res.status}`)
  return res.json() // { token, user }
}

class Bot {
  constructor(label) { this.label = label; this.alive = true; this.finished = false; this.round = null; this.st = null; this.timer = null }

  async connect() {
    const { token, user } = await guestToken()
    this.id = user.id
    this.socket = io(URL_, { auth: { token }, transports: ['websocket'], reconnection: false })
    await new Promise((resolve, reject) => {
      this.socket.once('connect', () => { stats.connected++; resolve() })
      this.socket.once('connect_error', (e) => { stats.connectErrors++; reject(e) })
    })
    this.socket.on('round:start', (r) => this.onRoundStart(r))
    this.socket.on('round:end', (r) => this.onRoundEnd(r))
    this.socket.on('game:end', () => { this.finished = true; this.stop() })
  }

  emit(event, payload = {}) {
    return new Promise((resolve) => {
      const t0 = process.hrtime.bigint()
      this.socket.timeout(10000).emit(event, payload, (err, res) => {
        if (event === 'word:submit') stats.latencies.push(Number(process.hrtime.bigint() - t0) / 1e6)
        resolve(err ? { ok: false, error: 'TIMEOUT' } : res)
      })
    })
  }

  onRoundStart(r) {
    this.stop()
    if (!this.alive) return
    this.round = r
    this.st = { used: new Set([r.seedWord?.toLowerCase()].filter(Boolean)), chainLetter: r.chainLetter?.toLowerCase(), rack: counts((r.letters || []).join('').toLowerCase()), contains: r.constraint?.contains?.toLowerCase() }
    const loop = async () => {
      if (!this.alive || this.round !== r) return
      const w = chooseWord(r, this.st)
      if (w) {
        this.st.used.add(w)
        stats.submits++
        const res = await this.emit('word:submit', { word: w })
        if (!res.ok) stats.errors++
        else if (res.status === 'accepted') { stats.accepted++; if (res.nextLetter) this.st.chainLetter = res.nextLetter.toLowerCase() }
        else stats.rejected++
      }
      this.timer = setTimeout(loop, jitter(THINK))
    }
    this.timer = setTimeout(loop, jitter(THINK))
  }

  onRoundEnd(r) {
    this.stop()
    if (r.eliminated?.playerId === this.id) this.alive = false
  }

  stop() { clearTimeout(this.timer); this.timer = null }
  close() { this.stop(); this.socket?.close() }
}

async function playRoom(n) {
  const bots = Array.from({ length: PLAYERS }, (_, i) => new Bot(`r${n}p${i}`))
  try {
    await Promise.all(bots.map((b) => b.connect()))
    const host = bots[0]
    const created = await host.emit('room:create')
    if (!created.ok) throw new Error(`create failed: ${created.error}`)
    for (const b of bots.slice(1)) {
      const joined = await b.emit('room:join', { code: created.code })
      if (!joined.ok) throw new Error(`join failed: ${joined.error}`)
      await b.emit('room:ready', { ready: true })
    }
    const started = await host.emit('game:start')
    if (!started.ok) throw new Error(`start failed: ${started.error} ${started.message || ''}`)
    // wait until the game ends (3 rounds + intermissions) — give up after 10 minutes
    const deadline = Date.now() + 10 * 60_000
    while (!host.finished && Date.now() < deadline) await sleep(500)
    if (host.finished) stats.gamesFinished++; else stats.roomsFailed++
  } catch (err) {
    stats.roomsFailed++
    console.error(`room ${n} failed:`, err.message)
  } finally {
    bots.forEach((b) => b.close())
  }
}

const pct = (arr, p) => { if (!arr.length) return 0; const s = [...arr].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] }

async function main() {
  console.log(`Load test: ${ROOMS} rooms x ${PLAYERS} bots = ${ROOMS * PLAYERS} players -> ${URL_}  (dictionary: ${words.length} words)`)
  const t0 = Date.now()
  const progress = setInterval(() => console.log(`  [${Math.round((Date.now() - t0) / 1000)}s] connected=${stats.connected} submits=${stats.submits} accepted=${stats.accepted} gamesFinished=${stats.gamesFinished}`), 5000)
  const games = []
  for (let n = 1; n <= ROOMS; n++) { games.push(playRoom(n)); await sleep(RAMP) }
  await Promise.all(games)
  clearInterval(progress)
  const secs = (Date.now() - t0) / 1000
  const l = stats.latencies
  console.log('\n===== RESULT =====')
  console.log(`duration            ${secs.toFixed(1)} s`)
  console.log(`rooms finished      ${stats.gamesFinished} / ${ROOMS}  (failed: ${stats.roomsFailed})`)
  console.log(`connections         ${stats.connected} ok, ${stats.connectErrors} errors`)
  console.log(`word submits        ${stats.submits}  (${(stats.submits / secs).toFixed(1)}/s)`)
  console.log(`  accepted          ${stats.accepted}`)
  console.log(`  rejected          ${stats.rejected}`)
  console.log(`  errors/timeouts   ${stats.errors}`)
  console.log(`submit round-trip   p50 ${pct(l, 50).toFixed(1)} ms | p95 ${pct(l, 95).toFixed(1)} ms | p99 ${pct(l, 99).toFixed(1)} ms | max ${Math.max(0, ...l).toFixed(1)} ms`)
  if (JSON_OUT) {
    require('fs').writeFileSync(JSON_OUT, JSON.stringify({
      url: URL_, rooms: ROOMS, players: PLAYERS, clients: ROOMS * PLAYERS, durationSec: secs, roomsFinished: stats.gamesFinished, roomsFailed: stats.roomsFailed,
      connected: stats.connected, connectErrors: stats.connectErrors, submits: stats.submits, accepted: stats.accepted, rejected: stats.rejected, errors: stats.errors,
      latencyMs: { p50: pct(l, 50), p95: pct(l, 95), p99: pct(l, 99), max: Math.max(0, ...l) },
    }, null, 2))
  }
  process.exit(stats.roomsFailed || stats.connectErrors ? 1 : 0)
}
main().catch((e) => { console.error(e); process.exit(1) })
