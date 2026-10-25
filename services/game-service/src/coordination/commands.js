const crypto = require('crypto')

/**
 * Request/acknowledgement routing between replicas over Redis Pub/Sub.
 *   cmd:{instanceId}    commands sent to the instance that owns a room
 *   reply:{instanceId}  acknowledgements sent back to the instance that holds the player's socket
 * Envelope: { id, room, epoch, user, socketId, type, payload, origin, sentAt }
 * The reply is { id, result } where `result` is exactly what the Socket.IO ack would have been.
 */
class CommandChannel {
  constructor({ store, instanceId, logger, handler }) {
    this.store = store
    this.instanceId = instanceId
    this.logger = logger
    this.handler = handler
    this.pending = new Map() // id -> { resolve, timer }
  }

  async start() {
    await this.store.subscribe(`cmd:${this.instanceId}`, (env) => { void this.onCommand(env) })
    await this.store.subscribe(`reply:${this.instanceId}`, (msg) => this.onReply(msg))
  }

  static newId() { return crypto.randomUUID() }

  /** Send to the owner and wait for its acknowledgement. Rejects with Error('TIMEOUT') if none arrives. */
  request(targetInstance, env, timeoutMs) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(env.id); reject(Object.assign(new Error('command timed out'), { code: 'TIMEOUT' })) }, timeoutMs)
      this.pending.set(env.id, { resolve, timer })
      this.store.publish(`cmd:${targetInstance}`, { ...env, origin: this.instanceId, sentAt: Date.now() }).catch((e) => {
        clearTimeout(timer); this.pending.delete(env.id); reject(e)
      })
    })
  }

  async onCommand(env) {
    let result
    try { result = await this.handler(env) } catch (e) {
      this.logger?.error({ command_id: env.id, room_code: env.room, err: e.message }, 'command handler crashed')
      result = { ok: false, error: 'INTERNAL', message: 'Something went wrong' }
    }
    try { await this.store.publish(`reply:${env.origin}`, { id: env.id, result }) } catch (e) { this.logger?.warn({ command_id: env.id, err: e.message }, 'could not send command reply') }
  }

  onReply({ id, result }) {
    const p = this.pending.get(id)
    if (!p) return // late reply for a request that already timed out or was retried
    clearTimeout(p.timer); this.pending.delete(id); p.resolve(result)
  }

  close() { for (const { timer } of this.pending.values()) clearTimeout(timer); this.pending.clear() }
}

module.exports = { CommandChannel }
