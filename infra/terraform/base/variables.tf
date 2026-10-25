variable "project_id" {
  description = "GCP project that hosts everything."
  type        = string
}

variable "region" {
  type    = string
  default = "asia-south1"
}

variable "zones" {
  description = "At least two zones of the region: the MIG spreads instances across them."
  type        = list(string)
  default     = ["asia-south1-a", "asia-south1-b"]
}

variable "name_prefix" {
  type    = string
  default = "wr"
}

variable "labels" {
  description = "Applied to every resource that supports labels (cost tracking)."
  type        = map(string)
  default = {
    app         = "wordroyale"
    managed_by  = "terraform"
    environment = "student-project"
  }
}

variable "billing_account" {
  description = "Billing account id (XXXXXX-XXXXXX-XXXXXX) for the project budget."
  type        = string
}

variable "budget_usd" {
  description = "Project budget. Alerts at 20/40/60/80/100 %. A budget alert does NOT stop spending by itself."
  type        = number
  default     = 25
}

variable "alert_email" {
  description = "Receives budget and monitoring notifications."
  type        = string
}

variable "github_repo" {
  description = "GitHub repository allowed to deploy through Workload Identity Federation, as owner/name."
  type        = string
}

variable "sql_tier" {
  type    = string
  default = "db-f1-micro"
}

variable "sql_deletion_protection" {
  description = "Keep true for the intentional base layer; set false only to tear the whole project down."
  type        = bool
  default     = true
}
