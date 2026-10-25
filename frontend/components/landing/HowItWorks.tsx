import { ArrowRight } from 'lucide-react'
import { steps } from '@/lib/landing-data'

export default function HowItWorks() {
  return (
    <section id="how" className="content-section section-pad">
      <div className="section-heading">
        <div>
          <p className="eyebrow">THE PLAYBOOK</p>
          <h2>Simple to learn.<br /><em>Impossible to put down.</em></h2>
        </div>
        <p className="section-intro">Three rounds. One room. Endless ways to outspell your friends.</p>
      </div>
      <div className="steps-grid">
        {steps.map(({ n, icon: Icon, title, text }) => (
          <div className="step-card" key={n}>
            <span className="step-number">{n}</span>
            <div className="step-icon"><Icon size={19} /></div>
            <h3>{title}</h3>
            <p>{text}</p>
            <ArrowRight className="step-arrow" size={17} />
          </div>
        ))}
      </div>
    </section>
  )
}
