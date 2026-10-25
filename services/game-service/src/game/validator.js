const { checkRule } = require('./rounds')

/**
 * Server-side word validation. Fails fast and returns a reason the UI can show.
 * Order: format -> already used -> round rule (length / chain / rack / constraint) -> dictionary.
 */
function validateWord(raw, def, state, dictionary) {
  const word = String(raw ?? '').trim().toLowerCase()
  if (!/^[a-z]+$/.test(word) || word.length > 15) return { ok: false, word, reason: 'Letters only' }
  if (state.used.has(word)) return { ok: false, word, reason: 'Already used' }
  const ruleReason = checkRule(def, state, word)
  if (ruleReason) return { ok: false, word, reason: ruleReason }
  if (!dictionary.has(word)) return { ok: false, word, reason: 'Not in dictionary' }
  return { ok: true, word }
}

module.exports = { validateWord }
