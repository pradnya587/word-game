#!/usr/bin/env bash
# Usage:
#   PROJECT_ID=... BILLING_ACCOUNT=... ALERT_EMAIL=... GITHUB_REPO=owner/repo scripts/apply.sh base
#   PROJECT_ID=... IMAGE_TAG=<commit sha> scripts/apply.sh environment
# `base` is applied once and kept. `environment` is the disposable session: apply, test, then scripts/destroy.sh environment.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"
layer="${1:?usage: apply.sh base|environment}"
ensure_state_bucket
tf_init "$layer"
case "$layer" in
  base)
    : "${BILLING_ACCOUNT:?}"; : "${ALERT_EMAIL:?}"; : "${GITHUB_REPO:?}"
    terraform -chdir="$ROOT/base" apply -input=false \
      -var "project_id=${PROJECT_ID}" -var "region=${REGION}" -var "billing_account=${BILLING_ACCOUNT}" \
      -var "alert_email=${ALERT_EMAIL}" -var "github_repo=${GITHUB_REPO}" ${TF_APPROVE:+-auto-approve}
    log_session base-applied "base layer applied"
    ;;
  environment)
    : "${IMAGE_TAG:?export IMAGE_TAG=<commit sha pushed by CI>}"
    terraform -chdir="$ROOT/environment" plan -input=false -out=session.plan \
      -var "project_id=${PROJECT_ID}" -var "region=${REGION}" -var "state_bucket=${STATE_BUCKET}" -var "image_tag=${IMAGE_TAG}"
    echo ">> This creates billable resources (2-3 VMs, load balancer, Memorystore). Destroy them after the session."
    if [ -z "${TF_APPROVE:-}" ]; then
      read -r -p "Apply this plan? [y/N] " ans
      [ "${ans:-n}" = "y" ] || { echo "aborted"; exit 1; }
    fi
    terraform -chdir="$ROOT/environment" apply -input=false session.plan
    log_session session-start "environment applied, image_tag=${IMAGE_TAG}"
    terraform -chdir="$ROOT/environment" output
    ;;
  *) echo "unknown layer $layer"; exit 2 ;;
esac
