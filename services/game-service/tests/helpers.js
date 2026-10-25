const { createDictionary } = require('../src/dictionary')

// Deterministic clock: time only moves when the test says so.
class FakeClock {
  constructor(start = 1_000_000) { this.t = start; this.timers = []; this.seq = 0 }
  now() { return this.t }
  setTimeout(fn, ms) { const h = { id: ++this.seq, at: this.t + ms, fn }; this.timers.push(h); return h }
  clearTimeout(h) { this.timers = this.timers.filter((x) => x !== h) }
  advance(ms) {
    const target = this.t + ms
    for (;;) {
      const due = this.timers.filter((x) => x.at <= target).sort((a, b) => a.at - b.at || a.id - b.id)[0]
      if (!due) break
      this.timers = this.timers.filter((x) => x !== due)
      this.t = due.at
      due.fn()
    }
    this.t = target
  }
}

// Small dictionary so tests are predictable.
const WORDS = ['moon', 'nova', 'arc', 'cat', 'act', 'tea', 'eat', 'ate', 'tan', 'ant', 'nap', 'pan', 'ear', 'era', 'rat', 'art', 'tar', 'star', 'rate', 'tears', 'stare', 'aster', 'taser', 'earn', 'near', 'nest', 'sent', 'tens', 'tree', 'seat', 'east', 'eats', 'cares', 'crate', 'trace', 'react']
const makeDictionary = (extra = []) => createDictionary([...WORDS, ...extra])

const silent = { info() {}, warn() {}, error() {}, debug() {} }

const baseConfig = {
  minPlayers: 2, maxPlayers: 6, roundDurationsMs: [45000, 60000, 20000], intermissionMs: 5000,
  reconnectGraceMs: 30000, finishedRoomTtlMs: 60000, rackSize: 7, wordSubmitsPerSecond: 1000,
  jwtSecret: 'test-secret', corsOrigin: '*',
}

// Fixed rounds: chain from "moon" (needs N), rack AERTSNC, speed = contains E, min 4.
const fixedRound = (index) => {
  if (index === 0) return { type: 'wordChain', durationMs: baseConfig.roundDurationsMs[0], minLength: 3, seedWord: 'moon', chainLetter: 'n', public: { type: 'wordChain', minLength: 3, seedWord: 'MOON', chainLetter: 'N' } }
  if (index === 1) {
    const letters = [...'aertsnc']; const rackCounts = {}; for (const l of letters) rackCounts[l] = (rackCounts[l] || 0) + 1
    return { type: 'letterBuilder', durationMs: baseConfig.roundDurationsMs[1], minLength: 3, letters, rackCounts, public: { type: 'letterBuilder', minLength: 3, letters: letters.map((l) => l.toUpperCase()) } }
  }
  return { type: 'speedRound', durationMs: baseConfig.roundDurationsMs[2], minLength: 4, constraint: { contains: 'e', minLength: 4 }, public: { type: 'speedRound', minLength: 4, constraint: { contains: 'E', minLength: 4 } } }
}

module.exports = { FakeClock, makeDictionary, silent, baseConfig, fixedRound }
