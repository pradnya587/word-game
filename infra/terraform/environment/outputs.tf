output "load_balancer_ip" { value = google_compute_global_address.lb.address }
output "url" { value = "https://${local.domain}" }
output "mig_name" { value = google_compute_region_instance_group_manager.app.name }
output "instance_template" { value = google_compute_instance_template.app.name }
output "redis_host" { value = local.base.redis_host }
output "images" { value = local.images }
