'use client'

import { useState } from 'react'
import { ArrowRight } from 'lucide-react'
import Logo from '@/components/layout/Logo'
import Background from '@/components/layout/Background'
import AuthModal from './AuthModal'
import { useAuth } from '@/context/AuthContext'
import type { AuthMode } from '@/types'

export default function AuthGate() {
  const [modal, setModal] = useState<AuthMode | null>(null)
  const { continueAsGuest } = useAuth()

  return (
    <main className="auth-gate site-shell">
      <Background />
      <div className="auth-gate-card">
        <Logo />
        <div className="auth-gate-copy">
          <p className="eyebrow"><span className="live-dot" /> THE WORD ARENA</p>
          <h1>Make words.<br /><em>Make waves.</em></h1>
          <p>Sign in to enter the court, save your royal identity, and appear on the live leaderboard.</p>
        </div>
        <div className="auth-gate-actions">
          <button className="solid-button large full" onClick={() => setModal('login')}>Log in <ArrowRight size={17} /></button>
          <button className="outline-button large full" onClick={() => setModal('signup')}>Create an account</button>
          <button className="ghost-button" onClick={() => continueAsGuest()}>Or continue as guest</button>
        </div>
        <p className="auth-gate-note">New here? Sign up with a username so friends know who is ruling the room.</p>
      </div>
      {modal && <AuthModal mode={modal} onClose={() => setModal(null)} onSwitch={setModal} />}
    </main>
  )
}
