const Redis = require('ioredis')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * Reads game events from a Redis Stream through a consumer group.
 *  - at-least-once: a message is acknowledged (XACK) only after the handler succeeded
 *  - messages that failed stay pending and are retried; after N attempts they go to a dead-letter stream
 *  - if stats-service was down, everything published meanwhile is processed on start-up
 */
class StreamConsumer {
  constructor({ redisUrl, stream, group, consumer, deadLetter, maxAttempts = 5, handler, logger, onResult = () => {}, blockMs = 5000, retryDelayMs = 2000 }) {
    Object.assign(this, { stream, group, consumer, deadLetter, maxAttempts, handler, logger, onResult, blockMs, retryDelayMs })
    this.redis = new Redis(redisUrl, { maxRetriesPerRequest: null, retryStrategy: (n) => Math.min(n * 500, 5000) })
    this.redis.on('error', (e) => logger.warn({ err: e.message }, 'redis error'))
    this.attempts = new Map()
    this.running = false
  }

  get up() { return this.running && this.redis.status === 'ready' }

  async start() {
    try { await this.redis.xgroup('CREATE', this.stream, this.group, '0', 'MKSTREAM') }
    catch (e) { if (!String(e.message).includes('BUSYGROUP')) throw e }
    this.running = true
    this.loop = this.run()
  }

  async run() {
    let pending = true // first drain our own unacknowledged messages, then switch to new ones
    while (this.running) {
      try {
        const res = await this.redis.xreadgroup('GROUP', this.group, this.consumer, 'COUNT', 10, 'BLOCK', this.blockMs, 'STREAMS', this.stream, pending ? '0' : '>')
        const entries = res?.[0]?.[1] ?? []
        if (pending && entries.length === 0) { pending = false; continue }
        let failed = false
        for (const [id, fields] of entries) {
          if (!(await this.process(id, fields))) failed = true
        }
        if (failed) { pending = true; await sleep(this.retryDelayMs) }
      } catch (err) {
        if (!this.running) break
        this.logger.warn({ err: err.message }, 'consumer loop error, retrying')
        await sleep(this.retryDelayMs)
      }
    }
  }

  async process(id, fields) {
    const msg = {}
    for (let i = 0; i < fields.length; i += 2) msg[fields[i]] = fields[i + 1]
    try {
      if (msg.type !== 'game.finished') { this.logger.warn({ id, type: msg.type }, 'ignoring unknown event type'); await this.redis.xack(this.stream, this.group, id); return true }
      const payload = JSON.parse(msg.data)
      const stored = await this.handler(payload)
      await this.redis.xack(this.stream, this.group, id)
      this.attempts.delete(id)
      this.onResult(stored ? 'stored' : 'duplicate')
      this.logger.info({ id, gameId: payload.gameId, stored }, 'game event processed')
      return true
    } catch (err) {
      const n = (this.attempts.get(id) || 0) + 1
      this.attempts.set(id, n)
      this.logger.error({ id, attempt: n, err: err.message }, 'failed to process game event')
      if (n >= this.maxAttempts || err instanceof SyntaxError || /^event /.test(err.message)) {
        // poison message: park it so it cannot block the stream
        await this.redis.xadd(this.deadLetter, '*', 'orig_id', id, 'error', err.message, ...fields)
        await this.redis.xack(this.stream, this.group, id)
        this.attempts.delete(id)
        this.onResult('dead_letter')
        return true
      }
      this.onResult('error')
      return false
    }
  }

  async stop() { this.running = false; this.redis.disconnect(); await Promise.race([this.loop, sleep(500)]) }
}
module.exports = { StreamConsumer }
