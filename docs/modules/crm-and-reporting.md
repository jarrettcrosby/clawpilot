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
| `ga4827316` Organization | Account | Generated `Organizations` projection |
| `gc8172045` Contact | Contact | Generated `Contacts` projection |
| `gl3549182` Lead | Lead | CRM only |
| `go7402631` Opportunity | Opportunity | Writable `Opportunities` input and canonical projection |
| `gm1968457` Meeting | Meeting | CRM only |
| `gi6253094` Interaction | Note | Generated `Interactions` projection |
| `gk9035718` Campaign | Campaign | CRM only |

Every migrated record preserves its source workbook payload, source row, stable source key, deterministic SuiteCRM identifier, last synchronization state, and error details. Imports are additive and idempotent; they do not delete the source workbook.

Every SuiteCRM module in the table has a native custom field labeled `Global ID`. Its API name is `global_id_c`; it is visible on the native detail layout, reportable, audited, available to unified search, and populated from the permanent ClawPilot reference. Existing projections are refreshed with `npm run crm:backfill-suitecrm` after the SuiteCRM metadata deployment.

The two-letter module prefix is fixed and the seven-digit suffix is randomly allocated. The permanent registries reserve both the full code and the numeric suffix globally across modules, prevent concurrent collisions, and never release either value after deletion or archival. Sequential codes issued before this contract remain reserved aliases that resolve to the replacement code and can never be reissued.

Each reference code has an organization-scoped short link. The link selects its owning pipeline after access is verified, then opens the record in ClawPilot; canonical organization and user codes remain stable when the same identity is projected into another owned pipeline.

## Customer Actions

- Organization, contact, and lead records with an email address can send through the signed-in user's selected Maton `google-mail` connection. ClawPilot displays the selected sender before submission, verifies the authenticated Gmail profile, records the actual sender in the provider attempt, and does not accept a caller-supplied From identity.
- Organization, contact, lead, opportunity, and meeting records can create Google Calendar invitations through that user's selected `google-calendar` connection. The action composer displays the selected organizer and records it with the provider result.
- Every Calendar invitation created by ClawPilot includes the meeting's permanent `gm` reference and organization-scoped short link. The `gm` reference is also stored in the event's private Google metadata so later Calendar changes can be reconciled safely.
- Records with a phone number expose a call command. It records the interaction before returning a validated `tel:` URL to the device.
- Campaigns accept `gc` and `gl` recipients, support `{{firstName}}`, `{{lastName}}`, `{{name}}`, `{{email}}`, and `{{referenceCode}}` merge fields, deduplicate recipients by email, and suppress opted-out recipients.
- Every action is a durable intent with an idempotency key, leased provider attempt, retry state, audit event, and resulting CRM interaction. The worker handles failed retries and campaign child messages.

## Email Association

Outbound CRM email always appends exact `%gslt<reference>` markers with no space after `gslt`. Organization and lead messages carry their target reference. Contact messages carry both the contact `gc` reference and its related organization `ga` reference so a reply is associated with both records through one CRM interaction.

Inbound Gmail polling runs per active user's selected connection. It follows these rules:

1. The first case-insensitive `%xx` ends imported content; content after it is neither stored nor cataloged.
2. Every exact `%gslt<reference>` before that boundary is resolved. One message may reference multiple CRM records.
3. Repeated markers in a quoted thread are deduplicated by reference. Gmail message ID plus reference prevents repeated actions across polling overlap.
4. An explicit marker can resolve across pipelines owned by the mailbox user. The default pipeline is only a deterministic tie-breaker for repeated canonical `ga` or `gc` projections.
5. Without a marker, a unique sender-email match in the default pipeline may associate the message. Ambiguous senders remain unmatched.
6. Mail addressed to `archive@eigenracing.com` is archive intake. An explicit marker still wins. Without a marker, ClawPilot checks email addresses in the message headers and imported body against Organizations, Contacts, and Leads in pipelines owned by that mailbox user.
7. Archive address matches are conservative: an address that maps to multiple CRM references is left unmatched. Related `gc` and `ga` references share one interaction and retain separate message links, so quoted or forwarded copies never duplicate the CRM activity.

## Workbook Contract

The managed workbook requires `Start Here`, `Organizations`, `Contacts`, `Opportunities`, `Interactions`, `Calculations`, `Dashboard`, and `Dropdowns`. Headers begin on row 4. Column A carries a hidden, protected ClawPilot record identity for CRM entity tabs.

Google protected ranges permit user edits only in `Opportunities!B5:M`. All other tabs, the opportunity headers, and record identifiers are generated and protected. `Calculations` and `Dashboard` derive reporting values from the projected CRM data.

The pipeline and CRM surfaces expose the workbook through its ClawPilot short link. The Pipeline header also creates, retries, or repairs the managed Sheet when the current owner has no usable link. That link does not bypass Google access controls.

## Synchronization

1. A ClawPilot form write or an Opportunities Sheet pull stages a pipeline-scoped Postgres projection and a `suitecrm` outbox item atomically.
2. The SuiteCRM worker claims records with a lease, uses OAuth2 client credentials against the private Railway service, and records success or a retriable failure.
3. A successful SuiteCRM batch queues a `project_crm_workbook` Google outbox operation.
4. The Google worker regenerates the protected workbook projections and records a reconciliation run.

Meeting time synchronization is bidirectional among the ClawPilot CRM surface, native SuiteCRM, and the original organizer's selected Google Calendar. Saving a meeting queues an idempotent Calendar create, update, or cancellation; new events request a unique Google Meet conference. The organizer identity is persisted with the meeting, so later edits by a shared-pipeline collaborator or through native SuiteCRM still target the calendar that owns the event. Calendar polling correlates events by provider event ID or the private `clawpilotMeetingReference`, applies changed time and event fields to the Postgres/SuiteCRM projection, preserves completed and cancelled terminal states, and ignores provider echoes whose meaningful fields already match. Native SuiteCRM polling applies changed meeting time, subject, status, location, and description to Postgres and queues the corresponding Calendar update. Cancellation from ClawPilot, Google, or native SuiteCRM cancels the Google event and keeps the CRM meeting cancelled; a later Calendar restore returns it to scheduled.

Meeting projection also creates SuiteCRM relationship links for the related Account, Contact, Lead, and Opportunity. This is separate from SuiteCRM's parent display field and is required for the native relationship subpanels to contain the associated records.

The active endpoints are `/api/crm`, `/api/crm/actions`, `/api/crm/import`, `/api/crm/workbook`, `/api/crm/outbox/process`, and the authenticated action/inbound-mail worker at `/api/crm/integrations/process`.

## Operations

Use the [SuiteCRM Railway runbook](../operations/suitecrm.md) for service variables, volume, worker, migration, and rollback checks. Use [Pipeline and synchronization](pipeline-and-sync.md) for Google provisioning and workbook access.
