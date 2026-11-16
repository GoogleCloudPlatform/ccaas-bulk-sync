# Copyright 2025 Google LLC
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

data "google_project" "this" {
  project_id = var.project_id
}

locals {
  project_number = data.google_project.this.number
  # Cloud Run's deterministic URL, known before the service exists.
  service_url   = "https://${var.service_name}-${local.project_number}.${var.region}.run.app"
  secrets       = ["ccaas-api-key", "gcp-sa-key", "ad-bind-password", "entra-client-secret"]
  iap_agent     = "service-${local.project_number}@gcp-sa-iap.iam.gserviceaccount.com"
  cloud_run_iap = var.iap_mode == "cloud_run"
  iap_audience  = local.cloud_run_iap ? "/projects/${local.project_number}/locations/${var.region}/services/${var.service_name}" : "/projects/${local.project_number}/global/backendServices/${google_compute_backend_service.app[0].generated_id}"

  apis = concat([
    "run.googleapis.com",
    "artifactregistry.googleapis.com",
    "cloudbuild.googleapis.com",
    "iam.googleapis.com",
    "iamcredentials.googleapis.com",
    "firestore.googleapis.com",
    "cloudscheduler.googleapis.com",
    "iap.googleapis.com",
    "secretmanager.googleapis.com",
    "admin.googleapis.com",
    "cloudresourcemanager.googleapis.com",
    "logging.googleapis.com",
    "monitoring.googleapis.com",
  ], local.cloud_run_iap ? [] : ["compute.googleapis.com"])
}

resource "google_project_service" "apis" {
  for_each           = toset(local.apis)
  service            = each.value
  disable_on_destroy = false
}

resource "google_firestore_database" "default" {
  count       = var.create_firestore_database ? 1 : 0
  name        = "(default)"
  location_id = var.region
  type        = "FIRESTORE_NATIVE"
  depends_on  = [google_project_service.apis]
}

resource "google_artifact_registry_repository" "repo" {
  repository_id = "ccaas-sync-repo"
  location      = var.region
  format        = "DOCKER"
  description   = "CCaaS Bulk Sync container images"
  depends_on    = [google_project_service.apis]
}

# --- Secrets (values are entered in the UI, never in Terraform state) ---

resource "google_secret_manager_secret" "app" {
  for_each  = toset(local.secrets)
  secret_id = each.value
  replication {
    auto {}
  }
  depends_on = [google_project_service.apis]
}

# --- Runtime service account, least privilege ---

resource "google_service_account" "runtime" {
  account_id   = "ccaas-sync-sa"
  display_name = "CCaaS Sync Service Account"
}

resource "google_project_iam_member" "firestore" {
  project = var.project_id
  role    = "roles/datastore.user"
  member  = google_service_account.runtime.member
}

resource "google_project_iam_custom_role" "scheduler" {
  role_id     = "ccaasSyncScheduler"
  title       = "CCaaS Sync Scheduler"
  description = "Manage Cloud Scheduler jobs only."
  permissions = ["cloudscheduler.jobs.get", "cloudscheduler.jobs.create", "cloudscheduler.jobs.update", "cloudscheduler.jobs.delete"]
}

resource "google_project_iam_member" "scheduler" {
  project = var.project_id
  role    = google_project_iam_custom_role.scheduler.id
  member  = google_service_account.runtime.member
}

resource "google_secret_manager_secret_iam_member" "access" {
  for_each  = google_secret_manager_secret.app
  secret_id = each.value.id
  role      = "roles/secretmanager.secretAccessor"
  member    = google_service_account.runtime.member
}

resource "google_secret_manager_secret_iam_member" "versions" {
  for_each  = google_secret_manager_secret.app
  secret_id = each.value.id
  role      = "roles/secretmanager.secretVersionManager"
  member    = google_service_account.runtime.member
}

# Attach itself to the Cloud Scheduler job, and sign keyless Workspace delegation tokens.
resource "google_service_account_iam_member" "self" {
  for_each           = toset(["roles/iam.serviceAccountUser", "roles/iam.serviceAccountTokenCreator"])
  service_account_id = google_service_account.runtime.name
  role               = each.value
  member             = google_service_account.runtime.member
}

