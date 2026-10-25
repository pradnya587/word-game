const { Room, RoomError } = require('../game/Room')
const { randomCode } = require('../game/RoomManager')
const { LeaseManager } = require('./leases')
const { RoomDirectory } = require('./directory')
const { CommandChannel } = require('./commands')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const RETRY_MARKERS = new Set(['NOT_OWNER', 'STALE_OWNER'])
const DEDUPE_TTL_MS = 60_000

const notInRoom = () => new RoomError('NOT_IN_ROOM', 'You are not in a room')

/**
 * What each room command does ON THE OWNER. This is the former body of the Socket.IO handlers, unchanged in behaviour:
 * only the instance that owns the room ever runs these, whichever replica the player's socket is connected to.
 * Each returns the acknowledgement payload; a RoomError thrown here becomes `{ ok:false, error, message }` in `fail()`.
 */
const COMMANDS = {
  join: ({ manager, user, socketId, code, payload }) => {
    const room = manager.join(code, user, socketId)
    return { ok: true, code: room.code, state: room.stateFor(user.id) }
  },
  sync: ({ room, user }) => ({ ok: true, state: room.stateFor(user.id) }),
  ready: ({ room, user, payload }) => { room.setReady(user.id, payload.ready); return { ok: true } },
  kick: ({ room, user, payload, deps }) => {
    const target = room.kick(user.id, String(payload.playerId ?? ''))
    if (target.socketId) deps.leaveSocket(target.socketId, room.code) // stop sending room events to the kicked player (any replica)
    return { ok: true }
  },
  start: ({ room, user }) => { room.start(user.id); return { ok: true } },
  submit: ({ room, user, payload }) => {
    const { word } = payload
    if (typeof word !== 'string' || word.length > 40) throw new RoomError('BAD_REQUEST', 'Invalid word')
    return { ok: true, ...room.submitWord(user.id, word) }
  },
  leave: ({ manager, user }) => { manager.leave(user.id); return { ok: true } },
  // a socket (re)connected on some replica: bind it to the player
  attach: ({ room, user, socketId }) => { room.reconnect(user.id, socketId); return { ok: true } },
  // a socket disconnected: start the reconnect grace period, unless the player already has a newer socket
  detach: ({ room, user, payload }) => {
    const p = room.players.get(user.id)
    if (p && (!p.socketId || p.socketId === payload.socketId)) room.markDisconnected(user.id)
    return { ok: true }
  },
}
// commands that need the room object (the user must be a member of the room the command is addressed to)
const NEEDS_ROOM = new Set(['sync', 'ready', 'kick', 'start', 'submit', 'attach', 'detach'])

/**
 * RoomCluster makes the in-process RoomManager/Room behave as one cluster-wide room service:
 *  - every room has exactly one owner replica (Redis lease + fencing epoch) that runs the game rules;
 *  - any replica accepts any socket and forwards the player's commands to the owner (Redis Pub/Sub, ack routed back);
 *  - the owner checkpoints each room into PostgreSQL; if the owner disappears, a surviving replica adopts the room.
 * Game rules stay in Room; nothing in here decides scoring, timers or eliminations.
 */
