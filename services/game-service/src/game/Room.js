const crypto = require('crypto')
const scoring = require('./scoring')
const rounds = require('./rounds')
const { validateWord } = require('./validator')

class RoomError extends Error {
  constructor(code, message, data) { super(message || code); this.code = code; this.data = data }
}

const TOTAL_ROUNDS = rounds.ROUND_TYPES.length

/**
 * One game room: lobby -> round(1..3) <-> intermission -> finished.
 * The server is the single source of truth: it owns the clock (endsAt), validates every word,
 * resolves duplicates and decides eliminations. Nothing here touches Socket.IO directly —
 * messages go out through `transport`, so the whole class is unit-testable with a fake clock.
 *
 * deps: { config, dictionary, clock:{now,setTimeout,clearTimeout}, transport:{broadcast(code,event,data), sendTo(socketId,event,data)},
 *         rng, createRound, publish(type,payload), metrics, logger, onEmpty(code) }
 */
class Room {
  constructor(code, deps) {
    this.code = code
    this.d = deps
    this.state = 'lobby' // lobby | round | intermission | finished
    this.players = new Map()
    this.hostId = null
    this.joinSeq = 0
    this.roundIndex = -1
    this.round = null
    this.gameId = null
    this.startedAt = null
    this.timer = null
    this.cleanupTimer = null
    this.lastRoundEnd = null
    this.destroyed = false
    this.fenced = false // set when this instance lost ownership: the room goes silent and timers are cancelled
    this.restoredRound = null
  }

  // ---------- helpers ----------
  get now() { return this.d.clock.now() }
  // A room only talks to clients while this instance still owns it (fencing against a stale owner).
  get active() { return !this.fenced && (this.d.isOwner ? this.d.isOwner(this.code) : true) }
  broadcast(event, data) { if (this.active) this.d.transport.broadcast(this.code, event, data) }
  sendTo(player, event, data) { if (player.socketId && this.active) this.d.transport.sendTo(player.socketId, event, data) }
  player(id) { const p = this.players.get(id); if (!p) throw new RoomError('NOT_IN_ROOM', 'You are not in this room'); return p }
  alive() { return [...this.players.values()].filter((p) => !p.eliminated) }
  connectedCount() { return [...this.players.values()].filter((p) => p.connected).length }
  setTimer(ms, fn) { this.clearTimer(); this.timer = this.d.clock.setTimeout(fn, ms) }
  clearTimer() { if (this.timer) { this.d.clock.clearTimeout(this.timer); this.timer = null } }
  // Tell the owner layer that the room reached a point worth persisting (see coordination/cluster.js).
  checkpoint(reason) { if (!this.destroyed && !this.fenced) this.d.onCheckpoint?.(this, reason) }

  // ---------- lobby ----------
  addPlayer({ id, username, guest }, socketId) {
    const existing = this.players.get(id)
    if (existing && !existing.left) throw new RoomError('ALREADY_IN_ROOM', 'You are already in this room', this.code)
    if (this.state !== 'lobby') throw new RoomError('GAME_IN_PROGRESS', 'This game has already started')
    if (this.players.size >= this.d.config.maxPlayers) throw new RoomError('ROOM_FULL', 'This room is full')
    const p = {
      id, username, guest: !!guest, socketId, connected: true, ready: false, joinedAt: ++this.joinSeq,
      eliminated: false, eliminatedRound: null, left: false, total: 0, roundScore: 0, lastScoreAt: Infinity,
      graceTimer: null, bestWord: null, wordsCount: 0,
    }
    this.players.set(id, p)
    if (!this.hostId) this.hostId = id
    this.broadcast('player:joined', { player: this.publicPlayer(p) })
    this.broadcastState()
    return p
  }

  setReady(id, ready) {
    const p = this.player(id)
    if (this.state !== 'lobby') throw new RoomError('BAD_STATE', 'The game has already started')
    p.ready = ready === undefined ? !p.ready : !!ready
    this.broadcastState()
  }

  kick(hostId, targetId) {
    if (hostId !== this.hostId) throw new RoomError('NOT_HOST', 'Only the host can remove players')
    if (this.state !== 'lobby') throw new RoomError('BAD_STATE', 'Players can only be removed in the lobby')
    if (targetId === hostId) throw new RoomError('BAD_REQUEST', 'The host cannot remove themselves')
    const target = this.player(targetId)
    this.sendTo(target, 'room:kicked', { code: this.code })
    this.removePlayer(targetId, 'kicked')
    return target
  }

