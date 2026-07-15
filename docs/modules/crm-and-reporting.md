---
title: CRM and Workbook Reporting
status: active
kind: module-contract
tags: [crm, suitecrm, organizations, contacts, opportunities, reporting]
app_visible: true
---

# CRM and Workbook Reporting

## Purpose

Use ClawPilot as the customer-work interface, SuiteCRM as the canonical CRM, Railway Postgres as the durable ClawPilot projection and action store, and Google Sheets as the opportunity input and reporting workbook.

## Ownership Contract

- SuiteCRM owns Organizations, Contacts, Leads, Opportunities, Meetings, Interactions, Campaigns, CRM relationships, and CRM record history.
- ClawPilot is the primary user interface for those modules. Administrators may open the native SuiteCRM surface for configuration and inspection.
- A workspace organization owns one durable `ga` identity and an app user owns one durable `gc` identity. Their pipeline records are projections of those identities, not new accounts or contacts.
- Saving a user profile updates the app user and workspace organization atomically, projects the user into every pipeline they own, and queues CRM and Drive reconciliation. Shared pipelines are excluded from profile projection. Migration `0025_profile_crm_projection_backfill.sql` applies the same projection to historical pipelines whose owner contact predates this workflow.
- The selected pipeline's `Opportunities` Sheet table is the only writable workbook input. Sheet pulls stage those changes into the same CRM gateway used by ClawPilot writes.
- Railway Postgres stores tenant-scoped CRM projections, source identity, synchronization status, reconciliation runs, and outbox leases. It is not a second independent CRM authority.
- Development and production use separate SuiteCRM, MariaDB, Postgres, Google workbook, and user data.

## Entity Mapping

| ClawPilot | SuiteCRM | Workbook |
|---|---|---|
| `ga5999999` Organization | Account | Generated `Organizations` projection |
| `gc5999999` Contact | Contact | Generated `Contacts` projection |
| `gl5999999` Lead | Lead | CRM only |
| `go5999999` Opportunity | Opportunity | Writable `Opportunities` input and canonical projection |
| `gm5999999` Meeting | Meeting | CRM only |
| `gi5999999` Interaction | Note | Generated `Interactions` projection |
| `gk5999999` Campaign | Campaign | CRM only |

Every migrated record preserves its source workbook payload, source row, stable source key, deterministic SuiteCRM identifier, last synchronization state, and error details. Imports are additive and idempotent; they do not delete the source workbook.

Each reference code has an organization-scoped short link. A signed-in user resolves the reference against the selected pipeline; canonical organization and user codes remain stable when the same identity is projected into another owned pipeline.

## Customer Actions

- Contact and lead records can send email through the signed-in user's selected Maton `google-mail` connection. ClawPilot verifies the authenticated Gmail profile and does not accept a caller-supplied From identity.
- Organization, contact, lead, opportunity, and meeting records can create Google Calendar invitations through that user's selected `google-calendar` connection.
- Records with a phone number expose a call command. It records the interaction before returning a validated `tel:` URL to the device.
- Campaigns accept `gc` and `gl` recipients, support `{{firstName}}`, `{{lastName}}`, `{{name}}`, `{{email}}`, and `{{referenceCode}}` merge fields, deduplicate recipients by email, and suppress opted-out recipients.
- Every action is a durable intent with an idempotency key, leased provider attempt, retry state, audit event, and resulting CRM interaction. The worker handles failed retries and campaign child messages.

## Email Association

Outbound CRM email appends exactly one `%gslt<reference>` marker, such as `%gsltga5999999`. There is no space between `gslt` and the reference.

Inbound Gmail polling runs per active user's selected connection. It follows these rules:

1. The first case-insensitive `%xx` ends imported content; content after it is neither stored nor cataloged.
2. Every exact `%gslt<reference>` before that boundary is resolved. One message may reference multiple CRM records.
3. Repeated markers in a quoted thread are deduplicated by reference. Gmail message ID plus reference prevents repeated actions across polling overlap.
4. An explicit marker can resolve across pipelines owned by the mailbox user. The default pipeline is only a deterministic tie-breaker for repeated canonical `ga` or `gc` projections.
5. Without a marker, a unique sender-email match in the default pipeline may associate the message. Ambiguous senders remain unmatched.

## Workbook Contract

The managed workbook requires `Start Here`, `Organizations`, `Contacts`, `Opportunities`, `Interactions`, `Calculations`, `Dashboard`, and `Dropdowns`. Headers begin on row 4. Column A carries a hidden, protected ClawPilot record identity for CRM entity tabs.

Google protected ranges permit user edits only in `Opportunities!B5:M`. All other tabs, the opportunity headers, and record identifiers are generated and protected. `Calculations` and `Dashboard` derive reporting values from the projected CRM data.

The pipeline and CRM surfaces expose the workbook through its ClawPilot short link. The Pipeline header also creates, retries, or repairs the managed Sheet when the current owner has no usable link. That link does not bypass Google access controls.

## Synchronization

1. A ClawPilot form write or an Opportunities Sheet pull stages a pipeline-scoped Postgres projection and a `suitecrm` outbox item atomically.
2. The SuiteCRM worker claims records with a lease, uses OAuth2 client credentials against the private Railway service, and records success or a retriable failure.
3. A successful SuiteCRM batch queues a `project_crm_workbook` Google outbox operation.
4. The Google worker regenerates the protected workbook projections and records a reconciliation run.

The active endpoints are `/api/crm`, `/api/crm/actions`, `/api/crm/import`, `/api/crm/workbook`, `/api/crm/outbox/process`, and the authenticated action/inbound-mail worker at `/api/crm/integrations/process`.

## Operations

Use the [SuiteCRM Railway runbook](../operations/suitecrm.md) for service variables, volume, worker, migration, and rollback checks. Use [Pipeline and synchronization](pipeline-and-sync.md) for Google provisioning and workbook access.
