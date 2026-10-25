import { Crown, Home, RotateCcw } from 'lucide-react'
import Background from '@/components/layout/Background'
import Logo from '@/components/layout/Logo'
import { initials, toneFor } from '@/lib/game-ui'
import type { Standing } from '@/types/game'

interface Props { standings: Standing[]; tones: Record<string, number>; myId: string; reason?: 'completed' | 'last_standing'; busy: boolean; onHome: () => void; onAgain: () => void }

export default function Results({ standings, tones, myId, reason, busy, onHome, onAgain }: Props) {
  const winner = standings[0]
  const iWon = winner?.playerId === myId
  const podium = [standings[1], standings[0], standings[2]] // 2nd, 1st, 3rd
  const best = [...standings].sort((a, b) => b.bestWordPoints - a.bestWordPoints)[0]
  const most = [...standings].sort((a, b) => b.wordsCount - a.wordsCount)[0]

  return (
    <main className="site-shell game-shell">
      <Background />
      <header className="topbar"><Logo /></header>
      <section className="results-main section-pad">
        <p className="eyebrow"><span className="live-dot" /> GAME OVER{reason === 'last_standing' ? ' · LAST PLAYER STANDING' : ''}</p>
        <h2 className="room-title">{iWon ? <>You take the <em>crown.</em></> : <><em>{winner?.username}</em> takes the crown.</>}</h2>

        <div className="podium" aria-label="Podium">
          {podium.map((s, i) => s ? (
            <div key={s.playerId} className={`podium-col place-${s.rank} ${s.playerId === myId ? 'me' : ''}`}>
              <span className={`avatar avatar-${toneFor(tones[s.playerId] ?? 0)} avatar-lg`}>{initials(s.username)}</span>
              {s.rank === 1 && <Crown size={22} fill="currentColor" className="podium-crown" />}
              <b>{s.username}</b>
              <span className="podium-score">{s.totalScore}</span>
              <div className="podium-block"><span>{s.rank}</span></div>
            </div>
          ) : <div key={`empty-${i}`} className="podium-col empty" />)}
        </div>

        <div className="results-grid">
          <div className="results-table" role="table" aria-label="Final standings">
            <div className="rt-head" role="row"><span>RANK</span><span>PLAYER</span><span>SCORE</span><span>WORDS</span><span>BEST WORD</span><span /></div>
            {standings.map((s) => (
              <div key={s.playerId} role="row" className={`rt-row ${s.playerId === myId ? 'me' : ''}`}>
                <span className="rank">{s.rank === 1 ? <Crown size={14} fill="currentColor" /> : String(s.rank).padStart(2, '0')}</span>
                <span className="player"><span className={`avatar avatar-${toneFor(tones[s.playerId] ?? 0)}`}>{initials(s.username)}</span><b>{s.username}</b>{s.playerId === myId && <small>YOU</small>}</span>
                <span className="score">{s.totalScore}</span>
                <span className="score">{s.wordsCount}</span>
                <span className="rt-best">{s.bestWord ? `${s.bestWord.toUpperCase()} · ${s.bestWordPoints}` : '—'}</span>
                <span className="rt-out">{s.left ? 'left' : s.eliminatedRound ? `out · R${s.eliminatedRound}` : 'survived'}</span>
              </div>
            ))}
          </div>

          <aside className="room-card">
            <p className="eyebrow">GAME STATS</p>
            <ul className="stat-list">
              <li><span>Best word</span><b>{best?.bestWord ? `${best.bestWord.toUpperCase()} (${best.bestWordPoints})` : '—'}</b><small>{best?.bestWord ? best.username : ''}</small></li>
              <li><span>Most words</span><b>{most?.wordsCount ?? 0}</b><small>{most?.username}</small></li>
              <li><span>Players</span><b>{standings.length}</b></li>
            </ul>
            <button className="solid-button large full" disabled={busy} onClick={onAgain}><RotateCcw size={16} /> {busy ? 'Creating…' : 'Play again'}</button>
            <button className="outline-button large full" disabled={busy} onClick={onHome}><Home size={16} /> Back to home</button>
            <p className="room-hint">“Play again” opens a new room and gives you a fresh code to share.</p>
          </aside>
        </div>
      </section>
    </main>
  )
}
