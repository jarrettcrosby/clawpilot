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
- Railway production is the required owner of SuiteCRM, MariaDB, Postgres,
  Google workbooks, and live user data after cutover. Local and remote-local
  runtimes have no production CRM, database, workbook, or provider authority.
  Post-retirement Vercel previews must have none; the current legacy Vercel
  database/configuration assignments leave that retirement unaccepted until the
  environment runbook's gated cleanup and re-audit pass.

## Company-wide CRM access (release candidate)

The root organization's actual owner can use **Settings → People → Company-wide
CRM access** to select the businesses in an explicit operator CRM scope, save
that scope, and select existing employees who may view its CRM pipelines and
managed account cards. Only currently owned, non-demo businesses may be added.
An email domain, personal default organization, or global role never creates a
business binding. A child-organization administrator cannot configure it.

Employee enrollment remains an explicit owner choice; inviting a person alone
does not grant company-wide access. The person's active membership, CRM module
permission and explicit business-level denials still apply. Private boards and
independent editor/admin permissions are not widened. Turning an enrollment or
business scope off preserves its identity and history rather than deleting it.
Linking an existing SuiteCRM login remains a separate user-card action; app-only
employees do not need a native login.

With native email permissions enabled, these controls use the same exact
native-first transition as user access changes. A pending or interrupted save
is discovered again on reload and resumed using its saved identity, never by
replaying draft form values. An unknown write followed by an unavailable read
locks mutations until **Reload CRM access** can confirm the current state.
This describes the local release candidate, not confirmation of production
permission activation or a deployed owner workflow.

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

One sellable inventory-and-pack identity owns one canonical Product. Shopify and Faire listings are read-only entries in that Product's `salesChannels` field, including exact provider variant identity and source lifecycle; they are not separate CRM Products. Each, inner-pack, case, and pallet identities remain separate Products and use a meaningful pack qualifier when their marketing title would otherwise collide. An authorized product editor with Operations-management authority may open **Resolve duplicate sales-channel product identities** to repair records created under the older provider-isolation rule. Exact SKU or GTIN/barcode matches may be reconciled in a reviewed batch. A name-only suggestion requires explicit confirmation of the same sellable identity and pack level. The transaction retains the old Product Global ID as a permanent alias, blocks a duplicate with operational relationships, and never deletes or rewrites historical business records.

The two-letter module prefix is fixed and the seven-digit suffix is randomly allocated. The permanent registries reserve both the full code and the numeric suffix globally across modules, prevent concurrent collisions, and never release either value after deletion or archival. Sequential codes issued before this contract remain permanently reserved and can never be reissued. Their obsolete public short links are disabled and removed from user-visible link results; the immutable registries retain the historical allocation and canonical replacement for audit integrity.

Each CRM record reference code has a stable short link. The redirect enters the authenticated ClawPilot CRM route, which selects a pipeline the user can access before opening the record; canonical organization and Contact codes remain stable when the same identity is projected into another authorized pipeline. User-created links remain visible and manageable only inside the exact organization that owns them.

Organization and Contact records are also projected into the owner's managed `CRM Board`. Titles use `<Global ID> - <record name>`. The card record block renders the Global ID and name as links to the ClawPilot CRM editor, renders the primary email as an organization-scoped link to the ClawPilot email composer, and maps the editable card Description directly to the native CRM description. The projection uses the CRM row UUID for durable one-card identity, not the visible reference string.

An Opportunity owns one permanent `go` reference, one required Organization relationship, an exact set of related Contacts, an optional tenant team owner, and an exact set of related Products. Every selected Contact and Product must belong to the selected tenant boundary. The pipeline Opportunity drawer edits related Contacts directly with a searchable multi-select and preserves the selected order; the first Contact is the primary compatibility relationship. Product records map to native SuiteCRM AOS Products, while the exact Opportunity-to-Product selection remains authoritative in the ClawPilot Postgres join until a verified native SuiteCRM relationship is provisioned; the gateway does not guess a relationship field. Account and Contact relationships are written to their verified native links. Opportunity reads resolve the Organization name through its durable Organization ID; renaming an Organization therefore updates pipeline cards and generated workbook projections without rewriting every Opportunity row.