# --- Cloud Run service ---

resource "google_cloud_run_v2_service" "app" {
  provider            = google-beta
  name                = var.service_name
  location            = var.region
  deletion_protection = false
  ingress             = local.cloud_run_iap ? "INGRESS_TRAFFIC_ALL" : "INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER"
  iap_enabled         = local.cloud_run_iap

  template {
    service_account = google_service_account.runtime.email
    timeout         = "900s"
    containers {
      image = var.image
      env {
        name  = "SERVICE_ACCOUNT"
        value = google_service_account.runtime.email
      }
      env {
        name  = "SERVICE_URL"
        value = local.service_url
      }
      env {
        name  = "REGION"
        value = var.region
      }
      env {
        name  = "IAP_AUDIENCE"
        value = local.iap_audience
      }
      env {
        name  = "ADMIN_EMAILS"
        value = join(",", var.admin_emails)
      }
      env {
        name  = "SCHEDULER_OIDC_AUDIENCE"
        value = local.cloud_run_iap ? var.scheduler_oauth_client_id : ""
      }
      startup_probe {
        http_get {
          path = "/healthz"
        }
      }
    }
  }

  depends_on = [google_project_service.apis, google_secret_manager_secret_iam_member.access]
}

# IAP's service agent invokes the service (both modes).
resource "google_project_service_identity" "iap" {
  provider = google-beta
  service  = "iap.googleapis.com"
}

resource "google_cloud_run_v2_service_iam_member" "iap_invoker" {
  name       = google_cloud_run_v2_service.app.name
  location   = var.region
  role       = "roles/run.invoker"
  member     = "serviceAccount:${local.iap_agent}"
  depends_on = [google_project_service_identity.iap]
}

# Load balancer mode: Cloud Scheduler calls the run.app URL with an OIDC token checked by Cloud Run IAM.
resource "google_cloud_run_v2_service_iam_member" "scheduler_invoker" {
  count    = local.cloud_run_iap ? 0 : 1
  name     = google_cloud_run_v2_service.app.name
  location = var.region
  role     = "roles/run.invoker"
  member   = google_service_account.runtime.member
}

# --- IAP directly on Cloud Run ---

resource "google_iap_web_cloud_run_service_iam_member" "users" {
  for_each               = local.cloud_run_iap ? toset(concat(var.iap_members, [google_service_account.runtime.member])) : toset([])
  project                = var.project_id
  location               = var.region
  cloud_run_service_name = google_cloud_run_v2_service.app.name
  role                   = "roles/iap.httpsResourceAccessor"
  member                 = each.value
}

resource "google_iap_settings" "cloud_run" {
  count = local.cloud_run_iap && var.scheduler_oauth_client_id != "" ? 1 : 0
  name  = "projects/${local.project_number}/iap_web/cloud_run-${var.region}/services/${google_cloud_run_v2_service.app.name}"
  access_settings {
    oauth_settings {
      programmatic_clients = [var.scheduler_oauth_client_id]
    }
  }
}

# --- Build service account (for `gcloud builds submit --service-account`) ---
# Orgs that disable automatic grants to default service accounts leave the
# Compute Engine default SA without roles, so builds need their own SA.

resource "google_service_account" "build" {
  account_id   = "ccaas-sync-build"
  display_name = "CCaaS Sync image builds"
}

resource "google_project_iam_member" "build_logs" {
  project = var.project_id
  role    = "roles/logging.logWriter"
  member  = google_service_account.build.member
}

resource "google_artifact_registry_repository_iam_member" "build_push" {
  location   = google_artifact_registry_repository.repo.location
  repository = google_artifact_registry_repository.repo.name
  role       = "roles/artifactregistry.writer"
  member     = google_service_account.build.member
}

# Cloud Build reads the uploaded source from the project's default bucket.
resource "google_project_iam_member" "build_source" {
  project = var.project_id
  role    = "roles/storage.objectViewer"
  member  = google_service_account.build.member
}
