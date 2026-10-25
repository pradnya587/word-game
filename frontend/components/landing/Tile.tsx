import type { TileData } from '@/types'

export default function Tile({ letter, value, tone, small = false }: TileData & { small?: boolean }) {
  return (
    <div className={`letter-tile tile-${tone} ${small ? 'tile-small' : ''}`}>
      <span>{letter}</span>
      <b>{value}</b>
    </div>
  )
}
