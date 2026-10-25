// All SQL lives here. `db` is a pg Pool (or a pg-mem adapter in tests).

const RANGE_SQL = { today: "NOW() - INTERVAL '24 hours'", weekly: "NOW() - INTERVAL '7 days'", all: null }

function validateEvent(e) {
  if (!e || typeof e !== 'object') throw new Error('event is not an object')
  if (!e.gameId || !e.roomCode || !e.startedAt || !e.endedAt) throw new Error('event is missing gameId/roomCode/startedAt/endedAt')
  if (!Array.isArray(e.players) || e.players.length === 0) throw new Error('event has no players')
  for (const p of e.players) {
    if (!p.playerId || !p.username || !Number.isInteger(p.rank) || !Number.isInteger(p.totalScore)) throw new Error('event has an invalid player row')
  }
}

/**
 * Save a finished game. Idempotent: Redis may deliver the same event twice (at-least-once),
 * we check first, and the primary key on games.id still protects us if two consumers race.
 * Returns true if the game was stored, false if it was already there.
 */
async function storeGame(db, e) {
  validateEvent(e)
  const client = db.connect ? await db.connect() : db
  try {
    await client.query('BEGIN')
    const existing = await client.query('SELECT id FROM games WHERE id = $1', [e.gameId])
    if (existing.rows.length > 0) { await client.query('ROLLBACK'); return false }
    await client.query(
      `INSERT INTO games (id, room_code, started_at, ended_at, rounds_played, winner_id, reason)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [e.gameId, e.roomCode, e.startedAt, e.endedAt, e.roundsPlayed ?? 0, e.winnerId ?? null, e.reason ?? 'completed'])
    for (const p of e.players) {
      await client.query(
        `INSERT INTO game_players (game_id, player_id, username, is_guest, final_rank, total_score, eliminated_round, best_word, best_word_points, words_count)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [e.gameId, p.playerId, p.username, !!p.guest || String(p.playerId).startsWith('guest:'), p.rank, p.totalScore, p.eliminatedRound ?? null, p.bestWord ?? null, p.bestWordPoints ?? 0, p.wordsCount ?? 0])
    }
    await client.query('COMMIT')
    return true
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    if (err.code === '23505') return false // two consumers raced on the same game: the other one stored it
    throw err
  } finally {
    if (client.release) client.release()
  }
}

async function leaderboard(db, { range = 'today', limit = 20 } = {}) {
  if (!(range in RANGE_SQL)) range = 'today'
  limit = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 100)
  const since = RANGE_SQL[range]
  const { rows } = await db.query(
    `SELECT gp.player_id, MAX(gp.username) AS username, COUNT(*) AS games,
            SUM(CASE WHEN gp.final_rank = 1 THEN 1 ELSE 0 END) AS wins,
            SUM(gp.total_score) AS total_score, MAX(gp.best_word_points) AS best_word_points
       FROM game_players gp JOIN games g ON g.id = gp.game_id
      WHERE gp.is_guest = false ${since ? `AND g.ended_at >= ${since}` : ''}
      GROUP BY gp.player_id
      ORDER BY wins DESC, total_score DESC, games ASC, username ASC
      LIMIT ${limit}`)
  if (rows.length === 0) return []
  // best word per player (separate simple query keeps the SQL portable)
  const ids = rows.map((r) => r.player_id)
  const bw = await db.query(
    `SELECT player_id, best_word, best_word_points FROM game_players
      WHERE best_word IS NOT NULL AND player_id IN (${ids.map((_, i) => `$${i + 1}`).join(',')})
      ORDER BY best_word_points DESC`, ids)
  const best = new Map()
  for (const r of bw.rows) if (!best.has(r.player_id)) best.set(r.player_id, r.best_word)
  return rows.map((r, i) => ({
    rank: i + 1, playerId: r.player_id, username: r.username, games: Number(r.games), wins: Number(r.wins),
    totalScore: Number(r.total_score), bestWord: best.get(r.player_id) ?? null, bestWordPoints: Number(r.best_word_points),
  }))
}

async function userStats(db, playerId) {
  const sum = await db.query(
    `SELECT COUNT(*) AS games, SUM(CASE WHEN final_rank = 1 THEN 1 ELSE 0 END) AS wins, SUM(total_score) AS total_score, MAX(best_word_points) AS best_word_points
       FROM game_players WHERE player_id = $1`, [playerId])
  const best = await db.query(`SELECT best_word FROM game_players WHERE player_id = $1 AND best_word IS NOT NULL ORDER BY best_word_points DESC LIMIT 1`, [playerId])
  const hist = await db.query(
    `SELECT g.id, g.room_code, g.ended_at, gp.final_rank, gp.total_score, gp.eliminated_round, gp.best_word
       FROM game_players gp JOIN games g ON g.id = gp.game_id WHERE gp.player_id = $1 ORDER BY g.ended_at DESC LIMIT 20`, [playerId])
  const s = sum.rows[0] || {}
  const games = Number(s.games || 0)
  const wins = Number(s.wins || 0)
  return {
    summary: { games, wins, winRate: games ? Math.round((wins / games) * 100) : 0, totalScore: Number(s.total_score || 0), bestWord: best.rows[0]?.best_word ?? null, bestWordPoints: Number(s.best_word_points || 0) },
    history: hist.rows.map((r) => ({ gameId: r.id, roomCode: r.room_code, endedAt: r.ended_at, rank: r.final_rank, totalScore: r.total_score, eliminatedRound: r.eliminated_round, bestWord: r.best_word })),
  }
}

async function summary(db) {
  const g = await db.query(`SELECT COUNT(*) AS total, SUM(CASE WHEN ended_at >= NOW() - INTERVAL '24 hours' THEN 1 ELSE 0 END) AS today FROM games`)
  const p = await db.query(`SELECT COUNT(DISTINCT player_id) AS players FROM game_players WHERE is_guest = false`)
  return { gamesTotal: Number(g.rows[0].total || 0), gamesToday: Number(g.rows[0].today || 0), players: Number(p.rows[0].players || 0) }
}

module.exports = { storeGame, leaderboard, userStats, summary, validateEvent }
