const jwt = require('jsonwebtoken')
const { io: connect } = require('socket.io-client')
const { createGameServer } = require('../src/createGameServer')
const { MemoryEventBus } = require('../src/events/bus')
const { makeDictionary, silent, baseConfig, fixedRound } = require('./helpers')

const config = { ...baseConfig, roundDurationsMs: [500, 500, 400], intermissionMs: 150, reconnectGraceMs: 600, finishedRoomTtlMs: 5000 }
let server, port, bus
const clients = []

beforeAll(async () => {
  bus = new MemoryEventBus()
  server = createGameServer({
    config, dictionary: makeDictionary(), bus, logger: silent,
    createRoundFn: (i) => ({ ...fixedRound(i), durationMs: config.roundDurationsMs[i] }),
  })
  await new Promise((r) => server.httpServer.listen(0, r))
  port = server.httpServer.address().port
})
afterEach(() => { while (clients.length) clients.pop().close() })
afterAll(async () => { server.io.close(); await new Promise((r) => server.httpServer.close(r)) })

const token = (id, username = id.toUpperCase()) => jwt.sign({ sub: id, username, guest: false }, 'test-secret', { expiresIn: '1h' })
function client(id, tok = token(id)) {
  const s = connect(`http://localhost:${port}`, { auth: { token: tok }, transports: ['websocket'], reconnection: false })
  clients.push(s)
  s.log = []
  s.onAny((event, data) => s.log.push({ event, data }))
  return new Promise((resolve, reject) => { s.on('connect', () => resolve(s)); s.on('connect_error', reject) })
}
const call = (s, event, payload = {}) => new Promise((resolve) => s.emit(event, payload, resolve))
const waitFor = (s, event, pred = () => true, ms = 4000) => new Promise((resolve, reject) => {
  const hit = s.log.find((e) => e.event === event && pred(e.data)); if (hit) return resolve(hit.data)
  const t = setTimeout(() => reject(new Error(`timeout waiting for ${event}`)), ms)
  s.onAny((ev, data) => { if (ev === event && pred(data)) { clearTimeout(t); resolve(data) } })
})

describe('authentication', () => {
  it('rejects connections without a valid token', async () => {
    await expect(client('x', 'garbage')).rejects.toThrow('unauthorized')
    await expect(client('x', '')).rejects.toThrow('unauthorized')
  })
  it('rejects a token signed with the wrong secret', async () => {
    const bad = jwt.sign({ sub: 'x', username: 'X' }, 'other-secret')
    await expect(client('x', bad)).rejects.toThrow('unauthorized')
  })
})

