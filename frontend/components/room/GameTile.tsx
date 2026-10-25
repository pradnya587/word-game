import { letterValue, toneForLetter } from '@/lib/game-ui'
import type { Tone } from '@/types'

interface Props {
  letter: string
  size?: 'md' | 'xl'
  tone?: Tone
  dim?: boolean
  onClick?: () => void
}

// A letter tile in the same style as the landing page tiles. Clickable when `onClick` is given.
export default function GameTile({ letter, size = 'md', tone, dim = false, onClick }: Props) {
  const cls = `letter-tile tile-static tile-${tone ?? toneForLetter(letter)} tile-${size} ${dim ? 'tile-dim' : ''}`
  const inner = <><span>{letter.toUpperCase()}</span><b>{letterValue(letter)}</b></>
  return onClick
    ? <button type="button" className={`${cls} tile-button`} onClick={onClick} disabled={dim} aria-label={`Letter ${letter.toUpperCase()}`}>{inner}</button>
    : <div className={cls} aria-label={`Letter ${letter.toUpperCase()}`}>{inner}</div>
}
