const { Pool } = require('pg')

// game-service owns one table, `room_snapshots`, in its own database (game_db).
// Migrations are idempotent and run under an advisory lock so several replicas can start at the same time.
const MIGRATIONS = [
  `CREATE TABLE IF NOT EXISTS room_snapshots (
     code           TEXT PRIMARY KEY,
     version        BIGINT NOT NULL,
     owner_epoch    BIGINT NOT NULL,
     owner_instance TEXT NOT NULL,
     phase          TEXT NOT NULL,
     state          JSONB NOT NULL,
     updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
   )`,
  `CREATE INDEX IF NOT EXISTS room_snapshots_updated_idx ON room_snapshots (updated_at)`,
]
const LOCK_ID = 727001 // arbitrary constant shared by every replica

const createPool = (url) => new Pool({ connectionString: url, max: 5, connectionTimeoutMillis: 5000 })

async function migrate(db, { lock = true } = {}) {
  if (!lock) { for (const sql of MIGRATIONS) await db.query(sql); return }
  const client = await db.connect()
  try {
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_ID])
    for (const sql of MIGRATIONS) await client.query(sql)
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [LOCK_ID]).catch(() => {})
    client.release()
  }
}

async function waitForDb(db, { retries = 30, delayMs = 1000, logger } = {}) {
  for (let i = 1; i <= retries; i++) {
    try { await db.query('SELECT 1'); return } catch (err) {
      logger?.warn({ attempt: i, err: err.message }, 'waiting for database')
      await new Promise((r) => setTimeout(r, delayMs))
    }
  }
  throw new Error('database not reachable')
}

module.exports = { createPool, migrate, waitForDb, MIGRATIONS }
