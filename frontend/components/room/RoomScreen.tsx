'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import Background from '@/components/layout/Background'
import Logo from '@/components/layout/Logo'
import Lobby from './Lobby'
import GameView from './GameView'
import Results from './Results'
import RoundEndOverlay from './RoundEndOverlay'
import ReconnectOverlay from './ReconnectOverlay'
import { useRoom } from '@/hooks/useRoom'
import { useAuth } from '@/context/AuthContext'
import { emitAck } from '@/lib/socket'
import { PENDING_JOIN_KEY } from '@/lib/game-ui'
import type { Standing, StateAck } from '@/types/game'

function Card({ title, text, action }: { title: string; text?: string; action?: 'home' | 'spinner' }) {
  return (
    <main className="site-shell auth-gate">
      <Background />
      <div className="auth-gate-card">
        <Logo />
        <div className="auth-gate-copy"><h1 className="card-title">{title}</h1>{text && <p>{text}</p>}</div>
        <div className="auth-gate-actions">
          {action === 'spinner' ? <span className="spinner" aria-label="Loading" /> : <Link href="/" className="solid-button large full">Back to home</Link>}
        </div>
      </div>
    </main>
  )
}

// One route for the whole match: lobby -> rounds -> results, switched by the phase the server reports.
export default function RoomScreen({ code }: { code: string }) {
  const router = useRouter()
  const { token, ready } = useAuth()
  const roomCode = code.toUpperCase()
  const r = useRoom(roomCode, token)
  const [busy, setBusy] = useState(false)

  // Opened an invite link without being logged in: remember the code, the landing page continues from there.
  useEffect(() => {
    if (ready && !token) { try { sessionStorage.setItem(PENDING_JOIN_KEY, roomCode) } catch { /* ignore */ } }
  }, [ready, token, roomCode])

  useEffect(() => { if (r.redirectTo) router.replace(`/room/${r.redirectTo}`) }, [r.redirectTo, router])

  const leave = async () => { await r.leave(); router.push('/') }
  const playAgain = async () => {
    setBusy(true)
    await r.leave()
    const res = await emitAck<StateAck>('room:create')
    setBusy(false)
    if (res.ok && res.code) router.push(`/room/${res.code}`)
    else router.push('/')
  }

  // standings: from game:end, or (after a reconnect) rebuilt from the room state
  const standings: Standing[] = useMemo(() => {
    if (r.gameEnd) return r.gameEnd.standings
    return [...(r.room?.players ?? [])]
      .sort((a, b) => Number(a.eliminated) - Number(b.eliminated) || b.totalScore - a.totalScore)
      .map((p, i) => ({ rank: i + 1, playerId: p.id, username: p.username, guest: p.guest, totalScore: p.totalScore, eliminatedRound: p.eliminatedRound, bestWord: null, bestWordPoints: 0, wordsCount: 0, left: false }))
  }, [r.gameEnd, r.room])

  const tones: Record<string, number> = Object.fromEntries((r.room?.players ?? []).map((p, i) => [p.id, i]))

  if (!ready) return <Card title="Loading…" action="spinner" />
  if (!token) return <Card title="Log in to join" text="Log in or continue as guest on the home page. We will bring you back to this room." />
  if (r.status === 'kicked') return <Card title="You were removed" text="The host removed you from this room." />
  if (r.status === 'replaced') return <Card title="Opened somewhere else" text="This game is open in another tab or device, so this one was closed." />
  if (r.status === 'error') return <Card title="Can't open this room" text={r.error} />
  if (r.status === 'connecting' || !r.room || !r.myId) return <Card title="Joining room…" text={`Room ${roomCode}`} action="spinner" />

  const { room, myId } = r
  let view
  if (r.phase === 'lobby') {
    view = <Lobby room={room} myId={myId} notice={r.notice} onReady={r.setReady} onKick={r.kick} onStart={r.start} onLeave={leave} />
  } else if (r.phase === 'finished') {
    view = <Results standings={standings} tones={tones} myId={myId} reason={r.gameEnd?.reason} busy={busy} onHome={leave} onAgain={playAgain} />
  } else {
    view = (
      <>
        <GameView
          room={room} myId={myId} phase={r.phase} round={r.round} scores={r.scores} words={r.words}
          chainLetter={r.chainLetter} streak={r.streak} offline={r.offline} notice={r.notice} connected={r.connected}
          getOffset={r.getOffset} onSubmit={r.submit} onLeave={leave}
        />
        {r.phase === 'intermission' && r.roundEnd && <RoundEndOverlay end={r.roundEnd} players={room.players} myId={myId} nextRoundAt={r.nextRoundAt} />}
      </>
    )
  }
  return <>{view}{!r.connected && <ReconnectOverlay onLeave={leave} />}</>
}
