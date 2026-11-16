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

output "url" {
  description = "Where users open the app."
  value       = local.cloud_run_iap ? local.service_url : "https://${var.domain}"
}

output "service_account" {
  value = google_service_account.runtime.email
}

output "service_account_client_id" {
  description = "Authorize this client ID for domain-wide delegation in the Workspace Admin Console (Google Workspace keyless sync only)."
  value       = google_service_account.runtime.unique_id
}

output "build_service_account" {
  description = "Use with: gcloud builds submit --config=terraform/cloudbuild-image.yaml --service-account=projects/PROJECT/serviceAccounts/<this> (see terraform/README.md)."
  value       = google_service_account.build.email
}

output "iap_audience" {
  value = local.iap_audience
}

output "load_balancer_ip" {
  description = "Create a DNS A record for var.domain pointing here (load_balancer mode)."
  value       = local.cloud_run_iap ? null : google_compute_global_address.app[0].address
}

output "next_steps" {
  value = join("\n", compact([
    local.cloud_run_iap && var.scheduler_oauth_client_id == "" ? "- Scheduled syncs: create a Web application OAuth client (Google Auth Platform > Clients), set scheduler_oauth_client_id, and apply again." : "",
    local.cloud_run_iap ? "" : "- DNS: create an A record ${var.domain} -> ${google_compute_global_address.app[0].address}; the certificate is issued once DNS resolves.",
    "- Open the UI, enter the CCaaS and directory settings, choose a schedule and click Save (this creates the Cloud Scheduler job).",
    length(var.admin_emails) == 0 ? "- Set admin_emails to restrict who can change the configuration." : "",
  ]))
}