## Customer Actions

- Organization, contact, and lead records with an email address can send through the signed-in user's selected Maton `google-mail` connection. ClawPilot displays the selected sender before submission, verifies the authenticated Gmail profile, records the actual sender in the provider attempt, and does not accept a caller-supplied From identity.
- Organization, contact, lead, opportunity, and meeting records can create Google Calendar invitations through that user's selected `google-calendar` connection. The action composer displays the selected organizer and records it with the provider result.
- Every Calendar invitation created by ClawPilot includes the meeting's permanent `gm` reference and organization-scoped short link. The `gm` reference is also stored in the event's private Google metadata so later Calendar changes can be reconciled safely.
- Pipeline owners can explicitly enable a linked calendar from **CRM → Meetings → Calendar import**. Discovery imports only meetings whose participant emails match active CRM Contacts on one account in that pipeline. All matched Contacts are retained in native CRM Meetings relationships; unrelated-account ambiguity stays unlinked. Personal/default calendars are never automatically enabled. The initial and daily rolling window covers the last 30 and next 90 days, with bounded pagination, incremental updates, cancellations, and stable calendar/event identity across reconnects. Import itself sends no invitations. Existing-event edits retain that exact verified calendar and update the same Google event from either ClawPilot or SuiteCRM, subject to Google event permissions. Meetings without a location or conferencing retain that state rather than generating a Google Meet link.
- Reimports and edits retain the same Meeting and Global ID. Within one pipeline, copies of the same Google Calendar occurrence share one durable claim. The original date or instant distinguishes recurring occurrences even after they are rescheduled. A secondary copy or a former calendar binding cannot edit, cancel, or rebind the canonical meeting. A verified move retains the old claims as duplicate protection.
- If an existing Calendar meeting has no verified occurrence identity, or a prior delivery may still be unresolved, discovery holds new imports rather than guessing whether they are copies. Verified exact observations can fill missing identity evidence without recreating the meeting. Review unavailable or conflicting historical sources by their exact provider identities; do not reset cursors, reassign meetings, or delete a suspected duplicate automatically.
- Before a Google Calendar write, the worker verifies the reviewed account against Google's unique live writable primary calendar on the pinned connection, then checks the exact selected calendar and organizer separately. An outdated Maton account label does not block a verified selection. A different or unverified live account blocks delivery even if it can write to the same shared calendar. Recorded and imported SuiteCRM edits queue against their original verified identity without contacting Google until delivery.
- Records with a phone number expose a call command. It records a native Call before returning a validated `tel:` URL to the device. A logged call defaults to **Held**, **Outbound**, and 15 minutes; the operator can change status, direction, and duration before submitting.
- Campaigns accept `gc` and `gl` recipients, support `{{firstName}}`, `{{lastName}}`, `{{name}}`, `{{email}}`, and `{{referenceCode}}` merge fields, deduplicate recipients by email, and suppress opted-out recipients.
- Every action is a durable intent with an idempotency key, leased provider attempt, retry state, and audit event. Email, call, and campaign actions also create the corresponding interaction. A Calendar action updates its one canonical `gm` Meeting and never creates a second `gi` Meeting interaction. The worker handles failed retries and campaign child messages.

Organization Priority, Type, and Owner use the selected pipeline's controlled catalogs and accessible users rather than free text. The Contact editor offers only active ClawPilot users who can access the selected pipeline as Owner. A selection persists the owner's immutable `gu`, normalized email, and display-name snapshot; the display name remains readable if the user later becomes unavailable. Unassigned contacts keep all three owner identity fields empty. Legacy owner strings remain readable and are upgraded only when they match one accessible active user unambiguously. When that user has an administrator-managed SuiteCRM mapping, Contact synchronization writes the native `assigned_user_id`; the Contact's own `gc` remains unchanged. A Contact may enable **Use organization address** to copy and maintain the complete street, city, state, postal-code, and country snapshot from the selected Organization during that save.

