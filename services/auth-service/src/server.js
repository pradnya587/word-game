const { load } = require('./config')
const makeLogger = require('./logger')
const { createPool, migrate, waitForDb } = require('./db')
const { createApp } = require('./app')

async function main() {
  const config = load()
  const logger = makeLogger(config.logLevel, config.instanceId)
  const db = createPool(config.databaseUrl)
  await waitForDb(db, { logger })
  await migrate(db)
  const app = createApp({ db, config, logger })
  const server = app.listen(config.port, () => logger.info({ port: config.port }, 'auth-service listening'))
  const shutdown = () => { logger.info('shutting down'); server.close(() => db.end().then(() => process.exit(0))) }
  process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown)
}
main().catch((err) => { console.error(err); process.exit(1) })
