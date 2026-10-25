/**
 * Cluster-wide room directory: which room codes exist, who owns each one, and which room every user is in.
 * Everything lives in the store (Redis), so any replica can answer "where is room ABC123?".
 */
class RoomDirectory {
  constructor({ store, ownerCacheMs = 300 }) {
    this.store = store
    this.ownerCacheMs = ownerCacheMs
    this.cache = new Map() // code -> { at, owner }
  }

  /** Reserve a globally unique room code. */
  async reserve(code) { return this.store.reserveCode(code) }
  async exists(code) { return this.store.roomExists(code) }
  async list() { return this.store.listRooms() }
  async remove(code) { this.cache.delete(code); await this.store.removeRoom(code) }

  async owner(code, { fresh = false } = {}) {
    const hit = this.cache.get(code)
    if (!fresh && hit && Date.now() - hit.at < this.ownerCacheMs) return hit.owner
    const owner = await this.store.getOwner(code)
    this.cache.set(code, { at: Date.now(), owner })
    return owner
  }
  invalidate(code) { this.cache.delete(code) }

  /** null = claimed for this room; otherwise the code of the room the user is already in. */
  async claimUser(userId, code) { return this.store.claimUser(userId, code) }
  async userRoom(userId) { return this.store.getUserRoom(userId) }
  async freeUser(userId, code) { return this.store.clearUser(userId, code) }
  async touchUsers(ids) { return this.store.touchUsers(ids) }
}

module.exports = { RoomDirectory }
