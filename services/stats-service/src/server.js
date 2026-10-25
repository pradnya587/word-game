const client = require('prom-client')
const { load } = require('./config')
const makeLogger = require('./logger')
const { createPool, migrate, waitForDb } = require('./db')
const { createApp } = require('./app')
const { StreamConsumer } = require('./consumer')
const repo = require('./repo')

async function main() {
  const config = load()
  const logger = makeLogger(config.logLevel, config.instanceId)
  const db = createPool(config.databaseUrl)
  await waitForDb(db, { logger })
  await migrate(db)

  const registry = new client.Registry()
  registry.setDefaultLabels({ service: 'stats-service', instance_id: config.instanceId })
  client.collectDefaultMetrics({ register: registry })
  const consumed = new client.Counter({ name: 'wordroyale_stats_events_total', help: 'Game events handled', labelNames: ['result'], registers: [registry] })

  const consumer = new StreamConsumer({
    redisUrl: config.redisUrl, stream: config.gameEventsStream, group: config.consumerGroup, consumer: config.consumerName,
    deadLetter: config.deadLetterStream, maxAttempts: config.maxDeliveryAttempts, logger,
    handler: (event) => repo.storeGame(db, event),
    onResult: (r) => consumed.inc({ result: r }),
  })
  await consumer.start()

  const app = createApp({ db, config, logger, registry, isConsumerUp: () => consumer.up })
  const server = app.listen(config.port, () => logger.info({ port: config.port }, 'stats-service listening'))
  const shutdown = async () => { logger.info('shutting down'); server.close(); await consumer.stop(); await db.end(); process.exit(0) }
  process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown)
}
main().catch((err) => { console.error(err); process.exit(1) })