The interaction editor requires a controlled interaction type and offers only active ClawPilot users who can access the selected pipeline as the Agent. Exact legacy `In Person` values normalize to `meeting`; unknown values are not guessed into a native activity module. Administrators can map each ClawPilot user to one active native SuiteCRM username; the gateway then assigns the native Note, Call, or Meeting to that SuiteCRM user while preserving the ClawPilot email as the durable actor identity. Contact selection is a searchable multi-select scoped to the selected Organization and is optional only when the interaction is genuinely account-level. ClawPilot persists the complete ordered Contact set in a tenant-safe relationship table. Notes retain the first selected Contact as their primary native Contact relationship, while Calls and Meetings project every selected Contact through the native activity relationship.

Email, Note, LinkedIn, and Campaign interactions project to SuiteCRM Notes and appear under native **History**. The Account remains the Note parent and the primary selected Contact is written to the native Contact field and relationship. The user-entered business timestamp is stored in the native Note `Occurred At` field (`occurred_at_c`); SuiteCRM's system `date_entered` remains the record creation audit timestamp and cannot replace it during reconciliation.

Call interactions project to native SuiteCRM Calls. Unlinked `meeting` and legacy `In Person` interactions project to native Meetings; a `gi` history entry linked to a canonical `gm` Meeting has no separate SuiteCRM projection. Native Call direction is controlled as **Inbound** or **Outbound**. Activity status is controlled as `planned`, `held`, or `not_held`, and duration is a whole number from 1 through 1,440 minutes. New Calls default to 15 minutes and unlinked interaction-shaped Meetings default to 30 minutes. SuiteCRM displays **Planned** Calls and Meetings under **Activities**; **Held** and **Not Held** records appear under **History**. A completed call therefore belongs in History rather than being mislabeled as open work.

Archived interactions remain excluded from active CRM views. Staging rechecks the existing interaction under its row lock and leaves an archived record unchanged, even when a synchronization worker read an older, active copy. That no-op preserves the original content, archive metadata and provider identity, creates no new synchronization action, and does not reactivate the record's short links. Ordinary staging is not an unarchive operation.

## CSV Data Transfer

Pipeline owners and editors can export the selected CRM tab as a tenant-scoped CSV. Organizations, Contacts, Products, Leads, and Opportunities also expose a header-only template and support a two-phase import. Meetings, Interactions, and Campaigns are export-only so a historical data transfer cannot create Calendar events, send communications, queue campaigns, delete records, or archive records.

Every exported existing record carries its permanent Global ID and an opaque record version derived from the current Postgres revision and source hash. The Global ID is the only update identity. A blank Global ID requests a create; ClawPilot never accepts a caller-created Global ID and never silently converts a create into an update from a name, email, or SKU match.

Uploading a CSV creates an expiring, no-write preview. Every row is classified as:

- `create`: a valid new identity with no possible existing or file-local duplicate;
- `update`: a current pipeline-scoped Global ID with field changes;
- `unchanged`: a current Global ID whose canonical values are unchanged;
- `ambiguous`: a duplicate Global ID, duplicate create identity, or possible existing-record collision; or
- `invalid`: a malformed or stale row, unsupported relationship, unsafe spreadsheet value, or record outside the selected pipeline.

Product previews enforce the same two pipeline-scoped identities as the current Product table: case-insensitive Product name and, when present, case-insensitive SKU. Creates and updates are checked independently against current Products and every other actionable CSV row, and apply repeats those checks inside the transaction so a database uniqueness error is not the first customer-visible result.

Updates show field-level before-and-after values and are not selected automatically. Applying any update requires the operator to confirm that those existing-record changes were reviewed. Only selected `create` and `update` rows can be applied. ClawPilot locks the preview and target records, rechecks `updated_at` plus `source_hash`, rechecks create identities under a pipeline advisory lock, and applies the complete selection in one transaction. A stale record aborts the entire selection with instructions to run preview again. The same transaction stages the SuiteCRM outbox through the normal CRM gateway; preview does not require a live SuiteCRM connection.

