# Deploying wordRoyale on Google Cloud

Decisions recorded here (they amend the BRD wording, not the gameplay):
- **D1 – images:** one immutable image **per microservice** (frontend, auth, game, stats), tagged with the commit SHA and identical across replicas of that service. The services are not merged into one image.
- **D2 – HTTPS name:** a Google-managed certificate for `<LB-IP-with-dashes>.sslip.io` by default (sslip.io resolves to the IP, so no domain purchase is needed); set `domain` to use your own.
- **D3 – VM bootstrap:** Debian 12 + Docker Compose from `infra/gcp/` (not Container-Optimized OS, because the Cloud Ops Agent is needed for Prometheus metrics and logs). Each VM runs the four service containers plus a local nginx exposing **one** port (80) to the load balancer.
- **Frontend:** stays its own container behind the HTTPS load balancer (same-origin `/api/auth`, `/api/stats`, `/socket.io`; no CORS, no mixed content). Gameplay (rounds, modes, scoring, timers, elimination, minimum players) is unchanged.

## Layout
```
infra/terraform/base         VPC, subnet, firewall, Cloud NAT (first boot only), private services access, Cloud SQL (private IP; auth_db, stats_db, game_db),
                             Secret Manager (JWT, DB password), Artifact Registry (immutable tags), service accounts, Workload Identity Federation, budget + alert channel
infra/terraform/environment  Memorystore Redis, instance template, regional multi-zone MIG (+autoscaler, autohealing), global HTTPS LB (managed cert, HTTP->HTTPS redirect,
                             WebSocket timeout 3600 s, connection draining 60 s), Cloud Monitoring dashboard and 3 alerts
infra/terraform/scripts      apply.sh / destroy.sh (state bucket creation, init, plan, cost log)
infra/gcp                    vm-startup.sh, compose.vm.yml, nginx.vm.conf, ops-agent.yaml (what every VM runs)
```
Base is kept between sessions; the environment is disposable (`destroy.sh environment`).

## One-time setup
```bash
export PROJECT_ID=<project> BILLING_ACCOUNT=<id> ALERT_EMAIL=<you@example.com> GITHUB_REPO=<owner/repo> REGION=asia-south1
gcloud auth application-default login
infra/terraform/scripts/apply.sh base           # creates the state bucket gs://$PROJECT_ID-wordroyale-tfstate on first run
terraform -chdir=infra/terraform/base output     # workload_identity_provider, deployer_service_account_email, artifact_registry
```
Set GitHub repository **variables** (not secrets): `GCP_PROJECT_ID`, `GCP_REGION`, `GCP_WIF_PROVIDER` (=`workload_identity_provider`), `GCP_DEPLOYER_SA`, `TF_STATE_BUCKET`, `GCP_DEPLOY_ENABLED=true`.
There are no SSH keys and no service-account JSON keys anywhere. Create a GitHub environment named `production` (optionally with required reviewers).

## Release (CI)
Push to `main` → tests (incl. two-replica suite against Redis) → build 4 images → Trivy → push `…/wordroyale-<svc>:<commit sha>` to Artifact Registry → `terraform apply` of the environment layer
with `image_tag=<sha>` creates a **new instance template**; the MIG replaces VMs with surge = number of zones and **0 unavailable**. (A regional MIG requires surge/unavailable to be 0 or ≥ the number of zones,
so "surge 1" becomes "surge 2" with two zones.) Every VM drains on SIGTERM: `/readyz` turns 503, rooms are snapshotted and handed over, sockets reconnect to another replica.
First session without CI: `IMAGE_TAG=<sha> infra/terraform/scripts/apply.sh environment`.

## Rollback
Re-run the workflow manually (Actions → CI/CD → Run workflow) with `image_tag = <an earlier commit SHA>` – the images still exist (immutable tags). Or from a shell:
`IMAGE_TAG=<old sha> TF_APPROVE=1 infra/terraform/scripts/apply.sh environment`. Emergency (no Terraform): `gcloud compute instance-groups managed rolling-action start-update wr-app-mig --region $REGION --version=template=<previous template>`.

## Security & network checklist
| Item | Where |
|---|---|
| VMs have no public IP | instance template has no `access_config` |
| App port 80 reachable only from Google LB/health-check ranges `130.211.0.0/22`, `35.191.0.0/16` | `base/main.tf` firewall `lb_to_app` |
| Admin access only through IAP + OS Login | firewall `iap_ssh` (35.235.240.0/20), `enable-oslogin=TRUE`; `gcloud compute ssh --tunnel-through-iap` |
| Private Google Access for registry/secrets/logging | subnet `private_ip_google_access` |
| Cloud SQL and Memorystore private IP only | `ipv4_enabled=false`, `PRIVATE_SERVICE_ACCESS` |
| Secrets never in repo/image/CI output | Secret Manager → tmpfs files via VM identity (`*_FILE` env); Terraform state holds the generated values, so keep the state bucket private |
| Keyless CI | Workload Identity Federation restricted to your repository |
| Shielded VM | secure boot, vTPM, integrity monitoring |
| HTTPS only | HTTP :80 → 301 to HTTPS; managed certificate |
| Logs hygiene | pino redacts tokens/passwords/URLs; no secrets in logs |
Rotate any credential that was ever committed (the old `.env.example` placeholders are not real, but check your own `.env`/history).

## Shared responsibility
| Layer | Google | This project |
|---|---|---|
| Hardware, hypervisor, global LB, Cloud SQL/Memorystore engines and patching, Secret Manager | ✔ | configuration (IAM, networking, sizes, backups) |
| Guest OS (Debian), Docker, Ops Agent, container images, dependencies | – | ✔ (image rebuild + Trivy; VM replacement on release) |
| Application code, game rules, JWT handling, input validation | – | ✔ |
| Budget and teardown | tooling (budget alerts) | ✔ budget alerts do **not** stop spending |

## Operating
- Health: `/healthz` (liveness, autohealing) and `/readyz` (LB). Logs: Cloud Logging, filter `jsonPayload.instance_id="…"` or `jsonPayload.room_code="…"`. Dashboard: *wordRoyale overview*. Alerts: instance unhealthy, CPU > 80 % for 5 min, 5xx > 5 %.
- Scale: CPU target 60 %, 2–3 `e2-medium` VMs across two zones. Delete a VM: it is recreated; its rooms resume on a survivor within one lease TTL.
- Teardown: `infra/terraform/scripts/destroy.sh environment`, then check `docs/cost-and-session-checklist.md`.

## Not verified in this repository snapshot
Terraform was formatted and syntax-checked (`tofu fmt`) but **not** planned/applied against a real project; Docker, CI and GCP were not executed in the environment that produced these changes. The first `terraform plan` may need small attribute fixes for your provider version. Treat every "Done when" in `docs/traceability.md` as a planned acceptance check until you have run it and stored the evidence.
