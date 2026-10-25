const { RoomError } = require('../game/Room')
const { verifyToken } = require('../auth')

// Small token bucket per socket so a bot cannot spam word:submit.
function makeLimiter(perSecond) {
  let tokens = perSecond
  let last = Date.now()
  return () => {
    const now = Date.now()
    tokens = Math.min(perSecond, tokens + ((now - last) / 1000) * perSecond)
    last = now
    if (tokens < 1) return false
    tokens -= 1
    return true
  }
}

const fail = (err, logger) => {
  if (err instanceof RoomError) return { ok: false, error: err.code, message: err.message, ...(err.code === 'ALREADY_IN_ROOM' && err.data ? { code: err.data } : {}) }
  logger.error({ err: err.stack || err.message }, 'unexpected handler error')
  return { ok: false, error: 'INTERNAL', message: 'Something went wrong' }
}

/**
 * Socket.IO entry point. This replica accepts ANY player; room commands are handed to RoomCluster, which runs them
 * locally when this replica owns the room and forwards them to the owning replica otherwise. Broadcasts reach every
 * replica through the Socket.IO Redis adapter, so a socket here receives events from a room owned elsewhere.
 */
function registerSocketHandlers(io, { cluster, config, logger, metrics }) {
  // ---- authentication (JWT issued by auth-service; the same secret is shared by every replica) ----
  io.use((socket, next) => {
    try {
      const token = socket.handshake.auth?.token || socket.handshake.query?.token
      if (!token) return next(new Error('unauthorized'))
      socket.data.user = verifyToken(String(token), config.jwtSecret)
      next()
    } catch {
      next(new Error('unauthorized'))
    }
  })

  io.on('connection', (socket) => {
    const user = socket.data.user
    metrics.wsConnections.inc()
    const canSubmit = makeLimiter(config.wordSubmitsPerSecond)
    const userRoom = `user:${user.id}`
    socket.join(userRoom) // lets any replica find every live socket of this user

    const handle = (event, fn) => socket.on(event, (payload, ack) => {
      if (typeof payload === 'function') { ack = payload; payload = {} }
      const done = typeof ack === 'function' ? ack : () => {}
      Promise.resolve()
        .then(() => fn(payload && typeof payload === 'object' ? payload : {}))
        .then(done, (err) => done(fail(err, logger)))
    })
    const joined = (code) => { socket.join(code); socket.data.roomCode = code }

    handle('room:create', async () => {
      const res = await cluster.createRoom(user, socket.id)
      joined(res.code)
      return res
    })

    handle('room:join', async ({ code }) => {
      const c = String(code ?? '').trim().toUpperCase()
      if (!/^[A-Z0-9]{6}$/.test(c)) throw new RoomError('BAD_CODE', 'Room codes are 6 characters')
      const res = await cluster.joinRoom(c, user, socket.id)
      if (res.ok) joined(res.code)
      return res
    })

    handle('room:sync', () => cluster.exec(user, socket.id, 'sync'))
    handle('room:ready', ({ ready }) => cluster.exec(user, socket.id, 'ready', { ready }))
    handle('room:kick', ({ playerId }) => cluster.exec(user, socket.id, 'kick', { playerId }))
    handle('game:start', () => cluster.exec(user, socket.id, 'start'))

    handle('word:submit', ({ word }) => {
      if (!canSubmit()) return { ok: false, error: 'RATE_LIMITED', message: 'Slow down' }
      return cluster.exec(user, socket.id, 'submit', { word })
    })

    handle('room:leave', async () => {
      const code = socket.data.roomCode
      const res = await cluster.exec(user, socket.id, 'leave')
      if (res.ok) { if (code) socket.leave(code); socket.data.roomCode = null }
      return res
    })

    socket.on('disconnect', (reason) => {
      metrics.wsConnections.dec()
      // 'server namespace disconnect' = we closed it because a newer connection of this user took over
      if (reason === 'server namespace disconnect') return
      cluster.exec(user, socket.id, 'detach', { socketId: socket.id }).catch((e) => {
        if (!(e instanceof RoomError)) logger.warn({ err: e.message, playerId: user.id }, 'detach failed')
      })
    })

    // ---- connection bootstrap (async): single live session per user, then re-attach to a room we are still in ----
    void (async () => {
      try {
        await cluster.ready
        // One live connection per user across ALL replicas: the newest connection replaces the older ones.
        socket.data.seq = await cluster.store.nextSession(user.id)
        for (const other of await io.in(userRoom).fetchSockets()) {
          if (other.id === socket.id || other.data?.seq === undefined) continue
          if (other.data.seq < socket.data.seq) { other.emit('session:replaced'); other.disconnect(true) }
          else { socket.emit('session:replaced'); socket.disconnect(true); return } // a newer connection already exists
        }
        if (socket.disconnected) return
        // Reconnect: if this user is still in a room (e.g. after a dropped connection), re-attach them.
        const code = await cluster.locate(user.id)
        if (!code || socket.disconnected) return
        socket.join(code)
        socket.data.roomCode = code
        const res = await cluster.exec(user, socket.id, 'attach')
        if (res.ok) logger.info({ room: code, room_code: code, playerId: user.id }, 'player reconnected')
        else logger.warn({ room_code: code, err: res.error }, 'reconnect failed')
      } catch (e) {
        if (e instanceof RoomError) logger.warn({ err: e.message, playerId: user.id }, 'reconnect failed')
        else logger.error({ err: e.stack || e.message }, 'connection bootstrap failed')
      }
    })()
  })
}

module.exports = { registerSocketHandlers }
