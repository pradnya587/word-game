const { load } = require('./config')
const makeLogger = require('./logger')
const { loadDictionary } = require('./dictionary')
const { RedisEventBus } = require('./events/bus')
const { createGameServer } = require('./createGameServer')
const { RedisStore, MemoryStore } = require('./coordination/stores')
const { PgSnapshotStore, MemorySnapshotStore } = require('./coordination/snapshots')
const { createPool, migrate, waitForDb } = require('./db')

async function main() {
  const config = load()
  const logger = makeLogger(config.logLevel, config.instanceId)
  const dictionary = loadDictionary(config.dictionaryPath)
  logger.info({ words: dictionary.size }, 'dictionary loaded')

  // Coordination (leases, directory, command routing, Socket.IO adapter) lives in Redis; snapshots in PostgreSQL.
  const store = process.env.COORDINATION === 'memory' ? new MemoryStore() : new RedisStore({ url: config.redisUrl, logger })
  let snapshots
  if (config.databaseUrl) {
    const db = createPool(config.databaseUrl)
    await waitForDb(db, { logger })
    if (config.autoMigrate) await migrate(db)
    snapshots = new PgSnapshotStore(db)
  } else if (process.env.ALLOW_MEMORY_SNAPSHOTS === 'true' || store.kind === 'memory') {
    logger.warn('DATABASE_URL is not set: room snapshots are kept in this process only, so rooms cannot survive a replica failure (development mode)')
    snapshots = new MemorySnapshotStore()
  } else {
    // Several replicas share Redis, but snapshots would be private to each one: a failover would silently lose every room.
    throw new Error('DATABASE_URL is required (room snapshots for failover). For local development set ALLOW_MEMORY_SNAPSHOTS=true')
  }

  // metrics object is created inside createGameServer; the bus is given it afterwards
  const bus = new RedisEventBus({ url: config.redisUrl, stream: config.gameEventsStream, logger })
  const server = createGameServer({ config, dictionary, bus, logger, store, snapshots })
  bus.metrics = server.metrics

  server.httpServer.listen(config.port, () => logger.info({ port: config.port, rounds: config.roundDurationsMs, instance_id: config.instanceId }, 'game-service listening'))

  let stopping = false
  const shutdown = async (signal) => {
    if (stopping) return
    stopping = true
    logger.info({ signal }, 'shutting down')
    const force = setTimeout(() => { logger.error('forced exit after shutdown timeout'); process.exit(1) }, 25_000)
    force.unref()
    try {
      await server.shutdown() // snapshot + release owned rooms, stop taking new ones (/ready now answers 503)
      await new Promise((r) => server.httpServer.close(r))
      await bus.close()
    } catch (e) { logger.error({ err: e.message }, 'error during shutdown') }
    process.exit(0)
  }
  process.on('SIGTERM', () => shutdown('SIGTERM')); process.on('SIGINT', () => shutdown('SIGINT'))
}
main().catch((err) => { console.error(err); process.exit(1) })
