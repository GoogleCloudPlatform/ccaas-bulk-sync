# Terraform deployment

This module deploys CCaaS Bulk Sync with the same security setup as the manual steps in the main README:

- Required APIs, Firestore (optional) and the Artifact Registry repository.
- The four Secret Manager secrets, created empty. Credentials are entered in the UI, so they **never end up in Terraform state**.
- A least-privilege runtime service account: Firestore access, a custom role for Cloud Scheduler jobs, per-secret access, and "act as" plus token signing on itself only.
- The Cloud Run service: 900-second timeout, `/healthz` startup probe, and every setting the app needs (`IAP_AUDIENCE`, `ADMIN_EMAILS`, `SCHEDULER_OIDC_AUDIENCE`, …).
- IAP, one of two ways (`iap_mode`):
  - **`cloud_run`** (default): IAP directly on Cloud Run, with no load balancer.
  - **`load_balancer`**: an external HTTPS load balancer with IAP, a managed certificate and a static IP for `domain`.
- Optional email alerts (`notify_email`), the same as `scripts/setup-alerts.sh`.

The Cloud Scheduler job isn't managed by Terraform. The app creates and updates it when you save the schedule in the UI.

## Usage

```bash
cd terraform
cp terraform.tfvars.example terraform.tfvars   # edit it

# 1. Create the Artifact Registry repository, then build the image into it.
terraform init
terraform apply -target=google_artifact_registry_repository_iam_member.build_push \
  -target=google_project_iam_member.build_logs -target=google_project_iam_member.build_source
(cd .. && gcloud builds submit . --project=PROJECT --region=REGION \
  --config=terraform/cloudbuild-image.yaml \
  --service-account=projects/PROJECT/serviceAccounts/$(terraform -chdir=terraform output -raw build_service_account) \
  --substitutions=_IMAGE=REGION-docker.pkg.dev/PROJECT/ccaas-sync-repo/ccaas-sync-service:v2.0.0)

# 2. Deploy everything else.
terraform apply
terraform output next_steps
```

To upgrade later, build a new image tag, set `image`, and run `terraform apply`.

## Steps Terraform can't do

| Step | Why | How |
|---|---|---|
| OAuth client for Cloud Scheduler (`cloud_run` mode) | Google shut down the API for creating IAP OAuth clients | Console: **Google Auth Platform > Clients > Create client > Web application**. Set `scheduler_oauth_client_id` and apply again. |
| DNS record (`load_balancer` mode) | DNS is usually managed elsewhere | Create an A record for `domain` pointing to `terraform output load_balancer_ip`. |
| Workspace domain-wide delegation (Google Workspace keyless sync) | It's configured in the Workspace Admin Console | Authorize `terraform output service_account_client_id` with the three Directory read-only scopes (main README). |
| CCaaS and directory credentials | They must not be stored in Terraform state | Enter them in the UI and click **Save**. |

> **Note:** If your organization restricts IAM members to your own domain (`iam.allowedPolicyMemberDomains`), the binding for the IAP service agent (`google_cloud_run_v2_service_iam_member.iap_invoker`) may be rejected. Ask an org admin for a temporary project-level exception.
