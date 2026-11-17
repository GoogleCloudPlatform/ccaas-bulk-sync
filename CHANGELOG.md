# Changelog

## Unreleased (2.0.0)
### Changed (sync behavior)
- **Multiple teams:** a user joins every team from every mapping they match, the same way roles accumulate. Previously only the first matching team was applied. Changes are detected by comparing the full set of teams.
- **Existing CCaaS users** without the sync role are now **skipped and reported**, instead of being submitted as new users (which could overwrite manual settings). New setting **Existing CCaaS Users**: `skip` (default) or `adopt`.
- **Name sync:** first and last names are compared and updated from the directory (setting **Sync names**, on by default). An empty directory value never blanks a CCaaS name.
- Simulations and run history report a `skipped` count; the simulation preview lists skipped users.

### Changed (architecture)
- **Live syncs run in a Cloud Run Job** (`<service>-sync`, one task, no retries, 1-hour timeout). `POST /api/sync` starts it and returns `202` with a run ID; the UI follows the run through the new `GET /api/sync-runs/:id`. This fixes live syncs started from the UI failing with "Failed to fetch" when they took longer than the roughly 30-second request limit through IAP. Simulations still run inline. If `SYNC_JOB_NAME` isn't set, live syncs run inline as before.
- Run history records a run as `queued` → `running` → final outcome. The job holds the sync lock for the whole run.
- Alert filters (script and Terraform) include the job's logs; `setup-alerts.sh` now updates existing policies and the metric in place.
- Load balancer backend timeout raised to 300s (README and Terraform).

**Upgrade impact:** expect one-off updates on the first sync for users who match several team mappings, and for users whose names differ. Run **Simulate Only** first.

## 1.4.0: Operations

### Upgrade notes
1. Redeploy. For a new deployment, consider [Terraform](terraform/README.md).
2. Optional: **keyless Google Workspace**. Grant the service account `roles/iam.serviceAccountTokenCreator` on itself, authorize its client ID for domain-wide delegation, select **Keyless** in the UI and click **Save**. Then delete the old key (README "Google Workspace without a stored key").
3. Optional: set up alerts with `scripts/setup-alerts.sh`, or with `notify_email` in Terraform.

### Added
- **Sync run history:** every sync (scheduled or manual, live or simulated, including blocked and failed runs) is recorded in Firestore (`ccaas-sync-runs`; newest 200 kept) with trigger, user, outcome, counts, job ID and duration. No user emails or names are stored. New `GET /api/sync-runs` and a **Recent Sync Runs** table in the UI.
- **Terraform module (`terraform/`):** deploys the whole stack (APIs, Firestore, Artifact Registry, empty secrets, least-privilege service account, Cloud Run, IAP in either `cloud_run` or `load_balancer` mode, optional alerts). Credentials never enter Terraform state. CI runs `terraform fmt` and `terraform validate`.
- **Health check:** `GET /healthz` (no auth) returns status and version; checked in CI.
- **Alerts:** `scripts/setup-alerts.sh` creates an email channel and two alert policies: live sync failed or blocked; no successful scheduled sync for N hours.
- **Structured run log:** one JSON log line per run (`event: sync_run`, with `severity` and `outcome`) for Cloud Logging metrics and alerts.
- **Keyless Google Workspace sync:** domain-wide delegation without a stored service account key. The service account signs the delegation JWT with the IAM Credentials `signJwt` API (needs `roles/iam.serviceAccountTokenCreator` on itself), and tokens are cached until close to expiry. Selectable in the UI. Existing key-based configs keep using their key until switched. See README "Google Workspace without a stored key".

## 1.3.0: Hardening and CI

### Upgrade notes
1. Redeploy (README step 5).
2. **Set `ADMIN_EMAILS`** (README step 8). Until it's set, every IAP user stays an admin, and the UI shows a warning.
3. **Tighten the service account's permissions** (README "Upgrading > To 1.3.0"): grant the per-secret roles and the custom scheduler role, then remove the old project-wide roles.
4. Open the UI and click **Save** once.

### Security
- CI on every PR: unit tests, `npm audit` (fails on high or critical), Docker build and container startup smoke test; Dependabot; CodeQL; branch protection on `main`.
- Fixed CodeQL findings: user-controlled values in log format strings, a slow regex in Bearer header parsing, and missing rate limiting (now 120 requests/min per IP on `/api`, 600/min on static files). Job IDs are validated.
- `npm audit`: **0 vulnerabilities** in production dependencies.

