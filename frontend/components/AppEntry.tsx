'use client'

import AuthGate from '@/components/auth/AuthGate'
import LandingPage from '@/components/landing/LandingPage'
import { useAuth } from '@/context/AuthContext'

// Shows the login gate until the user logs in or continues as guest.
export default function AppEntry() {
  const { isAuthenticated, isGuest, ready } = useAuth()
  if (!ready) return null
  return isAuthenticated || isGuest ? <LandingPage /> : <AuthGate />
}
