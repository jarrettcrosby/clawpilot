---
id: cp-module-crm-reporting
title: CRM and Workbook Reporting
summary: CRM entities, Global IDs, SuiteCRM projections, provider actions, email markers, meetings, and workbook reporting.
status: active
kind: module-contract
area: crm
tags: [crm, suitecrm, organizations, contacts, opportunities, reporting]
app_visible: true
---

# CRM and Workbook Reporting

## Purpose

Use ClawPilot as the customer-work interface, SuiteCRM as the canonical CRM, Railway Postgres as the durable ClawPilot projection and action store, and Google Sheets as the opportunity input and reporting workbook.

## Ownership Contract

- SuiteCRM owns Organizations, Contacts, Products, Leads, Opportunities, Meetings, Interactions, Campaigns, CRM relationships, and CRM record history.
- ClawPilot is the primary user interface for those modules. Only root-organization owners and administrators may open the global native SuiteCRM surface for configuration and inspection; child-organization administrators remain scoped to their ClawPilot account subtree.
- A workspace organization owns one durable `ga` identity. An app user owns one durable `gu` identity and one separate canonical `gc` identity for CRM Contact projections. Existing Contact `gc` values never become user IDs and are not rewritten when `gu` identities are allocated.
- Saving a user profile updates the app user and its CRM Contact projection. A profile refresh resolves the existing Contact by its pipeline-scoped app-user binding, canonical `gc`, or preserved profile-source alias and supplies that durable local ID explicitly. A new profile Contact belongs to the user's workspace Organization. When a preserved profile alias already resolves to a business Contact under another Organization, refresh keeps that Organization relationship and existing business fields, enriches only missing profile data, and retains the prior source payload alongside the profile snapshot. It never reparents the Contact on a read, guesses across pipelines, or creates a replacement identity. Administrators may rename the shared workspace organization; ordinary members cannot rename it from their personal profile. The user Contact is projected into the primary pipeline for the user's assigned organization, including when that pipeline is shared with other members of the same company.
- Invitations assign a user to an explicit workspace organization. An administrator may select the current organization, select a descendant organization, or create a child organization from an existing CRM Account while preserving its permanent `ga` identity. Child administrators can manage only their own organization subtree.
- Pipeline ownership choices are not application-access lists. Active ClawPilot members are projected to CRM Contacts and remain governed by their application role. An administrator may separately mark a tenant Contact as a CRM-only pipeline person; that record may own opportunities but cannot authenticate to ClawPilot until it completes the normal invitation and activation flow.
- The selected pipeline's `Opportunities` Sheet table is the only writable workbook input. Sheet pulls stage those changes into the same CRM gateway used by ClawPilot writes.
- Railway Postgres stores tenant-scoped CRM projections, source identity, synchronization status, reconciliation runs, and outbox leases. It is not a second independent CRM authority.
- Development and production use separate SuiteCRM, MariaDB, Postgres, Google workbook, and user data.

## Entity Mapping

| ClawPilot | SuiteCRM | Workbook |
|---|---|---|
| `gu2841963` App user | User assignment mapping through `assigned_user_id` | Native User `global_id_c` after administrator mapping |
| `ga4827316` Organization | Account | Generated `Organizations` projection |
| `gc8172045` Contact | Contact | Generated `Contacts` projection |
| `gp4286157` Product | AOS Product | `Dropdowns` validation and opportunity relationships |
| `gl3549182` Lead | Lead | CRM only |
| `go7402631` Opportunity | Opportunity | Writable `Opportunities` input and canonical projection |
| `gm1968457` Meeting | Meeting | CRM only |
| `gi6253094` Call interaction | Call | Generated `Interactions` projection |
| `gi3815274` Unlinked Meeting or In Person interaction | Meeting | Generated `Interactions` projection |
| `gi7462051` Email, Note, LinkedIn, or Campaign interaction | Note | Generated `Interactions` projection |
| `gk9035718` Campaign | Campaign | CRM only |

Every migrated record preserves its source workbook payload, source row, stable source key, deterministic SuiteCRM identifier, last synchronization state, and error details. Imports are additive and idempotent; they do not delete the source workbook.

