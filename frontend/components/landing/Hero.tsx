'use client'

import { ArrowRight, Flame, Play, Sparkles } from 'lucide-react'
import Tile from './Tile'
import { heroTiles } from '@/lib/landing-data'
import type { ModalType } from '@/types'

export default function Hero({ onOpenModal }: { onOpenModal: (m: ModalType) => void }) {
  return (
    <section className="hero section-pad">
      <div className="hero-copy">
        <div className="eyebrow"><span className="live-dot" /> LIVE NOW <span className="eyebrow-sep" /> 1,284 players competing</div>
        <h1>Make words.<br /><em>Make waves.</em></h1>
        <p className="hero-sub">The fast, social word game where every letter counts and only one player takes the crown.</p>
        <div className="hero-actions">
          <button className="solid-button large" onClick={() => onOpenModal('create')}><Play size={17} fill="currentColor" /> Create a room <ArrowRight size={17} /></button>
          <button className="outline-button large" onClick={() => onOpenModal('join')}>Join with code <span className="keycap">⌘ J</span></button>
        </div>
        <div className="hero-note">
          <div className="mini-avatars"><span>MC</span><span>TB</span><span>LK</span><span>+6</span></div>
          <span>Join the next game<br /><b>starting in 00:42</b></span>
        </div>
      </div>
      <div className="hero-art" aria-label="wordRoyale letter tiles">
        <div className="orbit orbit-a" /><div className="orbit orbit-b" />
        <div className="word-stack">
          {heroTiles.map((tile, i) => <Tile key={`${tile.letter}-${i}`} {...tile} />)}
        </div>
        <div className="art-badge badge-top"><Sparkles size={14} /><span>+24 pts</span><small>great word</small></div>
        <div className="art-badge badge-bottom"><Flame size={15} /><span>7 streak</span><small>on fire</small></div>
        <div className="art-caption"><span className="caption-line" /> <span>YOUR MOVE</span></div>
      </div>
    </section>
  )
}
