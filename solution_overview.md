CCaaS Bulk Synchronization Service - Solution Overview
1. Introduction
This document provides a technical overview of the CCaaS Bulk Synchronization Service, a Node.js application designed to run on Google Cloud Run. The primary purpose of this service is to act as a bridge between a source user directory (Microsoft Active Directory or Google Workspace) and Google Cloud Contact Center AI Platform (CCaaS).

It automates the process of user lifecycle management within CCaaS by synchronizing users from directory groups to specific CCaaS teams and roles. When users are added or removed from a source group (e.g., due to new hires or departures), the service automatically updates their status in CCaaS, ensuring user access is always current.

2. System Architecture
The solution is composed of several key components running on Google Cloud:

Node.js Application: The core of the service, built with Express.js. It provides a web UI and an API for configuration and exposes an endpoint to trigger the synchronization logic.

Web UI: A single-page application for configuration. Administrators can manage CCaaS and directory service credentials, map directory groups to CCaaS teams/roles, and manually trigger a sync.

Google Cloud Run: A fully managed serverless platform that hosts the containerized Node.js application.

Google Cloud Firestore: A serverless NoSQL document database used to persistently store the application's configuration, such as API keys, directory settings, and group mappings.

Google Cloud Build: A continuous integration and deployment (CI/CD) service used to automate the building of the Docker container and its deployment to Cloud Run.

Google Cloud Scheduler: A cron job service used to trigger the synchronization process on a recurring schedule.

Identity-Aware Proxy (IAP): A Google Cloud security service that protects the web UI by enforcing access policies.

3. Core Functionality
The main business logic is contained within the sync-logic.js module. The process is executed as follows:

Fetch Source Users: Based on the configured mappings stored in Firestore, the service connects to either Google Workspace or Microsoft Active Directory to fetch the current list of users within specified groups.

Fetch CCaaS State: The service makes calls to the CCaaS Bulk Update API to retrieve the list of available teams and roles for display in the UI's mapping configuration.

Compare and Reconcile: The application compares the list of users from the source directory with the list of existing users in CCaaS.

New Users: Users present in the source directory but not in CCaaS are marked for creation.

Existing Users: Users present in both systems are marked for update.

Deactivated Users: Users present in CCaaS but no longer in any mapped source groups are marked for deactivation.

Execute Bulk Update: The service constructs a payload containing the lists of users to be created, updated, and deactivated and sends it to the CCaaS Bulk Update API.

4. Configuration
All configuration is managed through the secure web UI and stored persistently in a Firestore document.

CCaaS Settings: The CCaaS API host URL and the necessary API key for authentication.

Directory Settings: The type of directory (Google Workspace or AD) and the required connection details.

Group Mappings: A flexible mapping table to define relationships between a source group and a specific CCaaS team and role.

Manual Trigger: A "Run Now" button in the UI for on-demand synchronization.

5. Deployment and Automation
The deployment and scheduling process is automated using infrastructure-as-code:

cloudbuild.yaml: This file defines the CI/CD pipeline. When changes are pushed to the source repository, Cloud Build automatically builds a new Docker image, pushes it to Google Artifact Registry, and deploys it to Cloud Run.

Cloud Scheduler: A scheduled job is configured to send a POST request to the /api/sync endpoint of the Cloud Run service at a defined interval, triggering the automated synchronization.