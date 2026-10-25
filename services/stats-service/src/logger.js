const pino = require('pino')
const { resolveInstanceId } = require('./instance')

// Cloud Logging understands `severity` and `message`; plain `docker logs` readers still get JSON lines.
const SEVERITY = { trace: 'DEBUG', debug: 'DEBUG', info: 'INFO', warn: 'WARNING', error: 'ERROR', fatal: 'CRITICAL' }

// JSON on stdout. Every line carries service + instance_id; secrets and tokens are redacted.
module.exports = (level = 'info', instanceId = resolveInstanceId()) => pino({
  level,
  base: { service: 'stats-service', service_name: 'stats-service', instance_id: instanceId },
  messageKey: 'message',
  timestamp: pino.stdTimeFunctions.isoTime,
  formatters: { level: (label) => ({ severity: SEVERITY[label] || 'DEFAULT', level: label }) },
  redact: { paths: ['token', '*.token', 'password', '*.password', 'authorization', '*.authorization', 'jwtSecret', 'databaseUrl', 'redisUrl'], censor: '[redacted]' },
})
