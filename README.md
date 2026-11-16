# CCaaS Bulk Synchronization Service

Keeps users in Google Cloud Contact Center as a Service (CCaaS) in sync with groups in your user directory: Google Workspace, Microsoft Active Directory or Microsoft Entra ID. It maps directory groups to CCaaS roles and teams, then adds, updates or deactivates CCaaS users on a schedule or on demand.

It runs on Cloud Run, stores its configuration in Firestore and its credentials in Secret Manager, uses Cloud Scheduler for scheduled syncs, and is protected by Identity-Aware Proxy (IAP).

- [Local development](#local-development)
- [Deployment](#deployment) (load balancer + IAP, or [IAP directly on Cloud Run](#option-b-iap-directly-on-cloud-run-no-load-balancer))
- [Monitoring and alerts](#monitoring-and-alerts)
- [Sync safety](#sync-safety)
- [Upgrading](#upgrading)
- [Appendix: Microsoft Entra ID setup](#appendix-microsoft-entra-id-setup)

## Local development

```bash
npm install
npm run build:css
ALLOW_INSECURE_LOCAL_DEV=true node index.js   # http://localhost:8080
npm test
```

> **Note:** All `/api/*` routes require an authenticated caller (see [step 7](#7-secure-the-application-with-iap)). `ALLOW_INSECURE_LOCAL_DEV=true` turns this check off for local development only, and is ignored when running on Cloud Run.

## Deployment

Each step below reuses the shell variables set in earlier steps, so run them all in the same terminal session.

### 1. Enable Google Cloud APIs

```bash
export PROJECT_ID=$(gcloud config get-value project)
export PROJECT_NUMBER=$(gcloud projects describe $PROJECT_ID --format='value(projectNumber)')
export REGION="us-central1"   # or your preferred region

gcloud services enable \
  run.googleapis.com \
  artifactregistry.googleapis.com \
  cloudbuild.googleapis.com \
  iam.googleapis.com \
  firestore.googleapis.com \
  cloudscheduler.googleapis.com \
  iap.googleapis.com \
  compute.googleapis.com \
  cloudresourcemanager.googleapis.com \
  secretmanager.googleapis.com \
  admin.googleapis.com
```

### 2. Create the Firestore database

```bash
gcloud firestore databases create --location=$REGION
```

### 3. Create an Artifact Registry repository

```bash
export REPO_NAME="ccaas-sync-repo"

gcloud artifacts repositories create $REPO_NAME \
  --repository-format=docker \
  --location=$REGION \
  --description="Repository for CCaaS Sync Service"
```

### 4. Create secrets and service accounts

#### 4.1 Secrets

```bash
for s in ccaas-api-key gcp-sa-key ad-bind-password entra-client-secret; do
  gcloud secrets create $s --replication-policy="automatic"
done
```

#### 4.2 Application service account

```bash
export SERVICE_ACCOUNT_NAME="ccaas-sync-sa"
export SERVICE_ACCOUNT_EMAIL="${SERVICE_ACCOUNT_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"

gcloud iam service-accounts create $SERVICE_ACCOUNT_NAME \
  --display-name="CCaaS Sync Service Account"

# Read and write the configuration in Firestore
gcloud projects add-iam-policy-binding $PROJECT_ID \
  --member="serviceAccount:${SERVICE_ACCOUNT_EMAIL}" \
  --role="roles/datastore.user"

# Read and rotate ONLY the four application secrets (not every secret in the project)
for s in ccaas-api-key gcp-sa-key ad-bind-password entra-client-secret; do
  for role in roles/secretmanager.secretAccessor roles/secretmanager.secretVersionManager; do
    gcloud secrets add-iam-policy-binding $s \
      --member="serviceAccount:${SERVICE_ACCOUNT_EMAIL}" --role="$role"
  done
done

# Manage only Cloud Scheduler jobs (custom role instead of roles/cloudscheduler.admin)
gcloud iam roles create ccaasSyncScheduler --project=$PROJECT_ID \
  --title="CCaaS Sync Scheduler" \
  --permissions=cloudscheduler.jobs.get,cloudscheduler.jobs.create,cloudscheduler.jobs.update,cloudscheduler.jobs.delete
gcloud projects add-iam-policy-binding $PROJECT_ID \
  --member="serviceAccount:${SERVICE_ACCOUNT_EMAIL}" \
  --role="projects/${PROJECT_ID}/roles/ccaasSyncScheduler"

# Let the service account attach itself to the scheduler job (on itself only)
gcloud iam service-accounts add-iam-policy-binding $SERVICE_ACCOUNT_EMAIL \
  --member="serviceAccount:${SERVICE_ACCOUNT_EMAIL}" \
  --role="roles/iam.serviceAccountUser"
```

> **Note:** The service doesn't create secrets; create them in step 4.1. When a credential is saved, the service adds a new secret version and **disables the previous versions**, so replaced credentials can no longer be read.

#### 4.3 Cloud Build permissions

```bash
export CLOUDBUILD_SA="${PROJECT_NUMBER}@cloudbuild.gserviceaccount.com"

for role in roles/run.admin roles/artifactregistry.writer roles/cloudbuild.builds.builder; do
  gcloud projects add-iam-policy-binding $PROJECT_ID \
    --member="serviceAccount:${CLOUDBUILD_SA}" --role="$role"
done

gcloud iam service-accounts add-iam-policy-binding $SERVICE_ACCOUNT_EMAIL \
  --member="serviceAccount:${CLOUDBUILD_SA}" \
  --role="roles/iam.serviceAccountUser"
```

### 5. Build and deploy

```bash
export SERVICE_NAME="ccaas-sync-service"

gcloud builds submit . \
  --config=cloudbuild.yaml \
  --substitutions=_REGION=$REGION,_REPO_NAME=$REPO_NAME,_SERVICE_NAME=$SERVICE_NAME,_SERVICE_ACCOUNT=$SERVICE_ACCOUNT_EMAIL
```

Cloud Build deploys the service with:
- `--no-allow-unauthenticated` and `--ingress=internal-and-cloud-load-balancing`, so the `*.run.app` URL can't be reached from the internet;
- `--timeout=900`, so a live sync has time to finish.

Until you complete [step 7.3](#73-configure-the-service-to-verify-iap-identities), the UI shows "Service authentication is not configured".

Allow the application's service account to invoke the service. Cloud Scheduler needs this to trigger syncs.

```bash
gcloud run services add-iam-policy-binding $SERVICE_NAME \
  --region=$REGION \
  --member="serviceAccount:${SERVICE_ACCOUNT_EMAIL}" \
  --role="roles/run.invoker"
```

### 6. Set up the load balancer and custom domain

```bash
export DOMAIN="sync.your-domain.com"   # replace with your domain

gcloud compute network-endpoint-groups create ccaas-sync-neg \
  --region=$REGION \
  --network-endpoint-type=serverless \
  --cloud-run-service=$SERVICE_NAME

gcloud compute backend-services create ccaas-sync-backend --global
gcloud compute backend-services add-backend ccaas-sync-backend \
  --global \
  --network-endpoint-group=ccaas-sync-neg \
  --network-endpoint-group-region=$REGION

gcloud compute url-maps create ccaas-sync-url-map --default-service=ccaas-sync-backend

gcloud compute ssl-certificates create ccaas-sync-ssl-cert --domains=$DOMAIN --global

gcloud compute target-https-proxies create ccaas-sync-https-proxy \
  --ssl-certificates=ccaas-sync-ssl-cert \
  --url-map=ccaas-sync-url-map \
  --global

gcloud compute addresses create ccaas-sync-lb-ip --global
export LB_IP=$(gcloud compute addresses describe ccaas-sync-lb-ip --global --format="value(address)")

gcloud compute forwarding-rules create ccaas-sync-forwarding-rule \
  --address=ccaas-sync-lb-ip \
  --global \
  --target-https-proxy=ccaas-sync-https-proxy \
  --ports=443

echo "Create a DNS A record for $DOMAIN pointing to $LB_IP"
```

**Action required:** create a DNS `A` record for your domain pointing to the IP address printed above.

### 7. Secure the application with IAP

#### 7.1 OAuth consent screen and IAP client

```bash
gcloud beta services identity create --service=iap.googleapis.com --project=$PROJECT_ID

gcloud iap oauth-brands create \
  --application_title="CCaaS Sync Service" \
  --support_email=$(gcloud config get-value account)

gcloud iap oauth-clients create $(gcloud iap oauth-brands list --format='value(name)') \
  --display_name="CCaaS Sync IAP Client"
```

#### 7.2 Enable IAP and grant access

```bash
# Enable IAP on the backend service
gcloud compute backend-services update ccaas-sync-backend --global --iap=enabled

# Allow IAP to invoke the Cloud Run service
gcloud run services add-iam-policy-binding $SERVICE_NAME \
  --region=$REGION \
  --member="serviceAccount:service-${PROJECT_NUMBER}@gcp-sa-iap.iam.gserviceaccount.com" \
  --role="roles/run.invoker"

# Grant users access (comma-separated list)
export IAP_MEMBERS="user:your-email@example.com"
for member in ${IAP_MEMBERS//,/ }; do
  gcloud iap web add-iam-policy-binding \
    --member="$member" \
    --role="roles/iap.httpsResourceAccessor" \
    --resource-type=backend-services \
    --service=ccaas-sync-backend
done

# Verify
gcloud iap web get-iam-policy --resource-type=backend-services --service=ccaas-sync-backend
```

#### 7.3 Configure the service to verify IAP identities

The application checks the signed IAP header (`x-goog-iap-jwt-assertion`) on every API request, and rejects any request that didn't come through IAP.

```bash
export BACKEND_ID=$(gcloud compute backend-services describe ccaas-sync-backend --global --format='value(id)')

gcloud run services update $SERVICE_NAME \
  --region=$REGION \
  --update-env-vars=IAP_AUDIENCE=/projects/${PROJECT_NUMBER}/global/backendServices/${BACKEND_ID}
```

### 8. Restrict who can make changes (admin allowlist)

IAP decides who can open the app. `ADMIN_EMAILS` decides who can **change** things:

| Role | Can |
|---|---|
| **Admin** (listed in `ADMIN_EMAILS`) | Save the configuration (including credentials), run live syncs, proceed CCaaS jobs, run connection tests |
| **Viewer** (anyone else with IAP access) | View the configuration, CCaaS details, jobs and directory groups, and run simulations |

```bash
gcloud run services update $SERVICE_NAME --region=$REGION \
  --update-env-vars='^;^ADMIN_EMAILS=alice@example.com,bob@example.com,domain:ops.example.com'
```

Entries are email addresses or `domain:<domain>`. The `^;^` prefix tells gcloud to use `;` as the separator between variables, so the commas stay inside the value. The scheduler's service account can always run scheduled syncs. **If `ADMIN_EMAILS` is not set, every IAP user is an admin** (the behavior before 1.3.0). The UI shows a warning when this is the case.

### Option B: IAP directly on Cloud Run (no load balancer)

Instead of steps 6 and 7, you can turn on IAP directly on the Cloud Run service. This needs no load balancer, domain, certificate or static IP. Users sign in at the service's `run.app` URL.

1. **Deploy with ingress `all`.** Run [step 5](#5-build-and-deploy) with `_INGRESS=all` added to `--substitutions`. IAP on the service authenticates every request, and the app still verifies IAP's signed header.
2. **Turn on IAP and allow it to call the service:**
   ```bash
   gcloud beta services identity create --service=iap.googleapis.com --project=$PROJECT_ID

   gcloud run services add-iam-policy-binding $SERVICE_NAME --region=$REGION \
     --member="serviceAccount:service-${PROJECT_NUMBER}@gcp-sa-iap.iam.gserviceaccount.com" \
     --role="roles/run.invoker"

   gcloud beta run services update $SERVICE_NAME --region=$REGION --iap \
     --update-env-vars=IAP_AUDIENCE=/projects/${PROJECT_NUMBER}/locations/${REGION}/services/${SERVICE_NAME}
   ```
3. **Grant access** to admins and to the application's service account. Scheduled syncs go through IAP too, so the service account needs access as well.
   ```bash
   for member in user:your-email@example.com serviceAccount:${SERVICE_ACCOUNT_EMAIL}; do
     gcloud iap web add-iam-policy-binding --resource-type=cloud-run \
       --service=$SERVICE_NAME --region=$REGION \
       --member="$member" --role="roles/iap.httpsResourceAccessor" --condition=None
   done
   ```
4. **Let Cloud Scheduler through IAP.** IAP accepts Cloud Scheduler's Google-signed token only if the token's audience is an OAuth client ID that IAP trusts.
   1. In the Console, go to **Google Auth Platform > Clients** and create a **Web application** OAuth client. No redirect URIs are needed, and you don't need the client secret.
   2. Trust that client in IAP and tell the service to use it as the scheduler audience:
      ```bash
      export SCHEDULER_CLIENT_ID="<client-id>.apps.googleusercontent.com"

      cat > iap-settings.yaml <<EOF
      accessSettings:
        oauthSettings:
          programmaticClients:
          - ${SCHEDULER_CLIENT_ID}
      EOF
      gcloud iap settings set iap-settings.yaml --resource-type=cloud-run \
        --service=$SERVICE_NAME --region=$REGION

      gcloud run services update $SERVICE_NAME --region=$REGION \
        --update-env-vars=SCHEDULER_OIDC_AUDIENCE=$SCHEDULER_CLIENT_ID
      ```
   3. Open the UI and click **Save**. Saving updates the scheduler job to send the new audience.

> **Note:** If your organization restricts IAM members to your own domain (`iam.allowedPolicyMemberDomains`), the IAP service agent binding in step 2 may be rejected. Ask an org admin for a temporary project-level exception while you add it.

## Google Workspace without a stored key

To sync from Google Workspace, the service reads users and groups through the Admin SDK using **domain-wide delegation**. By default this is **keyless**: the service's own service account signs the delegation token through the IAM Credentials API, so no service account key is created or stored.

1. **Allow the service account to sign as itself:**
   ```bash
   gcloud iam service-accounts add-iam-policy-binding $SERVICE_ACCOUNT_EMAIL \
     --member="serviceAccount:${SERVICE_ACCOUNT_EMAIL}" \
     --role="roles/iam.serviceAccountTokenCreator"
   gcloud services enable iamcredentials.googleapis.com
   ```
2. **Authorize domain-wide delegation** in the Google Workspace Admin Console (**Security > Access and data control > API controls > Manage Domain Wide Delegation > Add new**):
   - **Client ID:** `gcloud iam service-accounts describe $SERVICE_ACCOUNT_EMAIL --format='value(oauth2ClientId)'`
   - **OAuth scopes:**
     `https://www.googleapis.com/auth/admin.directory.user.readonly,https://www.googleapis.com/auth/admin.directory.group.readonly,https://www.googleapis.com/auth/admin.directory.group.member.readonly`
3. In the UI, choose **Google Workspace**, select **Keyless domain-wide delegation**, enter a Workspace **Admin Email** the service will act as, and click **Test Connection**.

Deployments that already use a service account JSON key keep using it until an admin switches to keyless. After switching, delete the old key: `gcloud iam service-accounts keys delete KEY_ID --iam-account=...`.

## Monitoring and alerts

- **Health check:** `GET /healthz` returns `{"status":"ok","version":"…"}` with no authentication, and touches no configuration or secrets. Use it for uptime checks or load balancer health checks.
- **Run history:** the UI shows **Recent Sync Runs**, and runs are stored in the Firestore collection `ccaas-sync-runs` (newest 200).
- **Structured logs:** each sync writes one log entry with `jsonPayload.event="sync_run"`, plus `outcome`, `trigger`, `simulate`, `counts` and `jobId`:
  ```bash
  gcloud logging read 'jsonPayload.event="sync_run"' --limit=10 \
    --format='table(timestamp,severity,jsonPayload.outcome,jsonPayload.trigger,jsonPayload.counts)'
  ```
- **Alerts:** `scripts/setup-alerts.sh` creates an email notification channel and two Cloud Monitoring alert policies:
  1. **Sync failed or blocked:** any live sync with outcome `error`, `blocked`, `group_not_found`, `job_failed` or `job_timeout`.
  2. **No successful scheduled sync:** no successful scheduled run for `NO_SUCCESS_HOURS` hours (default 3).
  ```bash
  PROJECT_ID=$PROJECT_ID SERVICE_NAME=$SERVICE_NAME NOTIFY_EMAIL=ops@example.com ./scripts/setup-alerts.sh
  ```

## Sync safety

Each sync works out which users to add, update and deactivate, then submits one CCaaS bulk job. To prevent accidental mass deactivation:

| Safeguard | Behavior |
|---|---|
| **Missing group** | If a mapped directory group can't be found, the whole sync is aborted. It no longer counts as "no members". |
| **Empty directory** | If no mapped group returns any users, but CCaaS has users managed by this tool, the sync is aborted. This check can't be overridden. |
| **Deactivation limit** | **Max Deactivations per Sync** (default 25; 0 blocks all deactivations). Scheduled syncs over the limit are blocked. Manual syncs over the limit show a **Run Anyway** option that requires confirmation. |
| **Simulation** | **Simulate Only** shows the counts and the email addresses that would be added, updated or deactivated, and warns when a live run would be blocked. |
| **One sync at a time** | A Firestore lock prevents overlapping live syncs (manual plus scheduled). A second request gets HTTP 409. |

Other behavior to be aware of:
- Emails are compared without regard to case.
- Users are matched against **all** CCaaS users, across every page of results.
- If a user matches several team mappings, only the first team is applied, and the result includes a warning.
- Scheduled times are in UTC.
- Logs contain only counts and job IDs, never user details.

## Upgrading

### To 1.3.0 (hardening)

1. Redeploy, then **set `ADMIN_EMAILS`** (step 8).
2. **Tighten the service account's permissions.** Grant the roles from step 4.2, then remove the broad project-wide ones that earlier versions of this README asked for:
   ```bash
   for role in roles/secretmanager.admin roles/secretmanager.secretAccessor roles/secretmanager.secretVersionManager roles/cloudscheduler.admin roles/iam.serviceAccountUser; do
     gcloud projects remove-iam-policy-binding $PROJECT_ID \
       --member="serviceAccount:${SERVICE_ACCOUNT_EMAIL}" --role="$role" 2>/dev/null || true
   done
   ```
3. Open the UI and click **Save** to confirm the scheduler job can still be updated.

### To 1.1.0 (sync safety)

1. Pull the latest code and redeploy ([step 5](#5-build-and-deploy)). Redeploying sets `--timeout=900` and the `REGION` environment variable.
2. Open the UI, review **Max Deactivations per Sync** (default 25), and click **Save**. Saving recreates the scheduler job with a 15-minute deadline and no automatic retries. If your service isn't in `us-central1`, saving also removes the old scheduler job from `us-central1`.
3. Run **Simulate Only** and review the results before the next scheduled run. Tenants with more than 100 users, or Entra ID groups with more than 100 members, may see corrections that earlier versions missed because they only read the first page of results.

### To 1.0.1 (security fix, GHSA-47vv-vx4f-pm44)

Deployments created before 1.0.1 used `--allow-unauthenticated`, which made the API reachable without IAP through the `*.run.app` URL. After redeploying and completing [step 7.3](#73-configure-the-service-to-verify-iap-identities):

```bash
# Remove the public invoker binding (if still present) and restrict ingress
gcloud run services remove-iam-policy-binding $SERVICE_NAME \
  --region=$REGION --member="allUsers" --role="roles/run.invoker"
gcloud run services update $SERVICE_NAME --region=$REGION --ingress=internal-and-cloud-load-balancing

# The run.app URL should now return 403 or 404
curl -s -o /dev/null -w "%{http_code}\n" -X POST \
  "$(gcloud run services describe $SERVICE_NAME --region=$REGION --format='value(status.url)')/api/config"
```

Then:
- **Rotate all stored credentials:** the AD bind password, CCaaS API key, Entra client secret and Google service account key.
- Check that the stored CCaaS host and LDAP URL are correct.
- Review the Cloud Run request logs for unexpected `POST` requests to `/api/config`, `/api/sync`, `/api/directory-test` or `/api/directory-groups`.

Changing the CCaaS host, LDAP URL or Entra tenant/client ID now requires re-entering the matching credential in the same save.

## Appendix: Microsoft Entra ID setup

1. In the [Microsoft Entra admin center](https://entra.microsoft.com/), go to **Identity > Applications > App registrations** and click **New registration**.
2. Name it (e.g. *CCaaS Sync Service*), choose **Accounts in this organizational directory only**, and click **Register**.
3. Copy the **Application (client) ID** and **Directory (tenant) ID** for the configuration UI.
4. Under **Certificates & secrets**, create a **New client secret** and copy its **Value** right away. It is shown only once.
5. Under **API permissions**, add these **Microsoft Graph > Application permissions**:
   - `Group.Read.All`
   - `GroupMember.Read.All`
   - `User.Read.All`
6. Click **Grant admin consent** for your organization.
