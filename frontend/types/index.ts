export type Tone = 'violet' | 'cyan' | 'coral' | 'amber'

export interface TileData {
  letter: string
  value: number
  tone: Tone
}

export interface LeaderboardPlayer {
  name: string
  initials: string
  score: number
  color: Tone
  rank: number
  streak: number
}

export interface User {
  id: string
  username: string
}

export interface Session {
  token: string
  user: User
}

export type AuthMode = 'login' | 'signup'
export type RoomMode = 'create' | 'join'
export type ModalType = AuthMode | RoomMode | null
