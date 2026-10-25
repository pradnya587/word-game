'use client'

import { useState } from 'react'
import { ArrowRight, Check, X } from 'lucide-react'
import type { RoomMode } from '@/types'

interface Props {
  mode: RoomMode
  onClose: () => void
  onCreate: () => void
  onJoin: (code: string) => void
  busy?: boolean
  error?: string
}

export default function RoomModal({ mode, onClose, onCreate, onJoin, busy = false, error = '' }: Props) {
  const [code, setCode] = useState('')
  const isCreate = mode === 'create'

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()}>
        <button className="modal-close" onClick={onClose} aria-label="Close"><X size={18} /></button>
        <p className="eyebrow">{isCreate ? 'NEW GAME' : 'READY TO PLAY'}</p>
        <h2>{isCreate ? 'Create your room.' : 'Enter the room code.'}</h2>
        <p>{isCreate ? "A private room for your favorite people. You can share the code once you're in." : 'Ask the host for their six-character code to join the game.'}</p>
        {!isCreate && (
          <input autoFocus value={code} onChange={(e) => setCode(e.target.value.toUpperCase().slice(0, 6))} placeholder="ABC123" maxLength={6} className="code-input" />
        )}
        {error && <p className="auth-error" role="alert">{error}</p>}
        {isCreate ? (
          <button className="solid-button large full" disabled={busy} onClick={onCreate}>{busy ? 'Creating…' : 'Create room'} <ArrowRight size={17} /></button>
        ) : (
          <button className="solid-button large full" disabled={code.length < 6 || busy} onClick={() => onJoin(code)}>{busy ? 'Joining…' : 'Join room'} <ArrowRight size={17} /></button>
        )}
        <p className="modal-foot"><Check size={14} /> Guest play is still available</p>
      </div>
    </div>
  )
}
