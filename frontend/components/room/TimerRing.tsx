import { fmtTime } from '@/lib/game-ui'

// Circular countdown. Cyan -> amber (under half the time) -> coral and pulsing (last 10 seconds).
export default function TimerRing({ remainingMs, totalMs }: { remainingMs: number; totalMs: number }) {
  const R = 34
  const C = 2 * Math.PI * R
  const frac = totalMs > 0 ? Math.min(1, remainingMs / totalMs) : 0
  const secs = Math.ceil(remainingMs / 1000)
  const tone = secs <= 10 ? 'danger' : frac < 0.5 ? 'warn' : 'ok'
  return (
    <div className={`timer-ring ${tone}`} role="timer" aria-label={`${secs} seconds left`}>
      <svg viewBox="0 0 80 80" aria-hidden="true">
        <circle className="ring-bg" cx="40" cy="40" r={R} />
        <circle className="ring-fg" cx="40" cy="40" r={R} strokeDasharray={C} strokeDashoffset={C * (1 - frac)} transform="rotate(-90 40 40)" />
      </svg>
      <span>{fmtTime(remainingMs)}</span>
    </div>
  )
}
