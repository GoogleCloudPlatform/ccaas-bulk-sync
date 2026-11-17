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

variable "project_id" {
  description = "Google Cloud project ID."
  type        = string
}

variable "region" {
  description = "Region for Cloud Run, Artifact Registry and Cloud Scheduler."
  type        = string
  default     = "us-central1"
}

variable "service_name" {
  description = "Cloud Run service name."
  type        = string
  default     = "ccaas-sync-service"
}

variable "image" {
  description = "Container image to deploy, e.g. us-central1-docker.pkg.dev/PROJECT/ccaas-sync-repo/ccaas-sync-service:v2.0.0. Build it first (see terraform/README.md)."
  type        = string
}

variable "iap_mode" {
  description = "\"cloud_run\": IAP directly on the Cloud Run service (no load balancer). \"load_balancer\": external HTTPS load balancer with IAP and a custom domain."
  type        = string
  default     = "cloud_run"
  validation {
    condition     = contains(["cloud_run", "load_balancer"], var.iap_mode)
    error_message = "iap_mode must be \"cloud_run\" or \"load_balancer\"."
  }
}

variable "domain" {
  description = "Custom domain for the load balancer (iap_mode = \"load_balancer\" only)."
  type        = string
  default     = ""
}

variable "iap_members" {
  description = "Principals allowed through IAP, e.g. [\"user:alice@example.com\", \"group:ccaas-admins@example.com\"]."
  type        = list(string)
}

variable "admin_emails" {
  description = "Admins who can change the configuration and run live syncs (ADMIN_EMAILS). Emails or \"domain:example.com\". Empty = every IAP user is an admin (not recommended)."
  type        = list(string)
  default     = []
}

variable "scheduler_oauth_client_id" {
  description = "iap_mode = \"cloud_run\" only: OAuth client ID that IAP trusts as a programmatic client, used as the Cloud Scheduler token audience. Create it in the Console (Google Auth Platform > Clients > Web application). Leave empty until created; scheduled syncs won't pass IAP without it."
  type        = string
  default     = ""
}

variable "create_firestore_database" {
  description = "Create the (default) Firestore database. Set false if the project already has one."
  type        = bool
  default     = true
}

variable "notify_email" {
  description = "Email for sync failure alerts. Empty = no alerts."
  type        = string
  default     = ""
}

variable "no_success_hours" {
  description = "Alert if no scheduled sync succeeds for this many hours."
  type        = number
  default     = 3
}
