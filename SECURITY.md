# Security Policy

## Reporting a vulnerability

Please **do not** open a public GitHub issue for security problems.

Report vulnerabilities privately through GitHub: **Security > Report a vulnerability** on this repository. You can also use Google's Vulnerability Reward Program at https://g.co/vulnz.

Please include the affected version or commit, steps to reproduce, and the impact.

## Supported versions

Only the latest release receives security fixes. Upgrade to the latest release and follow the upgrade notes in the README.

## Deployment security model

- The Cloud Run service must never be publicly invokable. Use either the HTTPS load balancer with IAP, or IAP directly on Cloud Run (see the README).
- Every `/api/*` request must carry a valid, signed IAP JWT. The app verifies it against `IAP_AUDIENCE`.
- Credentials are stored only in Secret Manager. They are never returned by the API, and never stored in the Firestore configuration.
