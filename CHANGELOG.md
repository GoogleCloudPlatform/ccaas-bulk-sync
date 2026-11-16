# Changelog

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
