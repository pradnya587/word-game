'use client'

import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Check, CornerDownLeft, X } from 'lucide-react'
import type { MyWord, WordResult } from '@/types/game'

interface Props {
  value: string
  onChange: (v: string) => void
  disabled: boolean
  disabledText: string
  minLength: number
  words: MyWord[] // newest first
  onSubmit: (word: string) => Promise<WordResult>
}

// Word box + feedback line + chips of the words played this round.
export default function WordInput({ value, onChange, disabled, disabledText, minLength, words, onSubmit }: Props) {
  const [feedback, setFeedback] = useState<{ ok: boolean; text: string } | null>(null)
  const [shake, setShake] = useState(false)
  const [sending, setSending] = useState(false)
  const input = useRef<HTMLInputElement>(null)

  useEffect(() => { if (!disabled) input.current?.focus() }, [disabled])
  useEffect(() => {
    if (!feedback) return
    const t = setTimeout(() => setFeedback(null), 2600)
    return () => clearTimeout(t)
  }, [feedback])

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    const word = value.trim()
    if (!word || sending || disabled) return
    setSending(true)
    const res = await onSubmit(word)
    setSending(false)
    if (res.status === 'accepted') {
      onChange('')
      setFeedback({ ok: true, text: `+${res.points} pts${res.bonus ? ` (streak +${res.bonus})` : ''}` })
    } else {
      setShake(true)
      setTimeout(() => setShake(false), 400)
      setFeedback({ ok: false, text: res.reason || 'Rejected' })
    }
    input.current?.focus()
  }

  return (
    <div className="word-panel">
      <form onSubmit={submit} className={`word-form ${shake ? 'shake' : ''}`}>
        <input
          ref={input}
          className="word-input"
          value={value}
          onChange={(e) => onChange(e.target.value.replace(/[^A-Za-z]/g, '').slice(0, 20))}
          placeholder={disabled ? disabledText : `Type a word (min ${minLength} letters)`}
          disabled={disabled}
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          aria-label="Your word"
        />
        <button type="submit" className="solid-button word-send" disabled={disabled || sending || !value.trim()}>
          <CornerDownLeft size={16} /> Play
        </button>
      </form>
      <p className={`word-feedback ${feedback ? (feedback.ok ? 'ok' : 'bad') : ''}`} role="status" aria-live="polite">{feedback?.text ?? ' '}</p>

      <div className="word-chips" aria-label="Words this round">
        {words.length === 0 && <span className="chips-empty">Words you play appear here.</span>}
        {words.slice(0, 40).map((w, i) => (
          <span key={`${w.word}-${i}`} className={`chip ${w.status}`} title={w.reason}>
            {w.status === 'accepted' ? <Check size={12} /> : <X size={12} />}
            <b>{w.word.toUpperCase()}</b>
            <small>{w.status === 'accepted' ? `+${w.points}` : w.reason}</small>
          </span>
        ))}
      </div>
    </div>
  )
}
