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

# Optional alerts (set var.notify_email). Same policies as scripts/setup-alerts.sh.

locals {
  alerts      = var.notify_email != ""
  base_filter = "((resource.type=\"cloud_run_revision\" AND resource.labels.service_name=\"${var.service_name}\") OR (resource.type=\"cloud_run_job\" AND resource.labels.job_name=\"${var.service_name}-sync\")) AND jsonPayload.event=\"sync_run\" AND jsonPayload.simulate=false"
  fail_filter = "${local.base_filter} AND jsonPayload.outcome=(\"error\" OR \"blocked\" OR \"group_not_found\" OR \"job_failed\" OR \"job_timeout\")"
  ok_filter   = "${local.base_filter} AND jsonPayload.trigger=\"scheduled\" AND jsonPayload.outcome=(\"no_changes\" OR \"job_finished\")"
  alert_doc   = "CCaaS Bulk Sync: open the UI and check **Recent Sync Runs**, or run `gcloud logging read 'jsonPayload.event=\"sync_run\"' --project=${var.project_id} --limit=5`."
}

resource "google_monitoring_notification_channel" "email" {
  count        = local.alerts ? 1 : 0
  display_name = "CCaaS Bulk Sync alerts (${var.notify_email})"
  type         = "email"
  labels = {
    email_address = var.notify_email
  }
}

resource "google_monitoring_alert_policy" "failed" {
  count        = local.alerts ? 1 : 0
  display_name = "CCaaS Bulk Sync: sync failed or blocked"
  combiner     = "OR"
  severity     = "ERROR"
  conditions {
    display_name = "Live sync failed or was blocked"
    condition_matched_log {
      filter = local.fail_filter
      label_extractors = {
        outcome = "EXTRACT(jsonPayload.outcome)"
        trigger = "EXTRACT(jsonPayload.trigger)"
      }
    }
  }
  alert_strategy {
    notification_rate_limit {
      period = "3600s"
    }
    auto_close = "86400s"
  }
  notification_channels = [google_monitoring_notification_channel.email[0].id]
  documentation {
    content   = local.alert_doc
    mime_type = "text/markdown"
  }
}

resource "google_logging_metric" "successful_runs" {
  count       = local.alerts ? 1 : 0
  name        = "ccaas_sync_successful_scheduled_runs"
  description = "Successful scheduled CCaaS Bulk Sync runs"
  filter      = local.ok_filter
  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "INT64"
  }
}

resource "google_monitoring_alert_policy" "no_success" {
  count        = local.alerts ? 1 : 0
  display_name = "CCaaS Bulk Sync: no successful scheduled sync"
  combiner     = "OR"
  severity     = "WARNING"
  conditions {
    display_name = "No successful scheduled sync for ${var.no_success_hours}h"
    condition_absent {
      filter   = "metric.type=\"logging.googleapis.com/user/${google_logging_metric.successful_runs[0].name}\" AND resource.type=one_of(\"cloud_run_revision\",\"cloud_run_job\")"
      duration = "${var.no_success_hours * 3600}s"
      aggregations {
        alignment_period   = "3600s"
        per_series_aligner = "ALIGN_COUNT"
      }
    }
  }
  notification_channels = [google_monitoring_notification_channel.email[0].id]
  documentation {
    content   = local.alert_doc
    mime_type = "text/markdown"
  }
}
