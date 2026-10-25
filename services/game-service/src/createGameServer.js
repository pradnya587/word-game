const http = require('http')
const express = require('express')
const { Server } = require('socket.io')
const { createAdapter } = require('@socket.io/redis-adapter')
const { RoomManager } = require('./game/RoomManager')
const { createRound } = require('./game/rounds')
const { createMetrics } = require('./metrics')
const { registerSocketHandlers } = require('./sockets/handlers')
const { RoomCluster } = require('./coordination/cluster')
const { MemoryStore } = require('./coordination/stores')
const { MemorySnapshotStore } = require('./coordination/snapshots')

const realClock = { now: () => Date.now(), setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (h) => clearTimeout(h) }

/**
 * Builds the HTTP + Socket.IO server. Everything external (dictionary, event bus, clock, rng, coordination store,
 * snapshot store) is passed in, so tests can run the real server with a tiny dictionary and short rounds.
 * Without `store`/`snapshots` the server runs standalone (in-memory coordination) - one instance, as before.
 */
function createGameServer({
  config, dictionary, bus, logger, clock = realClock, rng = Math.random, createRoundFn = createRound,
  store = new MemoryStore(), snapshots = new MemorySnapshotStore(),
}) {
  const instanceId = config.instanceId || 'standalone'
  const app = express()
  app.disable('x-powered-by')
  const httpServer = http.createServer(app)
  const io = new Server(httpServer, {
    cors: { origin: config.corsOrigin === '*' ? true : config.corsOrigin.split(',') },
    transports: config.transports || ['websocket'], // WebSocket only: no sticky sessions are needed behind the load balancer
    pingInterval: 10000, pingTimeout: 10000, // detect dead connections within ~20s
  })

  // Cluster-wide Socket.IO: broadcasts and per-socket emits reach sockets connected to any replica.
  const adapterClients = store.adapterClients()
  if (adapterClients) io.adapter(createAdapter(adapterClients.pub, adapterClients.sub))

  const manager = new RoomManager({})
  const metrics = createMetrics(manager, { instanceId })
  manager.roomDeps = {
    config, dictionary, clock, rng, logger, metrics,
    createRound: createRoundFn,
    publish: (type, payload) => bus.publish(type, payload),
    transport: {
      broadcast: (code, event, data) => io.to(code).emit(event, data),
      sendTo: (socketId, event, data) => io.to(socketId).emit(event, data),
    },
  }
  const cluster = new RoomCluster({ config, instanceId, store, snapshots, manager, io, logger, metrics })

  // Liveness: cheap and process-local. The load balancer / autohealer uses this one.
  app.get('/health', (req, res) => res.json({ status: 'ok', service: 'game-service', instance_id: instanceId, ...manager.stats(), eventBus: bus.connected ? 'up' : 'down' }))
  // Readiness: can this instance do its job? (Redis coordination + snapshot database, and not draining.)
  app.get('/ready', async (req, res) => {
    const { ready, checks } = await cluster.checkReady()
    res.status(ready ? 200 : 503).json({ status: ready ? 'ready' : 'unready', service: 'game-service', instance_id: instanceId, checks })
  })
  app.get('/metrics', async (req, res) => { res.set('Content-Type', metrics.registry.contentType); res.end(await metrics.registry.metrics()) })

  registerSocketHandlers(io, { cluster, config, logger, metrics })

  // Graceful stop: hand rooms over, disconnect clients (they reconnect to another replica), close connections.
  const shutdown = async () => {
    await cluster.drain()
    try { await io.close() } catch (e) { logger.warn({ err: e.message }, 'error while closing sockets') }
    await cluster.close()
    await snapshots.close?.()
  }
  return { app, httpServer, io, manager, metrics, cluster, store, snapshots, shutdown }
}

module.exports = { createGameServer }
