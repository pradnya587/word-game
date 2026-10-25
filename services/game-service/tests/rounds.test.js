const rounds = require('../src/game/rounds')
const { validateWord } = require('../src/game/validator')
const { makeDictionary, baseConfig, fixedRound } = require('./helpers')

const dict = makeDictionary()
const seq = (...values) => { let i = 0; return () => values[i++ % values.length] }

describe('createRound', () => {
  it('builds the three rounds in order with the configured durations', () => {
    const ctx = { rng: Math.random, dictionary: require('../src/dictionary').loadDictionary(require('path').join(__dirname, '..', 'data', 'words.txt')), config: baseConfig }
    const [a, b, c] = [0, 1, 2].map((i) => rounds.createRound(i, ctx))
    expect([a.type, b.type, c.type]).toEqual(['wordChain', 'letterBuilder', 'speedRound'])
    expect([a.durationMs, b.durationMs, c.durationMs]).toEqual([45000, 60000, 20000])
    expect(a.seedWord).toHaveLength(4)
    expect(a.chainLetter).toBe(a.seedWord.at(-1))
    expect(b.letters).toHaveLength(7)
    expect(rounds.countFormable(ctx.dictionary, b.letters.join(''))).toBeGreaterThanOrEqual(1)
    expect(c.constraint.contains).toMatch(/^[a-z]$/)
    expect([4, 5]).toContain(c.constraint.minLength)
  })
  it('every seed word is a real word', () => {
    const real = require('../src/dictionary').loadDictionary(require('path').join(__dirname, '..', 'data', 'words.txt'))
    for (const w of rounds.SEED_WORDS) expect(real.has(w)).toBe(true)
  })
  it('only ever hands clients uppercase public data (no rack counts, no dictionary)', () => {
    const r = rounds.createRound(1, { rng: seq(0.1, 0.5), dictionary: dict, config: baseConfig })
    expect(Object.keys(r.public)).toEqual(['type', 'minLength', 'letters'])
    expect(r.public.letters.every((l) => l === l.toUpperCase())).toBe(true)
  })
})

describe('canBuild', () => {
  const counts = { a: 1, e: 1, r: 2, t: 1 }
  it('respects how many of each tile exist', () => {
    expect(rounds.canBuild('rate', counts)).toBe(true)
    expect(rounds.canBuild('tear', counts)).toBe(true)
    expect(rounds.canBuild('rarer', counts)).toBe(false)
    expect(rounds.canBuild('eat', counts)).toBe(true)
    expect(rounds.canBuild('tee', counts)).toBe(false)
  })
})

describe('validateWord', () => {
  const state = (def, extra = {}) => ({ ...rounds.newPlayerRoundState(def), ...extra })

  it('word chain: must start with the chain letter, not reuse the seed, and be in the dictionary', () => {
    const def = fixedRound(0); const st = state(def)
    expect(validateWord('nova', def, st, dict)).toEqual({ ok: true, word: 'nova' })
    expect(validateWord('cat', def, st, dict)).toMatchObject({ ok: false, reason: "Doesn't start with N" })
    expect(validateWord('nzzz', def, st, dict)).toMatchObject({ ok: false, reason: 'Not in dictionary' })
    expect(validateWord('na', def, st, dict)).toMatchObject({ ok: false, reason: 'Too short (min 3)' })
    expect(validateWord('moon', def, { ...st, chainLetter: 'm' }, dict)).toMatchObject({ ok: false, reason: 'Already used' })
  })
  it('letter builder: only letters from the rack', () => {
    const def = fixedRound(1); const st = state(def)
    expect(validateWord('crate', def, st, dict).ok).toBe(true)
    expect(validateWord('moon', def, st, dict)).toMatchObject({ ok: false, reason: 'Letter not available' })
    expect(validateWord('tree', def, st, dict)).toMatchObject({ ok: false, reason: 'Letter not available' }) // only one E
  })
  it('speed round: min length and required letter', () => {
    const def = fixedRound(2); const st = state(def)
    expect(validateWord('star', def, st, dict)).toMatchObject({ ok: false, reason: 'Must contain E' })
    expect(validateWord('ant', def, st, dict)).toMatchObject({ ok: false, reason: 'Too short (min 4)' })
    expect(validateWord('rate', def, st, dict).ok).toBe(true)
  })
  it('normalises case/whitespace and rejects non-letters', () => {
    const def = fixedRound(1); const st = state(def)
    expect(validateWord('  CRATE ', def, st, dict)).toEqual({ ok: true, word: 'crate' })
    expect(validateWord('cr4te', def, st, dict)).toMatchObject({ ok: false, reason: 'Letters only' })
    expect(validateWord('', def, st, dict)).toMatchObject({ ok: false, reason: 'Letters only' })
    expect(validateWord(null, def, st, dict).ok).toBe(false)
  })
  it('rejects a word the player already used this round', () => {
    const def = fixedRound(1); const st = state(def); st.used.add('crate')
    expect(validateWord('crate', def, st, dict)).toMatchObject({ ok: false, reason: 'Already used' })
  })
})