  // Remove a player completely (leave / kick / grace expired).
  removePlayer(id, reason = 'left') {
    const p = this.players.get(id)
    if (!p) return
    if (p.graceTimer) { this.d.clock.clearTimeout(p.graceTimer); p.graceTimer = null }
    this.d.onPlayerRemoved?.(id) // frees the user to create/join another room

    if (this.state === 'lobby' || this.state === 'finished') {
      this.players.delete(id)
      this.broadcast('player:left', { playerId: id, username: p.username, reason })
      if (![...this.players.values()].some((x) => !x.left)) return this.destroy()
      if (this.hostId === id) this.hostId = this.pickNewHost()
      return this.broadcastState()
    }

    // mid-game: the player forfeits and stays in the standings as eliminated
    p.connected = false
    p.left = true
    p.socketId = null
    if (!p.eliminated) { p.eliminated = true; p.eliminatedRound = this.roundIndex + 1 }
    this.broadcast('player:left', { playerId: id, username: p.username, reason })
    if (this.hostId === id) this.hostId = this.pickNewHost()
    if (this.alive().length <= 1) return this.endGameEarly()
    this.broadcastState()
  }

  pickNewHost() {
    const candidates = [...this.players.values()].filter((p) => !p.left).sort((a, b) => (b.connected - a.connected) || (a.joinedAt - b.joinedAt))
    return candidates[0]?.id ?? null
  }

  // ---------- connection handling ----------
  markDisconnected(id) {
    const p = this.players.get(id)
    if (!p || p.left || !p.connected) return
    p.connected = false
    p.socketId = null
    const graceMs = this.d.config.reconnectGraceMs
    this.broadcast('player:disconnected', { playerId: id, graceMs })
    p.graceTimer = this.d.clock.setTimeout(() => {
      p.graceTimer = null
      this.d.logger.info({ room: this.code, room_code: this.code, playerId: id }, 'reconnect grace expired')
      this.removePlayer(id, 'disconnected')
    }, graceMs)
    this.broadcastState()
  }

  reconnect(id, socketId) {
    const p = this.player(id)
    if (p.left) throw new RoomError('NOT_IN_ROOM', 'You are no longer in this room')
    if (p.graceTimer) { this.d.clock.clearTimeout(p.graceTimer); p.graceTimer = null }
    p.socketId = socketId
    const wasDisconnected = !p.connected
    p.connected = true
    if (wasDisconnected) this.broadcast('player:reconnected', { playerId: id })
    this.sendTo(p, 'room:state', this.stateFor(id))
    return p
  }

  // ---------- game flow ----------
  start(hostId) {
    if (hostId !== this.hostId) throw new RoomError('NOT_HOST', 'Only the host can start the game')
    if (this.state !== 'lobby') throw new RoomError('BAD_STATE', 'The game has already started')
    if (this.connectedCount() < this.d.config.minPlayers) {
      throw new RoomError('NOT_ENOUGH_PLAYERS', `At least ${this.d.config.minPlayers} players are needed`)
    }
    // players who dropped while in the lobby do not take part
    for (const p of [...this.players.values()]) if (!p.connected) this.removePlayer(p.id, 'disconnected')
    this.gameId = crypto.randomUUID()
    this.startedAt = this.now
    for (const p of this.players.values()) { p.total = 0; p.roundScore = 0; p.eliminated = false; p.eliminatedRound = null }
    this.d.metrics?.gamesStarted.inc()
    this.d.logger.info({ room: this.code, room_code: this.code, gameId: this.gameId, players: this.players.size }, 'game started')
    this.startRound(0)
  }

  startRound(index, savedDef = null) {
    this.roundIndex = index
    const def = savedDef ?? this.d.createRound(index, { rng: this.d.rng, dictionary: this.d.dictionary, config: this.d.config })
    const startedAt = this.now
    this.round = { index, def, startedAt, endsAt: startedAt + def.durationMs, players: new Map() }
    for (const p of this.alive()) {
      p.roundScore = 0
      p.lastScoreAt = Infinity
      this.round.players.set(p.id, rounds.newPlayerRoundState(def))
    }
    this.state = 'round'
    this.broadcast('round:start', this.roundPayload())
    this.setTimer(def.durationMs, () => this.endRound())
    this.checkpoint('round_start')
  }

