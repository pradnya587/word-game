const stats = [
  ['18,492', 'games played today'],
  ['73,901', 'words discovered'],
  ['6', 'players per room'],
  ['04:00', 'to claim the crown'],
]

export default function StatsStrip() {
  return (
    <section className="stats-strip">
      {stats.map(([value, label]) => (
        <div key={label}><strong>{value}</strong><span>{label}</span></div>
      ))}
    </section>
  )
}
