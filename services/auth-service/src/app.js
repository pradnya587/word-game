const crypto = require('crypto')
const express = require('express')
const cors = require('cors')
const bcrypt = require('bcryptjs')
const jwt = require('jsonwebtoken')
const rateLimit = require('express-rate-limit')
const client = require('prom-client')

const USERNAME_RE = /^[A-Za-z0-9_]{3,20}$/
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

function createApp({ db, config, logger }) {
  const app = express()
  app.set('trust proxy', 1) // behind the nginx gateway
  app.disable('x-powered-by')
  app.use(cors({ origin: config.corsOrigin === '*' ? true : config.corsOrigin.split(',') }))
  app.use(express.json({ limit: '10kb' }))

  // ---- metrics ----
  const registry = new client.Registry()
  registry.setDefaultLabels({ service: 'auth-service', ...(config.instanceId ? { instance_id: config.instanceId } : {}) })
  client.collectDefaultMetrics({ register: registry })
  const httpDuration = new client.Histogram({
    name: 'http_request_duration_seconds', help: 'HTTP request duration',
    labelNames: ['method', 'route', 'status'], buckets: [0.005, 0.01, 0.05, 0.1, 0.3, 0.5, 1, 2], registers: [registry],
  })
  const authEvents = new client.Counter({
    name: 'wordroyale_auth_events_total', help: 'Auth events', labelNames: ['event', 'result'], registers: [registry],
  })
  app.use((req, res, next) => {
    const end = httpDuration.startTimer()
    res.on('finish', () => end({ method: req.method, route: req.route?.path || req.path, status: res.statusCode }))
    next()
  })

  // ---- helpers ----
  const sign = (payload, expiresIn) => jwt.sign(payload, config.jwtSecret, { algorithm: 'HS256', expiresIn })
  const session = (user) => ({
    token: sign({ sub: user.id, username: user.username, guest: false }, config.userTokenTtl),
    user: { id: user.id, username: user.username },
  })
  const limiter = config.rateLimitPerMinute > 0
    ? rateLimit({ windowMs: 60_000, limit: config.rateLimitPerMinute, standardHeaders: true, legacyHeaders: false, message: { error: 'Too many attempts, try again in a minute' } })
    : (req, res, next) => next()
  const bad = (res, msg, status = 400) => res.status(status).json({ error: msg })

  // ---- probes ----
  // /health = liveness: cheap, process-local (used by load balancer autohealing).
  // /ready  = readiness: can this instance do its job? Needs its database.
  app.get('/health', (req, res) => res.json({ status: 'ok', service: 'auth-service', instance_id: config.instanceId }))
  app.get('/ready', async (req, res) => {
    const checks = {}
    try { await db.query('SELECT 1'); checks.database = 'up' } catch { checks.database = 'down' }
    const ready = checks.database === 'up'
    res.status(ready ? 200 : 503).json({ status: ready ? 'ready' : 'unready', service: 'auth-service', instance_id: config.instanceId, checks })
  })
  app.get('/metrics', async (req, res) => { res.set('Content-Type', registry.contentType); res.end(await registry.metrics()) })

  // ---- routes ----
  app.post('/api/auth/register', limiter, async (req, res, next) => {
    try {
      const username = String(req.body?.username ?? '').trim()
      const email = String(req.body?.email ?? '').trim().toLowerCase()
      const password = String(req.body?.password ?? '')
      if (!USERNAME_RE.test(username)) return bad(res, 'Username must be 3-20 letters, numbers or underscores')
      if (!EMAIL_RE.test(email)) return bad(res, 'Enter a valid email address')
      if (password.length < 4 || password.length > 72) return bad(res, 'Password must be 4-72 characters')

      const dup = await db.query('SELECT username_lower, email FROM users WHERE username_lower = $1 OR email = $2', [username.toLowerCase(), email])
      if (dup.rows.length) {
        authEvents.inc({ event: 'register', result: 'conflict' })
        return bad(res, dup.rows[0].email === email ? 'Email already registered' : 'Username already taken', 409)
      }
      const id = crypto.randomUUID()
      const hash = await bcrypt.hash(password, config.bcryptRounds)
      await db.query('INSERT INTO users (id, username, username_lower, email, password_hash) VALUES ($1,$2,$3,$4,$5)',
        [id, username, username.toLowerCase(), email, hash])
      authEvents.inc({ event: 'register', result: 'ok' })
      logger.info({ userId: id }, 'user registered')
      res.status(201).json(session({ id, username }))
    } catch (err) {
      if (err.code === '23505') return bad(res, 'Username or email already in use', 409) // race on unique index
      next(err)
    }
  })

  app.post('/api/auth/login', limiter, async (req, res, next) => {
    try {
      const email = String(req.body?.email ?? '').trim().toLowerCase()
      const password = String(req.body?.password ?? '')
      const { rows } = await db.query('SELECT id, username, password_hash FROM users WHERE email = $1', [email])
      const user = rows[0]
      // compare even when the user is missing so response time does not reveal which emails exist
      const ok = await bcrypt.compare(password, user?.password_hash ?? '$2a$10$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidi')
      if (!user || !ok) {
        authEvents.inc({ event: 'login', result: 'failed' })
        return bad(res, 'Invalid email or password', 401)
      }
      authEvents.inc({ event: 'login', result: 'ok' })
      res.json(session(user))
    } catch (err) { next(err) }
  })

  // Temporary identity so people can play without an account. Guests never appear on the leaderboard.
  app.post('/api/auth/guest', limiter, (req, res) => {
    const id = `guest:${crypto.randomUUID()}`
    const username = `Guest${Math.floor(1000 + Math.random() * 9000)}`
    authEvents.inc({ event: 'guest', result: 'ok' })
    res.status(201).json({ token: sign({ sub: id, username, guest: true }, config.guestTokenTtl), user: { id, username } })
  })

  app.get('/api/auth/me', (req, res) => {
    const header = req.headers.authorization || ''
    try {
      const p = jwt.verify(header.replace(/^Bearer /, ''), config.jwtSecret, { algorithms: ['HS256'] })
      res.json({ user: { id: p.sub, username: p.username, guest: !!p.guest } })
    } catch { bad(res, 'Invalid or expired token', 401) }
  })

  app.use((req, res) => bad(res, 'Not found', 404))
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err.type === 'entity.parse.failed') return bad(res, 'Invalid JSON')
    logger.error({ err: err.message }, 'unhandled error')
    res.status(500).json({ error: 'Internal server error' })
  })
  return app
}

module.exports = { createApp }
