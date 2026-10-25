#!/bin/bash
# Bootstrap for every MIG VM (Debian 12). Idempotent: safe to re-run after a reboot.
# Configuration comes from instance metadata (set by Terraform); secrets from Secret Manager using the VM's service account.
# Nothing sensitive is stored in the image, the template or the repository, and no game state is written to disk.
set -euo pipefail
exec > >(tee -a /var/log/wordroyale-startup.log) 2>&1
echo "== wordroyale bootstrap $(date -u +%FT%TZ)"

MD=http://metadata.google.internal/computeMetadata/v1
md() { curl -fsS -H 'Metadata-Flavor: Google' "$MD/$1"; }
attr() { md "instance/attributes/$1"; }

INSTANCE_ID="$(md instance/name)"
ZONE="$(md instance/zone | awk -F/ '{print $NF}')"
REGION="${ZONE%-*}"
APP_DIR=/opt/wordroyale
SECRETS_DIR=/run/wordroyale-secrets          # tmpfs: gone on reboot, never on persistent disk
mkdir -p "$APP_DIR" "$SECRETS_DIR"

# ---- Docker + compose plugin (Debian repo of docker.io is old; use Docker's apt repo) ----
if ! command -v docker >/dev/null; then
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -y
  apt-get install -y ca-certificates curl gnupg
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian $(. /etc/os-release && echo "$VERSION_CODENAME") stable" > /etc/apt/sources.list.d/docker.list
  apt-get update -y
  apt-get install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin
  systemctl enable --now docker
fi

# ---- Cloud Ops Agent: logs (container stdout JSON) + Prometheus metrics -> Cloud Logging / Monitoring ----
if ! systemctl list-unit-files | grep -q google-cloud-ops-agent; then
  curl -fsSL https://dl.google.com/cloudagents/add-google-cloud-ops-agent-repo.sh -o /tmp/add-ops-agent.sh
  bash /tmp/add-ops-agent.sh --also-install
fi
attr ops-agent-config > /etc/google-cloud-ops-agent/config.yaml
systemctl restart google-cloud-ops-agent

# ---- Secrets (runtime only) ----
JWT_SECRET_ID="$(attr secret-jwt)"; DB_PASSWORD_SECRET_ID="$(attr secret-db-password)"
JWT="$(gcloud secrets versions access latest --secret="$JWT_SECRET_ID")"
DBPW="$(gcloud secrets versions access latest --secret="$DB_PASSWORD_SECRET_ID")"
SQL_IP="$(attr sql-private-ip)"; REDIS_HOST="$(attr redis-host)"; REDIS_PORT="$(attr redis-port)"
umask 077
printf '%s' "$JWT" > "$SECRETS_DIR/jwt_secret"
printf 'postgres://wordroyale:%s@%s:5432/auth_db'  "$DBPW" "$SQL_IP" > "$SECRETS_DIR/auth_database_url"
printf 'postgres://wordroyale:%s@%s:5432/stats_db' "$DBPW" "$SQL_IP" > "$SECRETS_DIR/stats_database_url"
printf 'postgres://wordroyale:%s@%s:5432/game_db'  "$DBPW" "$SQL_IP" > "$SECRETS_DIR/game_database_url"
printf 'redis://%s:%s' "$REDIS_HOST" "$REDIS_PORT" > "$SECRETS_DIR/redis_url"
# The containers run as a non-root user, so the files must be readable inside this tmpfs. The VM has no public IP,
# SSH only via IAP + OS Login, and the files vanish on reboot/delete.
chmod 0444 "$SECRETS_DIR"/*
chmod 0755 "$SECRETS_DIR"
unset JWT DBPW

# ---- Images from Artifact Registry (immutable tags / digests chosen by CI) ----
gcloud auth configure-docker "${REGION}-docker.pkg.dev" --quiet
cat > "$APP_DIR/.env" <<ENV
INSTANCE_ID=$INSTANCE_ID
SECRETS_DIR=$SECRETS_DIR
IMAGE_FRONTEND=$(attr image-frontend)
IMAGE_AUTH=$(attr image-auth-service)
IMAGE_GAME=$(attr image-game-service)
IMAGE_STATS=$(attr image-stats-service)
ENV
attr compose-yml > "$APP_DIR/compose.yml"
attr nginx-conf  > "$APP_DIR/nginx.conf"

cd "$APP_DIR"
docker compose --env-file .env -f compose.yml pull
# game-service runs its idempotent, advisory-locked migration itself (AUTO_MIGRATE), so VMs can boot in parallel.
docker compose --env-file .env -f compose.yml up -d --remove-orphans
docker compose --env-file .env -f compose.yml ps
echo "== bootstrap done"
