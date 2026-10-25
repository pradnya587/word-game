'use client'

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import * as api from '@/lib/api'
import { disconnectSocket } from '@/lib/socket'
import type { Session, User } from '@/types'

interface AuthValue {
  user: User | null
  token: string | null // real session token, or a guest token when playing as guest
  isAuthenticated: boolean
  isGuest: boolean
  ready: boolean
  login: (input: { email: string; password: string }) => Promise<void>
  register: (input: { username: string; email: string; password: string }) => Promise<void>
  logout: () => void
  continueAsGuest: () => void
}

const AuthContext = createContext<AuthValue | null>(null)
const STORAGE_KEY = 'wordroyale.session'
const GUEST_KEY = 'wordroyale.guest' // sessionStorage: a guest identity lives only as long as the tab

function saveSession(session: Session | null) {
  try {
    if (session) localStorage.setItem(STORAGE_KEY, JSON.stringify(session))
    else localStorage.removeItem(STORAGE_KEY)
  } catch {
    /* storage unavailable — session just won't persist */
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null)
  const [isGuest, setIsGuest] = useState(false)
  const [guestToken, setGuestToken] = useState<string | null>(null)
  const [ready, setReady] = useState(false) // avoids a flash of the login gate before localStorage is read

  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY)
      if (raw) setSession(JSON.parse(raw))
      else {
        const g = sessionStorage.getItem(GUEST_KEY)
        if (g) { setGuestToken(g); setIsGuest(true) }
      }
    } catch {
      /* ignore */
    }
    setReady(true)
  }, [])

  const start = (data: Session) => {
    setSession(data)
    saveSession(data)
    setIsGuest(false)
    setGuestToken(null)
  }

  const login = useCallback(async (input: { email: string; password: string }) => start(await api.login(input)), [])
  const register = useCallback(async (input: { username: string; email: string; password: string }) => start(await api.register(input)), [])
  const logout = useCallback(() => {
    disconnectSocket()
    setSession(null)
    setGuestToken(null)
    try { sessionStorage.removeItem(GUEST_KEY) } catch { /* ignore */ }
    saveSession(null)
    setIsGuest(true) // like the original design: logging out drops you into guest mode
  }, [])
  // Guests get a temporary identity from auth-service so they can still join game rooms.
  // If auth-service is unreachable the UI still lets them in (they just can't play online yet).
  const continueAsGuest = useCallback(async () => {
    try {
      const data = await api.guest()
      setGuestToken(data.token)
      try { sessionStorage.setItem(GUEST_KEY, data.token) } catch { /* ignore */ }
    } catch {
      setGuestToken(null)
    }
    setIsGuest(true)
  }, [])

  const value = useMemo<AuthValue>(
    () => ({
      user: session?.user ?? null,
      token: session?.token ?? guestToken,
      isAuthenticated: !!session,
      isGuest,
      ready,
      login,
      register,
      logout,
      continueAsGuest,
    }),
    [session, isGuest, guestToken, ready, login, register, logout, continueAsGuest]
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>')
  return ctx
}
