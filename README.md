# **CCaaS Bulk Synchronization Service \- README**

This document provides instructions to deploy and configure the CCaaS Bulk Synchronization Service on Google Cloud.

## **Local Development**

To run and test the application on your local machine:

1. **Install Dependencies**: npm install  
2. **Build CSS**: npm run build:css  
3. **Run Server**: node index.js

The application will be available at http://localhost:8080.

## **1\. Enable Google Cloud APIs**

Enable the necessary APIs for your project.

export PROJECT\_ID=$(gcloud config get-value project)

gcloud services enable \\  
  run.googleapis.com \\  
  artifactregistry.googleapis.com \\  
  cloudbuild.googleapis.com \\  
  iam.googleapis.com \\  
  firestore.googleapis.com \\  
  cloudscheduler.googleapis.com \\  
  iap.googleapis.com \\  
  compute.googleapis.com \\  
  cloudresourcemanager.googleapis.com \\  
  secretmanager.googleapis.com \\  
  admin.googleapis.com

## **2\. Create the Firestore Database**

Create a Firestore database in Native mode to store the application's configuration.

export REGION="us-central1" \# Or your preferred region

gcloud firestore databases create \--location=$REGION

## **3\. Create an Artifact Registry Repository**

Create a repository to store the Docker container image for the application.

export REPO\_NAME="ccaas-sync-repo"

gcloud artifacts repositories create $REPO\_NAME \\  
    \--repository-format=docker \\  
    \--location=$REGION \\  
    \--description="Repository for CCaaS Sync Service"

## **4\. Create Secrets and Service Accounts**

### **4.1 Create Secrets in Secret Manager**

Create empty secrets to hold your credentials.

gcloud secrets create ccaas-api-key \--replication-policy="automatic"  
gcloud secrets create gcp-sa-key \--replication-policy="automatic"  
gcloud secrets create ad-bind-password \--replication-policy="automatic"  
gcloud secrets create entra-client-secret \--replication-policy="automatic"

### **4.2 Create and Configure Service Accounts**

**a. Create a Dedicated Service Account for the Application**

export SERVICE\_ACCOUNT\_NAME="ccaas-sync-sa"  
export SERVICE\_ACCOUNT\_EMAIL="${SERVICE\_ACCOUNT\_NAME}@${PROJECT\_ID}.iam.gserviceaccount.com"

gcloud iam service-accounts create $SERVICE\_ACCOUNT\_NAME \\  
    \--display-name="CCaaS Sync Service Account"

**b. Grant Permissions to the Application's Service Account**

\# Grant permission to manage Cloud Scheduler  
gcloud projects add-iam-policy-binding $PROJECT\_ID \\  
    \--member="serviceAccount:${SERVICE\_ACCOUNT\_EMAIL}" \\  
    \--role="roles/cloudscheduler.admin"

\# Grant permission to access Firestore  
gcloud projects add-iam-policy-binding $PROJECT\_ID \\  
    \--member="serviceAccount:${SERVICE\_ACCOUNT\_EMAIL}" \\  
    \--role="roles/datastore.user"

\# Grant permission to fully manage Secret Manager secrets  
gcloud projects add-iam-policy-binding $PROJECT\_ID \\  
    \--member="serviceAccount:${SERVICE\_ACCOUNT\_EMAIL}" \\  
    \--role="roles/secretmanager.admin"

\# Grant permission for the service account to act as itself for scheduler jobs  
gcloud iam service-accounts add-iam-policy-binding ${SERVICE\_ACCOUNT\_EMAIL} \\  
    \--member="serviceAccount:${SERVICE\_ACCOUNT\_EMAIL}" \\  
    \--role="roles/iam.serviceAccountUser"

**c. Grant Permissions to Cloud Build**

export PROJECT\_NUMBER=$(gcloud projects describe $PROJECT\_ID \--format='value(projectNumber)')

gcloud projects add-iam-policy-binding $PROJECT\_ID \\  
    \--member="serviceAccount:${PROJECT\_NUMBER}@cloudbuild.gserviceaccount.com" \\  
    \--role="roles/run.admin"

\# Grant Cloud Build the ability to act as the Cloud Run service account  
gcloud iam service-accounts add-iam-policy-binding ${SERVICE\_ACCOUNT\_EMAIL} \\  
    \--member="serviceAccount:${PROJECT\_NUMBER}@cloudbuild.gserviceaccount.com" \\  
    \--role="roles/iam.serviceAccountUser"

gcloud projects add-iam-policy-binding $PROJECT\_ID \\  
    \--member="serviceAccount:${PROJECT\_NUMBER}@cloudbuild.gserviceaccount.com" \\  
    \--role="roles/artifactregistry.writer"

gcloud projects add-iam-policy-binding $PROJECT\_ID \\  
    \--member="serviceAccount:${PROJECT\_NUMBER}@cloudbuild.gserviceaccount.com" \\  
    \--role="roles/cloudbuild.builds.builder"

## **5\. Build and Deploy the Service**

This step uses Cloud Build to package the application into a Docker container and deploy it to Cloud Run.

export SERVICE\_NAME="ccaas-sync-service"

gcloud builds submit . \\  
  \--config=cloudbuild.yaml \\  
  \--substitutions=\_REGION=$REGION,\_REPO\_NAME=$REPO\_NAME,\_SERVICE\_NAME=$SERVICE\_NAME,\_SERVICE\_ACCOUNT=$SERVICE\_ACCOUNT\_EMAIL

### **5.1 Grant Invocation Permission to Service Account**

