#!/usr/bin/env bash
# Usage: PROJECT_ID=... scripts/destroy.sh environment      (end of every session: removes MIG, LB, Memorystore, alerts)
#        PROJECT_ID=... scripts/destroy.sh base             (only to retire the whole project; needs sql_deletion_protection=false)
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"
layer="${1:?usage: destroy.sh environment|base}"
ensure_state_bucket
tf_init "$layer"
case "$layer" in
  environment)
    terraform -chdir="$ROOT/environment" destroy -input=false ${TF_APPROVE:+-auto-approve} \
      -var "project_id=${PROJECT_ID}" -var "region=${REGION}" -var "state_bucket=${STATE_BUCKET}" -var "image_tag=${IMAGE_TAG:-destroy}"
    log_session session-end "environment destroyed"
    echo ">> verify nothing billable is left:"
    gcloud compute instance-groups managed list --project "$PROJECT_ID" || true
    gcloud compute forwarding-rules list --global --project "$PROJECT_ID" || true
    gcloud redis instances list --region "$REGION" --project "$PROJECT_ID" || true
    ;;
  base)
    terraform -chdir="$ROOT/base" destroy -input=false ${TF_APPROVE:+-auto-approve} \
      -var "project_id=${PROJECT_ID}" -var "region=${REGION}" -var "billing_account=x" -var "alert_email=x@example.com" -var "github_repo=x/x"
    log_session base-destroyed "base layer destroyed"
    ;;
  *) echo "unknown layer $layer"; exit 2 ;;
esac
