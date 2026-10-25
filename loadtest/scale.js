#!/usr/bin/env node
/**
 * Stepped scale test: plays full games with 10 / 50 / 100 / 200 / 400 concurrent clients (6 per room) using the
 * approved gameplay flow from bots.js, and records p95 latency, errors and timing per step.
 *
 *   node scale.js --url https://<lb> --label baseline-single-vm --steps 10,50,100,200,400
 *   node scale.js --url https://<lb> --label autoscaled-mig     --steps 10,50,100,200,400
 *
 * Run it once against ONE VM (baseline: set min=max=1 replicas) and once against the autoscaled MIG, then compare the two
 * result files in results/. Rooms created through the load balancer land on different replicas, so large steps exercise
 * the cross-replica path. Pair it with the evidence checklist in docs/evidence-runbook.md.
 */
const { spawnSync } = require('child_process')
const fs = require('fs')
const path = require('path')

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > -1 ? process.argv[i + 1] : d }
const url = arg('url', 'http://localhost')
const label = arg('label', 'run')
const steps = arg('steps', '10,50,100,200,400').split(',').map(Number)
const think = arg('think', '900')
const ramp = arg('ramp', '150')
const outDir = path.join(__dirname, 'results')
fs.mkdirSync(outDir, { recursive: true })

const rows = []
for (const clients of steps) {
  const rooms = Math.max(1, Math.round(clients / 6))
  const players = clients < 6 ? clients : 6
  const jsonPath = path.join(outDir, `${label}-${clients}.json`)
  console.log(`\n=== step: ${clients} clients (${rooms} rooms x ${players}) -> ${url}`)
  const startedAt = new Date().toISOString()
  const r = spawnSync('node', [path.join(__dirname, 'bots.js'), '--url', url, '--rooms', String(rooms), '--players', String(players), '--think', think, '--ramp', ramp, '--json', jsonPath], { stdio: 'inherit' })
  const res = fs.existsSync(jsonPath) ? JSON.parse(fs.readFileSync(jsonPath, 'utf8')) : { error: 'no result file', exit: r.status }
  rows.push({ clients, startedAt, ...res })
}

const csv = ['label,clients,rooms_finished,rooms_failed,connect_errors,submit_errors,submits,p50_ms,p95_ms,p99_ms,duration_s,started_at']
for (const r of rows) csv.push([label, r.clients, r.roomsFinished ?? '', r.roomsFailed ?? '', r.connectErrors ?? '', r.errors ?? '', r.submits ?? '', r.latencyMs?.p50?.toFixed(1) ?? '', r.latencyMs?.p95?.toFixed(1) ?? '', r.latencyMs?.p99?.toFixed(1) ?? '', r.durationSec?.toFixed(1) ?? '', r.startedAt].join(','))
const csvPath = path.join(outDir, `${label}.csv`)
fs.writeFileSync(csvPath, csv.join('\n') + '\n')
console.log(`\nsummary written to ${csvPath}\n${csv.join('\n')}`)
process.exit(rows.some((r) => r.roomsFailed || r.connectErrors || r.error) ? 1 : 0)