class RoomCluster {
  constructor({ config, instanceId, store, snapshots, manager, io, logger, metrics }) {
    this.cfg = {
      leaseTtlMs: config.leaseTtlMs ?? 6000, leaseRenewMs: config.leaseRenewMs ?? 2000, sweepIntervalMs: config.sweepIntervalMs ?? 1000,
      commandTimeoutMs: config.commandTimeoutMs ?? 2000, recoveryWaitMs: config.recoveryWaitMs ?? 7500, shutdownDrainMs: config.shutdownDrainMs ?? 3000,
    }
    this.instanceId = instanceId
    this.store = store
    this.snapshots = snapshots
    this.manager = manager
    this.io = io
    this.logger = logger
    this.metrics = metrics
    this.draining = false
    this.versions = new Map() // code -> last snapshot version written by this owner
    this.writers = new Map() // code -> { running, next, done }
    this.removing = new Set()
    this.dedupe = new Map() // `${room}|${commandId}` -> { at, result }
    this.sweeping = false
    this.sweepTimer = null

    this.leases = new LeaseManager({
      store, instanceId, ttlMs: this.cfg.leaseTtlMs, renewMs: this.cfg.leaseRenewMs, logger,
      onLost: (code, epoch, reason) => this.handleLost(code, reason),
    })
    this.dir = new RoomDirectory({ store })
    this.channel = new CommandChannel({ store, instanceId, logger, handler: (env) => this.handleCommand(env) })

    manager.hooks = {
      onUserFreed: (id, code) => { this.dir.freeUser(id, code).catch((e) => this.warn(e, 'could not free user')) },
      onRoomRemoved: (code) => { void this.onRoomRemoved(code) },
      onCheckpoint: (room, reason) => this.checkpoint(room, reason),
      isOwner: (code) => this.leases.isOwner(code),
    }
    this.deps = { leaveSocket: (socketId, code) => this.io.in(socketId).socketsLeave(code) }
    this.ready = this.start()
  }

  warn(e, msg, extra = {}) { this.logger.warn({ err: e?.message ?? String(e), ...extra }, msg) }

  async start() {
    await this.channel.start()
    await this.store.subscribe('events', (msg) => this.onClusterEvent(msg))
    this.leases.start()
    this.sweepTimer = setInterval(() => { void this.sweep() }, this.cfg.sweepIntervalMs)
    this.sweepTimer.unref()
    this.pruneTimer = setInterval(() => this.prune(), 15_000)
    this.pruneTimer.unref()
    this.logger.info({ lease_ttl_ms: this.cfg.leaseTtlMs, store: this.store.kind }, 'room cluster started')
  }

  // ------------------------------------------------------------------ ownership helpers
  canAct(code) { return this.leases.isOwner(code) }

  /** The room a user is in, cluster-wide (null if none). */
  async locate(userId) {
    return this.manager.userRoomCode(userId) ?? (await this.dir.userRoom(userId))
  }

  // ------------------------------------------------------------------ create / join (entry points for new membership)
  async createRoom(user, socketId) {
    await this.ready
    if (this.draining) throw new RoomError('UNAVAILABLE', 'The server is restarting, please try again in a moment')
    let code = null
    for (let i = 0; i < 50 && !code; i++) { const c = randomCode(); if (await this.dir.reserve(c)) code = c }
    if (!code) throw new RoomError('NO_CODE', 'Could not allocate a room code')
    let claimed = false
    try {
      const existing = await this.claimUser(user.id, code)
      if (existing) throw new RoomError('ALREADY_IN_ROOM', 'You are already in a room', existing)
      claimed = true
      const epoch = await this.leases.acquire(code)
      if (!epoch) throw new RoomError('NO_CODE', 'Could not allocate a room code')
      const room = this.manager.create(user, socketId, code)
      this.logger.info({ room_code: code, owner_epoch: epoch, playerId: user.id }, 'room created')
      return { ok: true, code, state: room.stateFor(user.id) }
    } catch (e) {
      this.manager.evict(code)?.halt()
      await this.leases.release(code)
      await this.dir.remove(code).catch(() => {})
      if (claimed) await this.dir.freeUser(user.id, code).catch(() => {})
      throw e
    }
  }

  /** Claim the user for `code`; a membership pointing at a room that no longer exists is stale and is dropped. */
  async claimUser(userId, code) {
    let existing = await this.dir.claimUser(userId, code)
    if (existing && existing !== code && !(await this.dir.exists(existing))) {
      await this.dir.freeUser(userId, existing)
      existing = await this.dir.claimUser(userId, code)
    }
    return existing
  }

  async joinRoom(code, user, socketId) {
    await this.ready
    if (this.draining) throw new RoomError('UNAVAILABLE', 'The server is restarting, please try again in a moment')
    if (!(await this.dir.exists(code))) throw new RoomError('ROOM_NOT_FOUND', 'No room with that code')
    const existing = await this.claimUser(user.id, code)
    if (existing && existing !== code) throw new RoomError('ALREADY_IN_ROOM', 'You are already in another room')
    const newlyClaimed = !existing
    let res
    try { res = await this.dispatch(code, user, socketId, 'join', {}) } catch (e) { if (newlyClaimed) await this.dir.freeUser(user.id, code).catch(() => {}); throw e }
    if (!res.ok && newlyClaimed) await this.dir.freeUser(user.id, code).catch(() => {})
    return res
  }

