const { readSecret } = require('./secrets')
const { resolveInstanceId } = require('./instance')

function load(env = process.env) {
  const jwtSecret = readSecret('JWT_SECRET', env)
  if (!jwtSecret) throw new Error('JWT_SECRET is required')
  return {
    port: Number(env.PORT || 4003),
    instanceId: resolveInstanceId(env),
    databaseUrl: readSecret('DATABASE_URL', env) || 'postgres://wordroyale:wordroyale@localhost:5432/stats_db',
    redisUrl: readSecret('REDIS_URL', env) || 'redis://localhost:6379',
    gameEventsStream: env.GAME_EVENTS_STREAM || 'wordroyale:game.finished',
    deadLetterStream: env.DEAD_LETTER_STREAM || 'wordroyale:game.finished.dead',
    consumerGroup: env.CONSUMER_GROUP || 'stats-service',
    consumerName: env.CONSUMER_NAME || require('os').hostname(),
    maxDeliveryAttempts: Number(env.MAX_DELIVERY_ATTEMPTS || 5),
    jwtSecret,
    corsOrigin: env.CORS_ORIGIN || '*',
    logLevel: env.LOG_LEVEL || 'info',
  }
}
module.exports = { load }
