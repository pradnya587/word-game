const pino = require('pino')
const { resolveInstanceId } = require('./instance')

// Cloud Logging understands `severity` and `message`; plain `docker logs` readers still get JSON lines.
const SEVERITY = { trace: 'DEBUG', debug: 'DEBUG', info: 'INFO', warn: 'WARNING', error: 'ERROR', fatal: 'CRITICAL' }

/**
 * JSON logger on stdout. Every line carries service + instance_id; callers add room_code, command_id
 * and owner_epoch through `logger.child(...)` or per-call fields. Secrets and tokens are redacted.
 */
module.exports = (level = 'info', instanceId = resolveInstanceId()) => pino({
  level,
  base: { service: 'game-service', service_name: 'game-service', instance_id: instanceId },
  messageKey: 'message',
  timestamp: pino.stdTimeFunctions.isoTime,
  formatters: { level: (label) => ({ severity: SEVERITY[label] || 'DEFAULT', level: label }) },
  redact: { paths: ['token', '*.token', 'auth', '*.auth', 'password', '*.password', 'jwtSecret', '*.jwtSecret', 'authorization', '*.authorization', 'databaseUrl', 'redisUrl'], censor: '[redacted]' },
})
