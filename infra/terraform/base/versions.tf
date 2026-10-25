terraform {
  required_version = ">= 1.6"

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 5.40"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }

  # Remote state in a Cloud Storage bucket. The bucket is created by scripts/apply.sh and passed with
  #   terraform init -backend-config="bucket=<bucket>" -backend-config="prefix=wordroyale/base"
  backend "gcs" {}
}

provider "google" {
  project               = var.project_id
  region                = var.region
  user_project_override = true # needed for the billing budget API
  billing_project       = var.project_id
}
