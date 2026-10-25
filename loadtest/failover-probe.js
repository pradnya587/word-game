#!/usr/bin/env node
/**
 * Failover probe: proves "owner VM deleted mid-match -> surviving replica resumes the room within 60 s".
 *
 *   node failover-probe.js --url https://<lb>
 * 1. two guest bots create/join a room and start a game; the probe prints the OWNER instance (from the logs you watch)
 * 2. you delete the owner VM (gcloud compute instances delete ... or docker compose stop game-a) when prompted
 * 3. the probe's sockets reconnect through the load balancer; it records the timeline until the room is playing again
 *    (room:state with the same code + a fresh round:start) and prints the recovery time. Exit code 1 if > 60 s.
 * Tip: set ROUND_DURATIONS_MS=60000,60000,60000 on the replicas so the match is still running when you kill the owner.
 */
const { io } = require('socket.io-client')
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > -1 ? process.argv[i + 1] : d }
const URL_ = arg('url', 'http://localhost').replace(/\/$/, '')
const LIMIT_MS = Number(arg('limit', 60000))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function guest() { const r = await fetch(`${URL_}/api/auth/guest`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }); return (await r.json()).token }
const ack = (s, ev, p = {}) => new Promise((res) => s.timeout(10000).emit(ev, p, (e, r) => res(e ? { ok: false, error: 'TIMEOUT' } : r)))

;(async () => {
  const tokens = [await guest(), await guest()]
  const t = { start: Date.now() }
  const log = (m) => console.log(`[+${((Date.now() - t.start) / 1000).toFixed(1)}s] ${m}`)
  let code = null; let lostAt = null; let recoveredAt = null; let rounds = 0
  const sockets = tokens.map((token, i) => {
    const s = io(URL_, { auth: { token }, transports: ['websocket'], reconnection: true, reconnectionDelay: 500, reconnectionDelayMax: 3000 })
    s.on('disconnect', (why) => { if (!lostAt) { lostAt = Date.now(); log(`bot${i} disconnected (${why}) - failover clock started`) } })
    s.on('connect', () => { if (lostAt && !recoveredAt) { log(`bot${i} reconnected`); void ack(s, 'room:sync').then((r) => log(`bot${i} room:sync -> ${r.ok ? `ok (${r.state.state})` : r.error}`)) } })
    s.on('round:start', (r) => { rounds++; log(`round:start #${r.round} (${r.type})`); if (lostAt && !recoveredAt && rounds > 1) { recoveredAt = Date.now() } })
    s.on('state:sync', (m) => log(`state:sync reason=${m.reason} epoch=${m.ownerEpoch}`))
    return s
  })
  await Promise.all(sockets.map((s) => new Promise((r) => s.once('connect', r))))
  const created = await ack(sockets[0], 'room:create'); code = created.code
  await ack(sockets[1], 'room:join', { code }); await ack(sockets[1], 'room:ready', { ready: true })
  log(`room ${code} created; starting game`)
  log((await ack(sockets[0], 'game:start')).ok ? 'game started' : 'could not start')
  console.log(`\n>>> Now DELETE THE OWNER VM of room ${code} (find it with: gcloud logging read 'jsonPayload.room_code="${code}"' --limit 1 --format='value(jsonPayload.instance_id)')\n`)
  const deadline = Date.now() + 10 * 60_000
  while (!recoveredAt && Date.now() < deadline) await sleep(250)
  if (!recoveredAt) { log('no recovery observed'); process.exit(1) }
  const ms = recoveredAt - lostAt
  log(`RECOVERED: room ${code} playing again ${(ms / 1000).toFixed(1)} s after the owner disappeared (limit ${LIMIT_MS / 1000} s)`)
  sockets.forEach((s) => s.close())
  process.exit(ms <= LIMIT_MS ? 0 : 1)
})()
