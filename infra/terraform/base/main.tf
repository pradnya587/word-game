# BASE layer: long-lived foundations that stay between test sessions (network, Cloud SQL, secrets, registry, IAM,
# Workload Identity Federation, budget). The disposable, expensive pieces (MIG, load balancer, Memorystore, alerts)
# live in ../environment and are created/destroyed per session.

data "google_project" "this" {
  project_id = var.project_id
}

locals {
  apis = [
    "compute.googleapis.com", "sqladmin.googleapis.com", "redis.googleapis.com", "servicenetworking.googleapis.com",
    "secretmanager.googleapis.com", "artifactregistry.googleapis.com", "iam.googleapis.com", "iamcredentials.googleapis.com",
    "sts.googleapis.com", "monitoring.googleapis.com", "logging.googleapis.com", "billingbudgets.googleapis.com",
    "cloudresourcemanager.googleapis.com", "serviceusage.googleapis.com", "iap.googleapis.com",
  ]
}

resource "google_project_service" "apis" {
  for_each           = toset(local.apis)
  service            = each.value
  disable_on_destroy = false
}

# ---------------------------------------------------------------- network (private by default)
resource "google_compute_network" "vpc" {
  name                    = "${var.name_prefix}-vpc"
  auto_create_subnetworks = false
  depends_on              = [google_project_service.apis]
}

resource "google_compute_subnetwork" "app" {
  name                     = "${var.name_prefix}-app"
  region                   = var.region
  network                  = google_compute_network.vpc.id
  ip_cidr_range            = "10.10.0.0/24"
  private_ip_google_access = true # Artifact Registry, Secret Manager, Logging, Monitoring without public IPs
}

# VMs have no public IP. Cloud NAT is only for the first-boot package installs (Docker, Ops Agent).
resource "google_compute_router" "nat" {
  name    = "${var.name_prefix}-router"
  region  = var.region
  network = google_compute_network.vpc.id
}

resource "google_compute_router_nat" "nat" {
  name                               = "${var.name_prefix}-nat"
  router                             = google_compute_router.nat.name
  region                             = var.region
  nat_ip_allocate_option             = "AUTO_ONLY"
  source_subnetwork_ip_ranges_to_nat = "ALL_SUBNETWORKS_ALL_IP_RANGES"
}

# Only two kinds of inbound traffic reach the app VMs: Google health checks / load balancer proxies on port 80,
# and SSH through Identity-Aware Proxy. The application port is not open to the internet.
resource "google_compute_firewall" "lb_to_app" {
  name          = "${var.name_prefix}-allow-lb-health"
  network       = google_compute_network.vpc.name
  direction     = "INGRESS"
  source_ranges = ["130.211.0.0/22", "35.191.0.0/16"]
  target_tags   = ["wr-app"]
  allow {
    protocol = "tcp"
    ports    = ["80"]
  }
}

resource "google_compute_firewall" "iap_ssh" {
  name          = "${var.name_prefix}-allow-iap-ssh"
  network       = google_compute_network.vpc.name
  direction     = "INGRESS"
  source_ranges = ["35.235.240.0/20"]
  target_tags   = ["wr-app"]
  allow {
    protocol = "tcp"
    ports    = ["22"]
  }
}

# ---------------------------------------------------------------- private service access (Cloud SQL, Memorystore)
resource "google_compute_global_address" "private_services" {
  name          = "${var.name_prefix}-private-services"
  purpose       = "VPC_PEERING"
  address_type  = "INTERNAL"
  prefix_length = 20
  network       = google_compute_network.vpc.id
}

resource "google_service_networking_connection" "private_services" {
  network                 = google_compute_network.vpc.id
  service                 = "servicenetworking.googleapis.com"
  reserved_peering_ranges = [google_compute_global_address.private_services.name]
  depends_on              = [google_project_service.apis]
}

# ---------------------------------------------------------------- Cloud SQL (PostgreSQL, private IP only)
resource "random_id" "sql" {
  byte_length = 3
}

resource "google_sql_database_instance" "pg" {
  name                = "${var.name_prefix}-pg-${random_id.sql.hex}"
  region              = var.region
  database_version    = "POSTGRES_16"
  deletion_protection = var.sql_deletion_protection

  settings {
    tier              = var.sql_tier
    edition           = "ENTERPRISE"
    availability_type = "ZONAL"
    disk_size         = 10
    disk_type         = "PD_SSD"
    user_labels       = var.labels

    ip_configuration {
      ipv4_enabled    = false
      private_network = google_compute_network.vpc.id
    }
    backup_configuration {
      enabled = true
    }
  }

  depends_on = [google_service_networking_connection.private_services]
}

# One database per service, as in the local stack: auth_db, stats_db and game_db (room snapshots).
resource "google_sql_database" "dbs" {
  for_each = toset(["auth_db", "stats_db", "game_db"])
  name     = each.value
  instance = google_sql_database_instance.pg.name
}

resource "random_password" "db" {
  length  = 32
  special = false
}

resource "google_sql_user" "app" {
  name     = "wordroyale"
  instance = google_sql_database_instance.pg.name
  password = random_password.db.result
}

# ---------------------------------------------------------------- Secret Manager (values injected at runtime, never baked in)
resource "random_password" "jwt" {
  length  = 64
  special = false
}