Contact identity keeps the workbook source key separate from its current matching keys. An exact email is preferred; otherwise ClawPilot uses the normalized name only within the selected Organization. When one name-only Contact later gains an email, the existing row is enriched in place and keeps its local ID, `gc` reference, and SuiteCRM ID. Workbook reimports use enrichment semantics, so blank or older sheet fields cannot erase a stronger email or title. Ambiguous same-name matches stop for review instead of creating or merging a guess. A guarded operator merge preserves former source and public references as aliases when a duplicate already exists.

Every SuiteCRM business-record module in the table has a native custom field labeled `Global ID`. Its API name is `global_id_c`; it is visible on the native detail layout, reportable, audited, available to unified search, and populated from the permanent ClawPilot record reference. Container boot also keeps AOS Products enabled in SuiteCRM's persisted global-search selection so a Product can be found directly by an exact `gp#######` value; other module visibility remains administrator-controlled. A `gu` identifies the ClawPilot user independently; an administrator's explicit SuiteCRM user mapping supplies the native `assigned_user_id` and queues the same `gu` for the native SuiteCRM User's `global_id_c`. The retryable projection refuses to overwrite a different permanent ID or duplicate a `gu` on another SuiteCRM User. Existing business-record projections are refreshed with `npm run crm:backfill-suitecrm` after the SuiteCRM metadata deployment.

The ClawPilot Products list uses one pipeline-scoped search across Global ID, product name, SKU, product type, category, and URL. Searching for a value such as `gp5915353` therefore resolves the same Product identity in both ClawPilot and SuiteCRM without widening the query outside the selected pipeline.

The two-letter module prefix is fixed and the seven-digit suffix is randomly allocated. The permanent registries reserve both the full code and the numeric suffix globally across modules, prevent concurrent collisions, and never release either value after deletion or archival. Sequential codes issued before this contract remain permanently reserved and can never be reissued. Their obsolete public short links are disabled and removed from user-visible link results; the immutable registries retain the historical allocation and canonical replacement for audit integrity.

Each CRM record reference code has a stable short link. The redirect enters the authenticated ClawPilot CRM route, which selects a pipeline the user can access before opening the record; canonical organization and Contact codes remain stable when the same identity is projected into another authorized pipeline. User-created links remain visible and manageable only inside the exact organization that owns them.

Organization and Contact records are also projected into the owner's managed `CRM Board`. Titles use `<Global ID> - <record name>`. The card record block renders the Global ID and name as links to the ClawPilot CRM editor, renders the primary email as an organization-scoped link to the ClawPilot email composer, and maps the editable card Description directly to the native CRM description. The projection uses the CRM row UUID for durable one-card identity, not the visible reference string.

An Opportunity owns one permanent `go` reference, one required Organization relationship, an exact set of related Contacts, an optional tenant team owner, and an exact set of related Products. Every selected Contact and Product must belong to the selected tenant boundary. The pipeline Opportunity drawer edits related Contacts directly with a searchable multi-select and preserves the selected order; the first Contact is the primary compatibility relationship. Product records map to native SuiteCRM AOS Products, while the exact Opportunity-to-Product selection remains authoritative in the ClawPilot Postgres join until a verified native SuiteCRM relationship is provisioned; the gateway does not guess a relationship field. Account and Contact relationships are written to their verified native links. Opportunity reads resolve the Organization name through its durable Organization ID; renaming an Organization therefore updates pipeline cards and generated workbook projections without rewriting every Opportunity row.

## Customer Actions

- Organization, contact, and lead records with an email address can send through the signed-in user's selected Maton `google-mail` connection. ClawPilot displays the selected sender before submission, verifies the authenticated Gmail profile, records the actual sender in the provider attempt, and does not accept a caller-supplied From identity.
- Organization, contact, lead, opportunity, and meeting records can create Google Calendar invitations through that user's selected `google-calendar` connection. The action composer displays the selected organizer and records it with the provider result.
- Every Calendar invitation created by ClawPilot includes the meeting's permanent `gm` reference and organization-scoped short link. The `gm` reference is also stored in the event's private Google metadata so later Calendar changes can be reconciled safely.
- Records with a phone number expose a call command. It records a native Call before returning a validated `tel:` URL to the device. A logged call defaults to **Held**, **Outbound**, and 15 minutes; the operator can change status, direction, and duration before submitting.
- Campaigns accept `gc` and `gl` recipients, support `{{firstName}}`, `{{lastName}}`, `{{name}}`, `{{email}}`, and `{{referenceCode}}` merge fields, deduplicate recipients by email, and suppress opted-out recipients.
- Every action is a durable intent with an idempotency key, leased provider attempt, retry state, and audit event. Email, call, and campaign actions also create the corresponding interaction. A Calendar action updates its one canonical `gm` Meeting and never creates a second `gi` Meeting interaction. The worker handles failed retries and campaign child messages.

