// One-shot migration entry point (used by the compose "game-migrate" job and the release pipeline):
//   DATABASE_URL=postgres://... node src/migrate.js
const makeLogger = require('./logger')
const { readSecret } = require('./secrets')
const { createPool, migrate, waitForDb } = require('./db')

async function main() {
  const logger = makeLogger(process.env.LOG_LEVEL || 'info')
  const url = readSecret('DATABASE_URL')
  if (!url) throw new Error('DATABASE_URL is required')
  const db = createPool(url)
  await waitForDb(db, { logger })
  await migrate(db)
  logger.info('game-service migrations applied')
  await db.end()
}
main().catch((err) => { console.error(err.message); process.exit(1) })
