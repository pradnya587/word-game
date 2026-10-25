# wordRoyale — real-time multiplayer word game (microservices)

Up to six players join a private room by code and play **3 rounds** against a server-controlled clock.
The lowest scorer is eliminated after **Round 1, Round 2 and Round 3**, but never below 2 players, so every game plays all three rounds.
The frontend is the same Next.js UI as before — only the backend was split into services.

```
Browser ──► gateway (nginx :80) ──┬─► frontend       Next.js UI
                                  ├─► auth-service   register / login / guest, issues JWTs      ─► Postgres auth_db
                                  ├─► stats-service  leaderboard, profile, match history        ─► Postgres stats_db
                                  └─► game-service   Socket.IO: rooms, rounds, timer, scoring   (N replicas; each room has one
                                            │            owner replica; snapshots ─► Postgres game_db)
                                            │ leases, directory, commands, adapter ─► Redis
                                            │ game.finished (Redis Stream)
                                            └──────────────► Redis ──────► stats-service
Prometheus scrapes /metrics on every service ─► Grafana dashboard
```

| Service | Port (internal) | Owns | Tech |
|---|---|---|---|
| gateway | 80 (public) | routing, WebSocket upgrade, rate limit | nginx |
| frontend | 3000 | UI | Next.js 16, TypeScript |
| auth-service | 4001 | `users` (auth_db) | Express, pg, bcryptjs, JWT |
| game-service | 4002 | live game state (owner replica, in memory) + `room_snapshots` (game_db) | Express, Socket.IO + Redis adapter, ioredis, pg |
| stats-service | 4003 | `games`, `game_players` (stats_db) | Express, pg, Redis Streams consumer |
| postgres / redis | 5432 / 6379 | data / event stream | |
| prometheus / grafana | 9090 / 3001 | metrics / dashboards | |

Why this split: login and the leaderboard are ordinary stateless request/response work, so they are separate services that can be
deployed, scaled and failed independently. The game itself (rooms, timers, validation, scoring, elimination) stays in **one** service
because it changes many times a second and must stay consistent — splitting it would only add network delay. The dictionary is a local
`words.txt` loaded into memory (as in the BRD). When a game ends, game-service publishes `game.finished` to a Redis Stream; stats-service
consumes it through a consumer group, so a result is never lost if stats-service is down.

## Run everything (Docker)

```bash
cp .env.example .env          # set JWT_SECRET, POSTGRES_PASSWORD, GRAFANA_ADMIN_PASSWORD
docker compose up -d --build
```

| What | URL |
|---|---|
| Game | http://localhost |
| Grafana dashboard "wordRoyale overview" | http://localhost:3001 (login from `.env`) |
| Prometheus | http://localhost:9090 |

Logs are structured JSON (with `service`, `instance_id`, `room_code`): `docker compose logs -f game-service`.

### Two game replicas on one machine (the "mini-cloud")

```bash
docker compose -f compose.local-cloud.yml up -d --build      # game-a + game-b behind nginx, Redis, Postgres, migrations, Prometheus, Grafana
node loadtest/bots.js --url http://localhost --rooms 3 --players 6   # rooms span both replicas
docker compose -f compose.local-cloud.yml stop game-a        # kill an owner: its rooms resume on game-b
```

Existing Postgres volumes do not re-run init scripts: create the new database once with
`docker compose exec postgres psql -U wordroyale -d postgres -c "CREATE DATABASE game_db;"`.

## Run a service on its own (development)

```bash
# infra only
docker compose up -d postgres redis
# a service (example)
cd services/game-service && npm install && JWT_SECRET=dev ALLOW_MEMORY_SNAPSHOTS=true npm run dev   # needs Redis; set DATABASE_URL to persist snapshots
# frontend alone (talks to the gateway or to services you started yourself)
cd frontend && cp .env.example .env.local && npm install && npm run dev
```

Each service has its own `package.json`, `Dockerfile`, tests and README-level config in `src/config.js` (all settings come from environment variables).

## Game rules (implemented in game-service)

| Round | Type | Time | Rule |
|---|---|---|---|
| 1 | Word chain | 45 s | Each word must start with the last letter of your previous word (first word: the last letter of the seed word) |
| 2 | Letter builder | 60 s | Build words from the shared rack of letters; each tile once |
| 3 | Speed round | 20 s | Words must contain the given letter and a minimum length; streak bonus |

