const jwt = require('jsonwebtoken')
const { io: connect } = require('socket.io-client')
const { createGameServer } = require('../src/createGameServer')
const { MemoryEventBus } = require('../src/events/bus')
const { RedisStore } = require('../src/coordination/stores')
const { MemorySnapshotStore } = require('../src/coordination/snapshots')
const { makeDictionary, silent, baseConfig, fixedRound } = require('./helpers')

// Fast coordination timings so failover tests finish in seconds (production: ttl 6 s, renew 2 s).
const clusterConfig = {
  ...baseConfig, roundDurationsMs: [800, 800, 600], intermissionMs: 300, reconnectGraceMs: 4000, finishedRoomTtlMs: 5000,
  leaseTtlMs: 1500, leaseRenewMs: 400, sweepIntervalMs: 200, commandTimeoutMs: 1000, recoveryWaitMs: 8000, shutdownDrainMs: 20,
}

/** Starts N game-service replicas that share one Redis (coordination + Socket.IO adapter) and one snapshot database. */
async function startReplicas(names, { redisUrl, config = {}, snapshots = new MemorySnapshotStore(), logger = process.env.TEST_LOGS ? require('../src/logger')('debug', 'test') : silent } = {}) {
  const prefix = `wrtest${Math.random().toString(36).slice(2, 8)}`
  const replicas = []
  for (const name of names) {
    const cfg = { ...clusterConfig, ...config, instanceId: name }
    const bus = new MemoryEventBus()
    const store = new RedisStore({ url: redisUrl, logger, prefix })
    const server = createGameServer({
      config: cfg, dictionary: makeDictionary(), bus, logger, store, snapshots,
      createRoundFn: (i) => ({ ...fixedRound(i), durationMs: cfg.roundDurationsMs[i] }),
    })
    await new Promise((r) => server.httpServer.listen(0, r))
    await server.cluster.ready
    replicas.push({ name, ...server, bus, port: server.httpServer.address().port, clients: [] })
  }
  return { replicas, snapshots, prefix }
}

const token = (id, username = id.toUpperCase()) => jwt.sign({ sub: id, username, guest: false }, 'test-secret', { expiresIn: '1h' })

function client(replica, id) {
  const s = connect(`http://localhost:${replica.port}`, { auth: { token: token(id) }, transports: ['websocket'], reconnection: false })
  replica.clients.push(s)
  s.log = []
  s.onAny((event, data) => s.log.push({ event, data }))
  return new Promise((resolve, reject) => { s.on('connect', () => resolve(s)); s.on('connect_error', reject) })
}
const call = (s, event, payload = {}) => new Promise((resolve) => s.emit(event, payload, resolve))
const waitFor = (s, event, pred = () => true, ms = 6000) => new Promise((resolve, reject) => {
  const hit = s.log.find((e) => e.event === event && pred(e.data)); if (hit) return resolve(hit.data)
  const t = setTimeout(() => reject(new Error(`timeout waiting for ${event}`)), ms)
  s.onAny((ev, data) => { if (ev === event && pred(data)) { clearTimeout(t); resolve(data) } })
})
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const until = async (fn, ms = 8000, step = 50) => { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) throw new Error('condition not met in time'); await sleep(step) } }

/** Simulates a VM that disappears: nothing is released or snapshotted, timers stop, sockets drop. */
async function killReplica(r) {
  r.killed = true
  r.cluster.leases.stop(); clearInterval(r.cluster.sweepTimer); r.cluster.channel.close()
  for (const room of r.manager.rooms.values()) room.halt()
  for (const s of r.clients) s.close()
  await r.io.close().catch(() => {})
  await r.store.close()
}

async function stopReplica(r) {
  for (const s of r.clients) s.close()
  if (r.killed) return // a dead VM runs no shutdown code
  await r.shutdown().catch(() => {})
}

module.exports = { startReplicas, client, call, waitFor, sleep, until, killReplica, stopReplica, token, clusterConfig }
