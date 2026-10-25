const Redis = require('ioredis')

/**
 * Publishes domain events (currently only game.finished) to a Redis Stream.
 * stats-service reads the stream through a consumer group, so an event is never lost
 * if stats-service is down — it waits in Redis until the consumer is back.
 * If Redis itself is unreachable the event is kept in a small in-memory outbox and retried.
 */
class RedisEventBus {
  constructor({ url, stream, logger, metrics, maxOutbox = 1000 }) {
    this.stream = stream
    this.logger = logger
    this.metrics = metrics
    this.outbox = []
    this.maxOutbox = maxOutbox
    this.redis = new Redis(url, { maxRetriesPerRequest: 3, retryStrategy: (n) => Math.min(n * 500, 5000) })
    this.redis.on('error', (e) => logger.warn({ err: e.message }, 'redis error'))
    this.flushing = false
    this.timer = setInterval(() => this.flush(), 5000)
    this.timer.unref()
  }

  get connected() { return this.redis.status === 'ready' }

  publish(type, payload) {
    if (this.outbox.length >= this.maxOutbox) this.outbox.shift()
    this.outbox.push({ type, payload })
    this.flush()
  }

  async flush() {
    if (this.flushing) return
    this.flushing = true
    try {
      while (this.outbox.length) {
        const { type, payload } = this.outbox[0]
        await this.redis.xadd(this.stream, 'MAXLEN', '~', 10000, '*', 'type', type, 'data', JSON.stringify(payload))
        this.outbox.shift()
        this.metrics?.eventsPublished.inc({ type, result: 'ok' })
        this.logger.info({ type, gameId: payload.gameId }, 'event published')
      }
    } catch (err) {
      this.metrics?.eventsPublished.inc({ type: this.outbox[0]?.type ?? 'unknown', result: 'error' })
      this.logger.warn({ err: err.message, pending: this.outbox.length }, 'could not publish event, will retry')
    } finally {
      this.flushing = false
    }
  }

  async close() { clearInterval(this.timer); await this.flush(); this.redis.disconnect() }
}

// Used in tests / when no Redis is wanted.
class MemoryEventBus {
  constructor() { this.events = []; this.connected = true }
  publish(type, payload) { this.events.push({ type, payload }) }
  async close() {}
}

module.exports = { RedisEventBus, MemoryEventBus }
