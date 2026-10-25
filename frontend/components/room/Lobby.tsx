'use client'

import { useState } from 'react'
import { Check, Copy, Crown, Link2, LogOut, Play, X } from 'lucide-react'
import Background from '@/components/layout/Background'
import Logo from '@/components/layout/Logo'
import { initials, ROUND_HINTS, ROUND_NAMES, ROUND_ORDER, toneFor } from '@/lib/game-ui'
import type { Ack, RoomState } from '@/types/game'

interface Props {
  room: RoomState
  myId: string
  notice: string
  onReady: (ready: boolean) => Promise<Ack>
  onKick: (playerId: string) => Promise<Ack>
  onStart: () => Promise<Ack>
  onLeave: () => void
}

export default function Lobby({ room, myId, notice, onReady, onKick, onStart, onLeave }: Props) {
  const [copied, setCopied] = useState<'code' | 'link' | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const me = room.players.find((p) => p.id === myId)
  const isHost = room.hostId === myId
  const connectedCount = room.players.filter((p) => p.connected).length
  const canStart = isHost && connectedCount >= room.config.minPlayers
  const seats = Array.from({ length: room.config.maxPlayers }, (_, i) => room.players[i] ?? null)

  const copy = async (what: 'code' | 'link') => {
    try {
      await navigator.clipboard.writeText(what === 'code' ? room.code : `${window.location.origin}/room/${room.code}`)
      setCopied(what)
      setTimeout(() => setCopied(null), 1800)
    } catch { /* clipboard not available */ }
  }

  const run = async (fn: () => Promise<Ack>) => {
    setBusy(true)
    setError('')
    const res = await fn()
    setBusy(false)
    if (!res.ok) setError(res.message || 'Something went wrong')
  }

  return (
    <main className="site-shell room-shell">
      <Background />
      <header className="topbar">
        <Logo />
        <button className="ghost-button leave-button" onClick={onLeave}><LogOut size={15} /> Leave room</button>
      </header>

      <section className="room-main section-pad">
        <div className="room-head">
          <p className="eyebrow"><span className="live-dot" /> PRIVATE ROOM <span className="eyebrow-sep" /> {room.players.length} / {room.config.maxPlayers} PLAYERS</p>
          <h2 className="room-title">Gather your <em>crew.</em></h2>
          <div className="room-code" aria-label={`Room code ${room.code}`}>
            {[...room.code].map((c, i) => <span key={i} className="code-cell">{c}</span>)}
          </div>
          <div className="room-share">
            <button className="outline-button" onClick={() => copy('code')}>{copied === 'code' ? <Check size={15} /> : <Copy size={15} />} {copied === 'code' ? 'Copied' : 'Copy code'}</button>
            <button className="outline-button" onClick={() => copy('link')}>{copied === 'link' ? <Check size={15} /> : <Link2 size={15} />} {copied === 'link' ? 'Copied' : 'Copy invite link'}</button>
          </div>
        </div>

        <div className="room-layout">
          <div className="seat-grid" role="list" aria-label="Players">
            {seats.map((p, i) => (
              <div key={p?.id ?? `empty-${i}`} role="listitem" className={`seat ${p ? 'filled' : 'empty'} ${p && !p.connected ? 'away' : ''}`}>
                {p ? (
                  <>
                    <span className={`avatar avatar-${toneFor(i)} avatar-lg`}>{initials(p.username)}</span>
                    <div className="seat-info">
                      <b>{p.username}{p.id === myId && <small className="you-tag">YOU</small>}</b>
                      <span className={`seat-status ${p.ready || p.isHost ? 'good' : ''}`}>
                        {p.isHost ? <><Crown size={12} fill="currentColor" /> Host</> : p.ready ? <><Check size={12} /> Ready</> : 'Not ready'}
                        {!p.connected && ' · reconnecting'}
                      </span>
                    </div>
                    <span className={`conn-dot ${p.connected ? 'on' : ''}`} title={p.connected ? 'Connected' : 'Disconnected'} />
                    {isHost && !p.isHost && (
                      <button className="seat-kick" onClick={() => run(() => onKick(p.id))} aria-label={`Remove ${p.username}`}><X size={14} /></button>
                    )}
                  </>
                ) : (
                  <><span className="seat-empty-dot" /><span className="seat-wait">Waiting for player…</span></>
                )}
              </div>
            ))}
          </div>

          <aside className="room-card">
            <p className="eyebrow">THE GAME</p>
            <ol className="rule-list">
              {ROUND_ORDER.map((t, i) => (
                <li key={t}><span className="rule-n">{i + 1}</span><div><b>{ROUND_NAMES[t]}</b><span>{ROUND_HINTS[t]}</span></div></li>
              ))}
            </ol>
            <p className="rule-note">The lowest scorer is eliminated after every round. Last players standing win.</p>

            {isHost ? (
              <>
                <button className="solid-button large full" disabled={!canStart || busy} onClick={() => run(onStart)}>
                  <Play size={16} fill="currentColor" /> {busy ? 'Starting…' : 'Start game'}
                </button>
                {!canStart && <p className="room-hint">Waiting for at least {room.config.minPlayers} players. Share the code above.</p>}
              </>
            ) : (
              <>
                <button className={`${me?.ready ? 'outline-button' : 'solid-button'} large full`} disabled={busy} onClick={() => run(() => onReady(!me?.ready))}>
                  {me?.ready ? 'Not ready' : <><Check size={16} /> I’m ready</>}
                </button>
                <p className="room-hint">Waiting for the host to start the game.</p>
              </>
            )}
            {error && <p className="auth-error" role="alert">{error}</p>}
          </aside>
        </div>
      </section>
      {notice && <div className="toast" role="status">{notice}</div>}
    </main>
  )
}
