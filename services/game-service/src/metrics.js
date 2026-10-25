const client = require('prom-client')

function createMetrics(manager, { instanceId } = {}) {
  const registry = new client.Registry()
  registry.setDefaultLabels({ service: 'game-service', ...(instanceId ? { instance_id: instanceId } : {}) })
  client.collectDefaultMetrics({ register: registry }) // CPU, memory, event loop lag, GC...

  new client.Gauge({ name: 'wordroyale_active_rooms', help: 'Rooms currently in memory', registers: [registry], collect() { this.set(manager.stats().rooms) } })
  new client.Gauge({ name: 'wordroyale_active_players', help: 'Connected players in rooms', registers: [registry], collect() { this.set(manager.stats().players) } })
  const wsConnections = new client.Gauge({ name: 'wordroyale_ws_connections', help: 'Open WebSocket connections', registers: [registry] })
  return {
    registry,
    wsConnections,
    roomsCreated: new client.Counter({ name: 'wordroyale_rooms_created_total', help: 'Rooms created', registers: [registry] }),
    gamesStarted: new client.Counter({ name: 'wordroyale_games_started_total', help: 'Games started', registers: [registry] }),
    gamesFinished: new client.Counter({ name: 'wordroyale_games_finished_total', help: 'Games finished', labelNames: ['reason'], registers: [registry] }),
    roundsCompleted: new client.Counter({ name: 'wordroyale_rounds_completed_total', help: 'Rounds completed', labelNames: ['type'], registers: [registry] }),
    words: new client.Counter({ name: 'wordroyale_words_total', help: 'Submitted words', labelNames: ['result', 'reason'], registers: [registry] }),
    submitDuration: new client.Histogram({ name: 'wordroyale_word_submit_duration_seconds', help: 'Server time to validate and answer a word', buckets: [0.0005, 0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5], registers: [registry] }),
    commandsForwarded: new client.Counter({ name: 'wordroyale_commands_forwarded_total', help: 'Room commands forwarded to the owner replica', labelNames: ['result'], registers: [registry] }),
    roomRecoveries: new client.Counter({ name: 'wordroyale_room_recoveries_total', help: 'Orphaned rooms adopted from a snapshot', labelNames: ['result'], registers: [registry] }),
    leaseLost: new client.Counter({ name: 'wordroyale_lease_lost_total', help: 'Room ownership lost (lease taken over or expired)', labelNames: ['reason'], registers: [registry] }),
    snapshotWrites: new client.Counter({ name: 'wordroyale_snapshot_writes_total', help: 'Room snapshot writes', labelNames: ['result'], registers: [registry] }),
    eventsPublished: new client.Counter({ name: 'wordroyale_events_published_total', help: 'Events published to Redis', labelNames: ['type', 'result'], registers: [registry] }),
  }
}
module.exports = { createMetrics }
