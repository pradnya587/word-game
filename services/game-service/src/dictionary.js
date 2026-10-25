const fs = require('fs')

// The dictionary is a plain word list held in memory (a Set) — validation is an O(1) lookup, no network call.
function createDictionary(words) {
  const list = []
  const set = new Set()
  for (const raw of words) {
    const w = String(raw).trim().toLowerCase()
    if (/^[a-z]{2,15}$/.test(w) && !set.has(w)) { set.add(w); list.push(w) }
  }
  return { has: (w) => set.has(w), words: list, size: set.size }
}

function loadDictionary(path) {
  return createDictionary(fs.readFileSync(path, 'utf8').split('\n'))
}

module.exports = { createDictionary, loadDictionary }
