# ENVIRONMENT layer (disposable): everything here is destroyed after a test session; ../base stays.

data "terraform_remote_state" "base" {
  backend = "gcs"
  config = {
    bucket = var.state_bucket
    prefix = "wordrush/base"
  }
}

locals {
  base     = data.terraform_remote_state.base.outputs
  zones    = local.base.zones
  registry = local.base.artifact_registry
  services = ["frontend", "auth-service", "game-service", "stats-service"]
  # one immutable image per microservice, identical on every VM (replicas of a service all run the same image)
  images = { for s in local.services : s => lookup(var.image_overrides, s, "${local.registry}/${s}:${var.image_tag}") }
  domain = var.domain != "" ? var.domain : "${replace(google_compute_global_address.lb.address, ".", "-")}.sslip.io"
}

# ---------------------------------------------------------------- instance template and multi-zone MIG
resource "google_compute_instance_template" "app" {
  name_prefix  = "${var.name_prefix}-app-"
  machine_type = var.machine_type
  tags         = ["wr-app"]
  labels       = var.labels

  disk {
    source_image = "projects/debian-cloud/global/images/family/debian-12"
    boot         = true
    auto_delete  = true
    disk_size_gb = 20
    disk_type    = "pd-balanced"
  }

  network_interface {
    subnetwork = local.base.subnetwork_self_link

    # Ephemeral external IP for outbound package downloads.
    # Firewall rules still restrict incoming connections.
    access_config {}
  }

  service_account {
    email  = local.base.vm_service_account_email
    scopes = ["cloud-platform"]
  }

  shielded_instance_config {
    enable_secure_boot          = true
    enable_vtpm                 = true
    enable_integrity_monitoring = true
  }

  metadata = {
    enable-oslogin   = "TRUE"
    startup-script   = file("${path.module}/../../gcp/vm-startup.sh")
    compose-yml      = file("${path.module}/../../gcp/compose.vm.yml")
    nginx-conf       = file("${path.module}/../../gcp/nginx.vm.conf")
    ops-agent-config = file("${path.module}/../../gcp/ops-agent.yaml")

    image-frontend      = local.images["frontend"]
    image-auth-service  = local.images["auth-service"]
    image-game-service  = local.images["game-service"]
    image-stats-service = local.images["stats-service"]
    redis-host          = local.base.redis_host
    redis-port          = tostring(local.base.redis_port)
    sql-private-ip      = local.base.sql_private_ip
    secret-jwt          = local.base.jwt_secret_id
    secret-db-password  = local.base.db_password_secret_id
  }

  lifecycle {
    create_before_destroy = true
  }
}

# Autohealing: a VM whose game-service process stops answering /healthz is recreated.
resource "google_compute_health_check" "autoheal" {
  name                = "${var.name_prefix}-autoheal"
  check_interval_sec  = 15
  timeout_sec         = 5
  healthy_threshold   = 2
  unhealthy_threshold = 4
  http_health_check {
    port         = 80
    request_path = "/healthz"
  }
}

# Load balancer health: /readyz needs Redis + the snapshot database and turns 503 while an instance drains.
resource "google_compute_health_check" "lb" {
  name                = "${var.name_prefix}-lb-ready"
  check_interval_sec  = 10
  timeout_sec         = 5
  healthy_threshold   = 2
  unhealthy_threshold = 3
  http_health_check {
    port         = 80
    request_path = "/readyz"
  }
}

resource "google_compute_region_instance_group_manager" "app" {
  name                      = "${var.name_prefix}-app-mig"
  region                    = var.region
  base_instance_name        = "${var.name_prefix}-app"
  distribution_policy_zones = local.zones

  version {
    instance_template = google_compute_instance_template.app.self_link_unique
  }

  named_port {
    name = "http"
    port = 80
  }

  auto_healing_policies {
    health_check      = google_compute_health_check.autoheal.id
    initial_delay_sec = 300 # first boot installs Docker and pulls four images
  }

  # Rolling release with no capacity loss: new VMs are created first (surge), old ones are removed only when healthy.
  # A regional MIG requires surge/unavailable to be 0 or >= the number of zones, hence surge = number of zones.
  update_policy {
    type                  = "PROACTIVE"
    minimal_action        = "REPLACE"
    replacement_method    = "SUBSTITUTE"
    max_surge_fixed       = length(local.zones)
    max_unavailable_fixed = 0
  }


}

