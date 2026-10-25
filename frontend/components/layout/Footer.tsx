import { Globe } from 'lucide-react'
import Logo from './Logo'

export default function Footer() {
  return (
    <footer className="footer section-pad">
      <Logo />
      <span>© 2026 wordRoyale</span>
      <div><a href="#">Rules</a><a href="#">Privacy</a><a href="#">Discord</a></div>
      <Globe size={16} />
    </footer>
  )
}
