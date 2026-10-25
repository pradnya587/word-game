const { Pool } = require('pg')

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS games (
     id            UUID PRIMARY KEY,
     room_code     TEXT NOT NULL,
     started_at    TIMESTAMPTZ NOT NULL,
     ended_at      TIMESTAMPTZ NOT NULL,
     rounds_played INT NOT NULL,
     winner_id     TEXT,
     reason        TEXT NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS game_players (
     game_id          UUID NOT NULL REFERENCES games(id) ON DELETE CASCADE,
     player_id        TEXT NOT NULL,
     username         TEXT NOT NULL,
     is_guest         BOOLEAN NOT NULL,
     final_rank       INT NOT NULL,
     total_score      INT NOT NULL,
     eliminated_round INT,
     best_word        TEXT,
     best_word_points INT NOT NULL DEFAULT 0,
     words_count      INT NOT NULL DEFAULT 0,
     PRIMARY KEY (game_id, player_id)
   )`,
  `CREATE INDEX IF NOT EXISTS game_players_player_idx ON game_players (player_id)`,
  `CREATE INDEX IF NOT EXISTS games_ended_at_idx ON games (ended_at)`,
]

const createPool = (url) => new Pool({ connectionString: url, max: 10 })
async function migrate(db) { for (const sql of SCHEMA) await db.query(sql) }
async function waitForDb(db, { retries = 30, delayMs = 1000, logger } = {}) {
  for (let i = 1; i <= retries; i++) {
    try { await db.query('SELECT 1'); return } catch (err) {
      logger?.warn({ attempt: i, err: err.message }, 'waiting for database')
      await new Promise((r) => setTimeout(r, delayMs))
    }
  }
  throw new Error('database not reachable')
}
module.exports = { createPool, migrate, waitForDb }