resource "google_secret_manager_secret" "jwt" {
  secret_id = "${var.name_prefix}-jwt-secret"
  labels    = var.labels
  replication {
    auto {}
  }
  depends_on = [google_project_service.apis]
}

resource "google_secret_manager_secret_version" "jwt" {
  secret      = google_secret_manager_secret.jwt.id
  secret_data = random_password.jwt.result
}

resource "google_secret_manager_secret" "db_password" {
  secret_id = "${var.name_prefix}-db-password"
  labels    = var.labels
  replication {
    auto {}
  }
  depends_on = [google_project_service.apis]
}

resource "google_secret_manager_secret_version" "db_password" {
  secret      = google_secret_manager_secret.db_password.id
  secret_data = random_password.db.result
}

# ---------------------------------------------------------------- Artifact Registry (one repo, one image per microservice)
resource "google_artifact_registry_repository" "images" {
  location      = var.region
  repository_id = "wordroyale"
  format        = "DOCKER"
  description   = "wordRoyale service images (immutable commit-SHA tags)"
  labels        = var.labels
  docker_config {
    immutable_tags = true
  }
  depends_on = [google_project_service.apis]
}

# ---------------------------------------------------------------- service accounts and IAM
resource "google_service_account" "vm" {
  account_id   = "${var.name_prefix}-vm"
  display_name = "wordRoyale app VMs"
}

resource "google_project_iam_member" "vm" {
  for_each = toset(["roles/artifactregistry.reader", "roles/logging.logWriter", "roles/monitoring.metricWriter"])
  project  = var.project_id
  role     = each.value
  member   = "serviceAccount:${google_service_account.vm.email}"
}

resource "google_secret_manager_secret_iam_member" "vm_jwt" {
  secret_id = google_secret_manager_secret.jwt.id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.vm.email}"
}

resource "google_secret_manager_secret_iam_member" "vm_db" {
  secret_id = google_secret_manager_secret.db_password.id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.vm.email}"
}

# CI/CD identity: assumed by GitHub Actions through Workload Identity Federation (no JSON keys, no SSH keys).
resource "google_service_account" "deployer" {
  account_id   = "${var.name_prefix}-deployer"
  display_name = "wordRoyale GitHub Actions deployer"
}

# Broad on purpose for a disposable student project (Terraform creates networks, MIGs, LBs, Redis, alerts).
# Tighten before using this layout for anything long-lived.
resource "google_project_iam_member" "deployer" {
  for_each = toset([
    "roles/artifactregistry.writer", "roles/compute.admin", "roles/redis.admin", "roles/monitoring.admin",
    "roles/iam.serviceAccountUser", "roles/serviceusage.serviceUsageConsumer", "roles/secretmanager.viewer",
  ])
  project = var.project_id
  role    = each.value
  member  = "serviceAccount:${google_service_account.deployer.email}"
}

resource "google_iam_workload_identity_pool" "github" {
  workload_identity_pool_id = "${var.name_prefix}-github"
  display_name              = "GitHub Actions"
  depends_on                = [google_project_service.apis]
}

resource "google_iam_workload_identity_pool_provider" "github" {
  workload_identity_pool_id          = google_iam_workload_identity_pool.github.workload_identity_pool_id
  workload_identity_pool_provider_id = "github"
  display_name                       = "GitHub OIDC"
  attribute_mapping = {
    "google.subject"       = "assertion.sub"
    "attribute.repository" = "assertion.repository"
    "attribute.ref"        = "assertion.ref"
  }
  attribute_condition = "assertion.repository == \"${var.github_repo}\""
  oidc {
    issuer_uri = "https://token.actions.githubusercontent.com"
  }
}

resource "google_service_account_iam_member" "github_impersonates_deployer" {
  service_account_id = google_service_account.deployer.name
  role               = "roles/iam.workloadIdentityUser"
  member             = "principalSet://iam.googleapis.com/${google_iam_workload_identity_pool.github.name}/attribute.repository/${var.github_repo}"
}

# ---------------------------------------------------------------- notifications and budget
resource "google_monitoring_notification_channel" "email" {
  display_name = "wordRoyale alerts"
  type         = "email"
  labels = {
    email_address = var.alert_email
  }
  depends_on = [google_project_service.apis]
}

# USD budget with 20/40/60/80/100 % notifications. Budgets only notify; they do not cap spending, so the
# apply/test/destroy checklist (docs/cost-and-session-checklist.md) is what actually keeps cost down.
resource "google_billing_budget" "project" {
  billing_account = var.billing_account
  display_name    = "${var.name_prefix}-project-budget"

  budget_filter {
    projects = ["projects/${data.google_project.this.number}"]
  }
  amount {
    specified_amount {
      currency_code = "USD"
      units         = tostring(var.budget_usd)
    }
  }

  dynamic "threshold_rules" {
    for_each = [0.2, 0.4, 0.6, 0.8, 1.0]
    content {
      threshold_percent = threshold_rules.value
    }
  }

  all_updates_rule {
    monitoring_notification_channels = [google_monitoring_notification_channel.email.id]
    disable_default_iam_recipients   = false
  }
  depends_on = [google_project_service.apis]
}