  roundPayload() {
    const r = this.round
    return { round: r.index + 1, totalRounds: TOTAL_ROUNDS, ...r.def.public, durationMs: r.def.durationMs, startedAt: r.startedAt, endsAt: r.endsAt, serverTime: this.now }
  }

  submitWord(id, raw) {
    const t0 = process.hrtime.bigint()
    const p = this.player(id)
    const reply = (res) => {
      this.sendTo(p, 'word:result', res)
      this.d.metrics?.submitDuration.observe(Number(process.hrtime.bigint() - t0) / 1e9)
      this.d.metrics?.words.inc({ result: res.status, reason: res.status === 'accepted' ? 'ok' : res.reason })
      return res
    }
    const word = String(raw ?? '').trim().toLowerCase()
    const reject = (reason) => reply({ word, status: 'rejected', points: 0, reason })

    // The server clock decides: a word that arrives after endsAt is too late even if the end timer has not fired yet.
    if (this.state !== 'round' || this.now >= this.round.endsAt) return reject('Round not active')
    if (p.eliminated) return reject('You have been eliminated')
    const st = this.round.players.get(id)
    if (!st) return reject('You have been eliminated')

    const v = validateWord(raw, this.round.def, st, this.d.dictionary)
    if (!v.ok) { st.streak = 0; return reject(v.reason) }

    st.used.add(v.word)
    st.streak += 1
    let points = scoring.wordPoints(v.word)
    let bonus = 0
    if (this.round.def.type === 'speedRound') { bonus = scoring.streakBonus(st.streak); points += bonus }
    st.words.push({ word: v.word, points, at: this.now - this.round.startedAt })
    if (this.round.def.type === 'wordChain') st.chainLetter = v.word[v.word.length - 1]
    p.roundScore = st.words.reduce((s, w) => s + w.points, 0)

    const res = reply({
      word: v.word, status: 'accepted', points, bonus, provisional: true,
      nextLetter: this.round.def.type === 'wordChain' ? st.chainLetter.toUpperCase() : undefined,
      streak: this.round.def.type === 'speedRound' ? st.streak : undefined,
    })
    this.broadcast('score:update', { round: this.round.index + 1, provisional: true, scores: this.provisionalScores() })
    return res
  }

  provisionalScores() {
    return [...this.players.values()].map((p) => ({ playerId: p.id, roundScore: this.round && !p.eliminated ? p.roundScore : 0, total: p.total + (this.round && !p.eliminated ? p.roundScore : 0) }))
  }

  endRound({ aborted = false } = {}) {
    if (this.state !== 'round') return
    this.clearTimer()
    const r = this.round
    const entries = [...r.players].filter(([id]) => !this.players.get(id).left).map(([playerId, st]) => ({ playerId, words: st.words }))
    const { duplicates, results } = scoring.resolveDuplicates(entries)

    for (const [playerId, res] of results) {
      const p = this.players.get(playerId)
      p.roundScore = res.roundScore
      p.lastScoreAt = res.lastScoreAt
      p.total += res.roundScore
      p.wordsCount += res.words.filter((w) => w.points > 0).length
      for (const w of res.words) {
        if (w.points > 0 && (!p.bestWord || w.points > p.bestWord.points || (w.points === p.bestWord.points && w.word.length > p.bestWord.word.length))) {
          p.bestWord = { word: w.word, points: w.points }
        }
      }
    }

    let eliminated = null
    let tieBreak = null
    const alive = this.alive()
    // Keep at least `minAlive` players (default 2) in the game, so every game plays all 3 rounds.
    if (!aborted && alive.length > (this.d.config.minAlive ?? 2)) {
      const pick = scoring.pickEliminated(alive.map((p) => ({ id: p.id, total: p.total, roundScore: p.roundScore, lastScoreAt: p.lastScoreAt, joinedAt: p.joinedAt })))
      const out = this.players.get(pick.id)
      out.eliminated = true
      out.eliminatedRound = r.index + 1
      eliminated = { playerId: out.id, username: out.username }
      tieBreak = pick.tieBreak ? { rule: pick.tieBreak, text: scoring.TIE_BREAK_TEXT[pick.tieBreak] } : null
    }

    this.broadcast('round:end', {
      round: r.index + 1, type: r.def.type, duplicates,
      finalScores: [...results].map(([playerId, res]) => ({ playerId, roundScore: res.roundScore, total: this.players.get(playerId).total, words: res.words.map(({ word, points, duplicate }) => ({ word, points, duplicate })) })),
      eliminated, tieBreak,
      survivors: this.alive().map((p) => p.id),
      nextRoundInMs: this.d.config.intermissionMs,
      serverTime: this.now,
    })
    this.d.metrics?.roundsCompleted.inc({ type: r.def.type })

    const lastRound = r.index === TOTAL_ROUNDS - 1
    if (aborted || lastRound || this.alive().length <= 1) return this.finishGame(aborted ? 'last_standing' : lastRound ? 'completed' : 'last_standing')
    this.state = 'intermission'
    this.lastRoundEnd = this.now
    this.setTimer(this.d.config.intermissionMs, () => this.startRound(r.index + 1))
    this.checkpoint('round_end')
  }