CSV transfer uses exact, versioned headers and Global IDs for relationships. Each file is bounded to 1 MB and 500 data rows. A larger export is delivered by the CRM UI as numbered, import-ready CSV segments rather than navigating the browser to a JSON size error. Exports quote every field and harden spreadsheet-formula prefixes. Import rejects an oversized declared multipart request before parsing when the browser supplies `Content-Length`, checks the uploaded file size before reading its text, and repeats the byte and row checks in the parser. Imports also reject formula-capable values after leading whitespace, unsupported control characters, malformed headers, unsupported currency or date values, and cross-pipeline relationships. A downloadable error report identifies the source row, field, safe error code, and message without exposing database IDs or provider credentials. Preview and apply runs are actor-scoped, pipeline-scoped, idempotent, expiring, and audited.

The duplicate sales-channel Product identity action is rendered only when the authenticated actor has the same Operations-management capability enforced by `/api/crm/product-identities`; ordinary CRM edit access alone does not expose a command that will return `403`.

## Email Association

Outbound CRM email always appends exact `%gslt<reference>` markers with no space after `gslt`. Organization and lead messages carry their target reference. Contact messages carry both the contact `gc` reference and its related organization `ga` reference so a reply is associated with both records through one CRM interaction.

Gmail polling runs per active user's selected connection and includes both received and sent mail, excluding drafts. Initial intake remains bounded to the preceding 24 hours; subsequent polling retains its five-minute overlap and page limits. Sent messages retain outbound/sent direction rather than appearing as incoming email. It follows these rules:

Before applying these association rules or storing message content, CRM skips confirmed ClawPilot and Career Desk sign-in-code notifications. Recognition requires one exact top-level sender address, the exact `Your ClawPilot sign-in code` or `Your Career Desk sign-in code` subject, and either the producer's `X-ClawPilot-Message-Purpose: auth-magic-code` header or the complete legacy authentication template matching that product. Sender addresses come from `CLAWPILOT_MAIL_FROM`, `CLAWPILOT_AUTH_MAIL_FROM`, the historical `stewards@eigenracing.com` sender, and optional `CLAWPILOT_AUTH_MAIL_ADDITIONAL_SENDERS`. The additional-senders variable is a comma-separated list of exact addresses for other environments or historical senders; case and surrounding whitespace are normalized and invalid entries are ignored. It grants no email-sending authority. Replies, forwards, ordinary customer code discussions, and other messages from these senders remain eligible for normal association. Skips increment `authMessagesSkipped` without storing authentication content or changing the Gmail message; polling continues normally. Existing historical authentication interactions are not automatically removed.

1. The first case-insensitive `%xx` ends imported content; content after it is neither stored nor cataloged.
2. Every exact `%gslt<reference>` before that boundary is resolved. One message may reference multiple CRM records.
3. Repeated markers in a quoted thread are deduplicated by reference. Gmail message ID plus reference prevents repeated actions across polling overlap.
4. An explicit marker can resolve across pipelines owned by the mailbox user. The default pipeline is only a deterministic tie-breaker for repeated canonical `ga` or `gc` projections.
5. Without a marker or archive recipient, exact validated top-level From/To/Cc/Bcc addresses match active Contacts and Leads across the mailbox user's owned pipelines with active organization membership. The mailbox owner, account and verified connected sender aliases are excluded. For the same exact email, an independently managed CRM Contact or Lead takes precedence over a verified accounting-only QuickBooks customer-contact mirror. This requires exact producer-only provenance and a durable same-workspace provider link; adopted or ambiguous records are not silently ignored, and a standalone accounting Contact remains eligible. Matching still requires one valid From address and one unambiguous pipeline/customer organization; genuine duplicate email identities, cross-pipeline or unrelated-account matches remain unlinked. Quoted text, Reply-To, delivery headers, snippets and attached messages are not ordinary routing evidence. Multiple matched Contacts of that same customer share one interaction and retain their relationships.
6. Mail addressed to `archive@eigenracing.com` is archive intake. An explicit marker still wins. Without a marker, ClawPilot checks email addresses in the message headers and imported body against Organizations, Contacts, and Leads in pipelines owned by that mailbox user.
7. Archive address matches are conservative: an address that maps to multiple CRM references is left unmatched. Related `gc` and `ga` references share one interaction and retain separate message links, so quoted or forwarded copies never duplicate the CRM activity.

