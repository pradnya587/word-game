/**
 * Room snapshots. Written by the room owner at controlled points (create/join/leave in the lobby, every round
 * boundary, game end, graceful shutdown) and read by whichever replica adopts an orphaned room.
 * Writes are fenced: a snapshot from an older owner epoch (or older version) never overwrites a newer one.
 */
class PgSnapshotStore {
  constructor(db) { this.kind = 'postgres'; this.db = db }

  /** @returns {Promise<boolean>} false when the write was rejected because a newer owner/version already wrote */
  async save({ code, version, epoch, instanceId, phase, state }) {
    const r = await this.db.query(
      `INSERT INTO room_snapshots (code, version, owner_epoch, owner_instance, phase, state, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb, now())
       ON CONFLICT (code) DO UPDATE SET version = EXCLUDED.version, owner_epoch = EXCLUDED.owner_epoch,
         owner_instance = EXCLUDED.owner_instance, phase = EXCLUDED.phase, state = EXCLUDED.state, updated_at = now()
       WHERE room_snapshots.owner_epoch < EXCLUDED.owner_epoch
          OR (room_snapshots.owner_epoch = EXCLUDED.owner_epoch AND room_snapshots.version < EXCLUDED.version)
     RETURNING owner_epoch, version`,
      [code, version, epoch, instanceId, phase, JSON.stringify(state)])
    // PostgreSQL returns no row when the fence rejected the write; also verify the stored row is the one we wrote.
    const row = r.rows[0]
    return !!row && Number(row.owner_epoch) === epoch && Number(row.version) === version
  }

  async load(code) {
    const { rows } = await this.db.query('SELECT code, version, owner_epoch, owner_instance, phase, state FROM room_snapshots WHERE code = $1', [code])
    if (!rows[0]) return null
    const r = rows[0]
    return { code: r.code, version: Number(r.version), epoch: Number(r.owner_epoch), instanceId: r.owner_instance, phase: r.phase, state: typeof r.state === 'string' ? JSON.parse(r.state) : r.state }
  }

  async delete(code) { await this.db.query('DELETE FROM room_snapshots WHERE code = $1', [code]) }
  async ping() { await this.db.query('SELECT 1'); return true }
  async close() { await this.db.end?.() }
}

// Same contract, in memory. Share one instance between several servers in a test to simulate the shared database.
class MemorySnapshotStore {
  constructor() { this.kind = 'memory'; this.rows = new Map() }
  async save({ code, version, epoch, instanceId, phase, state }) {
    const cur = this.rows.get(code)
    if (cur && !(cur.epoch < epoch || (cur.epoch === epoch && cur.version < version))) return false
    this.rows.set(code, { code, version, epoch, instanceId, phase, state: JSON.parse(JSON.stringify(state)) })
    return true
  }
  async load(code) { const r = this.rows.get(code); return r ? JSON.parse(JSON.stringify(r)) : null }
  async delete(code) { this.rows.delete(code) }
  async ping() { return true }
  async close() {}
}

module.exports = { PgSnapshotStore, MemorySnapshotStore }
