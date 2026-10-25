# Architecture notes

## Components and data ownership
- **auth-service** owns `users` in `auth_db`. Passwords are hashed with bcrypt. Issues HS256 JWTs (7 days for users, 12 hours for guests).
- **game-service** owns live game state. Each room lives in memory on exactly ONE replica (its **owner**: `RoomManager` → `Room` state machine: lobby → round → intermission → … → finished) and is checkpointed to PostgreSQL (`game_db.room_snapshots`) at lobby changes, every round boundary, game end and graceful shutdown. Coordination (owner leases, room directory, command routing, Socket.IO adapter) uses Redis.
  Rooms are deleted 5 minutes after the game ends. Pure modules (`rounds.js`, `scoring.js`, `validator.js`) hold the rules and are unit tested; `Room`
  gets its clock, random numbers and dictionary injected, so tests run whole games with a fake clock.
- **stats-service** owns `games` and `game_players` in `stats_db` and builds the leaderboard with SQL aggregation.
- **Redis** carries one stream, `wordroyale:game.finished`, from game-service to stats-service (consumer group, ack after the database write).
- **gateway** is the only public container: routes by path prefix, upgrades WebSockets, rate-limits the auth endpoints.

Services share no tables and never call each other over HTTP. The only things they share are the JWT secret (to verify tokens) and the event format.

## Server-authoritative game
- Timer: game-service sets `endsAt = now + duration` and a server timer ends the round; submissions after `endsAt` are rejected even if the timer has not fired yet.
- Validation order: round active → player not eliminated → min length → round rule → dictionary → not already used.
- Duplicates are resolved at round end (provisional scores until then). A word submitted by several players is worth 0 to each.
- Elimination and tie-break are pure functions (`scoring.pickEliminated`); the tie-break rule that was used is sent to the clients as text. Elimination only happens while more than `MIN_ALIVE` (2) players are alive, so a game never ends early.
- Reconnect: the JWT is the identity. A returning socket for a user who is still in a room is re-attached and receives the full state; after 30 s without
  returning, the player is removed (mid-game: counted as eliminated) and the round continues without waiting.
- One connection per user: a second tab replaces the first (`session:replaced`).
- Word submissions are limited to 8 per second per socket.

## Failure behaviour
| Failure | Effect |
|---|---|
| stats-service down | games keep running; results wait in the Redis Stream and are stored when it returns |
| auth-service down | existing players keep playing (tokens are verified locally); nobody can log in or register until it returns |
| game-service replica dies | its rooms are adopted by a surviving replica from the last snapshot (typically within ~7 s, always inside 60 s); the interrupted round restarts; players reconnect through any replica |
| Redis down | coordination stops (new rooms/commands fail, `/ready` = 503); a replica steps its rooms down when their lease can no longer be renewed; finished-game events wait in the in-memory outbox and are retried every 5 s |
| PostgreSQL (game_db) down | `/ready` = 503; running rooms continue, snapshots are retried at the next checkpoint |

## Scaling and failover (game-service replicas)
```
 player ──► any replica (no stickiness) ──► command ──► owner replica (Redis lease + fencing epoch) ──► Room (unchanged rules)
                 ▲                                              │ snapshot on round boundaries (PostgreSQL, fenced by epoch)
                 └──── Socket.IO Redis adapter ◄── broadcasts ──┘
```
| Concern | Mechanism | Code |
|---|---|---|
| One owner per room | `SET NX PX` lease in Lua; compare-and-renew every 2 s (TTL 6 s); compare-and-release; epoch counter = fencing token | `coordination/leases.js`, `scripts.js` |
| Self-fencing | an owner stops acting `0.5 s` before its lease can expire elsewhere; renew failure = immediate step-down; snapshot writes are rejected for old epochs | `LeaseManager.isOwner`, `snapshots.js` |
| Global room codes / user->room | Redis set `wr:rooms` (atomic SADD), `wr:user:{id}:room` (SET NX) | `coordination/directory.js` |
| Command forwarding | Pub/Sub `cmd:{instance}` / `reply:{instance}`, request id reused on retry, owner dedupe cache (60 s) | `coordination/commands.js`, `cluster.js` |
| Cluster-wide sockets | `@socket.io/redis-adapter` with dedicated pub/sub connections; per-user session counter so the newest connection wins on any replica | `createGameServer.js`, `sockets/handlers.js` |
| Failover | sweeper (1 s) finds rooms without an owner, one replica wins the lease, loads the snapshot, restarts the saved round with a fresh deadline, broadcasts `state:sync`; other replicas re-attach their sockets | `RoomCluster.sweep/adopt` |
| Rolling update | SIGTERM: `/ready` -> 503, final snapshot, release leases, close sockets; clients reconnect and the room is adopted at once | `RoomCluster.drain`, `server.js` |

What survives a failure: players, host, totals, eliminations, the round definition. What is replayed: the round that was running restarts from its beginning (words of that round
are not restored). Decision recorded: this is the intended reading of "resume from the last round-boundary snapshot"; gameplay rules themselves are unchanged.
Standalone mode (no Redis; used by the unit tests) runs the same code with an in-memory store.

auth-service and stats-service are stateless and run one copy per VM; the stats consumer group gives each VM its own consumer name.

## Cloud layout (GCP, Terraform in `infra/terraform`)
One microservice = one immutable image (commit-SHA tag), identical across all replicas of that service. Each MIG VM runs the four service containers plus an instance-local nginx
that exposes a single port to the load balancer; data is in Cloud SQL (private IP) and Memorystore (private). See `docs/deployment-gcp.md`.

## Resource use (single VM, local compose)
About 9 containers; the Node services idle at roughly 60–100 MB each. An `e2-medium` (4 GB) VM is comfortable; `e2-small` (2 GB) is tight once Grafana and Prometheus run.