  /** Any command for the room the user is already in (ready/start/submit/kick/sync/leave/attach/detach). */
  async exec(user, socketId, type, payload = {}) {
    await this.ready
    const code = await this.locate(user.id)
    if (!code) {
      if (type === 'leave') return { ok: true }
      throw notInRoom()
    }
    return this.dispatch(code, user, socketId, type, payload)
  }

  // ------------------------------------------------------------------ forwarding
  /**
   * Run a command on the room's owner: locally when this instance owns it, otherwise over Redis with a request id.
   * The same id is reused on every retry, so the owner applies a command at most once (idempotency).
   */
  async dispatch(code, user, socketId, type, payload) {
    const id = CommandChannel.newId()
    const deadline = Date.now() + this.cfg.recoveryWaitMs
    let attempt = 0
    for (;;) {
      const owner = await this.dir.owner(code, { fresh: attempt > 0 })
      if (owner) {
        const env = { id, room: code, epoch: owner.epoch, user, socketId, type, payload }
        let res = null
        if (owner.instanceId === this.instanceId) {
          res = await this.handleCommand(env)
        } else {
          try {
            res = await this.channel.request(owner.instanceId, env, this.cfg.commandTimeoutMs)
            this.metrics?.commandsForwarded.inc({ result: 'ok' })
          } catch (e) {
            this.metrics?.commandsForwarded.inc({ result: 'timeout' })
            this.logger.warn({ command_id: id, room_code: code, owner_instance: owner.instanceId, type, attempt }, 'command to owner timed out')
            this.dir.invalidate(code)
          }
        }
        if (res && !RETRY_MARKERS.has(res.error)) return res
        if (res) this.dir.invalidate(code)
      } else if (!(await this.dir.exists(code))) {
        // the room is gone: forget the stale membership
        await this.dir.freeUser(user.id, code).catch(() => {})
        if (type === 'leave') return { ok: true }
        throw type === 'join' ? new RoomError('ROOM_NOT_FOUND', 'No room with that code') : notInRoom()
      }
      // no owner yet (failover in progress), or the owner changed: wait for the sweeper to re-elect, then retry
      if (Date.now() >= deadline) throw new RoomError('ROOM_UNAVAILABLE', 'The room is recovering, please try again in a moment')
      attempt++
      await sleep(Math.min(250, 50 * attempt))
    }
  }

  /** Executes a command on THIS instance (called locally or for a forwarded envelope). Idempotent per command id. */
  async handleCommand(env) {
    const { room: code, id } = env
    if (!this.leases.isOwner(code)) return { ok: false, error: 'NOT_OWNER' }
    if (env.epoch && env.epoch !== this.leases.epochOf(code)) return { ok: false, error: 'STALE_OWNER' }
    const key = `${code}|${id}`
    const seen = this.dedupe.get(key)
    if (seen) { this.logger.info({ command_id: id, room_code: code, type: env.type }, 'duplicate command ignored'); return seen.promise }

    const run = (async () => {
      const cmd = COMMANDS[env.type]
      if (!cmd) return { ok: false, error: 'BAD_REQUEST', message: 'Unknown command' }
      try {
        const room = this.manager.get(code)
        if (!room) return { ok: false, error: 'NOT_OWNER' } // lease held, room not loaded yet (adoption in progress)
        const mine = this.manager.findByUser(env.user.id)
        if (NEEDS_ROOM.has(env.type) && !(mine && mine.code === code)) throw notInRoom()
        return cmd({ manager: this.manager, room, user: env.user, socketId: env.socketId, code, payload: env.payload ?? {}, deps: this.deps })
      } catch (err) { return this.toAck(err) }
    })()
    // remember the (in-flight) result so a retried request with the same id cannot be applied twice
    this.dedupe.set(key, { at: Date.now(), promise: run })
    const result = await run
    if (RETRY_MARKERS.has(result.error)) this.dedupe.delete(key) // nothing was applied: a retry must run for real
    return result
  }