Allow the application's service account to invoke the Cloud Run service. This is required for Cloud Scheduler to trigger the sync.

gcloud run services add-iam-policy-binding $SERVICE\_NAME \\  
    \--region=$REGION \\  
    \--member="serviceAccount:${SERVICE\_ACCOUNT\_EMAIL}" \\  
    \--role="roles/run.invoker"

## **6\. Set up Load Balancer and Custom Domain**

Configure an external HTTPS load balancer to provide a custom domain and SSL for the service.

### **6.1 Create a Serverless NEG**

gcloud compute network-endpoint-groups create ccaas-sync-neg \\  
    \--region=$REGION \\  
    \--network-endpoint-type=serverless \\  
    \--cloud-run-service=$SERVICE\_NAME

### **6.2 Create a Backend Service**

gcloud compute backend-services create ccaas-sync-backend \\  
    \--global

gcloud compute backend-services add-backend ccaas-sync-backend \\  
    \--global \\  
    \--network-endpoint-group=ccaas-sync-neg \\  
    \--network-endpoint-group-region=$REGION

### **6.3 Create a URL Map**

gcloud compute url-maps create ccaas-sync-url-map \\  
    \--default-service=ccaas-sync-backend

### **6.4 Create a Google-Managed SSL Certificate**

export DOMAIN="sync.your-domain.com" \# \<-- REPLACE with your actual domain

gcloud compute ssl-certificates create ccaas-sync-ssl-cert \\  
    \--domains=$DOMAIN \\  
    \--global

### **6.5 Create the HTTPS Proxy**

gcloud compute target-https-proxies create ccaas-sync-https-proxy \\  
    \--ssl-certificates=ccaas-sync-ssl-cert \\  
    \--url-map=ccaas-sync-url-map \\  
    \--global

### **6.6 Create a Static IP and Forwarding Rule**

gcloud compute addresses create ccaas-sync-lb-ip \--global

export LB\_IP=$(gcloud compute addresses describe ccaas-sync-lb-ip \--global \--format="value(address)")  
echo "Load Balancer IP Address: $LB\_IP"  
echo "Please create an 'A' record in your DNS for $DOMAIN pointing to this IP address."

gcloud compute forwarding-rules create ccaas-sync-forwarding-rule \\  
    \--address=ccaas-sync-lb-ip \\  
    \--global \\  
    \--target-https-proxy=ccaas-sync-https-proxy \\  
    \--ports=443

**Action Required:** Go to your DNS provider and create an "A" record for your domain that points to the IP address output above.

## **7\. Secure the Application with IAP**

### **7.1 Create OAuth Consent Screen and IAP OAuth Client**

gcloud beta services identity create \--service=iap.googleapis.com \--project=$PROJECT\_ID

export SUPPORT\_EMAIL=$(gcloud config get-value account)

gcloud iap oauth-brands create \\  
  \--application\_title="CCaaS Sync Service" \\  
  \--support\_email=$SUPPORT\_EMAIL

gcloud iap oauth-clients create $(gcloud iap oauth-brands list \--format='value(name)') \\  
  \--display\_name="CCaaS Sync IAP Client"

### **7.2 Enable IAP and Grant Permissions**

**a. Enable IAP on the Backend Service**

gcloud compute backend-services update ccaas-sync-backend \--global \--iap=enabled

**b. Grant IAP permission to invoke the Cloud Run service**

export IAP\_SA="service-${PROJECT\_NUMBER}@gcp-sa-iap.iam.gserviceaccount.com"  
gcloud run services add-iam-policy-binding $SERVICE\_NAME \\  
    \--region=$REGION \\  
    \--member="serviceAccount:${IAP\_SA}" \\  
    \--role="roles/run.invoker"

**c. Grant Users Access to the Application**

export IAP\_MEMBERS="user:your-email@example.com"

IFS=','  
for member in $IAP\_MEMBERS; do  
  echo "Granting IAP access to $member"  
  gcloud iap web add-iam-policy-binding \\  
      \--member="$member" \\  
      \--role="roles/iap.httpsResourceAccessor" \\  
      \--resource-type=backend-services \\  
      \--service="ccaas-sync-backend"  
done  
unset IFS

**d. Verify the IAP Policy**

gcloud iap web get-iam-policy \--resource-type=backend-services \--service=ccaas-sync-backend

## **Appendix: Microsoft Entra ID Setup**

To get a **Client ID** and **Client Secret** for Microsoft Entra ID, you need to create an App Registration.

1. Navigate to the [**Microsoft Entra admin center**](https://www.google.com/search?q=https://entra.microsoft.com/).  
2. Go to **Identity \> Applications \> App registrations**.  
3. Click **\+ New registration**.  
4. Give it a descriptive name (e.g., CCaaS Sync Service).  
5. For "Supported account types," select "Accounts in this organizational directory only".  
6. Click **Register**.  
7. On the app's overview page, copy the **Application (client) ID** and the **Directory (tenant) ID**. You will need these for the configuration UI.  
8. In the left navigation, go to **Certificates & secrets**.  
9. Click **\+ New client secret**, provide a description, and choose an expiration period.  
10. **Immediately copy the Value of the new secret.** This is your Client Secret, and it will not be shown again after you leave this page.  
11. In the left navigation, go to **API permissions**.  
12. Click **\+ Add a permission**, then select **Microsoft Graph**.  
13. Select **Application permissions**.  
14. Search for and add the following permissions:  
    * Group.Read.All  
    * GroupMember.Read.All  
    * User.Read.All  
15. Click the Grant admin consent for$$Your Organization$$  
    button to approve the permissions.