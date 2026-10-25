import { Crown, Skull } from 'lucide-react'
import { initials, ROUND_NAMES, toneFor } from '@/lib/game-ui'
import { useLocalRemaining } from '@/hooks/useRoom'
import type { RoomPlayer, RoundEnd } from '@/types/game'

interface Props { end: RoundEnd; players: RoomPlayer[]; myId: string; nextRoundAt: number | null }

// Shown between rounds: duplicates, the round scores, and who was eliminated.
export default function RoundEndOverlay({ end, players, myId, nextRoundAt }: Props) {
  const left = useLocalRemaining(nextRoundAt)
  const byId = new Map(players.map((p, i) => [p.id, { p, i }]))
  const name = (id: string) => byId.get(id)?.p.username ?? 'Player'
  const rows = [...end.finalScores].sort((a, b) => b.total - a.total)
  const outId = end.eliminated?.playerId
  const iAmOut = outId === myId
  const alive = end.survivors.length

  return (
    <div className="overlay" role="dialog" aria-modal="true" aria-label={`Round ${end.round} complete`}>
      <div className="overlay-card">
        <p className="eyebrow"><span className="live-dot" /> ROUND {end.round} COMPLETE · {ROUND_NAMES[end.type].toUpperCase()}</p>

        {end.eliminated ? (
          <div className={`elim-card ${iAmOut ? 'me' : ''}`}>
            <span className={`avatar avatar-${toneFor(byId.get(end.eliminated.playerId)?.i ?? 0)} avatar-lg`}>{initials(end.eliminated.username)}</span>
            <div>
              <h3>{iAmOut ? 'You were eliminated' : `${end.eliminated.username} is eliminated`}</h3>
              <p>{iAmOut ? 'Good game! You can stay and watch the rest of the match.' : 'Lowest score this round — they are out of the game.'}</p>
              {end.tieBreak && <p className="tie-note">{end.tieBreak.text}</p>}
            </div>
            <span className="elim-stamp"><Skull size={13} /> OUT</span>
          </div>
        ) : (
          <div className="elim-card safe"><div><h3>No one is eliminated</h3><p>Only {alive} players are left, so everyone plays on to the final round.</p></div></div>
        )}

        <div className="overlay-grid">
          <ol className="end-scores">
            {rows.map((r, rank) => (
              <li key={r.playerId} className={`${r.playerId === myId ? 'me' : ''} ${r.playerId === outId ? 'out' : ''}`}>
                <span className="score-rank">{rank === 0 ? <Crown size={14} fill="currentColor" /> : String(rank + 1).padStart(2, '0')}</span>
                <span className={`avatar avatar-${toneFor(byId.get(r.playerId)?.i ?? 0)}`}>{initials(name(r.playerId))}</span>
                <b>{name(r.playerId)}</b>
                <span className="end-round">+{r.roundScore}</span>
                <span className="score-total">{r.total}</span>
              </li>
            ))}
          </ol>

          <div className="dupes">
            <p className="eyebrow">DUPLICATE WORDS · 0 POINTS</p>
            {end.duplicates.length === 0 ? <p className="dupes-empty">No duplicates this round.</p> : (
              <ul>
                {end.duplicates.slice(0, 8).map((d) => (
                  <li key={d.word}><s>{d.word.toUpperCase()}</s><span>{d.playerIds.map(name).join(', ')}</span></li>
                ))}
              </ul>
            )}
          </div>
        </div>

        {left > 0 && <p className="next-round">Next round in {Math.ceil(left / 1000)}s…</p>}
      </div>
    </div>
  )
}
