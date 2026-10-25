// Shapes of the data game-service sends over Socket.IO (see docs/events.md).
export type RoomPhase = 'lobby' | 'round' | 'intermission' | 'finished'
export type RoundType = 'wordChain' | 'letterBuilder' | 'speedRound'

export interface RoomPlayer {
  id: string
  username: string
  guest: boolean
  isHost: boolean
  ready: boolean
  connected: boolean
  eliminated: boolean
  eliminatedRound: number | null
  totalScore: number
}

export interface RoundInfo {
  round: number
  totalRounds: number
  type: RoundType
  minLength: number
  durationMs: number
  startedAt: number
  endsAt: number
  serverTime: number
  seedWord?: string
  chainLetter?: string
  letters?: string[]
  constraint?: { contains: string; minLength: number }
}

export interface RoomState {
  code: string
  state: RoomPhase
  hostId: string
  config: { minPlayers: number; maxPlayers: number; totalRounds: number }
  players: RoomPlayer[]
  round: RoundInfo | null
  serverTime: number
  me?: { playerId: string; words: { word: string; points: number }[]; chainLetter: string | null; streak: number }
}

export interface ScoreRow { playerId: string; roundScore: number; total: number }

export interface WordResult {
  word: string
  status: 'accepted' | 'rejected'
  points: number
  bonus?: number
  reason?: string
  nextLetter?: string
  streak?: number
}

export interface MyWord { word: string; status: 'accepted' | 'rejected'; points: number; reason?: string }

export interface RoundEnd {
  round: number
  type: RoundType
  duplicates: { word: string; playerIds: string[] }[]
  finalScores: { playerId: string; roundScore: number; total: number; words: { word: string; points: number; duplicate: boolean }[] }[]
  eliminated: { playerId: string; username: string } | null
  tieBreak: { rule: string; text: string } | null
  survivors: string[]
  nextRoundInMs: number
  serverTime: number
}

export interface Standing {
  rank: number
  playerId: string
  username: string
  guest: boolean
  totalScore: number
  eliminatedRound: number | null
  bestWord: string | null
  bestWordPoints: number
  wordsCount: number
  left: boolean
}

export interface GameEnd { standings: Standing[]; winnerId: string | null; reason: 'completed' | 'last_standing'; serverTime: number }

export interface Ack { ok: boolean; error?: string; message?: string; code?: string }
export interface StateAck extends Ack { state?: RoomState }
