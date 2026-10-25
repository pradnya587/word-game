const Redis = require('ioredis')
const { ACQUIRE, RENEW, RELEASE, CLEAR_IF } = require('./scripts')

/**
 * A store is the only thing the coordination layer needs from Redis. Two implementations:
 *  - RedisStore:  production / multi-replica. Leases, room directory, user index and command channels live in Redis.
 *  - MemoryStore: one process (tests, `docker compose up` with a single game-service without Redis coordination).
 *                 Several MemoryStores can share a MemoryHub to simulate replicas in unit tests.
 * Key layout (prefix `wr:`):
 *   wr:room:{code}:owner   lease "<instance>|<epoch>" (PX ttl)    wr:room:{code}:epoch   fencing counter
 *   wr:rooms               set of live room codes (global uniqueness + sweeper index)
 *   wr:user:{id}:room      room code the user is in
 */
const EPOCH_TTL_MS = 24 * 3600 * 1000
const USER_TTL_S = 6 * 3600

class RedisStore {
  constructor({ url, logger, prefix = 'wr' }) {
    this.kind = 'redis'
    this.logger = logger
    this.p = prefix
    this.url = url
    this.redis = this.connect('main')
    this.sub = this.connect('subscriber')
    this.handlers = new Map()
    this.sub.on('message', (channel, raw) => {
      const fn = this.handlers.get(channel)
      if (!fn) return
      try { fn(JSON.parse(raw)) } catch (e) { logger?.warn({ err: e.message, channel }, 'bad pubsub message') }
    })
    this.redis.defineCommand('leaseAcquire', { numberOfKeys: 2, lua: ACQUIRE })
    this.redis.defineCommand('leaseRenew', { numberOfKeys: 1, lua: RENEW })
    this.redis.defineCommand('leaseRelease', { numberOfKeys: 1, lua: RELEASE })
    this.redis.defineCommand('clearIf', { numberOfKeys: 1, lua: CLEAR_IF })
    this.extra = []
  }

  connect(name) {
    const r = new Redis(this.url, { maxRetriesPerRequest: 3, retryStrategy: (n) => Math.min(n * 300, 3000), enableReadyCheck: true })
    r.on('error', (e) => this.logger?.warn({ err: e.message, conn: name }, 'redis error'))
    return r
  }

  /** Dedicated publisher/subscriber connections for @socket.io/redis-adapter. */
  adapterClients() {
    const pub = this.connect('socketio-pub'); const sub = this.connect('socketio-sub')
    this.extra.push(pub, sub)
    return { pub, sub }
  }

  get connected() { return this.redis.status === 'ready' }
  async ping() { return (await this.redis.ping()) === 'PONG' }

  k = {
    owner: (c) => `${this.p}:room:${c}:owner`,
    epoch: (c) => `${this.p}:room:${c}:epoch`,
    rooms: () => `${this.p}:rooms`,
    user: (id) => `${this.p}:user:${id}:room`,
  }

  // ---- leases (atomic in Lua) ----
  async acquireLease(code, instanceId, ttlMs) { return Number(await this.redis.leaseAcquire(this.k.owner(code), this.k.epoch(code), instanceId, ttlMs, EPOCH_TTL_MS)) }
  async renewLease(code, instanceId, epoch, ttlMs) { return (await this.redis.leaseRenew(this.k.owner(code), `${instanceId}|${epoch}`, ttlMs)) === 1 }
  async releaseLease(code, instanceId, epoch) { return (await this.redis.leaseRelease(this.k.owner(code), `${instanceId}|${epoch}`)) === 1 }
  async getOwner(code) {
    const v = await this.redis.get(this.k.owner(code))
    if (!v) return null
    const i = v.lastIndexOf('|')
    return { instanceId: v.slice(0, i), epoch: Number(v.slice(i + 1)) }
  }

  // ---- directory ----
  async reserveCode(code) { return (await this.redis.sadd(this.k.rooms(), code)) === 1 }
  async removeRoom(code) { await this.redis.multi().srem(this.k.rooms(), code).del(this.k.epoch(code)).exec() }
  async roomExists(code) { return (await this.redis.sismember(this.k.rooms(), code)) === 1 }
  async listRooms() { return this.redis.smembers(this.k.rooms()) }

