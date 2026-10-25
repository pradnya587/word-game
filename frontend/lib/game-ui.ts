import type { Tone } from '@/types'
import type { RoundType } from '@/types/game'

// Same letter values the server uses for scoring (shown in the corner of each tile).
const LETTER_VALUES: Record<string, number> = {
  a: 1, b: 3, c: 3, d: 2, e: 1, f: 4, g: 2, h: 4, i: 1, j: 8, k: 5, l: 1, m: 3,
  n: 1, o: 1, p: 3, q: 10, r: 1, s: 1, t: 1, u: 1, v: 4, w: 4, x: 8, y: 4, z: 10,
}
export const letterValue = (l: string) => LETTER_VALUES[l.toLowerCase()] ?? 1

const TONES: Tone[] = ['violet', 'cyan', 'coral', 'amber']
export const toneFor = (i: number): Tone => TONES[((i % 4) + 4) % 4]
export const toneForLetter = (l: string): Tone => TONES[l.toUpperCase().charCodeAt(0) % 4]

export const initials = (name: string) => name.replace(/[^A-Za-z0-9]/g, '').slice(0, 2).toUpperCase() || '?'

export const ROUND_NAMES: Record<RoundType, string> = { wordChain: 'Word chain', letterBuilder: 'Letter builder', speedRound: 'Speed round' }
export const ROUND_HINTS: Record<RoundType, string> = {
  wordChain: 'Every word starts with the last letter of your previous word.',
  letterBuilder: 'Build words from the shared letters. Each tile can be used once.',
  speedRound: 'Words must contain the highlighted letter. Chain words for a streak bonus.',
}
export const ROUND_ORDER: RoundType[] = ['wordChain', 'letterBuilder', 'speedRound']

export function fmtTime(ms: number) {
  const s = Math.ceil(ms / 1000)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

// sessionStorage key: an invite link was opened before logging in
export const PENDING_JOIN_KEY = 'wordroyale.pendingJoin'
