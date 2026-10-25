variable "project_id" {
  type = string
}

variable "region" {
  type    = string
  default = "asia-south1"
}

variable "name_prefix" {
  type    = string
  default = "wr"
}

variable "state_bucket" {
  description = "Cloud Storage bucket holding the Terraform state (the base layer's state is read from it)."
  type        = string
}

variable "image_tag" {
  description = "Immutable image tag (the commit SHA pushed by CI) used for all four services unless overridden."
  type        = string
}

variable "image_overrides" {
  description = "Optional per-service full image reference (registry/name@sha256:... or :tag), keys: frontend, auth-service, game-service, stats-service."
  type        = map(string)
  default     = {}
}

variable "machine_type" {
  type    = string
  default = "e2-medium"
}

variable "min_replicas" {
  type    = number
  default = 2
}

variable "max_replicas" {
  type    = number
  default = 3
}

variable "cpu_target" {
  description = "Autoscaler CPU utilisation target (0-1)."
  type        = number
  default     = 0.6
}

variable "domain" {
  description = "DNS name for the managed certificate. Empty = <load balancer ip>.sslip.io (resolves to the IP, so Google can issue the certificate without owning a domain)."
  type        = string
  default     = ""
}

variable "labels" {
  type = map(string)
  default = {
    app         = "wordroyale"
    managed_by  = "terraform"
    environment = "student-project"
    lifecycle   = "disposable"
  }
}