  // ---- user -> room index ----
  /** Atomically claim a user for a room. Returns null when claimed, or the code of the room they are already in. */
  async claimUser(userId, code) {
    const ok = await this.redis.set(this.k.user(userId), code, 'EX', USER_TTL_S, 'NX')
    if (ok === 'OK') return null
    return (await this.redis.get(this.k.user(userId))) || null
  }
  async setUserRoom(userId, code) { await this.redis.set(this.k.user(userId), code, 'EX', USER_TTL_S) }
  async getUserRoom(userId) { return this.redis.get(this.k.user(userId)) }
  async clearUser(userId, code) { await this.redis.clearIf(this.k.user(userId), code) }
  /** Monotonic connection counter per user: the newest connection wins when a user opens a second tab/device. */
  async nextSession(userId) { const k = `${this.p}:user:${userId}:session`; const n = await this.redis.incr(k); await this.redis.expire(k, USER_TTL_S); return n }
  async touchUsers(userIds) { if (!userIds.length) return; const m = this.redis.multi(); for (const id of userIds) m.expire(this.k.user(id), USER_TTL_S); await m.exec() }

  // ---- messaging ----
  async publish(channel, message) { await this.redis.publish(`${this.p}:${channel}`, JSON.stringify(message)) }
  async subscribe(channel, fn) { const name = `${this.p}:${channel}`; this.handlers.set(name, fn); await this.sub.subscribe(name) }

  async close() {
    for (const r of [this.sub, ...this.extra, this.redis]) { try { r.disconnect() } catch { /* already closed */ } }
  }
}

// ---------------- in-memory implementation ----------------
class MemoryHub {
  constructor() { this.kv = new Map(); this.sets = new Map(); this.subs = new Map() }
}

class MemoryStore {
  constructor({ hub = new MemoryHub(), now = () => Date.now() } = {}) {
    this.kind = 'memory'
    this.hub = hub
    this.now = now
    this.connected = true
  }

  _get(key) {
    const e = this.hub.kv.get(key)
    if (!e) return undefined
    if (e.exp && e.exp <= this.now()) { this.hub.kv.delete(key); return undefined }
    return e.v
  }
  _set(key, v, ttlMs) { this.hub.kv.set(key, { v, exp: ttlMs ? this.now() + ttlMs : 0 }) }
  _set_of(key) { let s = this.hub.sets.get(key); if (!s) { s = new Set(); this.hub.sets.set(key, s) } return s }

  async ping() { return true }
  adapterClients() { return null }

  async acquireLease(code, instanceId, ttlMs) {
    if (this._get(`owner:${code}`) !== undefined) return 0
    const e = (this._get(`epoch:${code}`) || 0) + 1
    this._set(`owner:${code}`, `${instanceId}|${e}`, ttlMs)
    this._set(`epoch:${code}`, e, EPOCH_TTL_MS)
    return e
  }
  async renewLease(code, instanceId, epoch, ttlMs) {
    if (this._get(`owner:${code}`) !== `${instanceId}|${epoch}`) return false
    this._set(`owner:${code}`, `${instanceId}|${epoch}`, ttlMs); return true
  }
  async releaseLease(code, instanceId, epoch) {
    if (this._get(`owner:${code}`) !== `${instanceId}|${epoch}`) return false
    this.hub.kv.delete(`owner:${code}`); return true
  }
  async getOwner(code) {
    const v = this._get(`owner:${code}`)
    if (!v) return null
    const i = v.lastIndexOf('|')
    return { instanceId: v.slice(0, i), epoch: Number(v.slice(i + 1)) }
  }

  async reserveCode(code) { const s = this._set_of('rooms'); if (s.has(code)) return false; s.add(code); return true }
  async removeRoom(code) { this._set_of('rooms').delete(code); this.hub.kv.delete(`epoch:${code}`) }
  async roomExists(code) { return this._set_of('rooms').has(code) }
  async listRooms() { return [...this._set_of('rooms')] }

  async claimUser(userId, code) { const cur = this._get(`user:${userId}`); if (cur) return cur; this._set(`user:${userId}`, code, USER_TTL_S * 1000); return null }
  async setUserRoom(userId, code) { this._set(`user:${userId}`, code, USER_TTL_S * 1000) }
  async getUserRoom(userId) { return this._get(`user:${userId}`) ?? null }
  async clearUser(userId, code) { if (this._get(`user:${userId}`) === code) this.hub.kv.delete(`user:${userId}`) }
  async nextSession(userId) { const n = (this._get(`session:${userId}`) || 0) + 1; this._set(`session:${userId}`, n, USER_TTL_S * 1000); return n }
  async touchUsers() {}

  async publish(channel, message) {
    const raw = JSON.stringify(message)
    for (const fn of this.hub.subs.get(channel) || []) setImmediate(() => fn(JSON.parse(raw)))
  }
  async subscribe(channel, fn) { const l = this.hub.subs.get(channel) || []; l.push(fn); this.hub.subs.set(channel, l); this.mySubs = [...(this.mySubs || []), [channel, fn]] }
  async close() { for (const [ch, fn] of this.mySubs || []) this.hub.subs.set(ch, (this.hub.subs.get(ch) || []).filter((f) => f !== fn)) }
}

module.exports = { RedisStore, MemoryStore, MemoryHub }
