// Needs a real Redis: REDIS_URL=redis://localhost:6379 npm test  (CI provides one as a service container)
const Redis = require('ioredis')
const crypto = require('crypto')
const { StreamConsumer } = require('../src/consumer')
const repo = require('../src/repo')
const { makeDb, gameEvent, silent } = require('./helpers')

const REDIS_URL = process.env.REDIS_URL
const d = REDIS_URL ? describe : describe.skip

d('StreamConsumer (real Redis)', () => {
  let redis, db, consumer, stream, dead, group
  const waitFor = async (fn, ms = 6000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await fn()) return true; await new Promise((r) => setTimeout(r, 50)) } return false }
  const publish = (payload, type = 'game.finished') => redis.xadd(stream, '*', 'type', type, 'data', typeof payload === 'string' ? payload : JSON.stringify(payload))
  const make = (handler) => new StreamConsumer({ redisUrl: REDIS_URL, stream, group, consumer: 'c1', deadLetter: dead, maxAttempts: 3, handler, logger: silent, blockMs: 200, retryDelayMs: 50 })
  const games = async () => Number((await db.query('SELECT COUNT(*) AS n FROM games')).rows[0].n)
  const pending = async () => (await redis.xpending(stream, group))[0]

  beforeEach(async () => {
    redis = new Redis(REDIS_URL); db = await makeDb()
    const id = crypto.randomUUID().slice(0, 8); stream = `test:games:${id}`; dead = `${stream}:dead`; group = 'stats-test'
  })
  afterEach(async () => { await consumer?.stop(); await redis.del(stream, dead); redis.disconnect() })

  it('stores events published before the consumer started (nothing is lost while stats-service is down)', async () => {
    await publish(gameEvent({ players: [{ playerId: 'u1', username: 'ann', totalScore: 10 }, { playerId: 'u2', username: 'bob', totalScore: 5 }] }))
    await publish(gameEvent({ players: [{ playerId: 'u1', username: 'ann', totalScore: 20 }, { playerId: 'u2', username: 'bob', totalScore: 5 }] }))
    consumer = make((e) => repo.storeGame(db, e)); await consumer.start()
    expect(await waitFor(async () => (await games()) === 2)).toBe(true)
    expect(await waitFor(async () => (await pending()) === 0)).toBe(true) // all acknowledged
  })
  it('processes live events and ignores a redelivered duplicate', async () => {
    consumer = make((e) => repo.storeGame(db, e)); await consumer.start()
    const e = gameEvent({ players: [{ playerId: 'u1', username: 'ann', totalScore: 10 }, { playerId: 'u2', username: 'bob', totalScore: 5 }] })
    await publish(e); await publish(e)
    expect(await waitFor(async () => (await pending()) === 0 && (await redis.xlen(stream)) === 2)).toBe(true)
    expect(await games()).toBe(1)
  })
  it('retries a failing event and then succeeds', async () => {
    let calls = 0
    consumer = make(async (e) => { if (++calls < 3) throw new Error('db down'); return repo.storeGame(db, e) })
    await consumer.start()
    await publish(gameEvent({ players: [{ playerId: 'u1', username: 'ann', totalScore: 10 }, { playerId: 'u2', username: 'bob', totalScore: 5 }] }))
    expect(await waitFor(async () => (await games()) === 1)).toBe(true)
    expect(calls).toBe(3)
  })
  it('moves a poison message to the dead-letter stream so it cannot block the rest', async () => {
    consumer = make((e) => repo.storeGame(db, e)); await consumer.start()
    await publish('{not json')
    await publish(gameEvent({ players: [{ playerId: 'u1', username: 'ann', totalScore: 10 }, { playerId: 'u2', username: 'bob', totalScore: 5 }] }))
    expect(await waitFor(async () => (await games()) === 1)).toBe(true)
    expect(await redis.xlen(dead)).toBe(1)
    expect(await waitFor(async () => (await pending()) === 0)).toBe(true)
  })
})
