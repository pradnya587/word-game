const os = require('os')
const crypto = require('crypto')

// Identifies this replica in logs, leases and metrics. On GCP the startup script injects INSTANCE_ID
// from VM metadata; locally it falls back to hostname + a short random suffix (unique per process).
function resolveInstanceId(env = process.env) {
  if (env.INSTANCE_ID) return String(env.INSTANCE_ID)
  return `${os.hostname()}-${crypto.randomBytes(3).toString('hex')}`
}

module.exports = { resolveInstanceId }
