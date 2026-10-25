# Socket.IO events (game-service)

Connect to the gateway origin, path `/socket.io`, with the JWT: `io(url, { auth: { token }, transports: ["websocket"] })`.
**WebSocket only** (server default `SOCKET_TRANSPORTS=websocket`; set `websocket,polling` to allow a long-polling fallback). Any game-service replica accepts any
player: there is **no session affinity**. The same signed JWT works on every replica (shared `JWT_SECRET`).
Every client → server event takes an optional acknowledgement callback and answers `{ ok: true, ... }` or
`{ ok: false, error: "CODE", message: "human readable" }`.

## Client → server
| Event | Payload | Ack |
|---|---|---|
| `room:create` | — | `{ ok, code, state }` |
| `room:join` | `{ code }` | `{ ok, code, state }` |
| `room:sync` | — | `{ ok, state }` (ask for the current state again) |
| `room:ready` | `{ ready: boolean }` | `{ ok }` |
| `room:kick` | `{ playerId }` (host, lobby only) | `{ ok }` |
| `game:start` | — (host only; needs ≥ 2 connected players; the ready flag is shown in the lobby but not enforced) | `{ ok }` |
| `word:submit` | `{ word }` | `{ ok, status: "accepted"\|"rejected", word, points, reason?, ... }` (same data as `word:result`) |
| `room:leave` | — | `{ ok }` |

Error codes: `BAD_CODE`, `NO_CODE`, `ROOM_NOT_FOUND`, `ROOM_FULL`, `GAME_IN_PROGRESS`, `ALREADY_IN_ROOM`, `NOT_IN_ROOM`, `NOT_HOST`,
`BAD_STATE`, `NOT_ENOUGH_PLAYERS`, `BAD_REQUEST`, `RATE_LIMITED`, `INTERNAL`, plus two cluster codes: `UNAVAILABLE` (this replica is draining, retry) and
`ROOM_UNAVAILABLE` (the room's owner is gone and a replica is taking it over; retry within a few seconds).

## Server → client
| Event | Payload |
|---|---|
| `room:state` | full public state: `{ code, state: "lobby"\|"round"\|"intermission"\|"finished", hostId, config, players: [{ id, username, guest, isHost, ready, connected, eliminated, eliminatedRound, totalScore }], round, serverTime }`. Sent on every change, and (with a `me` block: your words this round, chain letter, streak) when you reconnect |
| `player:joined` | `{ player }` |
| `player:left` | `{ playerId, username, reason }` (`left`, `kicked`, `disconnected`) |
| `room:kicked` | `{ code }` (to the kicked player) |
| `player:disconnected` | `{ playerId, graceMs }` — show the 30 s reconnect countdown |
| `player:reconnected` | `{ playerId }` |
| `round:start` | `{ round: 1..3, totalRounds, type, minLength, durationMs, startedAt, endsAt, serverTime, ...type fields }` — **drive the timer from `endsAt`**, correct for clock offset with `serverTime` |
| `word:result` | to the submitter only: `{ word, status, points, bonus?, provisional?, reason?, nextLetter? (word chain), streak? (speed round) }` |
| `score:update` | `{ round, provisional: true, scores: [{ playerId, roundScore, total }] }` — scores are provisional until `round:end` |
| `round:end` | `{ round, type, duplicates: [{ word, players }], finalScores: [{ playerId, roundScore, total, words: [{ word, points, duplicate }] }], eliminated: { playerId, username } \| null, tieBreak: { rule, text } \| null, survivors, nextRoundInMs, serverTime }` — `duplicates[].playerIds` lists who submitted the same word |
| `game:end` | `{ standings: [{ rank, playerId, username, guest, totalScore, eliminatedRound, bestWord, bestWordPoints, wordsCount, left }], winnerId, reason: "completed"\|"last_standing", serverTime }` |
| `session:replaced` | you opened the game in another tab/device (on any replica); this connection is closed |
| `state:sync` | **new, additive** - sent to the room after an owner failure: `{ reason: "owner_recovered", ownerEpoch, state }` with the authoritative public state. It is always followed by a fresh `round:start` (same round definition, new `endsAt`) when a round was running. Clients that ignore it keep working: they also receive `room:state` and `round:start` |

Round `type` fields:
- `wordChain` — `seedWord`, `chainLetter` (start your first word with it; after each accepted word use `nextLetter`)
- `letterBuilder` — `letters: ["A","E",...]`
- `speedRound` — `constraint: { contains: "R", minLength: 4 }`

Rejection reasons (shown to the player): `Too short (min N)`, `Doesn't start with X`, `Letter not available`, `Must contain X`,
`Not in dictionary`, `Already used`, `Round not active`, `You have been eliminated`.

## Internal event (game-service → stats-service, Redis Stream `wordroyale:game.finished`)
`game.finished`: `{ gameId, roomCode, startedAt, endedAt, roundsPlayed, totalRounds, reason, winnerId, players: [...same rows as game:end standings] }`.
Delivered at least once and stored idempotently by `gameId`; after 5 failed attempts an event moves to the dead-letter stream `wordroyale:game.finished.dead`.

## Cluster behaviour behind these events (no change to the contract above)
- Each room has one **owner** replica (Redis lease, fencing epoch). Commands from a socket on another replica are forwarded to the owner with a request id and the
  acknowledgement is routed back to that socket; a retried request id is applied once.
- Broadcasts use the Socket.IO Redis adapter, so `room:state`, `round:*`, `score:update`, `game:end` reach every connected player whichever replica holds the socket.
- Failover: if the owner disappears, a surviving replica adopts the room from its last round-boundary snapshot within one lease TTL (default 6 s + sweep interval),
  restarts the saved current round with a fresh server deadline and sends `state:sync`. Players keep their 30 s reconnect grace.
- Internal Redis keys/channels (`wr:room:{code}:owner`, `wr:rooms`, `wr:user:{id}:room`, `wr:cmd:{instance}`, `wr:reply:{instance}`, `wr:events`) are not a public contract.