  toAck(err) {
    if (err instanceof RoomError) return { ok: false, error: err.code, message: err.message, ...(err.code === 'ALREADY_IN_ROOM' && err.data ? { code: err.data } : {}) }
    this.logger.error({ err: err.stack || err.message }, 'unexpected command error')
    return { ok: false, error: 'INTERNAL', message: 'Something went wrong' }
  }

  prune() {
    const cutoff = Date.now() - DEDUPE_TTL_MS
    for (const [k, v] of this.dedupe) if (v.at < cutoff) this.dedupe.delete(k)
  }

  // ------------------------------------------------------------------ snapshots
  checkpoint(room, reason) {
    const code = room.code
    if (this.removing.has(code) || !this.leases.isOwner(code)) return
    const version = (this.versions.get(code) ?? 0) + 1
    this.versions.set(code, version)
    this.enqueueSnapshot({ code, version, epoch: this.leases.epochOf(code), instanceId: this.instanceId, phase: room.state, state: room.serialize(), reason })
  }

  enqueueSnapshot(doc) {
    const code = doc.code
    let w = this.writers.get(code)
    if (!w) { w = { running: false, next: null, done: Promise.resolve() }; this.writers.set(code, w) }
    w.next = doc // only the newest pending snapshot matters
    if (!w.running) {
      w.running = true
      w.done = (async () => {
        try {
          while (w.next) {
            const d = w.next; w.next = null
            try {
              const ok = await this.snapshots.save(d)
              this.metrics?.snapshotWrites.inc({ result: ok ? 'ok' : 'fenced' })
              if (!ok) { this.logger.warn({ room_code: d.code, owner_epoch: d.epoch, version: d.version }, 'snapshot rejected: a newer owner exists'); this.handleLost(d.code, 'snapshot_fenced'); w.next = null }
            } catch (e) {
              this.metrics?.snapshotWrites.inc({ result: 'error' })
              this.warn(e, 'snapshot write failed', { room_code: d.code })
            }
          }
        } finally { w.running = false; if (!w.next && this.writers.get(code) === w) this.writers.delete(code) }
      })()
    }
  }

  async flushSnapshots() { await Promise.all([...this.writers.values()].map((w) => w.done)) }

  // ------------------------------------------------------------------ losing / ending rooms
  handleLost(code, reason) {
    this.metrics?.leaseLost.inc({ reason })
    this.leases.forget(code)
    const room = this.manager.evict(code)
    if (room) room.halt()
    this.versions.delete(code)
    const w = this.writers.get(code); if (w) w.next = null
    if (room) this.logger.warn({ room_code: code, reason }, 'room halted on this instance')
  }

  /** A room ended normally (everybody left / finished room expired): free everything it held in the cluster. */
  async onRoomRemoved(code) {
    this.removing.add(code)
    try {
      const w = this.writers.get(code); if (w) { w.next = null; await w.done }
      await this.dir.remove(code)
      await this.leases.release(code)
      await this.snapshots.delete(code)
      this.versions.delete(code)
    } catch (e) { this.warn(e, 'room cleanup failed', { room_code: code }) } finally { this.removing.delete(code) }
  }

  // ------------------------------------------------------------------ failover
  async sweep() {
    if (this.sweeping || this.draining) return
    this.sweeping = true
    try {
      const codes = await this.dir.list()
      for (const code of codes) {
        if (this.draining) break
        if (this.manager.get(code) || this.leases.owned.has(code)) continue
        if (await this.dir.owner(code, { fresh: true })) continue
        await this.adopt(code)
      }
    } catch (e) { this.warn(e, 'sweep failed') } finally { this.sweeping = false }
  }