Organization Priority, Type, and Owner use the selected pipeline's controlled catalogs and accessible users rather than free text. The Contact editor offers only active ClawPilot users who can access the selected pipeline as Owner. A selection persists the owner's immutable `gu`, normalized email, and display-name snapshot; the display name remains readable if the user later becomes unavailable. Unassigned contacts keep all three owner identity fields empty. Legacy owner strings remain readable and are upgraded only when they match one accessible active user unambiguously. When that user has an administrator-managed SuiteCRM mapping, Contact synchronization writes the native `assigned_user_id`; the Contact's own `gc` remains unchanged. A Contact may enable **Use organization address** to copy and maintain the complete street, city, state, postal-code, and country snapshot from the selected Organization during that save.

The interaction editor requires a controlled interaction type and offers only active ClawPilot users who can access the selected pipeline as the Agent. Exact legacy `In Person` values normalize to `meeting`; unknown values are not guessed into a native activity module. Administrators can map each ClawPilot user to one active native SuiteCRM username; the gateway then assigns the native Note, Call, or Meeting to that SuiteCRM user while preserving the ClawPilot email as the durable actor identity. Contact selection is a searchable multi-select scoped to the selected Organization and is optional only when the interaction is genuinely account-level. ClawPilot persists the complete ordered Contact set in a tenant-safe relationship table. Notes retain the first selected Contact as their primary native Contact relationship, while Calls and Meetings project every selected Contact through the native activity relationship.

Email, Note, LinkedIn, and Campaign interactions project to SuiteCRM Notes and appear under native **History**. The Account remains the Note parent and the primary selected Contact is written to the native Contact field and relationship. The user-entered business timestamp is stored in the native Note `Occurred At` field (`occurred_at_c`); SuiteCRM's system `date_entered` remains the record creation audit timestamp and cannot replace it during reconciliation.

Call interactions project to native SuiteCRM Calls. Unlinked `meeting` and legacy `In Person` interactions project to native Meetings; a `gi` history entry linked to a canonical `gm` Meeting has no separate SuiteCRM projection. Native Call direction is controlled as **Inbound** or **Outbound**. Activity status is controlled as `planned`, `held`, or `not_held`, and duration is a whole number from 1 through 1,440 minutes. New Calls default to 15 minutes and unlinked interaction-shaped Meetings default to 30 minutes. SuiteCRM displays **Planned** Calls and Meetings under **Activities**; **Held** and **Not Held** records appear under **History**. A completed call therefore belongs in History rather than being mislabeled as open work.

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

Workbook projection is also the visual authority. Each run removes stale merges, filters, banding, conditional rules, protected ranges, and embedded charts before applying the managed ClawPilot layout. Generated tables use fixed widths, alternating light rows, status and synchronization cues, and hidden record identity. The Opportunities table is visually marked as the writable surface and receives pipeline-scoped dropdown and numeric validation. The Dashboard stores its chart formulas in hidden `P:Q` helpers so report cards and charts remain stable without exposing calculation plumbing to the operator.

Workbook branding uses the owning organization's configured primary and accent colors. REST-managed Sheets cannot reliably insert a private external image without a one-time human URL approval, so the header uses a deterministic `CP` mark by default and organization initials when a custom logo is configured; it never leaves a broken `#REF!` image formula in a generated workbook.

The pipeline and CRM surfaces expose the workbook through its ClawPilot short link. The Pipeline header also creates, retries, or repairs the managed Sheet when the current owner has no usable link. That link does not bypass Google access controls.

## Synchronization

1. A ClawPilot form write or an Opportunities Sheet pull stages a pipeline-scoped Postgres projection and a `suitecrm` outbox item atomically.
2. The SuiteCRM worker claims records with a lease, uses OAuth2 client credentials against the private Railway service, and records success or a retriable failure.
3. A successful SuiteCRM batch queues a `project_crm_workbook` Google outbox operation.
4. The Google worker regenerates the protected workbook projections and records a reconciliation run.

