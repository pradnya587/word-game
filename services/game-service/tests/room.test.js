const { Room, RoomError } = require('../src/game/Room')
const { FakeClock, makeDictionary, silent, baseConfig, fixedRound } = require('./helpers')

function setup(overrides = {}) {
  const clock = new FakeClock()
  const events = []
  const published = []
  const config = { ...baseConfig, ...overrides }
  const room = new Room('ABC234', {
    config, dictionary: makeDictionary(), clock, rng: Math.random, logger: silent,
    createRound: (i) => ({ ...fixedRound(i), durationMs: config.roundDurationsMs[i] }),
    publish: (type, payload) => published.push({ type, payload }),
    transport: {
      broadcast: (code, event, data) => events.push({ to: 'all', event, data }),
      sendTo: (socketId, event, data) => events.push({ to: socketId, event, data }),
    },
  })
  const last = (event) => [...events].reverse().find((e) => e.event === event)?.data
  const all = (event) => events.filter((e) => e.event === event).map((e) => e.data)
  const join = (id) => room.addPlayer({ id, username: id.toUpperCase(), guest: false }, `sock-${id}`)
  return { room, clock, events, published, last, all, join, config }
}
const err = (fn) => { try { fn() } catch (e) { return e } return null }

describe('lobby', () => {
  it('first player is host; ready toggles; join/leave are broadcast', () => {
    const { room, join, all } = setup()
    join('a'); join('b')
    expect(room.hostId).toBe('a')
    room.setReady('b')
    expect(room.publicState().players.find((p) => p.id === 'b').ready).toBe(true)
    expect(all('player:joined')).toHaveLength(2)
  })
  it('refuses a 7th player and a player who is already inside', () => {
    const { room, join } = setup()
    for (const id of ['a', 'b', 'c', 'd', 'e', 'f']) join(id)
    expect(err(() => join('g')).code).toBe('ROOM_FULL')
    expect(err(() => join('a')).code).toBe('ALREADY_IN_ROOM')
  })
  it('only the host can start, and only with enough players', () => {
    const { room, join } = setup()
    join('a')
    expect(err(() => room.start('a')).code).toBe('NOT_ENOUGH_PLAYERS')
    join('b')
    expect(err(() => room.start('b')).code).toBe('NOT_HOST')
    room.start('a')
    expect(room.state).toBe('round')
  })
  it('only the host can kick, and only in the lobby', () => {
    const { room, join } = setup()
    join('a'); join('b'); join('c')
    expect(err(() => room.kick('b', 'c')).code).toBe('NOT_HOST')
    room.kick('a', 'c')
    expect(room.players.has('c')).toBe(false)
    room.start('a')
    expect(err(() => room.kick('a', 'b')).code).toBe('BAD_STATE')
  })
  it('hands the host role to the next player when the host leaves; removes the room when empty', () => {
    const t = setup(); const gone = []
    t.room.d.onEmpty = (c) => gone.push(c)
    t.join('a'); t.join('b')
    t.room.removePlayer('a')
    expect(t.room.hostId).toBe('b')
    t.room.removePlayer('b')
    expect(gone).toEqual(['ABC234'])
  })
  it('no one can join once the game has started', () => {
    const { room, join } = setup()
    join('a'); join('b'); room.start('a')
    expect(err(() => join('z')).code).toBe('GAME_IN_PROGRESS')
  })
})