### Connected mailbox address review

The mailbox's saved display address is not its immutable Google identity. Normal
intake and ordinary verification refuse a saved-address/profile mismatch. In
**CRM → Interactions → Review email → Review saved mailbox address**, the exact
pipeline owner can instead request a separate, no-write address preview. It
requires a recent non-impersonated session, a fresh verified Google ID token and
an independent profile read from that selected active Gmail connection. The
Google subject must match any existing canonical mailbox binding; a changed
subject is not an address rename and remains held.

The preview shows the saved and verified addresses and expires after five
minutes. **Confirm address update** re-observes the profile and compares the
reviewed connection, credential, membership, pipeline and binding metadata before
updating the saved address, same canonical mailbox binding and audit together.
Concurrent changes require another review. Credentials stay in memory only and
are removed on expiry, cancellation or navigation. A successful in-flight reply
is acknowledged even if the local preview timer expired while awaiting it.

This operation does not change the user's login, rotate/reconnect Google, move
messages, reset cursors, rewrite historical source evidence or run email recovery.
Historical messages still require the separately reviewed recovery below.

A connection refresh may retain this verified address only for the same selected
active Maton Gmail connection, known unchanged provider creation/revision and
method, matching canonical mailbox binding, and credentials unchanged since
verification. Other provider metadata, status changes and removals still apply.
Unknown or changed revision/creation/method, changed credentials, or changed
status/app/source deliberately uses remote metadata and may require fresh
verification; the saved label is not a grant-continuity or historical proof.

Previously missed messages are not recovered by resetting a mailbox cursor. The owner-only `POST /api/crm/email-recovery` accepts one active workspace pipeline, its owner's selected Gmail connection, and 1–25 exact Gmail message IDs. It requires a real, non-impersonated same-origin session. The default dry run returns a content/routing digest and proposed references without changing CRM or Gmail. An explicit apply must supply that digest; it refetches the messages, rejects changed content or routing and rechecks current pipeline membership before staging. Drafts, spam, trash, authentication codes and messages routed outside the reviewed pipeline are ineligible. Recovery is audited and idempotent, queues normal CRM synchronization, never sends mail, and does not alter polling cursors. Review each bounded selection and verify the resulting CRM/SuiteCRM activity before expanding it.

The separately reviewed historical Casey pair has two exact actions in the
matching BPO pipeline/mailbox's review dialog. The retained-cache action
(`casey-reviewed-two-v1`) verifies both pinned cache records against fresh
provider content and preserves their **unknown original mailbox provenance**.
If there are no retained placements, the first-seen action
(`casey-reviewed-two-first-seen-v1`) gets the headers of only the two pinned
message IDs for selection. It never searches Gmail. Preview then reads those
two complete messages through the verified mailbox and binds their current
content, participants, access and planned placement into the review digest.
Apply re-fetches and rechecks that digest, then saves both complete sources,
interactions, account links and exact publication jobs in one transaction.
The path requires native publication authority; it stops on partial or
conflicting placements. Either path uses Globus as primary, Airspace as
additional, and the reviewed Contacts, with one Email per message. Neither is
a generic import, a future thread rule, or a mailbox-cursor replay. Keep the
original three-message review separate from this two-message review.

Native first-time Email publication requires the exact native record and its
managed identity to be absent. A deleted record, orphaned body or relationship,
matching Global ID, or leftover SecurityGroups link (including a deleted link)
holds creation for review. Native publication rechecks the condition inside its
write transaction; a preview does not reserve the ID. An exact retry of a
committed operation resolves its existing receipt instead of creating a copy.
For reviewed recovery, verify one ClawPilot interaction and one corresponding
SuiteCRM Email per selected provider message, with the customer and supplier
relationships on that same Email. A conflicting existing identity holds the
operation for review; it is not permission to recreate, merge, or delete it.

