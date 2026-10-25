'use client'

import { useState } from 'react'
import { Menu, Plus } from 'lucide-react'
import Logo from './Logo'
import { useAuth } from '@/context/AuthContext'
import type { ModalType } from '@/types'

export default function Navbar({ onOpenModal }: { onOpenModal: (m: ModalType) => void }) {
  const [menuOpen, setMenuOpen] = useState(false)
  const { user, logout } = useAuth()

  return (
    <header className="topbar">
      <Logo />
      <nav className={menuOpen ? 'nav-links open' : 'nav-links'}>
        <a href="#how">How it works</a>
        <a href="#rounds">Rounds</a>
        <a href="#leaderboard">Leaderboard</a>
      </nav>
      <div className="top-actions">
        {user ? (
          <button className="ghost-button account-name" onClick={logout}>{user.username} · Log out</button>
        ) : (
          <>
            <button className="ghost-button" onClick={() => onOpenModal('login')}>Log in</button>
            <button className="solid-button small" onClick={() => onOpenModal('signup')}>Sign up</button>
          </>
        )}
        <button className="ghost-button" onClick={() => onOpenModal('join')}>Join game</button>
        <button className="solid-button small" onClick={() => onOpenModal('create')}><Plus size={16} /> Create room</button>
      </div>
      <button className="menu-button" onClick={() => setMenuOpen(!menuOpen)} aria-label="Toggle navigation"><Menu size={20} /></button>
    </header>
  )
}
