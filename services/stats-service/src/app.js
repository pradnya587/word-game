const express = require('express')
const cors = require('cors')
const jwt = require('jsonwebtoken')
const client = require('prom-client')
const repo = require('./repo')

function createApp({ db, config, logger, registry = new client.Registry(), isConsumerUp = () => true }) {
  const app = express()
  app.set('trust proxy', 1)
  app.disable('x-powered-by')
  app.use(cors({ origin: config.corsOrigin === '*' ? true : config.corsOrigin.split(',') }))

  const httpDuration = new client.Histogram({ name: 'http_request_duration_seconds', help: 'HTTP request duration', labelNames: ['method', 'route', 'status'], buckets: [0.005, 0.01, 0.05, 0.1, 0.3, 0.5, 1, 2], registers: [registry] })
  app.use((req, res, next) => {
    const end = httpDuration.startTimer()
    res.on('finish', () => end({ method: req.method, route: req.route?.path || req.path, status: res.statusCode }))
    next()
  })

  const auth = (req, res, next) => {
    try {
      const p = jwt.verify((req.headers.authorization || '').replace(/^Bearer /, ''), config.jwtSecret, { algorithms: ['HS256'] })
      req.user = { id: String(p.sub), username: p.username, guest: !!p.guest }
      next()
    } catch { res.status(401).json({ error: 'Invalid or expired token' }) }
  }
  const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).catch(next)

  // /health = liveness: cheap, process-local. /ready = readiness: needs its database and the Redis stream consumer.
  app.get('/health', (req, res) => res.json({ status: 'ok', service: 'stats-service', instance_id: config.instanceId, consumer: isConsumerUp() ? 'up' : 'down' }))
  app.get('/ready', async (req, res) => {
    const checks = { redis: isConsumerUp() ? 'up' : 'down' }
    try { await db.query('SELECT 1'); checks.database = 'up' } catch { checks.database = 'down' }
    const ready = checks.database === 'up' && checks.redis === 'up'
    res.status(ready ? 200 : 503).json({ status: ready ? 'ready' : 'unready', service: 'stats-service', instance_id: config.instanceId, checks })
  })
  app.get('/metrics', async (req, res) => { res.set('Content-Type', registry.contentType); res.end(await registry.metrics()) })

  app.get('/api/stats/leaderboard', wrap(async (req, res) => {
    const range = ['today', 'weekly', 'all'].includes(req.query.range) ? req.query.range : 'today'
    res.json({ range, entries: await repo.leaderboard(db, { range, limit: req.query.limit }) })
  }))
  app.get('/api/stats/summary', wrap(async (req, res) => res.json(await repo.summary(db))))
  app.get('/api/stats/me', auth, wrap(async (req, res) => {
    if (req.user.guest) return res.status(403).json({ error: 'Guests do not have saved stats. Create an account to keep your history.' })
    res.json({ user: { id: req.user.id, username: req.user.username }, ...(await repo.userStats(db, req.user.id)) })
  }))

  app.use((req, res) => res.status(404).json({ error: 'Not found' }))
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => { logger.error({ err: err.message }, 'unhandled error'); res.status(500).json({ error: 'Internal server error' }) })
  return app
}
module.exports = { createApp }
