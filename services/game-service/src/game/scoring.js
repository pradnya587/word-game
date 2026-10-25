// Pure scoring functions — no I/O, no clocks, easy to unit test.

const LETTER_VALUES = {
  a: 1, b: 3, c: 3, d: 2, e: 1, f: 4, g: 2, h: 4, i: 1, j: 8, k: 5, l: 1, m: 3,
  n: 1, o: 1, p: 3, q: 10, r: 1, s: 1, t: 1, u: 1, v: 4, w: 4, x: 8, y: 4, z: 10,
}

const letterValue = (ch) => LETTER_VALUES[ch.toLowerCase()] ?? 0

function lengthBonus(len) {
  if (len >= 8) return 10
  if (len === 7) return 7
  if (len === 6) return 4
  if (len === 5) return 2
  return 0
}

// points = sum of letter values + length bonus
function wordPoints(word) {
  const w = word.toLowerCase()
  let sum = 0
  for (const ch of w) sum += letterValue(ch)
  return sum + lengthBonus(w.length)
}

// Speed round: +2 per consecutive accepted word after the first, capped at +10.
function streakBonus(streak) {
  return Math.min(Math.max(streak - 1, 0), 5) * 2
}

/**
 * Duplicate detection at the end of a round.
 * A word accepted for two or more different players scores 0 for all of them.
 * input:  [{ playerId, words: [{ word, points, at }] }]
 * output: { duplicates: [{ word, playerIds }], results: Map(playerId -> { roundScore, lastScoreAt, words: [{word, points, base, duplicate, at}] }) }
 */
function resolveDuplicates(entries) {
  const owners = new Map() // word -> Set(playerId)
  for (const { playerId, words } of entries) {
    for (const { word } of words) {
      if (!owners.has(word)) owners.set(word, new Set())
      owners.get(word).add(playerId)
    }
  }
  const duplicates = []
  for (const [word, ids] of owners) if (ids.size > 1) duplicates.push({ word, playerIds: [...ids] })
  const dupWords = new Set(duplicates.map((d) => d.word))

  const results = new Map()
  for (const { playerId, words } of entries) {
    let roundScore = 0
    let lastScoreAt = Infinity // no scoring word = "never scored" (worst for tie-breaks)
    const out = words.map((w) => {
      const duplicate = dupWords.has(w.word)
      const points = duplicate ? 0 : w.points
      roundScore += points
      if (points > 0) lastScoreAt = lastScoreAt === Infinity ? w.at : Math.max(lastScoreAt, w.at)
      return { word: w.word, points, base: w.points, duplicate, at: w.at }
    })
    results.set(playerId, { roundScore, lastScoreAt, words: out })
  }
  return { duplicates, results }
}

/**
 * Who is the "worse" player? Used for elimination and for ranking.
 * Order of tie-breaks (documented for the UI):
 *   1. lower TOTAL score is worse
 *   2. lower score THIS ROUND is worse
 *   3. the player who reached their last scoring word LATER is worse
 *   4. the player who joined the room LATER is worse
 *   5. id (so the result is always deterministic)
 * Returns negative if a is worse than b.
 */
function compareWorse(a, b) {
  if (a.total !== b.total) return a.total - b.total
  if (a.roundScore !== b.roundScore) return a.roundScore - b.roundScore
  if (a.lastScoreAt !== b.lastScoreAt) return a.lastScoreAt > b.lastScoreAt ? -1 : 1
  if (a.joinedAt !== b.joinedAt) return a.joinedAt > b.joinedAt ? -1 : 1
  return a.id < b.id ? -1 : 1
}

/**
 * players: [{ id, total, roundScore, lastScoreAt, joinedAt }] (only players still alive)
 * returns { id, tieBreak } where tieBreak is null, 'roundScore', 'speed' or 'joinOrder'
 * and says which rule broke a tie on total score.
 */
function pickEliminated(players) {
  if (players.length === 0) return null
  const sorted = [...players].sort(compareWorse)
  const worst = sorted[0]
  let tieBreak = null
  const next = sorted[1]
  if (next && next.total === worst.total) {
    if (next.roundScore !== worst.roundScore) tieBreak = 'roundScore'
    else if (next.lastScoreAt !== worst.lastScoreAt) tieBreak = 'speed'
    else tieBreak = 'joinOrder'
  }
  return { id: worst.id, tieBreak }
}

const TIE_BREAK_TEXT = {
  roundScore: 'Tied on total score: the lower score this round is eliminated.',
  speed: 'Tied on total and round score: the player who reached their score later is eliminated.',
  joinOrder: 'Still tied: the player who joined the room later is eliminated.',
}

/**
 * Final standings. Survivors first (best total first), then eliminated players
 * (eliminated later = better rank).
 * players: [{ id, total, roundScore, lastScoreAt, joinedAt, eliminatedRound|null }]
 */
function buildStandings(players) {
  const survivors = players.filter((p) => !p.eliminatedRound).sort((a, b) => compareWorse(b, a))
  const out = players.filter((p) => p.eliminatedRound).sort((a, b) => {
    if (a.eliminatedRound !== b.eliminatedRound) return b.eliminatedRound - a.eliminatedRound
    return compareWorse(b, a)
  })
  return [...survivors, ...out].map((p, i) => ({ ...p, rank: i + 1 }))
}

module.exports = { LETTER_VALUES, letterValue, lengthBonus, wordPoints, streakBonus, resolveDuplicates, compareWorse, pickEliminated, buildStandings, TIE_BREAK_TEXT }