describe('round 1: word chain with a server clock', () => {
  it('broadcasts round:start with endsAt = now + duration and serverTime', () => {
    const { room, join, last, clock } = setup()
    join('a'); join('b'); room.start('a')
    const r = last('round:start')
    expect(r).toMatchObject({ round: 1, totalRounds: 3, type: 'wordChain', seedWord: 'MOON', chainLetter: 'N', durationMs: 45000 })
    expect(r.endsAt).toBe(clock.now() + 45000)
    expect(r.serverTime).toBe(clock.now())
  })
  it('accepts a chain word, then requires the next word to start with its last letter', () => {
    const { room, join, last } = setup()
    join('a'); join('b'); room.start('a')
    expect(room.submitWord('a', 'nova')).toMatchObject({ status: 'accepted', provisional: true, nextLetter: 'A' })
    expect(room.submitWord('a', 'tea')).toMatchObject({ status: 'rejected', reason: "Doesn't start with A" })
    expect(room.submitWord('a', 'act')).toMatchObject({ status: 'accepted', nextLetter: 'T' })
    expect(last('score:update').scores.find((s) => s.playerId === 'a').roundScore).toBe(room.round.players.get('a').words.reduce((s, w) => s + w.points, 0))
  })
  it('rejects a repeated word, an unknown word, and words that are too short', () => {
    const { room, join } = setup()
    join('a'); join('b'); room.start('a')
    room.submitWord('a', 'nova')
    expect(room.submitWord('a', 'nova').reason).toBe('Already used')
    expect(room.submitWord('b', 'nzzz').reason).toBe('Not in dictionary')
    expect(room.submitWord('b', 'ne').reason).toBe('Too short (min 3)')
    expect(room.submitWord('b', 'moon').reason).toBe('Already used') // the seed word counts as used
  })
  it('rejects a word that arrives after endsAt even if the end timer has not fired yet', () => {
    const { room, join, clock } = setup()
    join('a'); join('b'); room.start('a')
    clock.t = room.round.endsAt // time passed, but timers did not run yet
    expect(room.submitWord('a', 'nova')).toMatchObject({ status: 'rejected', reason: 'Round not active' })
  })
  it('does not leak other players\' words in score updates', () => {
    const { room, join, last } = setup()
    join('a'); join('b'); room.start('a'); room.submitWord('a', 'nova')
    expect(JSON.stringify(last('score:update'))).not.toContain('nova')
  })
  it('a player not in the room cannot submit', () => {
    const { room, join } = setup()
    join('a'); join('b'); room.start('a')
    expect(err(() => room.submitWord('zzz', 'nova')).code).toBe('NOT_IN_ROOM')
  })
})

describe('round end: duplicates and elimination', () => {
  function playRound1() {
    const t = setup(); t.join('a'); t.join('b'); t.join('c'); t.room.start('a')
    return t
  }
  it('zeroes duplicate words across players and eliminates the lowest total after round 1', () => {
    const t = playRound1()
    t.room.submitWord('a', 'nova'); t.room.submitWord('b', 'nova') // duplicate
    t.room.submitWord('a', 'act')                                 // a: nova(dup)+act
    t.room.submitWord('b', 'ant')                                 // b: nova(dup)+ant
    t.room.submitWord('c', 'near')                                // c: near
    t.clock.advance(45000)
    const end = t.last('round:end')
    expect(end.duplicates).toEqual([{ word: 'nova', playerIds: ['a', 'b'] }])
    const score = (id) => end.finalScores.find((f) => f.playerId === id).roundScore
    expect(score('a')).toBe(5)   // act = 1+3+1
    expect(score('b')).toBe(3)   // ant = 1+1+1
    expect(score('c')).toBe(4)   // near = 1+1+1+1
    expect(end.eliminated.playerId).toBe('b')
    expect(end.tieBreak).toBeNull()
    expect(end.finalScores.find((f) => f.playerId === 'a').words.find((w) => w.word === 'nova')).toMatchObject({ points: 0, duplicate: true })
    expect(t.room.players.get('b').eliminated).toBe(true)
    expect(t.room.state).toBe('intermission')
  })
  it('explains a tie-break when totals are level', () => {
    const t = playRound1()
    t.room.submitWord('a', 'near'); t.clock.advance(1000)   // 4 points at +0s
    t.room.submitWord('b', 'nest'); t.clock.advance(1000)   // 4 points at +1s (later)
    t.room.submitWord('c', 'nap')                           // 5 points
    t.clock.advance(43000)
    const end = t.last('round:end')
    // a and b tie on total and round score; b reached it later, so b is eliminated
    expect(end.eliminated.playerId).toBe('b')
    expect(end.tieBreak.rule).toBe('speed')
    expect(end.tieBreak.text).toMatch(/later/)
  })
  it('eliminated players cannot submit and are not scored again', () => {
    const t = playRound1()
    t.room.submitWord('a', 'nova'); t.room.submitWord('b', 'nap'); t.clock.advance(45000)
    const out = t.last('round:end').eliminated.playerId
    t.clock.advance(5000) // intermission -> round 2
    expect(t.room.round.index).toBe(1)
    expect(t.room.submitWord(out, 'crate')).toMatchObject({ status: 'rejected', reason: 'You have been eliminated' })
  })
  it('runs round 2 then 3 on the server clock, intermission in between', () => {
    const t = playRound1()
    t.room.submitWord('a', 'nova'); t.room.submitWord('b', 'nap'); t.clock.advance(45000)
    expect(t.room.state).toBe('intermission')
    t.clock.advance(5000)
    expect(t.last('round:start')).toMatchObject({ round: 2, type: 'letterBuilder', letters: ['A', 'E', 'R', 'T', 'S', 'N', 'C'] })
    expect(t.room.submitWord('a', 'crate').status).toBe('accepted')
    expect(t.room.submitWord('b', 'moon').reason).toBe('Letter not available')
    t.clock.advance(60000)
    expect(t.last('round:end').round).toBe(2)
  })
})

