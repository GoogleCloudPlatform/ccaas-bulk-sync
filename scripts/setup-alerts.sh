#!/usr/bin/env bash
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

# Creates Cloud Monitoring alerts for the CCaaS Bulk Sync service:
#   1. "Sync failed or blocked": any live sync whose outcome is error, blocked,
#      group_not_found, job_failed or job_timeout (log-match alert).
#   2. "No successful scheduled sync": no successful scheduled run for
#      NO_SUCCESS_HOURS hours (metric absence on a log-based metric).
#
# Usage: PROJECT_ID=... SERVICE_NAME=ccaas-sync-service NOTIFY_EMAIL=ops@example.com \
#          [NO_SUCCESS_HOURS=3] ./scripts/setup-alerts.sh
# Safe to re-run: existing metrics, channels and policies with the same name are reused.
set -euo pipefail

: "${PROJECT_ID:?Set PROJECT_ID}"
: "${NOTIFY_EMAIL:?Set NOTIFY_EMAIL}"
SERVICE_NAME="${SERVICE_NAME:-ccaas-sync-service}"
NO_SUCCESS_HOURS="${NO_SUCCESS_HOURS:-3}"
G=(gcloud --project="$PROJECT_ID" --quiet)

BASE_FILTER="resource.type=\"cloud_run_revision\" AND resource.labels.service_name=\"${SERVICE_NAME}\" AND jsonPayload.event=\"sync_run\""
FAIL_FILTER="${BASE_FILTER} AND jsonPayload.simulate=false AND jsonPayload.outcome=(\"error\" OR \"blocked\" OR \"group_not_found\" OR \"job_failed\" OR \"job_timeout\")"
SUCCESS_FILTER="${BASE_FILTER} AND jsonPayload.simulate=false AND jsonPayload.trigger=\"scheduled\" AND jsonPayload.outcome=(\"no_changes\" OR \"job_finished\")"
SUCCESS_METRIC="ccaas_sync_successful_scheduled_runs"

echo "Notification channel for ${NOTIFY_EMAIL}..."
CHANNEL=$("${G[@]}" beta monitoring channels list --filter="type=\"email\" AND labels.email_address=\"${NOTIFY_EMAIL}\"" --format='value(name)' | head -1)
if [ -z "$CHANNEL" ]; then
  CHANNEL=$("${G[@]}" beta monitoring channels create --display-name="CCaaS Bulk Sync alerts (${NOTIFY_EMAIL})" \
    --type=email --channel-labels="email_address=${NOTIFY_EMAIL}" --format='value(name)')
fi
echo "  ${CHANNEL}"

echo "Log-based metric ${SUCCESS_METRIC}..."
if ! "${G[@]}" logging metrics describe "$SUCCESS_METRIC" >/dev/null 2>&1; then
  "${G[@]}" logging metrics create "$SUCCESS_METRIC" \
    --description="Successful scheduled CCaaS Bulk Sync runs" --log-filter="$SUCCESS_FILTER"
fi

create_policy() { # display-name, json
  if [ -n "$("${G[@]}" monitoring policies list --filter="displayName=\"$1\"" --format='value(name)')" ]; then
    echo "Alert policy \"$1\" already exists; skipping."
    return
  fi
  local f; f=$(mktemp); printf '%s' "$2" > "$f"
  "${G[@]}" monitoring policies create --policy-from-file="$f" --format='value(name)'
  rm -f "$f"
}

DOC="CCaaS Bulk Sync: open the UI and check **Recent Sync Runs**, or run: gcloud logging read 'jsonPayload.event=\"sync_run\"' --project=${PROJECT_ID} --limit=5"

echo "Alert: sync failed or blocked..."
create_policy "CCaaS Bulk Sync: sync failed or blocked" "$(python3 - "$FAIL_FILTER" "$CHANNEL" "$DOC" <<'PY'
import json, sys
f, ch, doc = sys.argv[1:4]
print(json.dumps({
  "displayName": "CCaaS Bulk Sync: sync failed or blocked",
  "combiner": "OR",
  "conditions": [{"displayName": "Live sync failed or was blocked",
                  "conditionMatchedLog": {"filter": f, "labelExtractors": {"outcome": "EXTRACT(jsonPayload.outcome)", "trigger": "EXTRACT(jsonPayload.trigger)"}}}],
  "alertStrategy": {"notificationRateLimit": {"period": "3600s"}, "autoClose": "86400s"},
  "notificationChannels": [ch],
  "documentation": {"content": doc, "mimeType": "text/markdown"},
  "severity": "ERROR",
}))
PY
)"

echo "Alert: no successful scheduled sync in ${NO_SUCCESS_HOURS}h..."
create_policy "CCaaS Bulk Sync: no successful scheduled sync" "$(python3 - "$SUCCESS_METRIC" "$CHANNEL" "$DOC" "$NO_SUCCESS_HOURS" <<'PY'
import json, sys
metric, ch, doc, hours = sys.argv[1], sys.argv[2], sys.argv[3], int(sys.argv[4])
print(json.dumps({
  "displayName": "CCaaS Bulk Sync: no successful scheduled sync",
  "combiner": "OR",
  "conditions": [{"displayName": f"No successful scheduled sync for {hours}h",
                  "conditionAbsent": {"filter": f'metric.type="logging.googleapis.com/user/{metric}" AND resource.type="cloud_run_revision"',
                                      "duration": f"{hours * 3600}s",
                                      "aggregations": [{"alignmentPeriod": "3600s", "perSeriesAligner": "ALIGN_COUNT"}]}}],
  "notificationChannels": [ch],
  "documentation": {"content": doc, "mimeType": "text/markdown"},
  "severity": "WARNING",
}))
PY
)"
echo "Done."
