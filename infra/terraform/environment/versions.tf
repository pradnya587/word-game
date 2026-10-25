terraform {
  required_version = ">= 1.6"

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 5.40"
    }
  }

  # prefix=wordroyale/environment (see scripts/apply.sh). The environment is created and destroyed per test session.
  backend "gcs" {}
}

provider "google" {
  project = var.project_id
  region  = var.region
}
