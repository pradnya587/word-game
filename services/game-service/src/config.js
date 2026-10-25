const { readSecret } = require('./secrets')
const { resolveInstanceId } = require('./instance')

const list = (v, fallback) => (v ? v.split(',').map((n) => Number(n.trim())) : fallback)

function load(env = process.env) {
  const jwtSecret = readSecret('JWT_SECRET', env)
  if (!jwtSecret) throw new Error('JWT_SECRET is required')
  const cfg = {
    port: Number(env.PORT || 4002),
    instanceId: resolveInstanceId(env),
    jwtSecret,
    // Data endpoints are injected by the environment (managed Memorystore / Cloud SQL private IPs in the cloud).
    redisUrl: readSecret('REDIS_URL', env) || 'redis://localhost:6379',
    databaseUrl: readSecret('DATABASE_URL', env) || '', // room snapshots; empty = snapshots kept in memory only (dev/tests)
    autoMigrate: env.AUTO_MIGRATE !== 'false',
    // WebSocket only by default (no sticky sessions needed). Set SOCKET_TRANSPORTS=websocket,polling to allow long-polling fallback.
    transports: (env.SOCKET_TRANSPORTS || 'websocket').split(',').map((t) => t.trim()).filter(Boolean),
    // distributed coordination (BRD: lease renew ~2 s, TTL ~6 s)
    leaseTtlMs: Number(env.LEASE_TTL_MS || 6000),
    leaseRenewMs: Number(env.LEASE_RENEW_MS || 2000),
    sweepIntervalMs: Number(env.SWEEP_INTERVAL_MS || 1000),
    commandTimeoutMs: Number(env.COMMAND_TIMEOUT_MS || 2000),
    commandRetries: Number(env.COMMAND_RETRIES || 2),
    recoveryWaitMs: Number(env.RECOVERY_WAIT_MS || 7500), // how long a request waits for a room to get a new owner
    shutdownDrainMs: Number(env.SHUTDOWN_DRAIN_MS || 3000),
    gameEventsStream: env.GAME_EVENTS_STREAM || 'wordroyale:game.finished',
    dictionaryPath: env.DICTIONARY_PATH || require('path').join(__dirname, '..', 'data', 'words.txt'),
    corsOrigin: env.CORS_ORIGIN || '*',
    logLevel: env.LOG_LEVEL || 'info',
    // game rules (BRD: up to six players, three rounds, server-controlled timer, 30s reconnect grace)
    minPlayers: Number(env.MIN_PLAYERS || 2),
    maxPlayers: Number(env.MAX_PLAYERS || 6),
    minAlive: Number(env.MIN_ALIVE || 2), // elimination stops when only this many players are left
    roundDurationsMs: list(env.ROUND_DURATIONS_MS, [45000, 60000, 20000]), // word chain, letter builder, speed round
    intermissionMs: Number(env.INTERMISSION_MS || 7000),
    reconnectGraceMs: Number(env.RECONNECT_GRACE_MS || 30000),
    finishedRoomTtlMs: Number(env.FINISHED_ROOM_TTL_MS || 5 * 60_000),
    rackSize: Number(env.RACK_SIZE || 7),
    wordSubmitsPerSecond: Number(env.WORD_SUBMITS_PER_SECOND || 8),
  }
  if (cfg.roundDurationsMs.length !== 3 || cfg.roundDurationsMs.some((n) => !(n > 0))) {
    throw new Error('ROUND_DURATIONS_MS must list exactly 3 positive millisecond values')
  }
  return cfg
}
module.exports = { load }