The gateway emits `crm.record.staged` activity only when the outbox accepts a new idempotency key. Idempotent hierarchy or profile reads may refresh local projections and short links, but they do not create duplicate queue history when no SuiteCRM work was added.

CRM list reads treat a conflicting-but-recoverable profile identity reconciliation as deferred ancillary work: the authorized tenant-scoped list still loads and the server records the reconciliation error for repair. Pipeline membership, active-user, and other authorization failures are not recoverable and continue to fail closed.

The SuiteCRM integration worker also polls Accounts and Contacts by `date_modified`. It matches native records by SuiteCRM ID or Global ID within each pipeline, stages only meaningful changes without echoing them back to SuiteCRM, and reconciles every bound CRM Board so newly deployed boards and native CRM edits appear without requiring a browser refresh to initiate the backfill.

Interactions always materialize their related organization in Postgres. When an interaction names only a Contact, Lead, Opportunity, or Meeting, the gateway derives the Account from that relationship, displays it in ClawPilot, and sends the appropriate native parent to SuiteCRM. Migration `0034_account_membership_crm_board_scope.sql` performed the same deterministic Account repair for historical Note interactions.

When a Note interaction names a Contact, its SuiteCRM Note also carries the native `contact_id` and `contact` relationship. The Account remains the Note parent while the Contact appears in the native Contact field and relationship subpanels. Native Calls and Meetings instead use SuiteCRM's activity relationship links for Accounts, Contacts, Leads, and Opportunities.

Native SuiteCRM Note polling performs a full historical scan on first activation and then advances a resumable cursor with a five-minute overlap. It matches by SuiteCRM ID or permanent `gi` Global ID within each pipeline, resolves Account, Contact, Lead, Opportunity, and Meeting parents conservatively, and stages inbound changes without echoing them back to SuiteCRM. Ambiguous or unknown records remain unmatched rather than crossing a pipeline boundary.

Native SuiteCRM Call polling uses the same full-first-scan and resumable-overlap model. It matches only Calls carrying an existing pipeline-scoped SuiteCRM ID or permanent `gi` Global ID, imports native status, direction, duration, subject, time, description, assignment, and verified relationships, and does not echo unchanged records back to SuiteCRM.

All persisted timestamps remain UTC ISO values. ClawPilot renders dates, activity, releases, agent messages, CRM interactions, pipeline sync times, integration status, and link updates in the signed-in user's profile timezone and locale. Changing the profile timezone updates the active UI without rewriting historical data.

Meeting time synchronization is bidirectional among the ClawPilot CRM surface, native SuiteCRM, and the original organizer's selected Google Calendar. Saving a meeting queues an idempotent Calendar create, update, or cancellation; new events request a unique Google Meet conference. The organizer identity is persisted with the meeting, so later edits by a shared-pipeline collaborator or through native SuiteCRM still target the calendar that owns the event. Calendar polling correlates events by provider event ID or the private `clawpilotMeetingReference`, applies changed time and event fields to the Postgres/SuiteCRM projection, preserves completed and cancelled terminal states, and ignores provider echoes whose meaningful fields already match. Native SuiteCRM polling applies changed meeting time, subject, status, location, and description to Postgres and queues the corresponding Calendar update. Cancellation from ClawPilot, Google, or native SuiteCRM cancels the Google event and keeps the CRM meeting cancelled; a later Calendar restore returns it to scheduled.

Meeting projection also creates SuiteCRM relationship links for the related Account, Contact, Lead, and Opportunity. This is separate from SuiteCRM's parent display field and is required for the native relationship subpanels to contain the associated records.

The active endpoints are `/api/crm`, `/api/crm/actions`, `/api/crm/import`, `/api/crm/workbook`, `/api/crm/outbox/process`, and the authenticated action/inbound-mail worker at `/api/crm/integrations/process`.

## Operations

Use the [SuiteCRM Railway runbook](../operations/suitecrm.md) for service variables, volume, worker, migration, and rollback checks. Use [Pipeline and synchronization](pipeline-and-sync.md) for Google provisioning and workbook access.