resource "google_compute_region_autoscaler" "app" {
  name   = "${var.name_prefix}-app-autoscaler"
  region = var.region
  target = google_compute_region_instance_group_manager.app.id

  autoscaling_policy {
    min_replicas    = var.min_replicas
    max_replicas    = var.max_replicas
    cooldown_period = 120
    cpu_utilization {
      target = var.cpu_target
    }
  }
}

# ---------------------------------------------------------------- global external HTTPS load balancer
resource "google_compute_global_address" "lb" {
  name   = "${var.name_prefix}-lb-ip"
  labels = var.labels
}

resource "google_compute_managed_ssl_certificate" "lb" {
  name = "${var.name_prefix}-cert-${substr(md5(local.domain), 0, 6)}"
  managed {
    domains = [local.domain]
  }
  lifecycle {
    create_before_destroy = true
  }
}

resource "google_compute_backend_service" "app" {
  name                            = "${var.name_prefix}-backend"
  protocol                        = "HTTP"
  port_name                       = "http"
  load_balancing_scheme           = "EXTERNAL_MANAGED"
  timeout_sec                     = 3600   # long-lived WebSocket (Socket.IO) connections
  session_affinity                = "NONE" # any replica serves any player: no sticky sessions
  connection_draining_timeout_sec = 60
  health_checks                   = [google_compute_health_check.lb.id]

  backend {
    group           = google_compute_region_instance_group_manager.app.instance_group
    balancing_mode  = "UTILIZATION"
    max_utilization = 0.8
    capacity_scaler = 1.0
  }

  log_config {
    enable      = true
    sample_rate = 0.5
  }
}

# Path routing (frontend / api / socket.io) is done by the instance-local nginx, so the URL map has one backend.
resource "google_compute_url_map" "https" {
  name            = "${var.name_prefix}-https"
  default_service = google_compute_backend_service.app.id
}

resource "google_compute_target_https_proxy" "https" {
  name             = "${var.name_prefix}-https-proxy"
  url_map          = google_compute_url_map.https.id
  ssl_certificates = [google_compute_managed_ssl_certificate.lb.id]
}

resource "google_compute_global_forwarding_rule" "https" {
  name                  = "${var.name_prefix}-https"
  ip_address            = google_compute_global_address.lb.id
  port_range            = "443"
  target                = google_compute_target_https_proxy.https.id
  load_balancing_scheme = "EXTERNAL_MANAGED"
  labels                = var.labels
}

resource "google_compute_url_map" "http_redirect" {
  name = "${var.name_prefix}-http-redirect"
  default_url_redirect {
    https_redirect         = true
    redirect_response_code = "MOVED_PERMANENTLY_DEFAULT"
    strip_query            = false
  }
}

resource "google_compute_target_http_proxy" "http_redirect" {
  name    = "${var.name_prefix}-http-proxy"
  url_map = google_compute_url_map.http_redirect.id
}

resource "google_compute_global_forwarding_rule" "http_redirect" {
  name                  = "${var.name_prefix}-http"
  ip_address            = google_compute_global_address.lb.id
  port_range            = "80"
  target                = google_compute_target_http_proxy.http_redirect.id
  load_balancing_scheme = "EXTERNAL_MANAGED"
  labels                = var.labels
}

# ---------------------------------------------------------------- Cloud Monitoring: dashboard + three alerts
resource "google_monitoring_alert_policy" "unhealthy_instance" {
  display_name = "wordRoyale: instance unhealthy"
  combiner     = "OR"
  conditions {
    display_name = "a service /metrics endpoint stopped answering for 2 min"
    condition_prometheus_query_language {
      query    = "up{job=~\"auth-service|game-service|stats-service\"} == 0"
      duration = "120s"
    }
  }
  notification_channels = []
  user_labels           = var.labels
}

