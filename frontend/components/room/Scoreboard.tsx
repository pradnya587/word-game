import { Crown, Flame, X } from 'lucide-react'
import { initials, toneFor } from '@/lib/game-ui'
import type { RoomPhase, RoomPlayer, ScoreRow } from '@/types/game'

interface Props {
  players: RoomPlayer[]
  scores: ScoreRow[]
  myId: string | null
  phase: RoomPhase
  offline: Record<string, number>
}

const MIN_ALIVE = 2 // the server stops eliminating when this many players are left

// Live standings. During a round the numbers are provisional: duplicate words are only zeroed when the round ends.
export default function Scoreboard({ players, scores, myId, phase, offline }: Props) {
  const rows = players
    .map((p, i) => ({ p, i, total: scores.find((s) => s.playerId === p.id)?.total ?? p.totalScore }))
    .sort((a, b) => Number(a.p.eliminated) - Number(b.p.eliminated) || b.total - a.total || a.i - b.i)

  const alive = rows.filter((r) => !r.p.eliminated)
  const danger = phase === 'round' && alive.length > MIN_ALIVE ? alive[alive.length - 1]?.p.id : null

  return (
    <aside className="score-panel" aria-label="Scoreboard">
      <div className="score-head">
        <p className="eyebrow">LIVE SCOREBOARD</p>
        {phase === 'round' && <span className="prov-tag" title="Duplicate words are resolved when the round ends">provisional</span>}
      </div>
      <ol className="score-list" aria-live="polite">
        {rows.map(({ p, i, total }, rank) => (
          <li key={p.id} className={`score-row ${p.id === myId ? 'me' : ''} ${p.eliminated ? 'out' : ''} ${p.id === danger ? 'danger' : ''}`}>
            <span className="score-rank">{p.eliminated ? <X size={13} /> : rank === 0 ? <Crown size={14} fill="currentColor" /> : String(rank + 1).padStart(2, '0')}</span>
            <span className={`avatar avatar-${toneFor(i)}`}>{initials(p.username)}</span>
            <span className="score-name">
              <b>{p.username}</b>
              {p.id === myId && <small className="you-tag">YOU</small>}
              {p.eliminated && <small className="out-tag">out · R{p.eliminatedRound}</small>}
              {!p.eliminated && (!p.connected || offline[p.id]) && <small className="out-tag">reconnecting</small>}
              {p.id === danger && <small className="danger-tag"><Flame size={10} /> danger</small>}
            </span>
            <span className="score-total">{total}</span>
          </li>
        ))}
      </ol>
      {phase === 'round' && alive.length > MIN_ALIVE && <p className="score-note">The lowest score is eliminated when the round ends.</p>}
    </aside>
  )
}