Legacy failed Email jobs use a separate private maintenance path. A reviewed
archive transaction retains each exact terminal original and blocks its old
queue identity from being reused. The historical provider outcome stays
unknown. This also prevents ordinary edits, deletion, and resync of each
protected interaction identity; it is not a general cleanup action. The
manifest must explicitly distinguish a reviewed-recovery batch from an
archive-only batch. Archive-only records cannot be previewed or staged for
publication, even if a later stage command supplies a separate approval. Archiving
requires independent signatures and an externally verified writer fence kept
through commit; an approval alone is not a fence.

When the exact terminal Email is still Supplier-only but a reviewed Customer
must be primary, correct the association before signing its archive manifest.
The private pre-archive repair compares the approved hashes of the current
Email, dead job, relationship and derived payload; it keeps the same Email,
provider identity and dead job, adds the Customer as primary, and preserves
the Supplier and its existing Contact. It retains immutable originals and
updates the job payload and revision key without requeueing or publishing.
An old or mismatched approval cannot write. The private controller below
exposes `repair-preview`, `repair`, and `repair-inspect` as distinct modes.
The migration installs no grants. An attended retained writer fence and
separate trusted attestor and repair logins are required for live use. Do not
repair an already archived or previously reviewed record through this path.

After verified native activation, a separate stage transaction checks one
archive receipt, the exact canonical source, the reviewed primary and related
accounts, and the current approved audience. It refuses stale placement
instead of silently publishing or correcting it. A second local row with the
same provider message ID in the reviewed pipeline also holds recovery for
review, even when the two rows have different CRM IDs.
It parks one replacement and its hold together, retaining the original content
and relationships. An expired release approval can be renewed for the same
parked intent before admission; it cannot change the selected job or command.
The job stays outside ordinary claims and retries, including after cancellation.
An uncertain archive, stage, or publication commit is resolved by its exact
receipt, not by repeating the write. The migrations grant no access to public
or application roles and install no live maintenance controller or credentials.

ClawPilot rechecks the live Account/Contact projection at staging, admission,
and dispatch. While an admitted replacement is unresolved, its exact local
relationship inputs cannot change; unrelated CRM edits still work. The guard
ends when the replacement is settled or safely cancelled. It does not pause
SuiteCRM or replace the verified writer pause required in both stores during
attended recovery. SuiteCRM's public maintenance responder blocks the normal
publication routes; the local fixture's PHP bridge is not a production
transport. The private controller prepares, publishes, and resolves with
separate signed action permits bound to the exact operation, verified writer
fence, and native target. A publish permit is issued only on the first durable
dispatch transition, after the same connection verifies readiness. For a new
operation, the controller registers, admits, and dispatches in one database
transaction. A refusal before that commit leaves the reviewed item parked
without creating an admission, so a fresh approval can still be given to the
same exact item. An operation already admitted by a previous controller still
requires its original approval; an expired one requires separate review, not
a dispatch bypass. Verify no such operation exists before activating the
atomic controller. Once dispatched, an uncertain response can only be resolved
with an active lease, not resent. Permits expire after at most 30 seconds. The
SuiteCRM image packages a private command for these
actions, not an HTTP endpoint. It refuses to run without maintenance mode, a
protected fence pinned to the deployment instance, replica and enrolled image, and a
dedicated MariaDB login distinct from the normal application login. The
command does not create that login, install a production fence, or prove that
writers have drained. Stock SuiteCRM also requires one existing system mailer
record to read Maps settings; the private recovery path refuses to create one.
The SSH client uses a pre-registered identity and does not send the email
packet until the same connection returns a fresh readiness proof for the
action, native target and maintenance window. A separate per-window secret
authenticates that proof and stays out of the SSH command and packet. Verify
the production route and separate database roles, and retain independent
writer-drain evidence in both stores before recovering live mail.

