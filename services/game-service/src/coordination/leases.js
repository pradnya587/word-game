/**
 * Owner leases. Exactly one instance may own (and therefore mutate) a room at any time.
 *  - acquire: atomic SET NX PX in Redis (Lua) -> a fencing epoch that grows on every ownership change
 *  - renew:   compare-and-renew every `renewMs` (default 2 s) with a `ttlMs` (default 6 s) lease
 *  - release: compare-and-release, so a stale owner can never free a lease somebody else now holds
 * Self-fencing: an owner stops acting on a room `safetyMs` BEFORE its lease can expire in Redis (measured from the
 * moment the renew request was sent), and the moment a renew fails. A frozen/partitioned owner therefore steps down
 * before a replacement can be elected.
 */
class LeaseManager {
  constructor({ store, instanceId, ttlMs = 6000, renewMs = 2000, safetyMs = 500, logger, onLost = () => {}, now = () => Date.now() }) {
    this.store = store
    this.instanceId = instanceId
    this.ttlMs = ttlMs
    this.renewMs = renewMs
    this.safetyMs = Math.min(safetyMs, Math.floor(ttlMs / 4))
    this.logger = logger
    this.onLost = onLost
    this.now = now
    this.owned = new Map() // code -> { epoch, validUntil }
    this.timer = null
    this.renewing = false
    this.paused = false // test hook: simulate a frozen VM that no longer renews
  }

  start() {
    if (this.timer) return
    this.timer = setInterval(() => { void this.renewAll() }, this.renewMs)
    this.timer.unref()
  }
  stop() { clearInterval(this.timer); this.timer = null }

  /** Try to become the owner. Resolves to the new epoch, or 0 when another instance holds the lease. */
  async acquire(code) {
    const sentAt = this.now()
    const epoch = await this.store.acquireLease(code, this.instanceId, this.ttlMs)
    if (epoch) this.owned.set(code, { epoch, validUntil: sentAt + this.ttlMs })
    return epoch
  }

  /** True only while this instance can be sure nobody else owns the room. */
  isOwner(code) {
    const r = this.owned.get(code)
    return !!r && this.now() < r.validUntil - this.safetyMs
  }
  epochOf(code) { return this.owned.get(code)?.epoch ?? 0 }
  codes() { return [...this.owned.keys()] }

  /** Give the room up (graceful shutdown / room destroyed). Only releases a lease we still hold. */
  async release(code) {
    const r = this.owned.get(code)
    if (!r) return false
    this.owned.delete(code)
    try { return await this.store.releaseLease(code, this.instanceId, r.epoch) } catch (e) { this.logger?.warn({ room_code: code, err: e.message }, 'lease release failed'); return false }
  }

  /** Forget a lease without touching Redis (we already know it is lost). */
  forget(code) { this.owned.delete(code) }

  async renewAll() {
    if (this.renewing || this.paused) return
    this.renewing = true
    try {
      await Promise.all([...this.owned].map(async ([code, rec]) => {
        const sentAt = this.now()
        try {
          const ok = await this.store.renewLease(code, this.instanceId, rec.epoch, this.ttlMs)
          if (this.owned.get(code) !== rec) return // released/replaced while we were waiting
          if (ok) { rec.validUntil = sentAt + this.ttlMs; return }
          this.lose(code, rec, 'lease_taken_over')
        } catch (e) {
          // Redis unreachable: keep going only until the lease would have expired anyway.
          if (this.owned.get(code) === rec && this.now() >= rec.validUntil - this.safetyMs) this.lose(code, rec, 'lease_expired_redis_unreachable')
        }
      }))
    } finally { this.renewing = false }
  }

  lose(code, rec, reason) {
    this.owned.delete(code)
    this.logger?.warn({ room_code: code, owner_epoch: rec.epoch, reason }, 'room ownership lost')
    try { this.onLost(code, rec.epoch, reason) } catch (e) { this.logger?.error({ err: e.message }, 'onLost handler failed') }
  }
}

module.exports = { LeaseManager }