### Added
- **Admin allowlist (`ADMIN_EMAILS`):** only admins can save the configuration, run live syncs, proceed CCaaS jobs and run connection tests. Other IAP users are read-only viewers who can still run simulations. New `GET /api/me`; the UI shows your role and disables admin-only actions. When `ADMIN_EMAILS` is unset, everyone stays an admin and a warning is shown. **Set it after upgrading.**
- **Least-privilege IAM (README step 4.2):** per-secret `secretAccessor` + `secretVersionManager` instead of project-wide Secret Manager roles; a custom role for Scheduler jobs only, instead of `roles/cloudscheduler.admin`; `serviceAccountUser` on the service account itself only. The service no longer creates secrets.
- **Old secret versions are disabled** when a credential is saved, so replaced credentials can't be read.
- **UI hardening:** Vue is served from the app instead of unpkg; the inline script and styles moved to `/app.js` and `/app.css`; Google Fonts import removed. `helmet` sets security headers and a strict Content Security Policy (same-origin only; `'unsafe-eval'` only for Vue's template compiler; `frame-ancestors 'none'`).
- **Container hardening:** runs as the unprivileged `node` user; `npm ci` with a pruned production `node_modules`; `NODE_ENV=production`. CI checks that the container doesn't run as root, and checks the security headers.

### Changed
- Major dependency upgrades: `@google-cloud/firestore` 9, `@google-cloud/secret-manager` 8, `@google-cloud/scheduler` 6, `googleapis` 190, `google-auth-library` 11, `ldapts` 9, `@azure/msal-node` 7, `express` 5, `express-rate-limit` 8. All require Node.js 22, which the container already uses.
- Removed `node-fetch`, `isomorphic-fetch` and `form-data`; the code uses Node.js 22's built-in `fetch`, `FormData` and `Blob`.

## 1.2.0: IAP directly on Cloud Run, secret redaction
### Security
- **`GET /api/config` no longer returns secret values.** Earlier versions stored some credentials (CCaaS API key, service account JSON key) in plaintext in the Firestore config, and `GET /api/config` returned them; it removed only the Secret Manager references. All secret values and references are now removed from responses.
- **Saving the config now removes leftover plaintext secrets from Firestore,** moving them into Secret Manager first if they aren't already there. **Upgrade, then click Save once.** If your deployment ever stored credentials in Firestore, rotate them: they were visible to signed-in users, and before 1.1.1 to anyone on the internet (see GHSA-47vv-vx4f-pm44).

### Added
- **IAP directly on Cloud Run (no load balancer):** new `_INGRESS` Cloud Build setting (default `internal-and-cloud-load-balancing`; use `all` with IAP on the service) and new `SCHEDULER_OIDC_AUDIENCE` setting, so Cloud Scheduler's token gets through IAP. See README "Option B".

## 1.1.2: CCaaS pagination fix
### Fixed
- **CCaaS users are now read across every page.** The CCaaS users API returns at most 100 records per page, even when `per=1000` is requested. Versions 1.1.0 and 1.1.1 stopped at the first page shorter than 1000, so they still read only the first 100 users. Pagination now continues until an empty page, and the sync aborts if the API returns the same page twice.
- Tenants with more than 100 CCaaS users should run **Simulate Only** after upgrading. Users beyond the first 100 may now be found, which can produce one-off updates or deactivations. The deactivation safety limit still applies.

## 1.1.1: Container startup fix
### Fixed
- **The container failed to start in v1.0.1 and v1.1.0** (`Cannot find module './config-security'`). The Dockerfile copied only `index.js` and `sync-logic.js` into the production image, leaving out the modules added in those releases (`auth.js`, `config-security.js`, `sync-plan.js`, `sync-lock.js`). It now copies every top-level `.js` module.
- Cloud Run keeps serving the previous revision when a new one fails to start. **If you deployed v1.0.1 or v1.1.0, check that the new revision is actually serving.** If it isn't, you are still running the pre-1.0.1 code, which is affected by GHSA-47vv-vx4f-pm44. Deploy v1.1.1.
### Added
- A packaging test that fails if the Dockerfile leaves out any module `index.js` loads.

## 1.1.0: Sync safety

### Fixed
- **Pagination:** CCaaS users are now read across every page (`page` / `per`). Previously only the first 100 were read, so in larger tenants some users were re-submitted as new and leavers were never deactivated.
- **Pagination:** Microsoft Entra ID group members and the group list now follow `@odata.nextLink`. Previously only the first 100 were read, so members of larger groups were wrongly deactivated.
- **Pagination:** Active Directory searches use paged results, so the 1000-entry server limit no longer cuts results short.
- Email addresses are compared without regard to case, so `John@x.com` and `john@x.com` are no longer treated as two different users.
- Duplicate roles from overlapping group mappings no longer cause an update on every run.
- Group names with special characters (for example `Sales (EMEA)`) now work in Active Directory and Entra ID lookups. Values are escaped (RFC 4515 / OData), and Google Workspace groups are matched by exact name instead of a query string.
- Scheduler jobs are created in the service's region (`REGION` is now passed to the service). A leftover job in `us-central1` is removed.

### Added
- **Sync safety checks:** the sync is aborted if a mapped group is not found, or if the directory returns no users. **Max Deactivations per Sync** (default 25) blocks scheduled runs over the limit. Manual runs can override it after confirmation.
- **Single-sync lock:** a Firestore lease prevents overlapping live syncs. A second request gets HTTP 409.
- **Simulation preview:** the UI shows the email addresses that would be added, updated or deactivated, any warnings (for example, a user matched to several teams), and whether a live run would be blocked.
- Unit tests for the sync plan, safety checks, lock and pagination.

### Changed
- Cloud Run is deployed with `--timeout=900`. The scheduler job uses a 900-second attempt deadline and no automatic retries, so a long sync no longer times out or runs twice.
- The scheduler job is updated in place, rather than deleted and recreated.
- Upload payloads, which contain user emails and names, are no longer logged. Logs contain counts and job IDs only.
- Dependencies updated with `npm audit fix`. This clears the critical (`protobufjs`, `proxy-addr`) and high (`@grpc/grpc-js`) advisories.
- README rewritten with commands you can copy and paste.

## 1.0.1: Security fix (GHSA-47vv-vx4f-pm44)
- All `/api/*` routes now require authentication (verified IAP JWT; scheduler OIDC token for `/api/sync`). Cloud Run is no longer publicly invokable.
- Changing the CCaaS host, LDAP URL or Entra tenant/client ID now requires re-entering the matching credential.

## 1.0.0
- Initial release.