- Every word: min length, round rule, dictionary check, not already used by you. Scores are **provisional** until the round ends.
- If two or more players submit the same word in a round, it scores **0 for all of them** (duplicate).
- After each round the lowest **total** score is eliminated. Ties: lower score this round → reached their score later → joined later.
- Elimination stops when 2 players are left (`MIN_ALIVE`), so every game plays all 3 rounds: with 6 players 5 → 4 → 3 remain, with 4 players 3 → 2 → 2, with 2 players nobody is eliminated and the higher total wins. (If everyone else leaves mid-game, the last player wins at once.)
- A player who disconnects has **30 s** to reconnect (same login) with their score intact; the round never waits for them.
- All timing uses the server clock: `round:start` carries `endsAt` and `serverTime`, and late words are rejected by the server.

Round lengths and other values can be changed with environment variables (`ROUND_DURATIONS_MS`, `INTERMISSION_MS`, `RECONNECT_GRACE_MS`).

## Tests

```bash
cd services/auth-service  && npm install && npm test     # register, login, guest, JWT, probes
cd services/game-service  && npm install && npm test     # 57 gameplay tests + lease/fencing, snapshot and room-restore tests; set REDIS_URL=redis://localhost:6379 to add the two-replica suite (forwarding, idempotency, failover, VM kill, drain)
cd services/stats-service && npm install && npm test     # leaderboard, consumer, probes (set REDIS_URL=redis://localhost:6379 to include the Redis Stream tests)
```

## Load test

```bash
cd loadtest && npm install
node bots.js --url http://localhost --rooms 10 --players 6 --think 900
```

Plays full games with bot players over real WebSockets through the gateway and prints throughput and word-submit latency percentiles.
Watch the Grafana dashboard while it runs. Tip: use short rounds on the server for a quick run
(`ROUND_DURATIONS_MS=8000,8000,5000 INTERMISSION_MS=2000`).

Stepped scale test, web load and failover probe (see `docs/evidence-runbook.md`):
`node scale.js --url https://<host> --label autoscaled-mig`, `node webload.js --url … --users 100`, `node failover-probe.js --url …`.

## CI/CD (.github/workflows/ci.yml) and Google Cloud

On every push/PR: tests for each service (with a Redis service container, so the two-replica suite runs), `npm audit`, frontend type-check/build, `terraform fmt`/`validate`.
On `main`: every service image is built, scanned with Trivy, pushed to **Artifact Registry** with an immutable commit-SHA tag, and a new instance template is rolled out
through the managed instance group (no SSH keys: GitHub authenticates with Workload Identity Federation). Infrastructure is Terraform in `infra/terraform`
(`base` stays, `environment` is disposable). Setup, rollback, security checklist and shared-responsibility table: **`docs/deployment-gcp.md`**; cost control and per-session
checklist: **`docs/cost-and-session-checklist.md`**; change-by-change status: **`docs/traceability.md`**.

## The pages

| Page | What it does |
|---|---|
| `/` | Landing page, login / sign-up / guest. **Create room** and **Join room** talk to game-service and open the room |
| `/room/ABC123` | The whole match on one route, switched by what the server reports: **lobby** (6 seats, copy code / invite link, ready, host starts, kick) → **game** (round stepper, server-driven timer ring, per-round play area, word input, live scoreboard, spectator mode, round-end overlay with duplicates and elimination) → **results** (podium, standings, stats, play again) |
| reconnect | If the connection drops, a blurred overlay shows the 30 s grace countdown; the page restores itself from the server when the connection returns |

Invite links (`/room/ABC123`) also work for people who are not logged in yet: they are sent to the home page and continue into the room after logging in or choosing guest.

## More

- `docs/architecture.md` — design decisions, data ownership, failure behaviour
- `docs/api.md` — REST endpoints
- `docs/events.md` — Socket.IO events and payloads (incl. cluster behaviour)
- `docs/deployment-gcp.md`, `docs/cost-and-session-checklist.md`, `docs/evidence-runbook.md`, `docs/traceability.md` — cloud deployment, cost, evidence, requirement traceability
