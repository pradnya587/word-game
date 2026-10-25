'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { connectSocket, emitAck } from '@/lib/socket'
import type {
  Ack, GameEnd, MyWord, RoomPhase, RoomState, RoundEnd, RoundInfo, ScoreRow, StateAck, WordResult,
} from '@/types/game'

export type RoomStatus = 'connecting' | 'ready' | 'error' | 'kicked' | 'replaced'

/**
 * Everything the room page needs, kept in sync with game-service over Socket.IO.
 * - The server clock decides time: we keep `serverTime - Date.now()` and count down to `endsAt`.
 * - On every (re)connect we ask the server for the current state, so a dropped connection recovers by itself.
 */
export function useRoom(code: string, token: string | null) {
  const [status, setStatus] = useState<RoomStatus>('connecting')
  const [error, setError] = useState('')
  const [connected, setConnected] = useState(false)
  const [redirectTo, setRedirectTo] = useState<string | null>(null)
  const [room, setRoom] = useState<RoomState | null>(null)
  const [myId, setMyId] = useState<string | null>(null)
  const [phase, setPhase] = useState<RoomPhase>('lobby')
  const [round, setRound] = useState<RoundInfo | null>(null)
  const [scores, setScores] = useState<ScoreRow[]>([])
  const [words, setWords] = useState<MyWord[]>([])
  const [chainLetter, setChainLetter] = useState<string | null>(null)
  const [streak, setStreak] = useState(0)
  const [roundEnd, setRoundEnd] = useState<RoundEnd | null>(null)
  const [nextRoundAt, setNextRoundAt] = useState<number | null>(null)
  const [gameEnd, setGameEnd] = useState<GameEnd | null>(null)
  const [offline, setOffline] = useState<Record<string, number>>({}) // playerId -> reconnect deadline (local time)
  const [notice, setNotice] = useState('')
  const offset = useRef(0)
  const roundRef = useRef<RoundInfo | null>(null)

  const getOffset = useCallback(() => offset.current, [])
  const syncClock = (serverTime: number) => { offset.current = serverTime - Date.now() }

  useEffect(() => {
    if (!token) return
    const socket = connectSocket(token)
    let alive = true
    const fail = (message: string) => { setError(message); setStatus('error') }

    const applyState = (s: RoomState) => {
      syncClock(s.serverTime)
      setRoom(s)
      setPhase(s.state)
      if (s.me) {
        setMyId(s.me.playerId)
        setStreak(s.me.streak)
        if (s.state === 'round' && s.round) {
          roundRef.current = s.round
          setRound(s.round)
          setChainLetter(s.me.chainLetter ?? s.round.chainLetter ?? null)
          // after a reconnect, rebuild "my words" from what the server remembers
          setWords((prev) => (prev.length ? prev : s.me!.words.map((w) => ({ word: w.word, status: 'accepted' as const, points: w.points }))))
        }
      }
      setStatus('ready')
    }

    const sync = async () => {
      const res = await emitAck<StateAck>('room:sync')
      if (!alive) return
      if (res.ok && res.state) {
        if (res.state.code !== code) return setRedirectTo(res.state.code) // you are in another room
        return applyState(res.state)
      }
      if (res.error === 'NOT_IN_ROOM') {
        const joined = await emitAck<StateAck>('room:join', { code })
        if (!alive) return
        if (joined.ok && joined.state) return applyState(joined.state)
        if (joined.error === 'ALREADY_IN_ROOM' && joined.code) return setRedirectTo(joined.code)
        return fail(joined.message || 'Could not join this room')
      }
      fail(res.message || 'Could not reach the game server')
    }

    const onConnect = () => { setConnected(true); void sync() }
    const onDisconnect = () => setConnected(false)
    const onConnectError = (e: Error) => {
      setConnected(false)
      if (e.message === 'unauthorized') fail('Your session has expired. Please log in again.')
    }

    const onRoomState = (s: RoomState) => {
      syncClock(s.serverTime)
      setRoom(s)
      setPhase(s.state)
    }
    const onRoundStart = (r: RoundInfo) => {
      syncClock(r.serverTime)
      roundRef.current = r
      setRound(r)
      setPhase('round')
      setWords([])
      setScores([])
      setStreak(0)
      setChainLetter(r.chainLetter ?? null)
      setRoundEnd(null)
      setNextRoundAt(null)
    }
    const onScore = (p: { scores: ScoreRow[] }) => setScores(p.scores)
    const onRoundEnd = (r: RoundEnd) => {
      syncClock(r.serverTime)
      setRoundEnd(r)
      // apply the outcome right away: totals, and who is out (the full room state only follows at the next change)
      setRoom((cur) => cur && {
        ...cur,
        players: cur.players.map((pl) => {
          const row = r.finalScores.find((f) => f.playerId === pl.id)
          const out = !pl.eliminated && !r.survivors.includes(pl.id)
          return { ...pl, totalScore: row ? row.total : pl.totalScore, eliminated: pl.eliminated || out, eliminatedRound: pl.eliminated ? pl.eliminatedRound : out ? r.round : null }
        }),
      })
      setScores([])
      setPhase('intermission')
      setNextRoundAt(Date.now() + r.nextRoundInMs)
    }
    const onGameEnd = (g: GameEnd) => { setGameEnd(g); setPhase('finished'); setNextRoundAt(null) }
    const onOffline = (p: { playerId: string; graceMs: number }) => setOffline((o) => ({ ...o, [p.playerId]: Date.now() + p.graceMs }))
    const onBack = (p: { playerId: string }) => setOffline((o) => { const { [p.playerId]: _gone, ...rest } = o; return rest })
    const onLeft = (p: { username: string; reason: string }) => setNotice(p.reason === 'kicked' ? `${p.username} was removed` : `${p.username} left the room`)
    const onJoined = (p: { player: { username: string } }) => setNotice(`${p.player.username} joined`)
    const onKicked = () => setStatus('kicked')
    const onReplaced = () => setStatus('replaced')

    const handlers: [string, (...a: never[]) => void][] = [
      ['connect', onConnect], ['disconnect', onDisconnect], ['connect_error', onConnectError],
      ['room:state', onRoomState], ['round:start', onRoundStart], ['score:update', onScore], ['round:end', onRoundEnd],
      ['game:end', onGameEnd], ['player:disconnected', onOffline], ['player:reconnected', onBack],
      ['player:left', onLeft], ['player:joined', onJoined], ['room:kicked', onKicked], ['session:replaced', onReplaced],
    ] as never
    for (const [ev, fn] of handlers) socket.on(ev, fn as never)
    if (socket.connected) onConnect()

    return () => {
      alive = false
      for (const [ev, fn] of handlers) socket.off(ev, fn as never)
    }
  }, [code, token])

  // clear the small "X joined / left" notice after a few seconds
  useEffect(() => {
    if (!notice) return
    const t = setTimeout(() => setNotice(''), 3500)
    return () => clearTimeout(t)
  }, [notice])

  // ---- actions ----
  const setReady = useCallback((ready: boolean) => emitAck<Ack>('room:ready', { ready }), [])
  const kick = useCallback((playerId: string) => emitAck<Ack>('room:kick', { playerId }), [])
  const start = useCallback(() => emitAck<Ack>('game:start'), [])
  const leave = useCallback(() => emitAck<Ack>('room:leave'), [])

  const submit = useCallback(async (raw: string): Promise<WordResult> => {
    const res = await emitAck<Ack & Partial<WordResult>>('word:submit', { word: raw })
    if (!res.ok) return { word: raw, status: 'rejected', points: 0, reason: res.message || 'Could not send the word' }
    const result = res as WordResult
    setWords((w) => [{ word: result.word, status: result.status, points: result.points, reason: result.reason }, ...w])
    if (result.status === 'accepted') {
      if (result.nextLetter) setChainLetter(result.nextLetter)
      if (typeof result.streak === 'number') setStreak(result.streak)
    } else setStreak(0)
    return result
  }, [])

  return {
    status, error, connected, redirectTo, room, myId, phase, round, scores, words, chainLetter, streak,
    roundEnd, nextRoundAt, gameEnd, offline, notice, getOffset,
    setReady, kick, start, leave, submit,
  }
}

// Milliseconds left until `endsAt` (server time), refreshed every 100 ms.
export function useRemaining(endsAt: number | null | undefined, getOffset: () => number) {
  const [ms, setMs] = useState(0)
  useEffect(() => {
    if (!endsAt) { setMs(0); return }
    const tick = () => setMs(Math.max(0, endsAt - (Date.now() + getOffset())))
    tick()
    const id = setInterval(tick, 100)
    return () => clearInterval(id)
  }, [endsAt, getOffset])
  return ms
}

// Milliseconds left until a local timestamp.
export function useLocalRemaining(at: number | null | undefined) {
  const [ms, setMs] = useState(0)
  useEffect(() => {
    if (!at) { setMs(0); return }
    const tick = () => setMs(Math.max(0, at - Date.now()))
    tick()
    const id = setInterval(tick, 200)
    return () => clearInterval(id)
  }, [at])
  return ms
}
