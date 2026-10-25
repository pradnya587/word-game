const { MemoryStore, RedisStore, MemoryHub } = require('../src/coordination/stores')
const { LeaseManager } = require('../src/coordination/leases')
const { silent } = require('./helpers')

const REDIS_URL = process.env.REDIS_URL
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const prefix = () => `wrlease${Math.random().toString(36).slice(2, 8)}`

const backends = [['memory', () => { const hub = new MemoryHub(); return () => new MemoryStore({ hub }) }]]
if (REDIS_URL) backends.push(['redis', () => { const p = prefix(); return () => new RedisStore({ url: REDIS_URL, logger: silent, prefix: p }) }])

describe.each(backends)('owner leases (%s store)', (name, makeFactory) => {
  let newStore; const opened = []
  beforeEach(() => { const f = makeFactory(); newStore = () => { const s = f(); opened.push(s); return s } })
  afterAll(async () => { for (const s of opened) await s.close() })

  it('exactly one of many simultaneous acquirers wins, with the same epoch for the winner', async () => {
    const stores = Array.from({ length: 20 }, () => newStore())
    const results = await Promise.all(stores.map((s, i) => s.acquireLease('ROOM01', `inst-${i}`, 5000)))
    const winners = results.filter((e) => e > 0)
    expect(winners).toEqual([1])
    const owner = await stores[0].getOwner('ROOM01')
    expect(owner.epoch).toBe(1)
    expect(results.indexOf(1)).toBe(Number(owner.instanceId.split('-')[1]))
  })

  it('compare-and-renew and compare-and-release only work for the current owner', async () => {
    const s = newStore()
    const epoch = await s.acquireLease('ROOM02', 'a', 5000)
    expect(await s.renewLease('ROOM02', 'b', epoch, 5000)).toBe(false) // wrong instance
    expect(await s.renewLease('ROOM02', 'a', epoch + 1, 5000)).toBe(false) // wrong epoch
    expect(await s.renewLease('ROOM02', 'a', epoch, 5000)).toBe(true)
    expect(await s.releaseLease('ROOM02', 'b', epoch)).toBe(false)
    expect(await s.getOwner('ROOM02')).toMatchObject({ instanceId: 'a', epoch })
    expect(await s.releaseLease('ROOM02', 'a', epoch)).toBe(true)
    expect(await s.getOwner('ROOM02')).toBeNull()
  })

  it('after expiry another instance takes over with a higher fencing epoch; the old owner cannot renew or release', async () => {
    const s = newStore()
    const e1 = await s.acquireLease('ROOM03', 'old', 150)
    await sleep(250)
    const e2 = await s.acquireLease('ROOM03', 'new', 5000)
    expect(e2).toBe(e1 + 1)
    expect(await s.renewLease('ROOM03', 'old', e1, 5000)).toBe(false)
    expect(await s.releaseLease('ROOM03', 'old', e1)).toBe(false)
    expect(await s.getOwner('ROOM03')).toMatchObject({ instanceId: 'new', epoch: e2 })
  })

  it('a room code can be reserved only once cluster-wide, and a user can be claimed for only one room', async () => {
    const a = newStore(); const b = newStore()
    const r = await Promise.all([a.reserveCode('CODE01'), b.reserveCode('CODE01')])
    expect(r.filter(Boolean)).toHaveLength(1)
    expect(await a.claimUser('u1', 'CODE01')).toBeNull()
    expect(await b.claimUser('u1', 'CODE02')).toBe('CODE01')
    await b.clearUser('u1', 'CODE02') // compare-and-delete: not the user's room, so nothing happens
    expect(await a.getUserRoom('u1')).toBe('CODE01')
    await a.clearUser('u1', 'CODE01')
    expect(await a.getUserRoom('u1')).toBeNull()
  })
})

describe('LeaseManager self-fencing', () => {
  it('stops acting as owner before the lease can expire elsewhere, and reports the loss when another instance took over', async () => {
    const hub = new MemoryHub()
    const lost = []
    const a = new LeaseManager({ store: new MemoryStore({ hub }), instanceId: 'a', ttlMs: 400, renewMs: 100, safetyMs: 100, logger: silent, onLost: (c, e, why) => lost.push([c, why]) })
    await a.acquire('R1')
    expect(a.isOwner('R1')).toBe(true)
    a.paused = true // frozen VM: no renewals
    a.start()
    await sleep(320) // ttl 400 - safety 100 = 300 ms
    expect(a.isOwner('R1')).toBe(false) // already fenced although Redis has not expired the lease yet
    await sleep(200)
    const b = new LeaseManager({ store: new MemoryStore({ hub }), instanceId: 'b', ttlMs: 400, renewMs: 100, logger: silent })
    expect(await b.acquire('R1')).toBe(2)
    a.paused = false
    await a.renewAll()
    expect(lost).toEqual([['R1', 'lease_taken_over']])
    expect(a.owned.has('R1')).toBe(false)
    a.stop()
  })
})
