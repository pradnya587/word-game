import { Crown, Radio, Users, Zap } from 'lucide-react'
import type { LeaderboardPlayer, TileData } from '@/types'

export const heroTiles: TileData[] = [
  { letter: 'W', value: 4, tone: 'violet' },
  { letter: 'O', value: 1, tone: 'cyan' },
  { letter: 'R', value: 1, tone: 'coral' },
  { letter: 'D', value: 2, tone: 'amber' },
  { letter: 'R', value: 1, tone: 'violet' },
  { letter: 'O', value: 1, tone: 'cyan' },
  { letter: 'Y', value: 4, tone: 'coral' },
  { letter: 'A', value: 1, tone: 'amber' },
  { letter: 'L', value: 1, tone: 'violet' },
  { letter: 'E', value: 1, tone: 'cyan' },
]

export const rackTiles: TileData[] = [
  { letter: 'S', value: 1, tone: 'violet' },
  { letter: 'T', value: 1, tone: 'cyan' },
  { letter: 'A', value: 1, tone: 'coral' },
  { letter: 'R', value: 1, tone: 'amber' },
  { letter: 'E', value: 1, tone: 'cyan' },
  { letter: 'D', value: 2, tone: 'violet' },
  { letter: 'N', value: 1, tone: 'coral' },
]

export const leaderboardPlayers: LeaderboardPlayer[] = [
  { name: 'you', initials: 'YO', score: 842, color: 'violet', rank: 1, streak: 12 },
  { name: 'Mira Chen', initials: 'MC', score: 791, color: 'cyan', rank: 2, streak: 8 },
  { name: 'Theo B.', initials: 'TB', score: 734, color: 'coral', rank: 3, streak: 5 },
  { name: 'Luna K.', initials: 'LK', score: 688, color: 'amber', rank: 4, streak: 5 },
]

export const steps = [
  { n: '01', icon: Users, title: 'Gather your crew', text: 'Create a private room and invite up to five friends with a shareable code.' },
  { n: '02', icon: Zap, title: 'Find your flow', text: 'Build words against the clock. Think fast, play bold, stay in the game.' },
  { n: '03', icon: Radio, title: 'Survive the rounds', text: 'The lowest scorer gets eliminated after every round.' },
  { n: '04', icon: Crown, title: 'Claim the crown', text: 'Outspell everyone and become the wordRoyale champion.' },
]
