const { Pool } = require('pg')

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id             UUID PRIMARY KEY,
  username       TEXT NOT NULL,
  username_lower TEXT NOT NULL UNIQUE,
  email          TEXT NOT NULL UNIQUE,
  password_hash  TEXT NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);`

function createPool(databaseUrl) {
  return new Pool({ connectionString: databaseUrl, max: 10 })
}

// `db` is anything with .query(text, params) — a pg Pool in production, a pg-mem adapter in tests.
async function migrate(db) {
  await db.query(SCHEMA)
}

// Wait for Postgres to accept connections (compose starts services in parallel).
async function waitForDb(db, { retries = 30, delayMs = 1000, logger } = {}) {
  for (let i = 1; i <= retries; i++) {
    try {
      await db.query('SELECT 1')
      return
    } catch (err) {
      logger?.warn({ attempt: i, err: err.message }, 'waiting for database')
      await new Promise((r) => setTimeout(r, delayMs))
    }
  }
  throw new Error('database not reachable')
}

module.exports = { createPool, migrate, waitForDb }