  // Everyone else left: the remaining player wins.
  endGameEarly() {
    if (this.alive().length === 0) { this.d.logger.info({ room: this.code }, 'all players gone, room abandoned'); return this.destroy() }
    if (this.state === 'round') return this.endRound({ aborted: true })
    if (this.state === 'intermission') { this.clearTimer(); return this.finishGame('last_standing') }
    this.broadcastState()
  }

  finishGame(reason) {
    this.clearTimer()
    this.state = 'finished'
    const standings = scoring.buildStandings([...this.players.values()].map((p) => ({
      id: p.id, total: p.total, roundScore: p.roundScore, lastScoreAt: p.lastScoreAt, joinedAt: p.joinedAt, eliminatedRound: p.eliminated ? p.eliminatedRound : null,
    })))
    const pl = (id) => this.players.get(id)
    const rows = standings.map((s) => ({
      rank: s.rank, playerId: s.id, username: pl(s.id).username, guest: pl(s.id).guest, totalScore: s.total,
      eliminatedRound: s.eliminatedRound, bestWord: pl(s.id).bestWord?.word ?? null, bestWordPoints: pl(s.id).bestWord?.points ?? 0,
      wordsCount: pl(s.id).wordsCount, left: pl(s.id).left,
    }))
    const winnerId = rows[0]?.playerId ?? null
    this.broadcast('game:end', { standings: rows, winnerId, reason, serverTime: this.now })
    this.d.metrics?.gamesFinished.inc({ reason })
    if (this.active) this.d.publish('game.finished', {
      gameId: this.gameId, roomCode: this.code, startedAt: new Date(this.startedAt).toISOString(), endedAt: new Date(this.now).toISOString(),
      roundsPlayed: this.round.index + 1, totalRounds: TOTAL_ROUNDS, reason, winnerId, players: rows,
    })
    this.d.logger.info({ room: this.code, room_code: this.code, gameId: this.gameId, winnerId, reason }, 'game finished')
    this.cleanupTimer = this.d.clock.setTimeout(() => this.destroy(), this.d.config.finishedRoomTtlMs)
    this.broadcastState()
  }

  destroy() {
    this.destroyed = true
    this.clearTimer()
    if (this.cleanupTimer) { this.d.clock.clearTimeout(this.cleanupTimer); this.cleanupTimer = null }
    for (const p of this.players.values()) if (p.graceTimer) this.d.clock.clearTimeout(p.graceTimer)
    this.d.onEmpty?.(this.code)
  }

  // ---------- views ----------
  publicPlayer(p) {
    return {
      id: p.id, username: p.username, guest: p.guest, isHost: p.id === this.hostId, ready: p.ready, connected: p.connected,
      eliminated: p.eliminated, eliminatedRound: p.eliminatedRound, totalScore: p.total + (this.state === 'round' && !p.eliminated ? p.roundScore : 0),
    }
  }