describe('whole game', () => {
  it('4 players: eliminations after rounds 1 and 2, nobody after round 3 (2 players stay); result is published once', () => {
    const t = setup(); ;['a', 'b', 'c', 'd'].forEach(t.join); t.room.start('a')
    // R1 chain: a>b>c>d
    t.room.submitWord('a', 'nova'); t.room.submitWord('a', 'act'); t.room.submitWord('b', 'near'); t.room.submitWord('c', 'nap'); t.clock.advance(45000)
    expect(t.last('round:end').eliminated.playerId).toBe('d')
    t.clock.advance(5000)
    // R2 rack AERTSNC
    t.room.submitWord('a', 'cares'); t.room.submitWord('b', 'crate'); t.room.submitWord('c', 'ear'); t.clock.advance(60000)
    expect(t.last('round:end').eliminated.playerId).toBe('c')
    t.clock.advance(5000)
    // R3 speed: contains E, min 4
    t.room.submitWord('a', 'rate'); t.room.submitWord('a', 'tears'); t.room.submitWord('b', 'near'); t.clock.advance(20000)
    const end = t.last('game:end')
    expect(t.last('round:end')).toMatchObject({ round: 3, eliminated: null })  // only 2 left: nobody else is eliminated
    expect(end.reason).toBe('completed')
    expect(end.winnerId).toBe('a')
    expect(end.standings.map((s) => s.playerId)).toEqual(['a', 'b', 'c', 'd'])
    expect(end.standings.map((s) => s.eliminatedRound)).toEqual([null, null, 2, 1])
    expect(t.published).toHaveLength(1)
    expect(t.published[0].type).toBe('game.finished')
    expect(t.published[0].payload).toMatchObject({ roomCode: 'ABC234', winnerId: 'a', roundsPlayed: 3, totalRounds: 3 })
    expect(t.published[0].payload.players).toHaveLength(4)
    expect(t.room.state).toBe('finished')
  })
  it('two players: nobody is eliminated, all 3 rounds are played and the higher total wins', () => {
    const t = setup(); t.join('a'); t.join('b'); t.room.start('a')
    t.room.submitWord('a', 'nova'); t.clock.advance(45000)
    expect(t.last('round:end')).toMatchObject({ round: 1, eliminated: null })
    expect(t.room.state).toBe('intermission')
    t.clock.advance(5000); t.room.submitWord('a', 'cares'); t.clock.advance(60000)
    expect(t.last('round:end')).toMatchObject({ round: 2, eliminated: null })
    t.clock.advance(5000); t.clock.advance(20000)
    const end = t.last('game:end')
    expect(end.reason).toBe('completed')
    expect(end.winnerId).toBe('a')
    expect(end.standings.map((s) => s.eliminatedRound)).toEqual([null, null])
  })
  it('three players: one elimination after round 1, then the last two play on', () => {
    const t = setup(); ;['a', 'b', 'c'].forEach(t.join); t.room.start('a')
    t.room.submitWord('a', 'nova'); t.room.submitWord('b', 'near'); t.clock.advance(45000)
    expect(t.last('round:end').eliminated.playerId).toBe('c')
    t.clock.advance(5000); t.clock.advance(60000)
    expect(t.last('round:end')).toMatchObject({ round: 2, eliminated: null })
    expect(t.room.state).toBe('intermission')
  })
})