  /** Become the owner of an orphaned room (idempotent: only one replica wins the lease) and resume it from its snapshot. */
  async adopt(code) {
    const t0 = Date.now()
    const epoch = await this.leases.acquire(code)
    if (!epoch) return false // another replica won the race
    try {
      const snap = await this.snapshots.load(code)
      if (!snap || snap.phase === 'finished') {
        // nothing to resume: free the room and its players
        for (const p of snap?.state?.players ?? []) await this.dir.freeUser(p.id, code).catch(() => {})
        await this.dir.remove(code); await this.leases.release(code); await this.snapshots.delete(code)
        this.metrics?.roomRecoveries.inc({ result: 'discarded' })
        this.logger.info({ room_code: code, reason: snap ? 'finished' : 'no_snapshot' }, 'orphaned room discarded')
        return false
      }
      const room = Room.restore(code, this.manager.roomDepsFor(code), snap.state)
      this.versions.set(code, snap.version)
      this.manager.adopt(room)
      room.resume() // fresh round deadline, reconnect grace for everybody, checkpoint under the new epoch
      room.broadcast('state:sync', { reason: 'owner_recovered', ownerEpoch: epoch, state: room.publicState() })
      this.metrics?.roomRecoveries.inc({ result: 'ok' })
      this.logger.info({ room_code: code, owner_epoch: epoch, phase: snap.phase, previous_owner: snap.instanceId, recovery_ms: Date.now() - t0 }, 'room adopted from snapshot')
      await this.store.publish('events', { type: 'adopted', code, instanceId: this.instanceId, epoch })
      return true
    } catch (e) {
      this.warn(e, 'adoption failed', { room_code: code })
      this.metrics?.roomRecoveries.inc({ result: 'error' })
      this.manager.evict(code)?.halt()
      await this.leases.release(code) // let another replica (or the next sweep) retry
      return false
    }
  }

  /** Every replica re-binds its own sockets of that room to the new owner. */
  onClusterEvent(msg) {
    if (msg?.type !== 'adopted') return
    for (const socket of this.io.of('/').sockets.values()) {
      if (socket.data.roomCode !== msg.code || !socket.data.user) continue
      this.exec(socket.data.user, socket.id, 'attach').then((res) => {
        if (!res.ok && res.error === 'NOT_IN_ROOM') socket.data.roomCode = null
      }).catch((e) => this.warn(e, 're-attach after failover failed', { room_code: msg.code }))
    }
  }

  // ------------------------------------------------------------------ health / lifecycle
  async checkReady() {
    const timeout = (p, ms = 1500) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))])
    const checks = {}
    try { await timeout(this.store.ping()); checks.redis = 'up' } catch { checks.redis = 'down' }
    try { await timeout(this.snapshots.ping()); checks.database = 'up' } catch { checks.database = 'down' }
    checks.draining = this.draining ? 'yes' : 'no'
    const ready = checks.redis === 'up' && checks.database === 'up' && !this.draining
    return { ready, checks }
  }

  /**
   * Controlled shutdown / rolling update: stop taking rooms, write a final snapshot of every owned room,
   * hand the leases back so a surviving replica can adopt immediately, and let in-flight work finish.
   */
  async drain() {
    if (this.draining) return
    this.draining = true
    clearInterval(this.sweepTimer)
    this.logger.info({ owned_rooms: this.leases.codes().length }, 'draining: handing rooms over')
    for (const code of this.leases.codes()) {
      const room = this.manager.get(code)
      try {
        if (room && this.leases.isOwner(code)) {
          room.halt()
          const version = (this.versions.get(code) ?? 0) + 1
          await this.snapshots.save({ code, version, epoch: this.leases.epochOf(code), instanceId: this.instanceId, phase: room.state, state: room.serialize(), reason: 'shutdown' })
          this.versions.set(code, version)
        }
      } catch (e) { this.warn(e, 'final snapshot failed', { room_code: code }) }
      this.manager.evict(code)
      await this.leases.release(code) // only releases while we still hold it (compare-and-release)
    }
    await this.flushSnapshots()
    await sleep(this.cfg.shutdownDrainMs) // let in-flight acknowledgements leave
  }

  async close() {
    clearInterval(this.sweepTimer); clearInterval(this.pruneTimer)
    this.leases.stop(); this.channel.close()
    await this.store.close?.()
  }
}

module.exports = { RoomCluster, COMMANDS }
