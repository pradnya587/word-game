const crypto = require('crypto')
const { newDb } = require('pg-mem')
const { migrate } = require('../src/db')

async function makeDb() {
  const { Pool } = newDb().adapters.createPg()
  const db = new Pool()
  await migrate(db)
  return db
}

// A finished-game event exactly as game-service publishes it.
function gameEvent({ endedAt = new Date().toISOString(), players, gameId = crypto.randomUUID(), roomCode = 'ABC234', reason = 'completed' }) {
  return {
    gameId, roomCode, startedAt: new Date(Date.parse(endedAt) - 150000).toISOString(), endedAt, roundsPlayed: 3, totalRounds: 3, reason,
    winnerId: players[0].playerId,
    players: players.map((p, i) => ({ rank: i + 1, guest: false, eliminatedRound: i === 0 ? null : 4 - i, bestWord: null, bestWordPoints: 0, wordsCount: 0, ...p })),
  }
}
const silent = { info() {}, warn() {}, error() {} }
module.exports = { makeDb, gameEvent, silent }