The private recovery executable is built separately with Node 24 using
`npm run build:native-email-recovery-operator`. Run its emitted entry only with
`node --conditions=react-server`, as an unprivileged operator identity. It has
separate profiles. The publication profile can inspect the exact durable
state, publish an already staged and separately signed release, or resolve that
same operation without republishing. The staging profile can preview one
archived Email, stage it against a separately signed exact intent, or inspect
its receipt. It accepts no Railway identity or native dispatch credentials
and cannot publish. The pre-archive account-repair profile also has no native
transport: `repair-preview` returns the bounded review and destination digest;
`repair` requires its exact signed, short-lived approval, explicit operation
UUID, two distinct direct PostgreSQL logins and independently verified writer
custody. It reserves a private, durable, single-use journal before either
login can write, then closes the attestor connection and rechecks custody
before opening the repair connection. The compiled
`nativeEmailAccountRepairCustodySelection` helper derives its stable
challenge hashes for the separate custodian without database credentials.
After any uncertain result, use the
same journal with `repair-inspect` and an independently scoped receipt-only
login. Inspection needs no fresh mutation approval and does not issue any
repair SQL. Do not delete a journal or retry even if inspection reports
unknown. The separate archive profile has `archive` and `archive-inspect`.
It accepts only an exact manifest signed by the native-absence attestor and
the independent review operator. The controller checks the manifest's
deployment and database pins, then requires fresh challenges from a third,
independent custodian. It reserves a distinct durable archive journal, closes
the attestor database connection, rechecks writer custody, and calls only the
exact archive SQL action. After any uncertain archive result, look up the
same receipt using the archive journal and a receipt-only database login.
The archive profile cannot publish or replay an Email. None of these
profiles can grant access, pause services, or restore them.
The controller takes a SHA-256-pinned canonical JSON configuration and protected
credential/approval files. Each mutating invocation also names the full exact
approved operation hash. Do not reuse the ordinary app's database credential,
the initial-enrollment keys, or the Railway identity of another service.

The command verifies fresh, challenge-bound attestations from a separately
owned custodian socket before and after the command and each native action.
The custodian's key, the release reviewer key, and the dispatch key are
distinct. The custodian must independently retain the exclusive writer pause
for the whole window: stopping producers, blocking their database logins,
draining both stores, and preventing alternate writers or a concurrent restore.
The signed observations authenticate that custodian's assertion; they do not
create or substitute for the pause. The only PostgreSQL connection is direct,
bounded, TLS-verified and pinned to the selected database, CA and role. A failure
to re-attest after an attempt is an uncertain outcome: keep maintenance in
place, inspect the exact operation and reconcile it. Do not repeat a write
based on a timeout or automatically reopen the writers. Local fixture passes
are not approval to install production roles, signing keys or maintenance
state, and do not establish the production custodian or Railway route.

The same private build emits a separate custodian responder library; the
controller does not import its signer. It runs the PostgreSQL and MariaDB
observers inside the independent custody capability before signing and closes
both observer connections before replying. Version 2 of the custody proof
binds the signed destination to the database identities observed on those
connections: PostgreSQL system identifier and database OID/name, and the
MariaDB database name and server identity (including `server_uid`). Missing or
mismatched identities, and older proofs without that binding, cannot authorize
a write. The SuiteCRM command independently checks the MariaDB identity on its
own writer connection before running the publisher. The custodian, not the client,
must identify any allowed idle PostgreSQL writer session by its exact role,
backend PID and start time. Installing and proving the real custody capability,
the direct observer identities and the Railway connection are separate release
gates; the library has no default custody implementation or listener.

The forward release uses production-rebind schema attestation v21 for the
reviewed migrations through `0412`. It includes the recovery evidence,
private-schema authority, Calendar occurrence claims and guards, and preserves the
existing Fractional product-read capability while adding the folder capability. Earlier v9–v20 catalogs
remain frozen historical evidence, never a fallback for current acceptance;
their existing receipts and source artifacts are not relabeled.

## Workbook Contract

