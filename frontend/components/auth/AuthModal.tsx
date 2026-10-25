'use client'

import { useState, type FormEvent } from 'react'
import { ArrowRight, X } from 'lucide-react'
import { useAuth } from '@/context/AuthContext'
import type { AuthMode } from '@/types'

export default function AuthModal({ mode, onClose, onSwitch }: { mode: AuthMode; onClose: () => void; onSwitch: (m: AuthMode) => void }) {
  const { login, register } = useAuth()
  const [username, setUsername] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const isSignup = mode === 'signup'

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      if (isSignup) await register({ username: username.trim(), email: email.trim(), password })
      else await login({ email: email.trim(), password })
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()}>
        <button className="modal-close" onClick={onClose} aria-label="Close"><X size={18} /></button>
        <form onSubmit={handleSubmit}>
          <p className="eyebrow">{isSignup ? 'JOIN THE COURT' : 'WELCOME BACK'}</p>
          <h2>{isSignup ? 'Create your account.' : 'Log in to play.'}</h2>
          <p>{isSignup ? 'Choose a username so your name can appear on the leaderboard.' : 'Sign in to keep your royal identity across games.'}</p>
          {isSignup && (
            <input autoFocus value={username} onChange={(e) => setUsername(e.target.value)} placeholder="Username" className="auth-input" required minLength={3} maxLength={20} />
          )}
          <input autoFocus={!isSignup} value={email} onChange={(e) => setEmail(e.target.value)} placeholder="Email" type="email" className="auth-input" required />
          <input value={password} onChange={(e) => setPassword(e.target.value)} placeholder={isSignup ? 'Password (min. 6 characters)' : 'Password'} type="password" className="auth-input" required minLength={4} />
          {error && <p className="auth-error" role="alert">{error}</p>}
          <button className="solid-button large full" type="submit" disabled={loading}>
            {loading ? 'Please wait…' : isSignup ? 'Create account' : 'Log in'} <ArrowRight size={17} />
          </button>
          <p className="modal-switch">
            {isSignup ? 'Already playing?' : 'New to wordRoyale?'}{' '}
            <button type="button" onClick={() => onSwitch(isSignup ? 'login' : 'signup')}>{isSignup ? 'Log in' : 'Sign up'}</button>
          </p>
        </form>
      </div>
    </div>
  )
}
