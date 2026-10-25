const repo = require('../src/repo')
const { makeDb, gameEvent } = require('./helpers')

const P = (playerId, username, totalScore, extra = {}) => ({ playerId, username, totalScore, ...extra })
const hoursAgo = (h) => new Date(Date.now() - h * 3600_000).toISOString()

let db
beforeEach(async () => { db = await makeDb() })

describe('storeGame', () => {
  it('stores a game and its players', async () => {
    const e = gameEvent({ players: [P('u1', 'ann', 120, { bestWord: 'crates', bestWordPoints: 12 }), P('u2', 'bob', 80)] })
    expect(await repo.storeGame(db, e)).toBe(true)
    expect((await db.query('SELECT COUNT(*) AS n FROM games')).rows[0].n).toBe(1)
    const rows = (await db.query('SELECT * FROM game_players ORDER BY final_rank')).rows
    expect(rows.map((r) => [r.player_id, r.final_rank, r.total_score])).toEqual([['u1', 1, 120], ['u2', 2, 80]])
    expect(rows[0].best_word).toBe('crates')
  })
  it('is idempotent: the same event delivered twice is stored once', async () => {
    const e = gameEvent({ players: [P('u1', 'ann', 50), P('u2', 'bob', 40)] })
    expect(await repo.storeGame(db, e)).toBe(true)
    expect(await repo.storeGame(db, e)).toBe(false)
    expect((await db.query('SELECT COUNT(*) AS n FROM game_players')).rows[0].n).toBe(2)
  })
  it('marks guests so they stay off the leaderboard', async () => {
    await repo.storeGame(db, gameEvent({ players: [P('guest:123', 'Guest1234', 99), P('u2', 'bob', 10)] }))
    const g = (await db.query("SELECT is_guest FROM game_players WHERE player_id = 'guest:123'")).rows[0]
    expect(g.is_guest).toBe(true)
  })
  it('rejects malformed events without writing anything', async () => {
    await expect(repo.storeGame(db, { gameId: 'x' })).rejects.toThrow(/^event /)
    await expect(repo.storeGame(db, gameEvent({ players: [P('u1', 'ann', 5)] }) && { ...gameEvent({ players: [P('u1', 'ann', 5)] }), players: [] })).rejects.toThrow(/no players/)
    expect((await db.query('SELECT COUNT(*) AS n FROM games')).rows[0].n).toBe(0)
  })
  it('rolls back the whole game if a player row is bad', async () => {
    const e = gameEvent({ players: [P('u1', 'ann', 5), P('u2', 'bob', 3)] })
    e.players[1].total_score_typo = 1; e.players[1].totalScore = 'not-a-number'
    await expect(repo.storeGame(db, e)).rejects.toThrow()
    expect((await db.query('SELECT COUNT(*) AS n FROM games')).rows[0].n).toBe(0)
  })
})

describe('leaderboard', () => {
  beforeEach(async () => {
    await repo.storeGame(db, gameEvent({ endedAt: hoursAgo(1), players: [P('u1', 'ann', 100, { bestWord: 'cares', bestWordPoints: 9 }), P('u2', 'bob', 60), P('guest:9', 'Guest9999', 200)] }))
    await repo.storeGame(db, gameEvent({ endedAt: hoursAgo(2), players: [P('u1', 'ann', 70, { bestWord: 'crates', bestWordPoints: 12 }), P('u3', 'cy', 65)] }))
    await repo.storeGame(db, gameEvent({ endedAt: hoursAgo(24 * 3), players: [P('u2', 'bob', 300), P('u3', 'cy', 10)] }))
    await repo.storeGame(db, gameEvent({ endedAt: hoursAgo(24 * 30), players: [P('u3', 'cy', 500)] }))
  })
  it('ranks by wins then total score, excludes guests, and picks each player\'s best word', async () => {
    const all = await repo.leaderboard(db, { range: 'all' })
    expect(all.map((r) => r.username)).toEqual(['ann', 'cy', 'bob']) // ann 2 wins, cy 1 win (30d ago), bob 1 win (3d ago)
    expect(all.find((r) => r.username === 'ann')).toMatchObject({ rank: 1, wins: 2, games: 2, totalScore: 170, bestWord: 'crates', bestWordPoints: 12 })
    expect(all.some((r) => r.username.startsWith('Guest'))).toBe(false)
  })
  it('filters by time range', async () => {
    const today = await repo.leaderboard(db, { range: 'today' })
    expect(today.map((r) => r.username)).toEqual(['ann', 'cy', 'bob']) // no wins for cy/bob in 24h: cy has more points
    expect(today.find((r) => r.username === 'cy').games).toBe(1)
    const weekly = await repo.leaderboard(db, { range: 'weekly' })
    expect(weekly.find((r) => r.username === 'cy').totalScore).toBe(75)
    expect(weekly.find((r) => r.username === 'bob').wins).toBe(1)
  })
  it('respects the limit and handles an empty database', async () => {
    expect(await repo.leaderboard(db, { range: 'all', limit: 1 })).toHaveLength(1)
    expect(await repo.leaderboard(await makeDb(), { range: 'all' })).toEqual([])
  })
})

describe('userStats and summary', () => {
  it('summarises a player and lists recent games newest first', async () => {
    await repo.storeGame(db, gameEvent({ endedAt: hoursAgo(5), players: [P('u2', 'bob', 90), P('u1', 'ann', 40, { bestWord: 'tea', bestWordPoints: 3 })] }))
    await repo.storeGame(db, gameEvent({ endedAt: hoursAgo(1), players: [P('u1', 'ann', 100, { bestWord: 'crates', bestWordPoints: 12 }), P('u2', 'bob', 5)] }))
    const s = await repo.userStats(db, 'u1')
    expect(s.summary).toEqual({ games: 2, wins: 1, winRate: 50, totalScore: 140, bestWord: 'crates', bestWordPoints: 12 })
    expect(s.history.map((h) => h.rank)).toEqual([1, 2]) // newest first
    expect(await repo.summary(db)).toEqual({ gamesTotal: 2, gamesToday: 2, players: 2 })
  })
  it('returns zeroes for a player with no games', async () => {
    expect((await repo.userStats(db, 'nobody')).summary).toEqual({ games: 0, wins: 0, winRate: 0, totalScore: 0, bestWord: null, bestWordPoints: 0 })
  })
})
