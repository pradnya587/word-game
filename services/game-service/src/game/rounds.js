// The three rounds of a game, in order. Each round type knows how to set itself up
// and which rule a submitted word must satisfy (besides being in the dictionary).

const ROUND_TYPES = ['wordChain', 'letterBuilder', 'speedRound']

// Common words that end in a friendly letter, used to start the word chain.
const SEED_WORDS = ['moon', 'star', 'tree', 'lake', 'wind', 'fire', 'rain', 'sand', 'bird', 'gold', 'home', 'tide', 'dawn', 'dust', 'hill', 'mint']

// Scrabble-like letter frequencies for the Letter Builder rack.
const RACK_BAG = 'aaaaaaaaabbccddddeeeeeeeeeeeeffggghhiiiiiiiiijkllllmmnnnnnnooooooooppqrrrrrrssssttttttuuuuvvwwxyyz'
const VOWELS = new Set('aeiou')
const SPEED_LETTERS = 'aeiorstlndcmpgbh'

const pick = (arr, rng) => arr[Math.floor(rng() * arr.length)]

function countLetters(str) {
  const m = {}
  for (const ch of str) m[ch] = (m[ch] || 0) + 1
  return m
}

// Can `word` be made from the letters in `rack` (each tile used at most once)?
function canBuild(word, rackCounts) {
  const used = {}
  for (const ch of word) {
    used[ch] = (used[ch] || 0) + 1
    if (used[ch] > (rackCounts[ch] || 0)) return false
  }
  return true
}

function countFormable(dictionary, rack, limit = Infinity) {
  const counts = countLetters(rack)
  let n = 0
  for (const w of dictionary.words) {
    if (w.length < 3 || w.length > rack.length) continue
    if (canBuild(w, counts)) { n++; if (n >= limit) break }
  }
  return n
}

// A playable rack: 2-4 vowels and enough possible words so the round is fun.
function generateRack(size, dictionary, rng, minWords = 12) {
  let best = null
  let bestCount = -1
  for (let attempt = 0; attempt < 25; attempt++) {
    const letters = Array.from({ length: size }, () => RACK_BAG[Math.floor(rng() * RACK_BAG.length)])
    const vowels = letters.filter((l) => VOWELS.has(l)).length
    if (vowels < 2 || vowels > 4) continue
    const count = countFormable(dictionary, letters.join(''), minWords)
    if (count >= minWords) return letters
    if (count > bestCount) { best = letters; bestCount = count }
  }
  return best || Array.from({ length: size }, (_, i) => 'aeirstnl'[i % 8])
}

/**
 * Set up round `index` (0..2). Returns:
 *  { type, durationMs, minLength, public: {...sent to clients...}, rackCounts? }
 */
function createRound(index, { rng, dictionary, config }) {
  const type = ROUND_TYPES[index]
  const durationMs = config.roundDurationsMs[index]
  if (type === 'wordChain') {
    const seedWord = pick(SEED_WORDS, rng)
    const chainLetter = seedWord[seedWord.length - 1]
    return { type, durationMs, minLength: 3, seedWord, chainLetter,
      public: { type, minLength: 3, seedWord: seedWord.toUpperCase(), chainLetter: chainLetter.toUpperCase() } }
  }
  if (type === 'letterBuilder') {
    const letters = generateRack(config.rackSize, dictionary, rng)
    return { type, durationMs, minLength: 3, letters, rackCounts: countLetters(letters.join('')),
      public: { type, minLength: 3, letters: letters.map((l) => l.toUpperCase()) } }
  }
  const letter = pick([...SPEED_LETTERS], rng)
  const minLength = rng() < 0.5 ? 4 : 5
  return { type, durationMs, minLength, constraint: { contains: letter, minLength },
    public: { type, minLength, constraint: { contains: letter.toUpperCase(), minLength } } }
}

// Per-player state at the start of a round.
function newPlayerRoundState(def) {
  return {
    words: [],                        // accepted words: { word, points, at }
    used: new Set(def.seedWord ? [def.seedWord] : []),
    streak: 0,
    chainLetter: def.chainLetter || null,
  }
}

// Round-specific rule. Returns a reason string if the word breaks it, otherwise null.
function checkRule(def, state, word) {
  if (word.length < def.minLength) return `Too short (min ${def.minLength})`
  if (def.type === 'wordChain' && word[0] !== state.chainLetter) return `Doesn't start with ${state.chainLetter.toUpperCase()}`
  if (def.type === 'letterBuilder' && !canBuild(word, def.rackCounts)) return 'Letter not available'
  if (def.type === 'speedRound' && !word.includes(def.constraint.contains)) return `Must contain ${def.constraint.contains.toUpperCase()}`
  return null
}

module.exports = { ROUND_TYPES, SEED_WORDS, createRound, newPlayerRoundState, checkRule, canBuild, countFormable, generateRack }