The in-app Pipeline report defaults its interaction metric/chart to **Customers and prospects**. It uses the current CRM Account `account_type`, not the structural `relationship_type` value. Supplier-only, unclassified and unlinked activity remains available under **All activity**. An interaction linked to several companies counts once when any active, same-pipeline customer/prospect qualifies; legacy Contact/Lead/Opportunity/Meeting-only primary associations follow the normal CRM resolution order. Archived interactions and archived companies do not qualify for the sales metric. Changing this selector does not change opportunity revenue or contact totals. The CRM header explicitly labels its unfiltered total **all interactions**; the generated workbook remains an all-activity projection, not a copy of this per-view selector.

The CRM organization table separates **Type** (Customer, Supplier, etc.) from **Organization role** (workspace root, workspace member, external organization). The internal `relationship_type=customer` hierarchy value is displayed as **External organization**, so a Supplier is not misleadingly labeled a customer.

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

Meeting time synchronization is bidirectional among the ClawPilot CRM surface, native SuiteCRM, and the original organizer's selected Google Calendar. Saving a meeting queues an idempotent Calendar create, update, or cancellation. Google Meet conferences are requested only for Google Meet meetings; in-person locations and custom meeting links retain their selected mode.

The Calendar badge distinguishes **Imported from Google Calendar** from an outgoing invitation's **Delivered** receipt. Import provenance must match the saved provider event identity; historical scheduled status alone is **Not verified**. Failed, pending and cancelled delivery states remain visible. Recurring imported meetings may be grouped for presentation only, within the currently loaded/search-filtered rows and exact pipeline/owner/connection/calendar/series identity. Each group opens its next loaded occurrence (or latest past occurrence); it does not edit the series. **Show every occurrence** restores the individual rows. Grouping never merges or deletes database records, and failures/cancellations remain separate.

The delivered event's account, connection, calendar and organizer are retained with the meeting and its successful action. Native SuiteCRM edits preserve that identity and meeting mode instead of adopting today's default calendar. The current organization membership, pipeline editing access and connection authorization are checked again before synchronization and delivery. Missing or revoked authority requires review rather than moving the event to a different calendar. A source-revision check prevents a delayed CRM edit from overwriting newly saved meeting details, and the CRM update and outbound Calendar action are staged atomically.

Calendar synchronization updates existing ClawPilot-linked meetings; it does not import unrelated personal-calendar events. Meetings with recorded Calendar identity use bounded exact-event reads, including secondary calendars and non-default connected accounts. Legacy primary-calendar polling is limited to meetings without explicit connection/calendar selection. Matching and staging recheck the complete account/connection/calendar/event tuple and reject conflicting meeting markers or a concurrent calendar move. Changed time and event fields update the Postgres/SuiteCRM projection, while unchanged provider echoes do not create extra actions. An inaccessible or missing event is not treated as proof of cancellation. Actual cancellation and restoration evidence determines meeting status.

Reverse Calendar synchronization defers meetings with a matching unresolved outbound update, including a pending calendar move. Queued, processing, failed and exhausted actions retain the user's unsent intent until delivery or explicit resolution; an older provider snapshot must not overwrite it. Deferred meetings advance through the bounded scan and are reported separately from successful reconciliation. The pending-action check and action enqueue share the meeting-row lock so an enqueue racing with a provider response cannot bypass this protection.

Meeting projection also creates SuiteCRM relationship links for the related Account, Contact, Lead, and Opportunity. This is separate from SuiteCRM's parent display field and is required for the native relationship subpanels to contain the associated records.

The active endpoints are `/api/crm`, `/api/crm/actions`, `/api/crm/data-transfer`, `/api/crm/product-identities`, `/api/crm/import`, `/api/crm/workbook`, `/api/crm/email-recovery`, `/api/crm/outbox/process`, and the authenticated action/inbound-mail worker at `/api/crm/integrations/process`.

## Operations

Use the [SuiteCRM Railway runbook](../operations/suitecrm.md) for service variables, volume, worker, migration, and rollback checks. Use [Pipeline and synchronization](pipeline-and-sync.md) for Google provisioning and workbook access.

The [Fractional CRM gateway](fractional-crm-gateway.md) documents the separately scoped machine integration, disabled-by-default configuration, conditional company/contact updates, and atomic onboarding rules. Its local source acceptance does not establish hosted activation.
