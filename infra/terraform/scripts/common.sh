#!/usr/bin/env bash
# Shared helpers for apply.sh / destroy.sh. Required: PROJECT_ID. Optional: REGION (default asia-south1), STATE_BUCKET.
set -euo pipefail
: "${PROJECT_ID:?export PROJECT_ID=<your gcp project>}"
REGION="${REGION:-asia-south1}"
STATE_BUCKET="${STATE_BUCKET:-${PROJECT_ID}-wordroyale-tfstate}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COST_LOG="${COST_LOG:-$ROOT/../../docs/cost-log.csv}"

ensure_state_bucket() {
  if ! gcloud storage buckets describe "gs://${STATE_BUCKET}" --project "$PROJECT_ID" >/dev/null 2>&1; then
    echo ">> creating state bucket gs://${STATE_BUCKET} (versioned, uniform access)"
    gcloud storage buckets create "gs://${STATE_BUCKET}" --project "$PROJECT_ID" --location "$REGION" --uniform-bucket-level-access
    gcloud storage buckets update "gs://${STATE_BUCKET}" --versioning
  fi
}

tf_init() { # $1 = base|environment
  terraform -chdir="$ROOT/$1" init -input=false -reconfigure \
    -backend-config="bucket=${STATE_BUCKET}" -backend-config="prefix=wordroyale/$1"
}

log_session() { # $1 = event, $2 = note
  mkdir -p "$(dirname "$COST_LOG")"
  [ -f "$COST_LOG" ] || echo "timestamp_utc,event,project,note" > "$COST_LOG"
  echo "$(date -u +%FT%TZ),$1,${PROJECT_ID},\"$2\"" >> "$COST_LOG"
}
