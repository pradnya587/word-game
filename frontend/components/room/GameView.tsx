'use client'

import { useMemo, useState } from 'react'
import { ArrowRight, Eye, Flame, LogOut, Shuffle, Eraser } from 'lucide-react'
import Background from '@/components/layout/Background'
import Logo from '@/components/layout/Logo'
import GameTile from './GameTile'
import Scoreboard from './Scoreboard'
import TimerRing from './TimerRing'
import WordInput from './WordInput'
import { ROUND_HINTS, ROUND_NAMES, ROUND_ORDER } from '@/lib/game-ui'
import { useRemaining } from '@/hooks/useRoom'
import type { MyWord, RoomPhase, RoomPlayer, RoomState, RoundInfo, ScoreRow, WordResult } from '@/types/game'

interface Props {
  room: RoomState
  myId: string
  phase: RoomPhase
  round: RoundInfo | null
  scores: ScoreRow[]
  words: MyWord[]
  chainLetter: string | null
  streak: number
  offline: Record<string, number>
  notice: string
  connected: boolean
  getOffset: () => number
  onSubmit: (word: string) => Promise<WordResult>
  onLeave: () => void
}

export default function GameView(p: Props) {
  const { room, myId, phase, round, words } = p
  const [value, setValue] = useState('')
  const [order, setOrder] = useState<number[] | null>(null)
  const remaining = useRemaining(phase === 'round' ? round?.endsAt : null, p.getOffset)

  const me: RoomPlayer | undefined = room.players.find((x) => x.id === myId)
  const spectating = !!me?.eliminated
  const live = phase === 'round' && !!round && remaining > 0

  // ---- Letter builder rack: which tiles are already used by what is typed ----
  const letters = useMemo(() => (round?.letters ?? []).map((l) => l.toUpperCase()), [round?.letters])
  const tileOrder = order && order.length === letters.length ? order : letters.map((_, i) => i)
  const used = useMemo(() => {
    const flags = new Array(letters.length).fill(false)
    for (const ch of value.toUpperCase()) {
      const idx = tileOrder.find((i) => !flags[i] && letters[i] === ch)
      if (idx !== undefined) flags[idx] = true
    }
    return flags
  }, [value, letters, tileOrder])
  const shuffle = () => {
    const a = letters.map((_, i) => i)
    for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]] }
    setOrder(a)
  }

  const acceptedChain = words.filter((w) => w.status === 'accepted').map((w) => w.word.toUpperCase()).reverse()

  return (
    <main className="site-shell game-shell">
      <Background />
      <header className="game-top section-pad">
        <Logo />
        <ol className="round-steps" aria-label="Rounds">
          {ROUND_ORDER.map((t, i) => {
            const n = i + 1
            const state = round ? (n < round.round ? 'done' : n === round.round ? 'current' : 'todo') : 'todo'
            return (
              <li key={t} className={`step-pill ${state}`} aria-current={state === 'current' ? 'step' : undefined}>
                <span>{n}</span><b>{ROUND_NAMES[t]}</b>
              </li>
            )
          })}
        </ol>
        <div className="game-top-right">
          {round && phase === 'round' && <TimerRing remainingMs={remaining} totalMs={round.durationMs} />}
          <button className="ghost-button leave-button" onClick={p.onLeave}><LogOut size={15} /> Leave</button>
        </div>
      </header>

      <section className="game-body section-pad">
        <div className="play-area">
          {!round ? (
            <div className="play-card center-card"><p className="eyebrow"><span className="live-dot" /> GET READY</p><h3>The next round is about to start…</h3></div>
          ) : (
            <>
              <div className="play-card">
                <div className="play-card-head">
                  <div>
                    <p className="eyebrow">ROUND {round.round} OF {round.totalRounds}</p>
                    <h3>{ROUND_NAMES[round.type]}</h3>
                    <p className="play-hint">{ROUND_HINTS[round.type]}</p>
                  </div>
                  {round.type === 'speedRound' && (
                    <div className={`streak-box ${p.streak > 1 ? 'hot' : ''}`} aria-label={`Streak ${p.streak}`}>
                      <Flame size={20} fill="currentColor" /><strong>{String(p.streak).padStart(2, '0')}</strong><span>streak</span>
                    </div>
                  )}
                </div>

                {round.type === 'wordChain' && (
                  <div className="chain-area">
                    <div className="chain-seed">
                      <span className="chain-label">Starts from</span>
                      <b className="chain-word">{(round.seedWord ?? '').toUpperCase()}</b>
                    </div>
                    <ArrowRight size={18} className="chain-arrow" />
                    <div className="chain-need">
                      <span className="chain-label">Your next word starts with</span>
                      <GameTile letter={p.chainLetter ?? round.chainLetter ?? '?'} size="xl" tone="cyan" />
                    </div>
                    {acceptedChain.length > 0 && (
                      <div className="chain-trail" aria-label="Your chain">
                        {acceptedChain.slice(-5).map((w, i, arr) => (
                          <span key={`${w}-${i}`} className="trail-item"><span className={i === arr.length - 1 ? 'highlight-word' : ''}>{w}</span>{i < arr.length - 1 && <ArrowRight size={12} />}</span>
                        ))}
                      </div>
                    )}
                  </div>
                )}

                {round.type === 'letterBuilder' && (
                  <div className="rack-area">
                    <div className="rack" role="group" aria-label="Letter rack">
                      {tileOrder.map((idx) => (
                        <GameTile key={idx} letter={letters[idx]} size="xl" dim={used[idx] || !live || spectating} onClick={() => setValue((v) => v + letters[idx])} />
                      ))}
                    </div>
                    <div className="rack-actions">
                      <button type="button" className="outline-button" onClick={shuffle}><Shuffle size={14} /> Shuffle</button>
                      <button type="button" className="outline-button" onClick={() => setValue('')}><Eraser size={14} /> Clear</button>
                    </div>
                  </div>
                )}

                {round.type === 'speedRound' && round.constraint && (
                  <div className="speed-area">
                    <span className="chain-label">Every word must contain</span>
                    <GameTile letter={round.constraint.contains} size="xl" tone="coral" />
                    <span className="min-badge">{round.constraint.minLength}+ letters</span>
                  </div>
                )}
              </div>

              {spectating ? (
                <div className="spectator-banner"><Eye size={18} /><div><b>You have been eliminated.</b><span>You are spectating. Watch the scoreboard to see who survives.</span></div></div>
              ) : (
                <WordInput
                  value={value}
                  onChange={setValue}
                  disabled={!live}
                  disabledText={phase === 'round' ? 'Time is up' : 'Waiting for the next round…'}
                  minLength={round.minLength}
                  words={words}
                  onSubmit={p.onSubmit}
                />
              )}
            </>
          )}
        </div>

        <Scoreboard players={room.players} scores={p.scores} myId={myId} phase={phase} offline={p.offline} />
      </section>
      {p.notice && <div className="toast" role="status">{p.notice}</div>}
    </main>
  )
}
