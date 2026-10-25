'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import Background from '@/components/layout/Background'
import Navbar from '@/components/layout/Navbar'
import Footer from '@/components/layout/Footer'
import AuthModal from '@/components/auth/AuthModal'
import Hero from './Hero'
import StatsStrip from './StatsStrip'
import HowItWorks from './HowItWorks'
import RoundsSection from './RoundsSection'
import LeaderboardSection from './LeaderboardSection'
import RoomModal from './RoomModal'
import { useAuth } from '@/context/AuthContext'
import { MOCK } from '@/lib/api'
import { connectSocket, emitAck } from '@/lib/socket'
import { PENDING_JOIN_KEY } from '@/lib/game-ui'
import type { Ack, StateAck } from '@/types/game'
import type { ModalType } from '@/types'

export default function LandingPage() {
  const router = useRouter()
  const { token } = useAuth()
  const [modal, setModal] = useState<ModalType>(null)
  const [busy, setBusy] = useState(false)
  const [roomError, setRoomError] = useState('')
  const close = () => { setModal(null); setRoomError('') }
  const open = (m: ModalType) => { setRoomError(''); setModal(m) }

  // Someone opened an invite link before logging in: continue to that room now.
  useEffect(() => {
    if (!token) return
    try {
      const code = sessionStorage.getItem(PENDING_JOIN_KEY)
      if (code) { sessionStorage.removeItem(PENDING_JOIN_KEY); router.push(`/room/${code}`) }
    } catch { /* ignore */ }
  }, [token, router])

  // Talk to game-service: connect (with the JWT), send the request, then open the room page.
  const enterRoom = async (event: 'room:create' | 'room:join', payload: object) => {
    if (MOCK) return setRoomError('Demo mode: set NEXT_PUBLIC_MOCK=false to play against the game server.')
    if (!token) return setRoomError('Please log in or continue as guest first.')
    setBusy(true)
    setRoomError('')
    connectSocket(token)
    const res = await emitAck<StateAck & Ack>(event, payload)
    setBusy(false)
    if (res.ok && res.code) { close(); router.push(`/room/${res.code}`); return }
    if (res.error === 'ALREADY_IN_ROOM' && res.code) { close(); router.push(`/room/${res.code}`); return }
    setRoomError(res.error === 'TIMEOUT' || res.error === 'NO_SOCKET'
      ? 'Could not reach the game server. Please try again.'
      : res.message || 'Something went wrong')
  }
  const handleCreate = () => enterRoom('room:create', {})
  const handleJoin = (code: string) => enterRoom('room:join', { code })

  return (
    <main className="site-shell">
      <Background />
      <Navbar onOpenModal={open} />
      <Hero onOpenModal={open} />
      <StatsStrip />
      <HowItWorks />
      <RoundsSection />
      <LeaderboardSection />
      <Footer />
      {(modal === 'login' || modal === 'signup') && <AuthModal mode={modal} onClose={close} onSwitch={setModal} />}
      {(modal === 'create' || modal === 'join') && <RoomModal mode={modal} onClose={close} onCreate={handleCreate} onJoin={handleJoin} busy={busy} error={roomError} />}
    </main>
  )
}
