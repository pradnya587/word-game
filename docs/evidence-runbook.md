# Evidence runbook (acceptance matrix)

Run in this order during one disposable session. Save command output, `loadtest/results/*`, and screenshots in an `evidence/` folder (not committed with secrets).

| # | Check | How | Pass criterion | Evidence |
|---|---|---|---|---|
| E0 | Local two-replica suite | `cd services/game-service && REDIS_URL=redis://localhost:6379 npm test` | all pass (ownership, fencing, forwarding, idempotency, recovery) | test output |
| E1 | Local mini-cloud | `docker compose -f compose.local-cloud.yml up -d --build`; `node loadtest/bots.js --url http://localhost --rooms 3 --players 6` | all rooms finish; `docker compose logs game-a game-b` show both replicas serving the same rooms | logs + bot summary |
| E2 | Cloud boot | `apply.sh environment`; open the `url` output | HTTPS works, 2–3 VMs in ≥ 2 zones healthy; `curl -I http://<ip>` redirects | screenshots (MIG, LB, cert ACTIVE) |
| E3 | Private only | `gcloud compute instances list` (no EXTERNAL_IP); try `curl http://<vm-internal-ip>` from the internet | no public IPs; port not internet-open | output |
| E4 | Cross-replica six-player match | `node loadtest/bots.js --url https://<url> --rooms 1 --players 6` | game completes; Cloud Logging shows ≥ 2 `instance_id` values for the same `room_code` | log query screenshot |
| E5 | Scale test (baseline) | MIG min=max=1 → `node loadtest/scale.js --url … --label baseline-single-vm` | p95/errors recorded per step | `loadtest/results/baseline-single-vm.csv` |
| E6 | Scale test (autoscaled) | min 2 / max 3 → `node loadtest/scale.js --url … --label autoscaled-mig`; `node loadtest/webload.js --url … --users 100 --seconds 120` | a new VM serves traffic ≤ 5 min after the CPU trigger; no full outage | CSV + MIG size timeline |
| E7 | Owner failure | `node loadtest/failover-probe.js --url …`, delete the owner VM when prompted | recovery ≤ 60 s, clients receive `state:sync` + fresh `round:start` | probe output |
| E8 | Rolling update | push a trivial commit; watch `deploy` job | no moment with 0 healthy backends; rooms keep playing; sockets reconnect | job log + LB graph |
| E9 | Autohealing | `gcloud compute ssh --tunnel-through-iap … -- sudo docker stop wordroyale-game-service-1` | VM recreated by the MIG | MIG history |
| E10 | Alerts | stop a container / generate CPU (`stress`) / return 5xx | the three alerts fire | alert screenshots |
| E11 | Teardown | `destroy.sh environment` + checklist | nothing billable left | command output, cost log |

Key numbers to report: p95 submit latency per step (baseline vs autoscaled), error counts, scale-out time (trigger → new VM serving), failover recovery time, cost planned vs actual.
