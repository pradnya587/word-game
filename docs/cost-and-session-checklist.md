# Cost controls and test-session checklist (budget: USD 25)

Budget alerts at **20 / 40 / 60 / 80 / 100 %** are created by `infra/terraform/base` (`google_billing_budget`) and sent to `alert_email`. **Budgets notify; they do not stop spending.**
Everything expensive is in the disposable environment layer; only the cheap base layer (Cloud SQL micro, secrets, registry, network, NAT) stays.

## Before the session
- [ ] `terraform -chdir=infra/terraform/environment plan` reviewed (expect: 1 Memorystore, 1 MIG with 2–3 `e2-medium`, 1 global LB, 1 static IP, alerts, dashboard)
- [ ] Planned duration and planned cost written in `docs/cost-log.csv` (use the `note` column, e.g. `planned 3h ≈ USD 1.5`)
- [ ] All resources carry labels `app=wordroyale, lifecycle=disposable` (Billing → Reports → group by label)

## During
- [ ] `apply.sh environment` (logs `session-start` automatically) → run the evidence runbook (`docs/evidence-runbook.md`)
- [ ] Do not leave the session overnight

## After (always)
- [ ] `destroy.sh environment` (logs `session-end`) and read the verification output: **no** managed instance groups, **no** global forwarding rules, **no** Redis instances
- [ ] `gcloud compute addresses list --global` and `gcloud compute instances list` are empty (a leftover static IP or VM keeps billing)
- [ ] Check Billing → Reports for the day; append actual cost to the log; compare with the plan
- [ ] Export alert/budget screenshots into the evidence folder

## Cost log
`docs/cost-log.csv` is appended by the scripts (`timestamp_utc,event,project,note`). Keep a second table in your report: *planned vs actual per session* (hours, resources, USD).
Rough planning numbers (verify in the pricing calculator for your region): 2×e2-medium ≈ USD 0.07/h each, global LB ≈ USD 0.025/h + traffic, Memorystore basic 1 GB ≈ USD 0.05/h, Cloud NAT ≈ USD 0.045/h + traffic, Cloud SQL micro ≈ USD 10/month.
