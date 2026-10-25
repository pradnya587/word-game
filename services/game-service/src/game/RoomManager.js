const crypto = require('crypto')
const { Room, RoomError } = require('./Room')

// No O/0/I/1/L so codes are easy to read out loud.
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'
const CODE_LENGTH = 6

function randomCode() {
  let code = ''
  for (let j = 0; j < CODE_LENGTH; j++) code += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)]
  return code
}

class RoomManager {
  // `rooms` only holds the rooms THIS instance currently owns; the cluster-wide view lives in coordination/directory.js.
  // hooks: { onUserFreed(userId, code), onRoomRemoved(code), onCheckpoint(room, reason) } - used by the cluster layer.
  constructor(roomDeps, hooks = {}) {
    this.roomDeps = roomDeps
    this.hooks = hooks
    this.rooms = new Map() // code -> Room
    this.userRoom = new Map() // userId -> code
  }

  roomDepsFor(code) {
    return {
      ...this.roomDeps,
      onEmpty: (c) => this.remove(c),
      onPlayerRemoved: (id) => { if (this.userRoom.get(id) === code) { this.userRoom.delete(id); this.hooks.onUserFreed?.(id, code) } },
      onCheckpoint: (room, reason) => this.hooks.onCheckpoint?.(room, reason),
      isOwner: this.hooks.isOwner ? (c) => this.hooks.isOwner(c) : undefined,
    }
  }

  /** Register a room rebuilt from a snapshot (failover). */
  adopt(room) {
    this.rooms.set(room.code, room)
    for (const p of room.players.values()) if (!p.left) this.userRoom.set(p.id, room.code)
    return room
  }

  /** Drop a room from this instance without any side effects (ownership lost / shutdown). */
  evict(code) {
    const room = this.rooms.get(code)
    if (!room) return null
    for (const id of room.players.keys()) if (this.userRoom.get(id) === code) this.userRoom.delete(id)
    this.rooms.delete(code)
    return room
  }

  generateCode() {
    for (let i = 0; i < 50; i++) {
      let code = ''
      for (let j = 0; j < CODE_LENGTH; j++) code += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)]
      if (!this.rooms.has(code)) return code
    }
    throw new RoomError('NO_CODE', 'Could not allocate a room code')
  }

  // `code` can be pre-allocated by the cluster layer (globally unique); otherwise a locally unique one is generated.
  create(user, socketId, code = null) {
    if (this.userRoom.has(user.id)) throw new RoomError('ALREADY_IN_ROOM', 'You are already in a room', this.userRoom.get(user.id))
    code = code || this.generateCode()
    const room = new Room(code, this.roomDepsFor(code))
    this.rooms.set(code, room)
    try { room.addPlayer(user, socketId) } catch (e) { this.rooms.delete(code); throw e }
    this.userRoom.set(user.id, code)
    this.roomDeps.metrics?.roomsCreated.inc()
    return room
  }

  join(code, user, socketId) {
    if (this.userRoom.has(user.id) && this.userRoom.get(user.id) !== code) {
      throw new RoomError('ALREADY_IN_ROOM', 'You are already in another room')
    }
    const room = this.rooms.get(code)
    if (!room) throw new RoomError('ROOM_NOT_FOUND', 'No room with that code')
    room.addPlayer(user, socketId)
    this.userRoom.set(user.id, code)
    return room
  }

  leave(userId) {
    const room = this.findByUser(userId)
    if (!room) return null
    room.removePlayer(userId, 'left') // also frees the user via onPlayerRemoved
    return room
  }

  findByUser(userId) {
    const code = this.userRoom.get(userId)
    return code ? this.rooms.get(code) ?? null : null
  }

  get(code) { return this.rooms.get(code) ?? null }
  userRoomCode(userId) { return this.userRoom.get(userId) ?? null }

  remove(code) {
    const room = this.rooms.get(code)
    if (!room) return
    for (const id of room.players.keys()) if (this.userRoom.get(id) === code) { this.userRoom.delete(id); this.hooks.onUserFreed?.(id, code) }
    this.rooms.delete(code)
    this.hooks.onRoomRemoved?.(code)
  }

  // For metrics
  stats() {
    let players = 0
    for (const r of this.rooms.values()) for (const p of r.players.values()) if (p.connected) players++
    return { rooms: this.rooms.size, players }
  }
}

module.exports = { RoomManager, CODE_ALPHABET, randomCode }
