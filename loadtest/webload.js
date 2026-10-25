#!/usr/bin/env node
/**
 * Web login + page-load script: guest login and the landing page / leaderboard API, N virtual users for D seconds.
 *   node webload.js --url https://<lb> --users 50 --seconds 60 --label web-autoscaled
 * Reports request count, error count and p50/p95/p99 latency per endpoint (written to results/<label>.json).
 */
const fs = require('fs')
const path = require('path')
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > -1 ? process.argv[i + 1] : d }
const URL_ = arg('url', 'http://localhost').replace(/\/$/, '')
const USERS = Number(arg('users', 25))
const SECONDS = Number(arg('seconds', 30))
const LABEL = arg('label', 'web')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const pct = (a, p) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] }

const m = {} // endpoint -> { n, errors, lat[] }
async function hit(name, fn) {
  const e = (m[name] ||= { n: 0, errors: 0, lat: [] })
  const t0 = process.hrtime.bigint()
  try { const res = await fn(); if (!res.ok) e.errors++ } catch { e.errors++ }
  e.lat.push(Number(process.hrtime.bigint() - t0) / 1e6); e.n++
}

async function user(stopAt) {
  while (Date.now() < stopAt) {
    await hit('GET /', () => fetch(`${URL_}/`))
    let token = null
    await hit('POST /api/auth/guest', async () => { const r = await fetch(`${URL_}/api/auth/guest`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }); if (r.ok) token = (await r.json()).token; return r })
    if (token) await hit('GET /api/auth/me', () => fetch(`${URL_}/api/auth/me`, { headers: { Authorization: `Bearer ${token}` } }))
    await hit('GET /api/stats/leaderboard', () => fetch(`${URL_}/api/stats/leaderboard?range=today`))
    await sleep(500 + Math.random() * 1000)
  }
}

;(async () => {
  console.log(`web load: ${USERS} users x ${SECONDS}s -> ${URL_}`)
  const stopAt = Date.now() + SECONDS * 1000
  await Promise.all(Array.from({ length: USERS }, () => user(stopAt)))
  const out = {}
  for (const [name, e] of Object.entries(m)) out[name] = { requests: e.n, errors: e.errors, p50: pct(e.lat, 50), p95: pct(e.lat, 95), p99: pct(e.lat, 99) }
  console.table(out)
  fs.mkdirSync(path.join(__dirname, 'results'), { recursive: true })
  fs.writeFileSync(path.join(__dirname, 'results', `${LABEL}.json`), JSON.stringify({ url: URL_, users: USERS, seconds: SECONDS, endpoints: out }, null, 2))
  process.exit(Object.values(out).some((e) => e.errors) ? 1 : 0)
})()