describe('speed round streak (3 players reach round 3 only with 4+, so test the rule directly)', () => {
  it('+2 per consecutive accepted word, reset by a rejected word', () => {
    const t = setup(); ;['a', 'b', 'c', 'd', 'e'].forEach(t.join); t.room.start('a')
    t.clock.advance(45000); t.clock.advance(5000); t.clock.advance(60000); t.clock.advance(5000)
    expect(t.room.round.def.type).toBe('speedRound')
    const alive = t.room.alive()[0].id
    const r1 = t.room.submitWord(alive, 'rate')
    const r2 = t.room.submitWord(alive, 'seat')
    const r3 = t.room.submitWord(alive, 'zzzz') // rejected: streak resets
    const r4 = t.room.submitWord(alive, 'tears')
    expect([r1.bonus, r2.bonus, r3.status, r4.bonus]).toEqual([0, 2, 'rejected', 0])
    expect(r2.streak).toBe(2); expect(r4.streak).toBe(1)
    expect(r2.points).toBe(1 + 1 + 1 + 1 + 2)
  })
})

describe('disconnect and reconnect', () => {
  it('keeps score and state for a player who comes back inside the grace period', () => {
    const t = setup(); t.join('a'); t.join('b'); t.join('c'); t.room.start('a')
    t.room.submitWord('b', 'nova')
    t.room.markDisconnected('b')
    expect(t.last('player:disconnected')).toEqual({ playerId: 'b', graceMs: 30000 })
    t.clock.advance(20000)
    t.room.reconnect('b', 'sock-b2')
    expect(t.last('player:reconnected')).toEqual({ playerId: 'b' })
    const state = t.events.filter((e) => e.to === 'sock-b2' && e.event === 'room:state').pop().data
    expect(state.me.words).toEqual([{ word: 'nova', points: 7 }])
    expect(state.me.chainLetter).toBe('A')
    expect(state.round.endsAt).toBe(t.room.round.endsAt)
    t.clock.advance(60000) // original grace timer must be gone
    expect(t.room.players.get('b').left).toBe(false)
    expect(t.room.players.get('b').total).toBe(7)
  })
  it('the round does not wait for a disconnected player', () => {
    const t = setup(); t.join('a'); t.join('b'); t.join('c'); t.room.start('a')
    t.room.markDisconnected('b')
    t.clock.advance(45000)
    expect(t.last('round:end').round).toBe(1)
  })
  it('a player who is gone past the grace period forfeits; if one player remains they win', () => {
    const t = setup(); t.join('a'); t.join('b'); t.room.start('a')
    t.room.markDisconnected('b')
    t.clock.advance(30000)
    expect(t.last('player:left')).toMatchObject({ playerId: 'b', reason: 'disconnected' })
    const end = t.last('game:end')
    expect(end).toMatchObject({ winnerId: 'a', reason: 'last_standing' })
    expect(end.standings.find((s) => s.playerId === 'b').left).toBe(true)
  })
  it('a lobby player who stays away is removed after the grace period', () => {
    const t = setup(); t.join('a'); t.join('b')
    t.room.markDisconnected('b'); t.clock.advance(30000)
    expect(t.room.players.has('b')).toBe(false)
  })
  it('the room is destroyed once everyone has left after the game ended', () => {
    const t = setup(); const gone = []; t.room.d.onEmpty = (c) => gone.push(c)
    t.join('a'); t.join('b'); t.room.start('a')
    t.room.removePlayer('a')            // b is the last one standing, game ends
    expect(t.room.state).toBe('finished')
    expect(gone).toEqual([])
    t.room.removePlayer('b')
    expect(gone).toEqual(['ABC234'])
    expect(t.published).toHaveLength(1)
  })
  it('a finished room is cleaned up after its TTL even if nobody leaves', () => {
    const t = setup(); const gone = []; t.room.d.onEmpty = (c) => gone.push(c)
    t.join('a'); t.join('b'); t.room.start('a'); t.room.submitWord('a', 'nova')
    t.clock.advance(45000); t.clock.advance(5000); t.clock.advance(60000); t.clock.advance(5000); t.clock.advance(20000)
    expect(t.room.state).toBe('finished')
    t.clock.advance(60000)
    expect(gone).toEqual(['ABC234'])
  })
})