describe('rooms over sockets', () => {
  it('create -> join -> state is broadcast; errors come back as acks', async () => {
    const a = await client('p1'); const b = await client('p2')
    const created = await call(a, 'room:create')
    expect(created.ok).toBe(true)
    expect(created.code).toMatch(/^[A-HJKMNP-Z2-9]{6}$/)
    expect(await call(b, 'room:join', { code: 'zzzzzz' })).toMatchObject({ ok: false, error: 'ROOM_NOT_FOUND' })
    expect(await call(b, 'room:join', { code: 'x' })).toMatchObject({ ok: false, error: 'BAD_CODE' })
    const joined = await call(b, 'room:join', { code: created.code.toLowerCase() })
    expect(joined.ok).toBe(true)
    expect(joined.state.players.map((p) => p.username)).toEqual(['P1', 'P2'])
    const st = await waitFor(a, 'room:state', (s) => s.players.length === 2)
    expect(st.hostId).toBe('p1')
    expect(await call(b, 'game:start')).toMatchObject({ ok: false, error: 'NOT_HOST' })
    expect(await call(a, 'room:create')).toMatchObject({ ok: false, error: 'ALREADY_IN_ROOM', code: created.code })
  })

  it('plays a full game: rounds, server timer, duplicates, elimination, winner, result published', async () => {
    const [a, b, c, d] = await Promise.all(['a', 'b', 'c', 'd'].map((id) => client(id)))
    const { code } = await call(a, 'room:create')
    for (const s of [b, c, d]) await call(s, 'room:join', { code })
    expect(await call(a, 'game:start')).toEqual({ ok: true })

    const r1 = await waitFor(a, 'round:start', (r) => r.round === 1)
    expect(r1).toMatchObject({ type: 'wordChain', seedWord: 'MOON', chainLetter: 'N' })
    expect(r1.endsAt - r1.startedAt).toBe(500) // the server clock decides when the round ends
    expect(r1.serverTime).toBeGreaterThanOrEqual(r1.startedAt)

    const ok = await call(a, 'word:submit', { word: 'nova' })
    expect(ok).toMatchObject({ ok: true, status: 'accepted', points: 7 })
    expect(await call(a, 'word:submit', { word: 'cat' })).toMatchObject({ ok: true, status: 'rejected', reason: "Doesn't start with A" })
    await call(b, 'word:submit', { word: 'nova' }) // duplicate with a
    await call(b, 'word:submit', { word: 'ant' })
    await call(c, 'word:submit', { word: 'near' })
    expect(await waitFor(a, 'word:result', (w) => w.word === 'nova')).toMatchObject({ status: 'accepted' })

    const e1 = await waitFor(a, 'round:end', (r) => r.round === 1)
    expect(e1.duplicates).toEqual([{ word: 'nova', playerIds: ['a', 'b'] }])
    expect(e1.eliminated.playerId).toBe('d') // never scored
    // a late word after the server's deadline is refused
    expect(await call(a, 'word:submit', { word: 'act' })).toMatchObject({ status: 'rejected', reason: 'Round not active' })

    await waitFor(a, 'round:start', (r) => r.round === 2)
    expect(await call(d, 'word:submit', { word: 'crate' })).toMatchObject({ status: 'rejected', reason: 'You have been eliminated' })
    await call(a, 'word:submit', { word: 'cares' }); await call(b, 'word:submit', { word: 'crate' }); await call(c, 'word:submit', { word: 'ear' })
    const e2 = await waitFor(a, 'round:end', (r) => r.round === 2)
    expect(e2.eliminated.playerId).toBe('c')

    await waitFor(a, 'round:start', (r) => r.round === 3)
    await call(a, 'word:submit', { word: 'rate' }); await call(a, 'word:submit', { word: 'tears' }); await call(b, 'word:submit', { word: 'near' })
    const end = await waitFor(d, 'game:end') // eliminated players still receive everything (spectating)
    expect(end.reason).toBe('completed')
    expect(end.winnerId).toBe('a')
    expect(end.standings.map((s) => s.playerId)).toEqual(['a', 'b', 'c', 'd'])

    expect(bus.events.filter((e) => e.payload.roomCode === code)).toHaveLength(1)
    expect(bus.events.at(-1).payload).toMatchObject({ winnerId: 'a', totalRounds: 3 })
  })

  it('a dropped player can come back inside the grace period with their score intact', async () => {
    const a = await client('r1'); let b = await client('r2')
    const { code } = await call(a, 'room:create'); await call(b, 'room:join', { code })
    await call(a, 'game:start')
    await waitFor(b, 'round:start')
    expect(await call(b, 'word:submit', { word: 'nova' })).toMatchObject({ status: 'accepted' })
    b.close()
    expect(await waitFor(a, 'player:disconnected', (p) => p.playerId === 'r2')).toEqual({ playerId: 'r2', graceMs: 600 })

    b = await client('r2') // same token, new connection
    const state = await waitFor(b, 'room:state', (s) => s.me?.words?.length === 1)
    expect(state.me).toMatchObject({ words: [{ word: 'nova', points: 7 }], chainLetter: 'A' })
    expect(state.round.type).toBe('wordChain')
    expect(await waitFor(a, 'player:reconnected', (p) => p.playerId === 'r2')).toEqual({ playerId: 'r2' })
    const sync = await call(b, 'room:sync')
    expect(sync.state.players.find((p) => p.id === 'r2').connected).toBe(true)
  })

  it('a player who does not return in time forfeits; the other player wins', async () => {
    const a = await client('s1'); const b = await client('s2')
    const { code } = await call(a, 'room:create'); await call(b, 'room:join', { code })
    await call(a, 'game:start'); await waitFor(a, 'round:start')
    b.close()
    const left = await waitFor(a, 'player:left', (p) => p.playerId === 's2', 3000)
    expect(left.reason).toBe('disconnected')
    const end = await waitFor(a, 'game:end')
    expect(end).toMatchObject({ winnerId: 's1', reason: 'last_standing' })
  })

  it('a second connection for the same user replaces the first', async () => {
    const first = await client('dup'); await call(first, 'room:create')
    const second = await client('dup')
    await waitFor(first, 'session:replaced')
    expect((await call(second, 'room:sync')).ok).toBe(true) // still in the same room
  })

  it('exposes health and prometheus metrics', async () => {
    const health = await (await fetch(`http://localhost:${port}/health`)).json()
    expect(health.status).toBe('ok')
    const metrics = await (await fetch(`http://localhost:${port}/metrics`)).text()
    for (const name of ['wordroyale_active_rooms', 'wordroyale_active_players', 'wordroyale_ws_connections', 'wordroyale_word_submit_duration_seconds_bucket', 'process_cpu_seconds_total']) {
      expect(metrics).toContain(name)
    }
  })
})
