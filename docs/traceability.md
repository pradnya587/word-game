# Traceability: change report → implementation → verification

Scope: BRD v2.1 alignment, **existing four-service architecture retained, gameplay excluded** (round count/numbering/modes, minimum players, scoring, elimination, timers are unchanged on purpose).
Approved deviations recorded: the BRD's "same immutable container image" (CR-05) is read as *one immutable image per microservice, identical across replicas of that service*; CR-14 allows a separate frontend container; D2/D3 are in `docs/deployment-gcp.md`.

Legend: **Tested** = automated test in this repo passed in the authoring environment (Node 22 + real Redis 7; Postgres emulated by pg-mem). **Implemented** = code/config written and syntax-checked, **not executed** (needs Docker/GCP/CI). 

| ID | Change | Where | Verification | Status |
|---|---|---|---|---|
| A01 | Redis owner lease + distributed directory, Lua compare-and-renew/release, fencing epoch | `game-service/src/coordination/{scripts,stores,leases,directory}.js` | `tests/leases.test.js` (20 racers → 1 winner, stale renew/release refused, epoch↑ on takeover, code/user uniqueness) on memory **and** real Redis; `cluster.test.js` "no two owners" | Tested |
| A02 | Command forwarding to owner with request ids, epoch, timeout, ack routing, idempotency | `coordination/{commands,cluster}.js`, `sockets/handlers.js` | `cluster.test.js`: cross-replica create/join, six-player match across A/B, duplicate command id applied once, wrong epoch refused | Tested |
| A03 | `@socket.io/redis-adapter`, cluster-wide session replacement, kick, reconnect | `createGameServer.js`, `sockets/handlers.js` | `cluster.test.js`: broadcasts/private events cross replicas, session replaced on other replica, reconnect via other replica, kick across replicas | Tested |
| A04 | PostgreSQL `room_snapshots` + migration, round-boundary/shutdown snapshots, serializer | `src/db.js`, `coordination/snapshots.js`, `Room.serialize/restore` | `tests/snapshots.test.js` (fenced upsert on pg-mem, JSON round-trip restore). Real PostgreSQL not available in the authoring environment | Tested (pg-mem) |
| A05 | Lease-expiry takeover, sweeper + recovery, fresh deadline, `state:sync`, fencing of old owner | `RoomCluster.sweep/adopt`, `Room.resume` | `cluster.test.js`: owner killed mid-match → resumed in ≈1.6 s (limit 60 s) with scores intact, fresh `round:start`, `state:sync`; frozen old owner fenced | Tested |
| A06 | Graceful shutdown / rolling update | `RoomCluster.drain`, `server.js`, `/ready` 503 | `cluster.test.js` graceful hand-over (≈0.2 s); manual SIGTERM smoke test of `server.js` | Tested |
| A07 | WebSocket-only transport, shared JWT, no stickiness | `frontend/lib/socket.ts`, server `transports`, `config.js` | `cluster.test.js` uses websocket-only clients and reconnects through the other replica with the same token | Tested |
| B01 | `/health` (cheap) vs `/ready` (dependencies) on all backends | `*/src/app.js`, `createGameServer.js` | `auth.test.js`, `app.test.js`, `cluster.test.js` readiness | Tested |
| B02 | Instance-aware JSON logs (`instance_id`, `service_name`, `room_code`, `command_id`, `owner_epoch`), redaction | `*/src/logger.js`, `instance.js` | smoke test of `server.js` output | Tested (manual) |
| B03 | Externalised endpoints/secrets (`*_URL`, `*_FILE`), no state on disk | `*/src/{config,secrets}.js`, compose files, `infra/gcp/vm-startup.sh` | unit paths exercised by tests; VM flow not executed | Implemented |
| B04 | Local two-replica mini-cloud | `compose.local-cloud.yml`, `infra/nginx/nginx.local-cloud.conf`, `infra/prometheus/prometheus.local-cloud.yml`, `src/migrate.js` | YAML validated; Docker not available to run it | Implemented |
| B05 | Separate frontend behind same-origin LB routes | `infra/gcp/nginx.vm.conf`, `docs/deployment-gcp.md` | – | Implemented |
| C01–C04 | Terraform base/environment, MIG across zones, HTTPS LB, Cloud SQL, Memorystore, scripts | `infra/terraform/**`, `infra/gcp/**` | `tofu fmt` clean (syntax). **No plan/apply** was possible (provider registry/GCP unreachable) | Implemented |
| C05 | Keyless CI, Artifact Registry immutable SHA tags, rolling release, Terraform checks, rollback | `.github/workflows/ci.yml` | workflow YAML parses; not executed | Implemented |
| C06 | Ops Agent logs + Prometheus metrics, dashboard, 3 alerts | `infra/gcp/ops-agent.yaml`, `environment/main.tf` | – | Implemented |
| C07 | USD 25 budget with 20/40/60/80/100 % alerts, labels, session checklist, cost log | `base/main.tf`, `docs/cost-*`, scripts | – | Implemented |
| D01 | Two-replica concurrency/failure tests | `tests/{leases,cluster,snapshots}.test.js` | 83 game-service tests pass (57 original unchanged + 26 new) | Tested |
| D02 | Scale/cloud evidence scripts | `loadtest/{bots,scale,webload,failover-probe}.js` | syntax-checked only; need a live stack | Implemented |
| D03 | Docs: architecture, events, runbook, shared responsibility, security checklist, cost, traceability | `docs/**`, `README.md` | – | Done |

Not covered by this repository change (needs you): BRD document edits (title/status/O11, CR-05/CR-14 wording), real cloud runs and their evidence (screenshots, plans, cost report), credential rotation if any secret was ever exposed.
