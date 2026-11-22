# Roadmap

This is a proposed roadmap for CCaaS Bulk Sync after 2.0.0. It is a plan, not a commitment: items, order and sizes may change. See the [CHANGELOG](CHANGELOG.md) for what has shipped.

Feedback is welcome. Open an issue to vote for an item, suggest a new one, or describe your use case. See [CONTRIBUTING.md](CONTRIBUTING.md) if you'd like to help build one.

Sizes are rough engineering estimates for one person: **S** is up to 2 days, **M** is 3–5 days, **L** is 1–2 weeks and **XL** is more than 2 weeks. Items marked **(API?)** depend on fields the CCaaS bulk API may not support; check those first.

```mermaid
flowchart LR
  v21["v2.1: Safety and governance"] --> v22["v2.2: Richer mappings and reporting"]
  v22 --> v3["v3.0: Real time, multi-tenant, routing"]
```

### v2.1: Safety and governance (about 3–4 weeks)
| Item | Size | Why |
|---|---|---|
| **Grace period before deactivation**: deactivate only after a user has been missing for N days or N runs | M | Protects against short-lived directory glitches and accidental group edits. |
| **Scheduled dry runs with notifications**: simulate on the schedule and send the diff by email or Google Chat; apply after approval | M | Lets admins review changes without opening the UI; reuses the simulation diff. |
| **Approval workflow**: a live sync over a threshold waits for a second admin | M | Two-person control for large changes. |
| **Run notifications**: email, Google Chat or Slack webhook, or Pub/Sub, on every run or only on blocked or failed runs | S | Faster reaction than log-based alerts alone. |
| **Config as code**: export and import the configuration as JSON or YAML, with a diff view of changes | M | Repeatable environments, promotion from test to prod, code review of mappings. |
| **Audit log of configuration changes**: who, when, before and after (never secrets), to Cloud Logging or BigQuery | S | Governance and support. |
| **End-to-end UI tests in CI**: headless Chrome against a mocked API | M | Guards the new UI; practical now that the template is precompiled. |
| Percentage deactivation limits and per-mapping limits | S | Scales the safety limit with tenant size. |

### v2.2: Richer mappings and reporting (about 4–6 weeks)
| Item | Size | Why |
|---|---|---|
| **Attribute-based mappings**: rules on department, location, job title or cost center, combined with AND/OR, alongside group mappings | L | A common enterprise need that groups alone don't cover. |
| **More synced attributes**: phone or extension, time zone, language, employee ID **(API?)** | M | Fewer manual edits in CCaaS. |
| **Primary team or role priority** (optional) when a user matches several mappings | S | Only if admins ask for it; teams accumulate today. |
| **Drift detection**: flag managed users whose roles or teams were changed by hand in CCaaS | M | Shows where manual edits will be overwritten. |
| **Reporting**: BigQuery export of runs and per-team counts, plus a Looker Studio template | M | Trends: adds and deactivations per week, users per team and role. |
| **Run history export (CSV)**, errors per user, and links to CCaaS bulk jobs | S | Audit and support. |
| **Mapping preview**: member count per group, with nested groups on and off, in the Group Mappings card | S | Shows a mapping's effect before simulating. |
| **Finer access control**: mapping editor, credential admin and approver roles; Google Groups as the admin source | M | Separation of duties; easier than maintaining `ADMIN_EMAILS`. |
| **Load tests**: synthetic tenants with more than 10,000 users and deep nesting | M | Finds limits before customers do. |

### v3.0: Real time, multi-tenant, routing (about 2–3 months)
| Item | Size | Why |
|---|---|---|
| **Delta sync**: Graph delta queries, LDAP `uSNChanged`, Workspace push notifications | L | Faster and cheaper for very large tenants; enables frequent syncs. |
| **Inbound SCIM 2.0 endpoint** for Entra ID and Okta | XL | Near real-time provisioning; a standard enterprise integration. |
| **More directories**: Okta, generic SCIM, OpenLDAP or FreeIPA, CSV upload | L | Wider customer coverage. |
| **Multiple CCaaS instances and directories** in one deployment, each with its own mappings and schedule | XL | Regional tenants, test and prod, mergers. |
| **Skills and proficiency, queues and supervisors** from groups, attributes or the manager field **(API?)** | L | Moves from user provisioning to routing setup. |
| **Rollback**: re-apply the state from before a given run | M | Fast recovery from a bad sync. |
| **Keyless directory credentials**: Workload Identity Federation for Entra; certificate or Kerberos login for AD | M | Removes the remaining stored secrets. |
| **Packaging**: a "Deploy to Cloud Run" button or Marketplace listing; signed images with SLSA provenance | M | Easier adoption and supply-chain assurance. |
| **Public API and CLI** for triggering syncs, reading results and managing mappings | M | Automation from CI/CD and runbooks. |

### Open questions
1. **Check the CCaaS bulk API** for the **(API?)** fields: skills, queues, supervisors, phone, time zone, language.
2. **Validate priorities with users or customers:** are attribute mappings, approvals or SCIM most wanted?
3. **Expand test data** before v2.2: more than 1,000 CCaaS users; Entra and AD groups with more than 100 members, deep nesting and special characters.
