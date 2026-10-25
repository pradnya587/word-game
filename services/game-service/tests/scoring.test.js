const s = require('../src/game/scoring')

describe('wordPoints', () => {
  it('sums letter values', () => { expect(s.wordPoints('cat')).toBe(3 + 1 + 1) })
  it('adds a length bonus', () => {
    expect(s.lengthBonus(4)).toBe(0); expect(s.lengthBonus(5)).toBe(2); expect(s.lengthBonus(6)).toBe(4)
    expect(s.lengthBonus(7)).toBe(7); expect(s.lengthBonus(8)).toBe(10); expect(s.lengthBonus(12)).toBe(10)
    expect(s.wordPoints('stare')).toBe(1 + 1 + 1 + 1 + 1 + 2)
  })
  it('is case-insensitive and scores Q/Z high', () => { expect(s.wordPoints('QUIZ')).toBe(10 + 1 + 1 + 10) })
})

describe('streakBonus', () => {
  it('is 0 for the first word, +2 per extra word, capped at 10', () => {
    expect([1, 2, 3, 4, 5, 6, 7, 20].map(s.streakBonus)).toEqual([0, 2, 4, 6, 8, 10, 10, 10])
    expect(s.streakBonus(0)).toBe(0)
  })
})

describe('resolveDuplicates', () => {
  const entries = [
    { playerId: 'a', words: [{ word: 'cat', points: 5, at: 1000 }, { word: 'tea', points: 3, at: 2000 }] },
    { playerId: 'b', words: [{ word: 'cat', points: 5, at: 1500 }, { word: 'nap', points: 5, at: 3000 }] },
    { playerId: 'c', words: [] },
  ]
  const { duplicates, results } = s.resolveDuplicates(entries)
  it('zeroes a word submitted by two different players, for both', () => {
    expect(duplicates).toEqual([{ word: 'cat', playerIds: ['a', 'b'] }])
    expect(results.get('a').roundScore).toBe(3)
    expect(results.get('b').roundScore).toBe(5)
    expect(results.get('a').words.find((w) => w.word === 'cat')).toMatchObject({ points: 0, base: 5, duplicate: true })
  })
  it('tracks when each player last scored (duplicates do not count)', () => {
    expect(results.get('a').lastScoreAt).toBe(2000)
    expect(results.get('b').lastScoreAt).toBe(3000)
    expect(results.get('c').lastScoreAt).toBe(Infinity)
    expect(results.get('c').roundScore).toBe(0)
  })
  it('does not mutate its input', () => { expect(entries[0].words[0].points).toBe(5) })
})

describe('pickEliminated', () => {
  const P = (id, total, roundScore, lastScoreAt, joinedAt) => ({ id, total, roundScore, lastScoreAt, joinedAt })
  it('eliminates the lowest total, no tie-break needed', () => {
    expect(s.pickEliminated([P('a', 30, 10, 1, 1), P('b', 12, 12, 1, 2), P('c', 20, 5, 1, 3)])).toEqual({ id: 'b', tieBreak: null })
  })
  it('breaks a total tie by lower round score', () => {
    expect(s.pickEliminated([P('a', 20, 10, 1, 1), P('b', 20, 4, 1, 2), P('c', 40, 5, 1, 3)])).toEqual({ id: 'b', tieBreak: 'roundScore' })
  })
  it('then by who reached their score later', () => {
    expect(s.pickEliminated([P('a', 20, 10, 5000, 1), P('b', 20, 10, 9000, 2), P('c', 40, 5, 1, 3)])).toEqual({ id: 'b', tieBreak: 'speed' })
  })
  it('a player who never scored loses the speed tie-break', () => {
    expect(s.pickEliminated([P('a', 0, 0, Infinity, 1), P('b', 0, 0, 4000, 2)]).id).toBe('a')
  })
  it('then by later join order, and is always deterministic', () => {
    expect(s.pickEliminated([P('a', 20, 10, 5000, 1), P('b', 20, 10, 5000, 2)])).toEqual({ id: 'b', tieBreak: 'joinOrder' })
    expect(s.pickEliminated([P('b', 20, 10, 5000, 2), P('a', 20, 10, 5000, 1)])).toEqual({ id: 'b', tieBreak: 'joinOrder' })
  })
  it('returns null for nobody', () => { expect(s.pickEliminated([])).toBeNull() })
})

describe('buildStandings', () => {
  it('ranks survivors by score, then eliminated players (later elimination = better)', () => {
    const P = (id, total, elim, joinedAt = 1) => ({ id, total, roundScore: 0, lastScoreAt: 1, joinedAt, eliminatedRound: elim })
    const st = s.buildStandings([P('e1', 90, 1), P('s1', 50, null), P('e2', 10, 2), P('s2', 70, null)])
    expect(st.map((x) => x.id)).toEqual(['s2', 's1', 'e2', 'e1'])
    expect(st.map((x) => x.rank)).toEqual([1, 2, 3, 4])
  })
})
