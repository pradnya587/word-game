'use client'

import { useEffect, useState } from 'react'
import { WifiOff } from 'lucide-react'
import { getSocket } from '@/lib/socket'

const GRACE_MS = 30000 // same as the server's reconnect grace period

// Shown while the connection is down. The server keeps your seat and score for 30 seconds.
export default function ReconnectOverlay({ onLeave }: { onLeave: () => void }) {
  const [since] = useState(() => Date.now())
  const [left, setLeft] = useState(GRACE_MS)
  useEffect(() => {
    const id = setInterval(() => setLeft(Math.max(0, GRACE_MS - (Date.now() - since))), 250)
    return () => clearInterval(id)
  }, [since])

  const retry = () => getSocket()?.connect()

  return (
    <div className="overlay blur" role="alertdialog" aria-modal="true" aria-label="Connection lost">
      <div className="overlay-card small">
        <WifiOff size={28} className="wifi-icon" />
        {left > 0 ? (
          <>
            <h3>Reconnecting…</h3>
            <p>Your seat and score are safe for another <b>{Math.ceil(left / 1000)}s</b>.</p>
            <span className="spinner" aria-hidden="true" />
          </>
        ) : (
          <>
            <h3>Still disconnected</h3>
            <p>The grace period is over, so your seat may have been released.</p>
            <div className="overlay-actions">
              <button className="solid-button" onClick={retry}>Try to rejoin</button>
              <button className="outline-button" onClick={onLeave}>Leave</button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
