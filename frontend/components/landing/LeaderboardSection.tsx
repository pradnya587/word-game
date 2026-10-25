'use client'

import { ArrowRight, ChevronDown, Crown, Flame } from 'lucide-react'
import { leaderboardPlayers } from '@/lib/landing-data'
import { useAuth } from '@/context/AuthContext'

export default function LeaderboardSection() {
  const { user } = useAuth()
  const myName = user?.username ?? 'you'

  return (
    <section id="leaderboard" className="leader-section section-pad">
      <div className="leader-heading">
        <div>
          <p className="eyebrow">LIVE LEADERBOARD</p>
          <h2>Today&apos;s <em>royal court.</em></h2>
        </div>
        <div className="online"><span className="live-dot" /> 1,284 online <ChevronDown size={15} /></div>
      </div>
      <div className="leader-table">
        <div className="leader-head"><span>RANK</span><span>PLAYER</span><span>SCORE</span><span>STREAK</span><span /></div>
        {leaderboardPlayers.map((p) => {
          const isMe = p.name === 'you'
          const name = isMe ? myName : p.name
          return (
            <div className={`leader-row ${isMe ? 'current' : ''}`} key={p.name}>
              <span className="rank">{p.rank === 1 ? <Crown size={15} fill="currentColor" /> : `0${p.rank}`}</span>
              <span className="player">
                <span className={`avatar avatar-${p.color}`}>{isMe ? myName.slice(0, 2).toUpperCase() : p.initials}</span>
                <b>{name}</b>
                {isMe && <small>YOU</small>}
              </span>
              <span className="score">{p.score.toLocaleString()}</span>
              <span className="streak"><Flame size={14} fill={p.rank === 1 ? 'currentColor' : 'none'} /> {p.streak}</span>
              <ArrowRight size={17} className="row-arrow" />
            </div>
          )
        })}
      </div>
    </section>
  )
}
