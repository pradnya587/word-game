const request = require('supertest')
const jwt = require('jsonwebtoken')
const { newDb } = require('pg-mem')
const { createApp } = require('../src/app')
const { migrate } = require('../src/db')

const config = { jwtSecret: 'test-secret', userTokenTtl: '1h', guestTokenTtl: '1h', bcryptRounds: 4, corsOrigin: '*', rateLimitPerMinute: 0 }
const silent = { info() {}, warn() {}, error() {} }

let app
beforeEach(async () => {
  const { Pool } = newDb().adapters.createPg()
  const db = new Pool()
  await migrate(db)
  app = createApp({ db, config, logger: silent })
})

const user = { username: 'pradnya', email: 'Pradnya@Example.com', password: 'secret123' }

describe('POST /api/auth/register', () => {
  it('creates a user and returns a JWT', async () => {
    const res = await request(app).post('/api/auth/register').send(user)
    expect(res.status).toBe(201)
    expect(res.body.user.username).toBe('pradnya')
    const payload = jwt.verify(res.body.token, 'test-secret')
    expect(payload).toMatchObject({ sub: res.body.user.id, username: 'pradnya', guest: false })
  })
  it('rejects bad input', async () => {
    expect((await request(app).post('/api/auth/register').send({ ...user, username: 'a' })).status).toBe(400)
    expect((await request(app).post('/api/auth/register').send({ ...user, email: 'nope' })).status).toBe(400)
    expect((await request(app).post('/api/auth/register').send({ ...user, password: '123' })).status).toBe(400)
  })
  it('rejects duplicate username and email (case-insensitive)', async () => {
    await request(app).post('/api/auth/register').send(user)
    const a = await request(app).post('/api/auth/register').send({ ...user, username: 'PRADNYA', email: 'other@example.com' })
    expect(a.status).toBe(409); expect(a.body.error).toMatch(/Username/)
    const b = await request(app).post('/api/auth/register').send({ ...user, username: 'someoneelse' })
    expect(b.status).toBe(409); expect(b.body.error).toMatch(/Email/)
  })
  it('never stores the plain password', async () => {
    const { Pool } = newDb().adapters.createPg(); const db = new Pool(); await migrate(db)
    const a = createApp({ db, config, logger: silent })
    await request(a).post('/api/auth/register').send(user)
    const { rows } = await db.query('SELECT password_hash FROM users')
    expect(rows[0].password_hash).not.toContain('secret123')
    expect(rows[0].password_hash).toMatch(/^\$2[aby]\$/)
  })
})

describe('POST /api/auth/login', () => {
  beforeEach(() => request(app).post('/api/auth/register').send(user))
  it('logs in with correct credentials (email is case-insensitive)', async () => {
    const res = await request(app).post('/api/auth/login').send({ email: 'pradnya@example.com', password: 'secret123' })
    expect(res.status).toBe(200)
    expect(res.body.token).toBeTruthy()
  })
  it('rejects wrong password and unknown email with the same message', async () => {
    const a = await request(app).post('/api/auth/login').send({ email: 'pradnya@example.com', password: 'wrongpass' })
    const b = await request(app).post('/api/auth/login').send({ email: 'ghost@example.com', password: 'secret123' })
    expect(a.status).toBe(401); expect(b.status).toBe(401)
    expect(a.body.error).toBe(b.body.error)
  })
})

describe('guest + me + probes', () => {
  it('issues a guest token that is flagged as guest', async () => {
    const res = await request(app).post('/api/auth/guest').send({})
    expect(res.status).toBe(201)
    expect(res.body.user.id).toMatch(/^guest:/)
    expect(jwt.verify(res.body.token, 'test-secret').guest).toBe(true)
  })
  it('/me validates the bearer token', async () => {
    const { body } = await request(app).post('/api/auth/register').send(user)
    const ok = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${body.token}`)
    expect(ok.body.user.username).toBe('pradnya')
    expect((await request(app).get('/api/auth/me').set('Authorization', 'Bearer garbage')).status).toBe(401)
    const expired = jwt.sign({ sub: 'x' }, 'test-secret', { expiresIn: -10 })
    expect((await request(app).get('/api/auth/me').set('Authorization', `Bearer ${expired}`)).status).toBe(401)
  })
  it('/health and /metrics respond', async () => {
    expect((await request(app).get('/health')).body.status).toBe('ok')
    const m = await request(app).get('/metrics')
    expect(m.text).toContain('wordroyale_auth_events_total')
  })
  it('returns JSON 400 for malformed JSON bodies', async () => {
    const res = await request(app).post('/api/auth/login').set('Content-Type', 'application/json').send('{bad')
    expect(res.status).toBe(400)
  })
})

describe('liveness vs readiness', () => {
  it('/health stays cheap (no database access); /ready needs the database and answers 503 without it', async () => {
    const broken = { query: async () => { throw new Error('db down') } }
    const down = createApp({ db: broken, config: { ...config, instanceId: 'vm-1' }, logger: silent })
    const health = await request(down).get('/health')
    expect(health.status).toBe(200)
    expect(health.body).toMatchObject({ status: 'ok', instance_id: 'vm-1' })
    const notReady = await request(down).get('/ready')
    expect(notReady.status).toBe(503)
    expect(notReady.body).toMatchObject({ status: 'unready', checks: { database: 'down' } })
    const ready = await request(app).get('/ready')
    expect(ready.status).toBe(200)
    expect(ready.body).toMatchObject({ status: 'ready', checks: { database: 'up' } })
  })
})
