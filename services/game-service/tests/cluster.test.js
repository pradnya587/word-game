/**
 * Two (or three) real game-service replicas in one process, sharing Redis (leases, directory, command channels,
 * Socket.IO adapter) and a snapshot store. Needs a Redis: set REDIS_URL (CI provides one); skipped otherwise.
 */
const { startReplicas, client, call, waitFor, sleep, until, killReplica, stopReplica } = require('./clusterHelpers')

const REDIS_URL = process.env.REDIS_URL
const suite = REDIS_URL ? describe : describe.skip

suite('game-service replicas (A and B) sharing Redis', () => {
  let A; let B; let env
  beforeEach(async () => {
    env = await startReplicas(['game-a', 'game-b'], { redisUrl: REDIS_URL })
    ;[A, B] = env.replicas
  })
  afterEach(async () => { await Promise.all(env.replicas.map(stopReplica)) })

  it('a room created on replica A is discovered and joined from replica B; state and events cross replicas', async () => {
    const p1 = await client(A, 'p1'); const p2 = await client(B, 'p2')
    const created = await call(p1, 'room:create')
    expect(created.ok).toBe(true)
    expect(await A.store.getOwner(created.code)).toMatchObject({ instanceId: 'game-a', epoch: 1 })
    expect(B.manager.get(created.code)).toBeNull() // B holds no copy of the room

    const joined = await call(p2, 'room:join', { code: created.code.toLowerCase() })
    expect(joined.ok).toBe(true)
    expect(joined.state.players.map((p) => p.username)).toEqual(['P1', 'P2'])
    // events emitted by the owner (A) reach the socket connected to B, and the other way round
    expect(await waitFor(p1, 'player:joined', (e) => e.player.id === 'p2')).toBeTruthy()
    expect(await call(p1, 'room:ready', { ready: true })).toEqual({ ok: true })
    expect((await waitFor(p2, 'room:state', (s) => s.players.find((p) => p.id === 'p1')?.ready)).hostId).toBe('p1')
    expect(await call(p2, 'room:ready', { ready: true })).toEqual({ ok: true }) // forwarded B -> A
    await waitFor(p1, 'room:state', (s) => s.players.find((p) => p.id === 'p2')?.ready)

    // errors travel back over the same acknowledgement route
    expect(await call(p2, 'game:start')).toMatchObject({ ok: false, error: 'NOT_HOST' })
    expect(await call(p2, 'room:join', { code: 'ZZZZZZ' })).toMatchObject({ ok: false, error: 'ROOM_NOT_FOUND' })
    expect(await call(p2, 'room:create')).toMatchObject({ ok: false, error: 'ALREADY_IN_ROOM', code: created.code })
    const p3 = await client(A, 'p3')
    expect(await call(p3, 'room:join', { code: created.code })).toMatchObject({ ok: true })
    // the same user cannot sit in two rooms, even on different replicas
    const other = await call(await client(B, 'p4'), 'room:create')
    expect(await call(p3, 'room:join', { code: other.code })).toMatchObject({ ok: false, error: 'ALREADY_IN_ROOM' })
  })

  it('a six-player room spanning both replicas completes a whole game; the result is published exactly once', async () => {
    const ids = ['a1', 'b1', 'a2', 'b2', 'a3', 'b3']
    const socks = []
    for (const id of ids) socks.push(await client(id.startsWith('a') ? A : B, id))
    const { code } = await call(socks[0], 'room:create')
    for (const s of socks.slice(1)) expect(await call(s, 'room:join', { code })).toMatchObject({ ok: true })
    expect(await call(socks[0], 'game:start')).toEqual({ ok: true })

    await Promise.all(socks.map((s) => waitFor(s, 'round:start', (r) => r.round === 1)))
    // players on replica B submit words; the acknowledgement and the private word:result come back to the right socket
    const ok = await call(socks[1], 'word:submit', { word: 'nova' })
    expect(ok).toMatchObject({ ok: true, status: 'accepted', points: 7 })
    expect(await waitFor(socks[1], 'word:result', (w) => w.word === 'nova')).toMatchObject({ status: 'accepted' })
    expect(socks[0].log.some((e) => e.event === 'word:result')).toBe(false) // private to the submitter
    await call(socks[0], 'word:submit', { word: 'nova' }) // duplicate across replicas -> resolved at round end
    await call(socks[2], 'word:submit', { word: 'near' })

    const e1 = await Promise.all(socks.map((s) => waitFor(s, 'round:end', (r) => r.round === 1)))
    expect(e1[0].duplicates).toEqual([{ word: 'nova', playerIds: ['a1', 'b1'] }])
    for (const s of socks) await waitFor(s, 'round:start', (r) => r.round === 2)
    const ends = await Promise.all(socks.map((s) => waitFor(s, 'game:end', () => true, 9000)))
    expect(new Set(ends.map((e) => e.winnerId)).size).toBe(1)
    expect(ends[0].reason).toBe('completed')

    expect(A.bus.events.filter((e) => e.payload.roomCode === code)).toHaveLength(1) // published by the owner only
    expect(B.bus.events).toHaveLength(0)
  })

  it('applies a forwarded command once, even when the same command id is delivered twice', async () => {
    const p1 = await client(A, 'i1'); const p2 = await client(B, 'i2')
    const { code } = await call(p1, 'room:create'); await call(p2, 'room:join', { code })
    await call(p1, 'game:start'); await waitFor(p2, 'round:start')

    const env = { id: 'cmd-123', room: code, epoch: A.cluster.leases.epochOf(code), user: { id: 'i2', username: 'I2', guest: false }, socketId: p2.id, type: 'submit', payload: { word: 'nova' } }
    const first = await A.cluster.handleCommand(env)
    const again = await A.cluster.handleCommand(env) // network retry / duplicate delivery
    expect(first).toMatchObject({ ok: true, status: 'accepted' })
    expect(again).toBe(first) // answered from the idempotency cache
    expect(A.manager.get(code).players.get('i2').roundScore).toBe(7) // scored once
    // a NEW command id with the same word is a genuine second submission
    expect(await A.cluster.handleCommand({ ...env, id: 'cmd-124' })).toMatchObject({ status: 'rejected', reason: 'Already used' })
    // wrong fencing epoch is refused, nothing is applied
    expect(await A.cluster.handleCommand({ ...env, id: 'cmd-125', epoch: 99 })).toMatchObject({ ok: false, error: 'STALE_OWNER' })
  })

  it('a second connection for the same user on another replica replaces the first', async () => {
    const first = await client(A, 'dup'); await call(first, 'room:create')
    const second = await client(B, 'dup')
    await waitFor(first, 'session:replaced')
    expect((await call(second, 'room:sync')).ok).toBe(true) // still in the same room, served through the owner on A
    expect(second.log.some((e) => e.event === 'session:replaced')).toBe(false)
  })

  it('a player can reconnect through the other replica with the same token and keeps their words', async () => {
    const p1 = await client(A, 'r1'); let p2 = await client(B, 'r2')
    const { code } = await call(p1, 'room:create'); await call(p2, 'room:join', { code })
    await call(p1, 'game:start'); await waitFor(p2, 'round:start')
    expect(await call(p2, 'word:submit', { word: 'nova' })).toMatchObject({ status: 'accepted' })
    p2.close()
    expect(await waitFor(p1, 'player:disconnected', (p) => p.playerId === 'r2')).toMatchObject({ playerId: 'r2' })

    p2 = await client(A, 'r2') // other replica, no sticky session
    const state = await waitFor(p2, 'room:state', (s) => s.me?.words?.length === 1)
    expect(state.me).toMatchObject({ words: [{ word: 'nova', points: 7 }], chainLetter: 'A' })
    expect(await waitFor(p1, 'player:reconnected', (p) => p.playerId === 'r2')).toEqual({ playerId: 'r2' })
    expect((await call(p2, 'word:submit', { word: 'ant' })).status).toBe('accepted')
  })

  it('kick across replicas: the target gets room:kicked and stops receiving room events', async () => {
    const host = await client(A, 'h'); const target = await client(B, 't')
    const { code } = await call(host, 'room:create'); await call(target, 'room:join', { code })
    expect(await call(host, 'room:kick', { playerId: 't' })).toEqual({ ok: true })
    await waitFor(target, 'room:kicked')
    await sleep(100)
    const before = target.log.length
    await call(host, 'room:ready', { ready: true })
    await sleep(150)
    expect(target.log.slice(before).filter((e) => e.event === 'room:state')).toHaveLength(0)
    expect((await call(target, 'room:sync'))).toMatchObject({ ok: false, error: 'NOT_IN_ROOM' })
  })

  it('readiness reports redis + database, liveness stays cheap', async () => {
    const ready = await fetch(`http://localhost:${A.port}/ready`)
    expect(ready.status).toBe(200)
    expect((await ready.json())).toMatchObject({ status: 'ready', checks: { redis: 'up', database: 'up', draining: 'no' } })
    const health = await (await fetch(`http://localhost:${A.port}/health`)).json()
    expect(health).toMatchObject({ status: 'ok', instance_id: 'game-a' })
  })
})

