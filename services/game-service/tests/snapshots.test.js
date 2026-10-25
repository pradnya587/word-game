const { newDb } = require('pg-mem')
const { migrate } = require('../src/db')
const { PgSnapshotStore, MemorySnapshotStore } = require('../src/coordination/snapshots')
const { Room } = require('../src/game/Room')
const { FakeClock, makeDictionary, silent, baseConfig, fixedRound } = require('./helpers')

async function pgStore() {
  const { Pool } = newDb().adapters.createPg()
  const db = new Pool()
  await migrate(db, { lock: false }) // pg-mem has no advisory locks; the lock only matters with several real replicas
  return new PgSnapshotStore(db)
}

describe.each([['postgres (pg-mem)', pgStore], ['memory', async () => new MemorySnapshotStore()]])('room snapshots - %s', (name, make) => {
  const doc = (over = {}) => ({ code: 'ABC234', version: 1, epoch: 1, instanceId: 'a', phase: 'lobby', state: { players: [{ id: 'p1' }] }, ...over })

  it('round-trips JSON state and deletes', async () => {
    const s = await make()
    expect(await s.save(doc())).toBe(true)
    expect(await s.load('ABC234')).toMatchObject({ code: 'ABC234', version: 1, epoch: 1, instanceId: 'a', phase: 'lobby', state: { players: [{ id: 'p1' }] } })
    await s.delete('ABC234')
    expect(await s.load('ABC234')).toBeNull()
  })

  it('fences writes: newer version/epoch wins, an older owner can never overwrite', async () => {
    const s = await make()
    // pg-mem echoes the proposed row from RETURNING even when ON CONFLICT ... WHERE rejects it (real PostgreSQL returns
    // no row), so the boolean result is only asserted for the memory store; the stored data is asserted for both.
    const strict = s.kind === 'memory'
    const saved = async (d, expected) => { const r = await s.save(d); if (strict) expect(r).toBe(expected) }
    await saved(doc({ version: 5, epoch: 1, phase: 'round' }), true)
    await saved(doc({ version: 5, epoch: 1, phase: 'x' }), false) // same version again
    await saved(doc({ version: 4, epoch: 1, phase: 'x' }), false) // older version
    expect(await s.load('ABC234')).toMatchObject({ version: 5, epoch: 1, phase: 'round' })
    await saved(doc({ version: 1, epoch: 2, instanceId: 'b', phase: 'intermission' }), true) // new owner, counter restarts
    await saved(doc({ version: 99, epoch: 1, phase: 'stale' }), false) // old owner, however high its version
    expect(await s.load('ABC234')).toMatchObject({ epoch: 2, instanceId: 'b', phase: 'intermission' })
  })
})

describe('Room.serialize / Room.restore', () => {
  const setup = () => {
    const clock = new FakeClock()
    const sent = []
    const deps = (code) => ({
      config: { ...baseConfig }, dictionary: makeDictionary(), clock, rng: Math.random, logger: silent, metrics: null,
      createRound: (i) => ({ ...fixedRound(i) }), publish: () => {},
      transport: { broadcast: (c, e, d) => sent.push([e, d]), sendTo: () => {} },
      onEmpty: () => {}, onPlayerRemoved: () => {},
    })
    return { clock, sent, deps }
  }

  it('a room snapshotted between rounds resumes with scores, eliminations and host intact (JSON round trip)', () => {
    const { clock, sent, deps } = setup()
    const room = new Room('ROOM01', deps('ROOM01'))
    for (const id of ['a', 'b', 'c']) room.addPlayer({ id, username: id.toUpperCase(), guest: false }, `s-${id}`)
    room.start('a')
    room.submitWord('a', 'nova'); room.submitWord('b', 'near'); room.submitWord('b', 'rate') // c scores nothing
    clock.advance(45_000) // round 1 ends: c eliminated; intermission
    expect(room.state).toBe('intermission')
    const snap = JSON.parse(JSON.stringify(room.serialize())) // what Postgres would store

    const fresh = setup()
    const restored = Room.restore('ROOM01', fresh.deps('ROOM01'), snap)
    expect(restored.players.get('c')).toMatchObject({ eliminated: true, eliminatedRound: 1, connected: false })
    expect(restored.players.get('b').total).toBe(room.players.get('b').total)
    expect(restored.hostId).toBe('a')
    restored.resume()
    // intermission continues into round 2 with everybody on the reconnect grace period
    fresh.clock.advance(5000)
    expect(restored.state).toBe('round')
    expect(restored.roundIndex).toBe(1)
    expect(fresh.sent.some(([e, d]) => e === 'round:start' && d.round === 2 && d.type === 'letterBuilder')).toBe(true)
    expect(restored.players.get('c').eliminated).toBe(true) // eliminated player stays out
  })

  it('a room snapshotted mid-round restarts that round with the SAME definition and a fresh deadline', () => {
    const { clock, deps } = setup()
    const room = new Room('ROOM02', deps('ROOM02'))
    for (const id of ['a', 'b']) room.addPlayer({ id, username: id, guest: false }, `s-${id}`)
    room.start('a')
    clock.advance(10_000)
    room.submitWord('a', 'nova')
    const snap = JSON.parse(JSON.stringify(room.serialize()))
    expect(snap.round.def.seedWord).toBe('moon')

    const fresh = setup(); fresh.clock.t = clock.t + 20_000
    const restored = Room.restore('ROOM02', fresh.deps('ROOM02'), snap)
    restored.resume()
    expect(restored.state).toBe('round')
    expect(restored.round.def.seedWord).toBe('moon')
    expect(restored.round.endsAt).toBe(fresh.clock.t + 45_000) // new server deadline, full duration
    expect(restored.players.get('a').roundScore).toBe(0) // the interrupted round is replayed from its start
    const sync = restored.stateFor('a')
    expect(sync.round.durationMs).toBe(45_000)
  })
})