  publicState() {
    return {
      code: this.code, state: this.state, hostId: this.hostId,
      config: { minPlayers: this.d.config.minPlayers, maxPlayers: this.d.config.maxPlayers, totalRounds: TOTAL_ROUNDS },
      players: [...this.players.values()].sort((a, b) => a.joinedAt - b.joinedAt).map((p) => this.publicPlayer(p)),
      round: this.state === 'round' ? this.roundPayload() : null,
      serverTime: this.now,
    }
  }

  // State for one player: the public state plus what only they should see (their own words this round).
  stateFor(id) {
    const base = this.publicState()
    const st = this.round && this.state === 'round' ? this.round.players.get(id) : null
    return { ...base, me: { playerId: id, words: st ? st.words.map((w) => ({ word: w.word, points: w.points })) : [], chainLetter: st?.chainLetter?.toUpperCase() ?? null, streak: st?.streak ?? 0 } }
  }

  broadcastState() { this.broadcast('room:state', this.publicState()); this.checkpoint('state') }

  // ---------- persistence / failover (no game rules in here) ----------
  /** Plain-JSON copy of everything needed to rebuild the room on another instance. */
  serialize() {
    return {
      v: 1, code: this.code, state: this.state, hostId: this.hostId, joinSeq: this.joinSeq, roundIndex: this.roundIndex,
      gameId: this.gameId, startedAt: this.startedAt, lastRoundEnd: this.lastRoundEnd,
      round: this.state === 'round' && this.round ? { index: this.round.index, def: this.round.def } : null,
      players: [...this.players.values()].map((p) => ({
        id: p.id, username: p.username, guest: p.guest, ready: p.ready, joinedAt: p.joinedAt, eliminated: p.eliminated,
        eliminatedRound: p.eliminatedRound, left: p.left, total: p.total, roundScore: p.roundScore,
        lastScoreAt: Number.isFinite(p.lastScoreAt) ? p.lastScoreAt : null, bestWord: p.bestWord, wordsCount: p.wordsCount,
      })),
    }
  }

  static restore(code, deps, snap) {
    const room = new Room(code, deps)
    room.state = snap.state; room.hostId = snap.hostId; room.joinSeq = snap.joinSeq; room.roundIndex = snap.roundIndex
    room.gameId = snap.gameId; room.startedAt = snap.startedAt; room.lastRoundEnd = snap.lastRoundEnd
    room.restoredRound = snap.round
    // finishGame() only needs the index of the last round that was played
    if (snap.state === 'intermission') room.round = { index: snap.roundIndex, players: new Map() }
    for (const sp of snap.players) {
      room.players.set(sp.id, {
        id: sp.id, username: sp.username, guest: sp.guest, socketId: null, connected: false, ready: sp.ready, joinedAt: sp.joinedAt,
        eliminated: sp.eliminated, eliminatedRound: sp.eliminatedRound, left: sp.left, total: sp.total, roundScore: sp.roundScore,
        lastScoreAt: sp.lastScoreAt ?? Infinity, graceTimer: null, bestWord: sp.bestWord, wordsCount: sp.wordsCount,
      })
    }
    return room
  }

  /**
   * Continue a restored room. Nobody is connected to it yet, so every player gets the normal reconnect grace period;
   * a round that was running restarts with its saved definition and a fresh server deadline.
   */
  resume() {
    const graceMs = this.d.config.reconnectGraceMs
    for (const p of this.players.values()) {
      if (p.left) continue
      p.graceTimer = this.d.clock.setTimeout(() => { p.graceTimer = null; this.removePlayer(p.id, 'disconnected') }, graceMs)
    }
    if (this.state === 'round' && this.restoredRound) this.startRound(this.roundIndex, this.restoredRound.def)
    else if (this.state === 'intermission') this.setTimer(this.d.config.intermissionMs, () => this.startRound(this.roundIndex + 1))
    this.restoredRound = null
    this.broadcastState()
  }

  /** Stop all activity (ownership lost or controlled shutdown). Nothing is broadcast, published or persisted afterwards. */
  halt() {
    this.fenced = true
    this.clearTimer()
    if (this.cleanupTimer) { this.d.clock.clearTimeout(this.cleanupTimer); this.cleanupTimer = null }
    for (const p of this.players.values()) if (p.graceTimer) { this.d.clock.clearTimeout(p.graceTimer); p.graceTimer = null }
  }
}

module.exports = { Room, RoomError, TOTAL_ROUNDS }
