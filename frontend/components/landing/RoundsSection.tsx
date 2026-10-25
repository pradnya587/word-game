import { ArrowRight, Flame } from 'lucide-react'
import Tile from './Tile'
import { rackTiles } from '@/lib/landing-data'

export default function RoundsSection() {
  return (
    <section id="rounds" className="rounds-section section-pad">
      <div className="section-heading">
        <div>
          <p className="eyebrow">THREE WAYS TO PLAY</p>
          <h2>Every round<br /><em>changes the game.</em></h2>
        </div>
        <button className="text-button">Explore all rounds <ArrowRight size={16} /></button>
      </div>
      <div className="rounds-grid">
        <div className="round-card chain">
          <div className="round-top"><span className="round-pill">ROUND 01</span><span className="round-time">45 sec</span></div>
          <h3>Word chain</h3>
          <p>Start where your last word ended. No breaking the chain.</p>
          <div className="chain-preview">
            <span>MOON</span><ArrowRight size={14} />
            <span className="highlight-word">NOVA</span><ArrowRight size={14} />
            <span>ARC</span>
          </div>
          <span className="round-index">01</span>
        </div>
        <div className="round-card featured">
          <div className="round-top"><span className="round-pill">ROUND 02</span><span className="round-time">60 sec</span></div>
          <h3>Letter builder</h3>
          <p>Build as many words as you can from your letter rack.</p>
          <div className="rack-preview">
            {rackTiles.map((t, i) => <Tile key={i} {...t} small />)}
          </div>
          <span className="round-index">02</span>
        </div>
        <div className="round-card speed">
          <div className="round-top"><span className="round-pill">ROUND 03</span><span className="round-time">20 sec</span></div>
          <h3>Speed round</h3>
          <p>Rapid-fire prompts. Quick thinking wins the crown.</p>
          <div className="speed-preview"><Flame size={18} fill="currentColor" /><strong>07</strong><span>streak</span></div>
          <span className="round-index">03</span>
        </div>
      </div>
    </section>
  )
}