resource "google_monitoring_alert_policy" "high_cpu" {
  display_name = "wordRoyale: sustained high CPU"
  combiner     = "OR"
  conditions {
    display_name = "VM CPU above 80% for 5 min"
    condition_threshold {
      filter          = "resource.type = \"gce_instance\" AND metadata.user_labels.app = \"wordroyale\" AND metric.type = \"compute.googleapis.com/instance/cpu/utilization\""
      comparison      = "COMPARISON_GT"
      threshold_value = 0.8
      duration        = "300s"
      aggregations {
        alignment_period   = "60s"
        per_series_aligner = "ALIGN_MEAN"
      }
    }
  }
  notification_channels = []
  user_labels           = var.labels
}

resource "google_monitoring_alert_policy" "error_rate" {
  display_name = "wordRoyale: high 5xx error rate"
  combiner     = "OR"
  conditions {
    display_name = "more than 5% of load balancer responses are 5xx for 5 min"
    condition_threshold {
      filter             = "resource.type = \"https_lb_rule\" AND metric.type = \"loadbalancing.googleapis.com/https/request_count\" AND metric.labels.response_code_class = 500"
      denominator_filter = "resource.type = \"https_lb_rule\" AND metric.type = \"loadbalancing.googleapis.com/https/request_count\""
      comparison         = "COMPARISON_GT"
      threshold_value    = 0.05
      duration           = "300s"
      aggregations {
        alignment_period   = "60s"
        per_series_aligner = "ALIGN_RATE"
      }
      denominator_aggregations {
        alignment_period   = "60s"
        per_series_aligner = "ALIGN_RATE"
      }
    }
  }
  notification_channels = []
  user_labels           = var.labels
}

resource "google_monitoring_dashboard" "overview" {
  dashboard_json = jsonencode({
    displayName = "wordRoyale overview"
    mosaicLayout = {
      columns = 12
      tiles = [
        {
          width = 6, height = 4,
          widget = {
            title = "CPU utilisation per VM"
            xyChart = { dataSets = [{ plotType = "LINE", timeSeriesQuery = { timeSeriesFilter = {
              filter      = "resource.type=\"gce_instance\" metadata.user_labels.\"app\"=\"wordroyale\" metric.type=\"compute.googleapis.com/instance/cpu/utilization\""
              aggregation = { alignmentPeriod = "60s", perSeriesAligner = "ALIGN_MEAN", groupByFields = ["metadata.system_labels.\"name\""], crossSeriesReducer = "REDUCE_MEAN" }
            } } }] }
          }
        },
        {
          xPos = 6, width = 6, height = 4,
          widget = {
            title   = "Active rooms per game-service instance"
            xyChart = { dataSets = [{ plotType = "LINE", timeSeriesQuery = { prometheusQuery = "sum by (instance_id) (wordroyale_active_rooms)" } }] }
          }
        },
        {
          yPos = 4, width = 6, height = 4,
          widget = {
            title   = "Connected players per instance"
            xyChart = { dataSets = [{ plotType = "LINE", timeSeriesQuery = { prometheusQuery = "sum by (instance_id) (wordroyale_active_players)" } }] }
          }
        },
        {
          xPos = 6, yPos = 4, width = 6, height = 4,
          widget = {
            title = "Load balancer requests by response class"
            xyChart = { dataSets = [{ plotType = "STACKED_BAR", timeSeriesQuery = { timeSeriesFilter = {
              filter      = "resource.type=\"https_lb_rule\" metric.type=\"loadbalancing.googleapis.com/https/request_count\""
              aggregation = { alignmentPeriod = "60s", perSeriesAligner = "ALIGN_RATE", groupByFields = ["metric.label.\"response_code_class\""], crossSeriesReducer = "REDUCE_SUM" }
            } } }] }
          }
        },
        {
          yPos = 8, width = 6, height = 4,
          widget = {
            title = "Room recoveries / lost leases"
            xyChart = { dataSets = [
              { plotType = "LINE", timeSeriesQuery = { prometheusQuery = "sum by (instance_id) (increase(wordroyale_room_recoveries_total[5m]))" } },
              { plotType = "LINE", timeSeriesQuery = { prometheusQuery = "sum by (instance_id) (increase(wordroyale_lease_lost_total[5m]))" } },
            ] }
          }
        },
        {
          xPos = 6, yPos = 8, width = 6, height = 4,
          widget = {
            title   = "Service up (per instance)"
            xyChart = { dataSets = [{ plotType = "LINE", timeSeriesQuery = { prometheusQuery = "up" } }] }
          }
        },
      ]
    }
  })
}
