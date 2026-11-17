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

# External HTTPS load balancer with IAP (iap_mode = "load_balancer").
# The serverless NEG references the service by name, so the backend service
# (whose ID is the IAP audience) can be created before the Cloud Run service.

resource "google_compute_region_network_endpoint_group" "app" {
  count                 = local.cloud_run_iap ? 0 : 1
  name                  = "${var.service_name}-neg"
  region                = var.region
  network_endpoint_type = "SERVERLESS"
  cloud_run {
    service = var.service_name
  }
  depends_on = [google_project_service.apis]
}

resource "google_compute_backend_service" "app" {
  count                 = local.cloud_run_iap ? 0 : 1
  name                  = "${var.service_name}-backend"
  load_balancing_scheme = "EXTERNAL_MANAGED"
  protocol              = "HTTPS"
  # Simulations can take longer than the 30s default for large tenants.
  timeout_sec = 300
  backend {
    group = google_compute_region_network_endpoint_group.app[0].id
  }
  iap {
    enabled = true
  }
}

resource "google_iap_web_backend_service_iam_member" "users" {
  for_each            = local.cloud_run_iap ? toset([]) : toset(var.iap_members)
  project             = var.project_id
  web_backend_service = google_compute_backend_service.app[0].name
  role                = "roles/iap.httpsResourceAccessor"
  member              = each.value
}

resource "google_compute_url_map" "app" {
  count           = local.cloud_run_iap ? 0 : 1
  name            = "${var.service_name}-url-map"
  default_service = google_compute_backend_service.app[0].id
}

resource "google_compute_managed_ssl_certificate" "app" {
  count = local.cloud_run_iap ? 0 : 1
  name  = "${var.service_name}-cert"
  managed {
    domains = [var.domain]
  }
  lifecycle {
    precondition {
      condition     = var.domain != ""
      error_message = "Set var.domain when iap_mode = \"load_balancer\"."
    }
  }
}

resource "google_compute_target_https_proxy" "app" {
  count            = local.cloud_run_iap ? 0 : 1
  name             = "${var.service_name}-https-proxy"
  url_map          = google_compute_url_map.app[0].id
  ssl_certificates = [google_compute_managed_ssl_certificate.app[0].id]
}

resource "google_compute_global_address" "app" {
  count = local.cloud_run_iap ? 0 : 1
  name  = "${var.service_name}-ip"
}

resource "google_compute_global_forwarding_rule" "app" {
  count                 = local.cloud_run_iap ? 0 : 1
  name                  = "${var.service_name}-https"
  load_balancing_scheme = "EXTERNAL_MANAGED"
  ip_address            = google_compute_global_address.app[0].id
  target                = google_compute_target_https_proxy.app[0].id
  port_range            = "443"
}