suite('failover', () => {
  let env; let A; let B
  afterEach(async () => { await Promise.all(env.replicas.map((r) => stopReplica(r).catch(() => {}))) })

  const startMatch = async (config) => {
    env = await startReplicas(['game-a', 'game-b'], { redisUrl: REDIS_URL, config })
    ;[A, B] = env.replicas
    const pa = await client(A, 'fa'); const pb = await client(B, 'fb')
    const { code } = await call(pa, 'room:create'); await call(pb, 'room:join', { code })
    return { pa, pb, code }
  }

  it('owner VM killed mid-match: the surviving replica resumes the room from its snapshot within 60 s', async () => {
    const { pa, pb, code } = await startMatch({ roundDurationsMs: [900, 4000, 600], intermissionMs: 300 })
    await call(pa, 'game:start')
    await waitFor(pb, 'round:start', (r) => r.round === 1)
    await call(pb, 'word:submit', { word: 'nova' }); await call(pa, 'word:submit', { word: 'near' })
    await waitFor(pb, 'round:end', (r) => r.round === 1)
    const r2 = await waitFor(pb, 'round:start', (r) => r.round === 2)
    const totalsBefore = (await call(pb, 'room:sync')).state.players.map((p) => [p.id, p.totalScore])
    await until(async () => (await env.snapshots.load(code))?.phase === 'round' && (await env.snapshots.load(code)).state.roundIndex === 1)

    const killedAt = Date.now()
    await killReplica(A) // no release, no final snapshot
    expect(await B.store.getOwner(code)).toMatchObject({ instanceId: 'game-a' }) // lease still looks held for a moment

    await until(() => B.manager.get(code), 60_000, 50)
    const recoveryMs = Date.now() - killedAt
    expect(recoveryMs).toBeLessThan(60_000)
    console.log(`owner kill -> room resumed on game-b in ${recoveryMs} ms`)

    expect(await B.store.getOwner(code)).toMatchObject({ instanceId: 'game-b' })
    const newOwner = await B.store.getOwner(code)
    expect(newOwner.epoch).toBe(2) // fencing epoch advanced
    // the connected player gets an authoritative STATE_SYNC and a fresh round with a NEW server deadline
    const sync = await waitFor(pb, 'state:sync', () => true, 8000)
    expect(sync).toMatchObject({ reason: 'owner_recovered', ownerEpoch: 2 })
    const r2again = await waitFor(pb, 'round:start', (r) => r.round === 2 && r.endsAt > r2.endsAt, 8000)
    expect(r2again.type).toBe('letterBuilder')
    expect(r2again.letters).toEqual(r2.letters) // same saved round definition
    expect(r2again.endsAt - r2again.startedAt).toBe(4000)
    // scores accumulated before the failure are intact
    const st = (await call(pb, 'room:sync')).state
    expect(st.players.map((p) => [p.id, p.totalScore])).toEqual(totalsBefore)
    expect(st.state).toBe('round')
    // the player whose VM died reconnects (to the survivor) inside the grace period and plays on
    const pa2 = await client(B, 'fa')
    const back = await waitFor(pa2, 'room:state', (s) => s.me && s.state === 'round')
    expect(back.me.playerId).toBe('fa')
    expect((await call(pa2, 'word:submit', { word: 'cares' })).status).toBe('accepted')
    expect((await call(pb, 'word:submit', { word: 'crate' })).status).toBe('accepted')
  }, 30_000)

  it('no two owners: a frozen old owner steps down before takeover, then cannot emit, snapshot or run commands', async () => {
    const { pa, pb, code } = await startMatch({})
    const roomA = A.manager.get(code)
    A.cluster.leases.paused = true // VM freeze: A stops renewing (but its timers/process still exist)
    await until(() => B.manager.get(code), 20_000, 50) // B adopts after the lease expires
    expect(A.cluster.leases.isOwner(code)).toBe(false) // A fenced itself no later than B's takeover

    // A can no longer talk to clients
    const before = pb.log.length
    roomA.broadcast('room:state', { forged: true })
    await sleep(150)
    expect(pb.log.slice(before).some((e) => e.data?.forged)).toBe(false)
    // ... or write snapshots, or accept commands
    const snapBefore = await env.snapshots.load(code)
    A.cluster.checkpoint(roomA, 'stale'); await A.cluster.flushSnapshots()
    expect((await env.snapshots.load(code)).version).toBeGreaterThanOrEqual(snapBefore.version)
    expect((await env.snapshots.load(code)).epoch).toBe(2)
    expect(await A.cluster.handleCommand({ id: 'late', room: code, epoch: 1, user: { id: 'fa' }, type: 'sync', payload: {} })).toMatchObject({ error: 'NOT_OWNER' })
    // a stale snapshot (old epoch) is rejected by the store itself
    expect(await env.snapshots.save({ code, version: 999, epoch: 1, instanceId: 'game-a', phase: 'lobby', state: {} })).toBe(false)
    // once A renews again it discovers the loss and drops the room
    A.cluster.leases.paused = false
    await A.cluster.leases.renewAll()
    expect(A.manager.get(code)).toBeNull()
    expect(await B.store.getOwner(code)).toMatchObject({ instanceId: 'game-b', epoch: 2 })
  }, 30_000)

  it('graceful shutdown (rolling update): rooms are snapshotted and handed over at once; clients reconnect', async () => {
    const { pa, pb, code } = await startMatch({})
    expect(await call(pa, 'room:ready', { ready: true })).toEqual({ ok: true })
    const t0 = Date.now()
    const ready = await fetch(`http://localhost:${A.port}/ready`)
    expect(ready.status).toBe(200)
    const draining = A.cluster.drain()
    await sleep(50)
    expect((await fetch(`http://localhost:${A.port}/ready`)).status).toBe(503) // LB stops sending new traffic
    expect(await call(await client(A, 'late-joiner'), 'room:create')).toMatchObject({ ok: false, error: 'UNAVAILABLE' })
    await draining
    expect(await B.store.getOwner(code)).toBeNull() // lease released, not left to expire
    await until(() => B.manager.get(code), 10_000, 25)
    console.log(`graceful hand-over: room serving again on game-b after ${Date.now() - t0} ms`)

    const sync = (await call(pb, 'room:sync')).state
    expect(sync.code).toBe(code)
    expect(sync.players.find((p) => p.id === 'fa')).toBeTruthy()
    expect(sync.players.find((p) => p.id === 'fa').ready).toBe(true) // lobby state survived
    const pa2 = await client(B, 'fa') // the client of the drained replica reconnects elsewhere
    expect((await waitFor(pa2, 'room:state', (s) => s.me)).code).toBe(code)
    expect(await call(pa2, 'game:start')).toEqual({ ok: true }) // fa is still the host after the hand-over
  }, 30_000)

  it('orphaned lobby with a lost snapshot or a finished game is discarded instead of adopted', async () => {
    env = await startReplicas(['game-a', 'game-b'], { redisUrl: REDIS_URL }); [A, B] = env.replicas
    // a code that exists in the directory but has neither an owner nor a snapshot
    await A.store.reserveCode('GHOST1'); await A.store.claimUser('ghost-user', 'GHOST1')
    await until(async () => !(await A.store.roomExists('GHOST1')), 10_000, 100)
    // the user's stale membership is dropped lazily: they can create a room right away
    expect(await call(await client(B, 'ghost-user'), 'room:create')).toMatchObject({ ok: true })
  }, 20_000)
})
