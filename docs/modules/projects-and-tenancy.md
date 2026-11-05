---
id: cp-module-projects-tenancy
title: Projects and Tenancy
summary: Personal and shared project boards, CRM board projections, card behavior, organization scoping, and resource access.
status: active
kind: module-contract
area: projects
tags: [projects, boards, tasks, sharing]
app_visible: true
---

# Projects and Tenancy

## Purpose

Give every user a private project board while allowing deliberate collaboration.

## Current Contract

- Every active workspace membership receives a default board owned by that user and scoped to that workspace organization.
- A board owner can share view or edit access with another active ClawPilot user.
- The selected board is explicit and persisted per user and active workspace, independently of another user's selection or another browser's active workspace.
- Task reads and writes resolve through board access before touching durable task data.
- Comments use the signed-in user as the actor. Agent assignment and task-thread routing retain that attribution.
- Project activity is promoted into the append-only audit stream with the owning board organization's event-time scope. The global Activity drawer reads all authorized boards rather than the board currently selected; the card drawer remains the resource-local history.
- Archived and deleted work is excluded from the current board but retained according to the task lifecycle policy.
- Ordinary project work follows one kanban lifecycle: Backlog, Todo, In Progress, Review, and Done. Creating, editing, moving, assigning, commenting, completing, archiving, and restoring all use explicit user actions.
- Reading a board never creates, retags, assigns, moves, hides, or archives work. A rejected move leaves the card unchanged and returns an actionable reason.
- New ordinary tasks require a meaningful title and auditable signed-user/source attribution. Automation is deny-by-default, and agents can propose work but cannot create tasks.
- A task has at most one product-agent assignment. The task remains the canonical source for status, owner, next action, blocker, checklist, activity, and agent-thread context.
- A global application administrator does not automatically receive every organization's board, CRM, pipeline, document, or short-link data. Those reads continue to require the relevant organization graph, pipeline membership, board membership, ownership, or explicit share.
- Every invited or active membership receives one private board named `CRM Board` in that workspace. Users in the same organization share that organization's primary CRM pipeline, but their board comments, assignments, checklists, and agent conversations remain private unless the board is explicitly shared.
- Successful first sign-in also guarantees a separate default personal pipeline for that user and durably queues its managed Google Sheet, Drive hierarchy, and organization-scoped shortlink. The private CRM Board remains bound to the organization-primary pipeline, so shared account context does not replace the user's personal pipeline.
- A CRM Board projects the Account that represents the user's assigned workspace organization, every descendant Account in that organization graph, and Contacts attached to those Accounts. It never projects ancestors, siblings, or an unrelated tenant's records. Root administrators therefore see the root subtree while child-organization administrators see only their own subtree; ordinary members see only their assigned organization in the hierarchy surface.
- ClawPilot creates exactly one durable projection card for every visible CRM Organization and Contact, initially in Backlog. Projection is not an ordinary task-creation event: it must not create a second work task, assign a user, or assign an agent. A user may later add card-specific comments, checklists, status, or an explicit assignment.
- Managed CRM cards cannot be created, renamed, archived, or permanently deleted from Projects. Their identity and lifecycle follow the CRM record; access requires the intersection of the user's board and pipeline permissions.
- CRM card descriptions are versioned, transactional write-through fields. A valid edit updates the Postgres CRM projection, SuiteCRM outbox, task projection, and audit trail together; a stale edit is rejected instead of overwriting newer CRM data.
- Organization cards offer **Edit customer folder links** for two customer-specific references: **BPO Supply Chain Drive** and **Fractional Customer Folder**. Both are stored as named HTTPS lines in the existing CRM description, not as organization-wide defaults. Updating or clearing a link preserves unrelated notes; duplicate or malformed named lines require explicit repair in the description. Valid folder lines render as links, while other description content remains escaped text. Editor-only writes retain the description hash captured when editing began, and failed saves keep the draft visible.
- The manual reference editor does not provision folders, fetch remote content, change sharing permissions, or grant access. BPO folder automation and Fractional's separate folder-reference receiver are prepared in the later local checkpoints below; neither is activated. Fractional owns creation of its customer folder, and its sending-side integration is still required. No supplied customer links are global application defaults or automatically backfilled into production records.

## Durable Data

- `project_boards`
  - required `workspace_organization_id`; default and CRM-board uniqueness is per owner and workspace
- `project_board_members`
- `tasks`
- `crm_board_projections`
- `crm_board_cards`
- `crm_customer_drive_folders` (prepared local reservation/publication state; no live activation)
- `crm_customer_folder_settings`, `crm_customer_folder_jobs` (prepared opt-in setup and exact-account jobs; no configured defaults or backfill)
- task comments, activity, checklist, and assignment tables

## Open CRM release requirements

These requirements are part of the active CRM release goal, not deferred follow-up work. The link editor above is only partial implementation; its tests do not prove customer-folder provisioning or Fractional folder discovery. The operator reconfirmed the full account/card/folder workflow on November 2, 2026.

- **Account identity and Project card:** A customer Account created in ClawPilot must retain its canonical account Global ID across CRM, its managed Project card, and the folder association. A rename, repeated sync, retry, or card refresh must not create another customer/card/folder identity. Do not use a company-name match alone to adopt a folder.
- **BPO customer folder:** Creation of a customer Account must durably queue creation or verified reuse of its BPO customer folder under the established `BPO Supply Chain / 01 Customers` parent. Reuse the established customer structure below. Existing customers need an explicit verified adoption path rather than a duplicate folder or a mailbox-wide/data-wide replay. Do not create BPO folders for every supplier/contact merely because they appear in CRM.
- **Customer-specific editable links:** Keep separate **BPO Supply Chain Drive** and **Fractional Customer Folder** references on each customer's Global-ID-linked Project card. The authorized administrator can edit either link. Save them through the CRM description with the existing optimistic-concurrency check, preserving unrelated notes and links. Neither link is an organization-wide default.
- **Fractional-owned folder:** Fractional creates its own customer folder. Carry its authoritative folder reference through the explicitly linked Fractional customer/account integration into the matching ClawPilot Account and Project card; do not provision a second Fractional folder or infer identity by customer name. The prepared receiver is a separate gateway subresource, not a company field; sending-side wiring and end-to-end acceptance remain required work.
- **Creation and failure behavior:** Record durable provisioning state, customer identity, selected parent, verified folder IDs, and retry/reconciliation identity. Interrupted or repeated requests must recover the same provider result without duplicating folders. Expose actionable pending/failure status rather than showing success with an empty or unrelated link. Preserve existing sharing; folder creation must not silently grant public access.
- **Acceptance evidence:** Locally test creation, explicit adoption, repeated/concurrent requests, lost provider responses, customer rename, stale description saves, cross-account isolation, link edits, and CRM/card write-through. Verify the real provider hierarchy and a scoped account/card/CRM round trip before calling this requirement complete. Existing pure/static link-editor tests alone are insufficient. Supplied Globus links are examples for that customer, not automatic global backfill instructions.

### Established BPO structure and adoption boundary

Customer-folder auto-provisioning is approved in principle but not implemented by the link editor. A read-only Drive check on 2026-10-29 established the existing BPO layout: `BPO Supply Chain / 01 Customers / <customer>` with `00 Account`, `01 Discovery & Data`, `02 Proposals`, `03 Contracts`, `04 Delivery`, `05 Reporting`, and `06 Meetings`. Any future provisioner must reuse that layout and explicitly adopt an existing selected customer root, not create a duplicate based on a name match. Fractional's independently managed customer hierarchy remains separate. Folder creation/adoption must retain existing sharing and be retry-safe before writing its customer-specific link back to CRM. The previously supplied Globus BPO shortlink was observed pointing to an invoice subfolder, not the customer root; it must not be silently repointed or used as the auto-provisioning parent.

### Root employee CRM visibility clarification

On November 2, 2026 the operator confirmed that an explicitly authorized root-level employee with CRM access should see all CRM organizations in the operator's account, as the operator does, rather than requiring individual pipeline sharing. This is a target requirement, not proof that inheritance is implemented. It must include the app's organization/pipeline selection, Account/Contact/interaction/meeting reads, managed CRM cards, and native CRM readers for an explicitly linked existing SuiteCRM identity. Edit/delete authority stays separate. Ordinary private Project boards, disabled/trashed users, explicit CRM denial, demo access, and unrelated customer tenants must not inherit this grant. The current workspace/pipeline gates described above still apply until the new scope is implemented and tested; do not achieve the target by bypassing all tenant checks or promoting employees to owner.

Current-source inspection also established that browser sessions have a foreign
key to the user's actual active-workspace membership. Merely returning a virtual
workspace from a broader list would not make workspace switching work and must
not be presented as implementation. Inheritance requires a separately recorded,
stable operator-account anchor and explicit employee access grant, backed by an
active source-root membership with CRM access. The mutable default/primary
workspace and the CRM employee identity toggle are not that grant. Exact target
workspaces must belong to the reviewed operator account, with explicit target
denials preserved—not email domains, company-name matches or global
administrator status. Inherited
reads must use audited membership/pipeline intent and the native-first workflow.
The new unshared-workspace admission step below does not itself grant a CRM
pipeline. Complete the root-scope grant/revocation workflow before activation,
and do not manufacture owner/editor access or expose ordinary private boards to
avoid it.

### Local root-employee source/provenance contract, November 2, 2026

`rootEmployeeCrmAccess.ts` now derives read-only workspace/pipeline/managed-card
intent from an explicit anchor, source grant, current operator ownership,
employee eligibility, target scope and independent provenance. Peer business
roots can be in the same explicitly bound operator account; arbitrary roots,
demos, disabled pipelines, explicit CRM denials, inactive/trashed users and
private Project boards do not inherit access. A native identity is optional for
app-only staff; a mapped employee must have exactly one existing native identity.
New business scopes produce viewer intent, never ownership/editor promotion.

Revocation detaches only the selected source's proven inheritance. Independent
manual grants and other source grants are preserved. Unexpected source keys,
inconsistent repeated memberships, duplicate resources, fabricated board bindings
and ambiguous identities are refused. Nine pure contract groups (59 cases)
pass and run in the native-authority test suite. These are **not** persisted
grants or runtime access: the collector/registry, exact native-first app delta,
source lifecycle wiring, organization/pipeline selection and managed-card
integration still must be completed and tested. The module must not be used as
a shortcut around the existing membership/session foreign keys or native fences.
No production permission or schema was changed.

### Local explicit operator registry and collector, November 2, 2026

Prepared migration `0392` adds empty operator-account, explicitly bound business
workspace and root-employee intent tables. It seeds no account, infers no scope
from an email/name/default workspace, and creates no reader memberships. Root
identity/source bindings are immutable, writes require the next revision and
current operator ownership, and disabled history cannot be deleted/rebound.
Public table/function privileges are revoked. Registry writers acquire the same
control-first fence as the private `crmRootEmployeeAccess.ts` source collector.
The collector rechecks the actual operator owner, exact root/peer bindings,
employee eligibility, target denials, native identity and registered CRM-board
projections, and pins registry revisions plus the current control generation.

The 61-case pure contract and nine actual PostgreSQL registry/collector groups
pass (`root-employee-registry-postgres-20261102-r88.log`). Source reads and metadata
registration do not materialize memberships, pipeline readers, board grants or
outbox work. Native-enabled registry changes deliberately remain refused until
the exact native-first root-resource delta integration is complete. Ordinary
private Project boards are never selected by the collector. These new tables
are not wired into login, authorization or user-management routes yet.

The whole regression and predeploy **pre-registry baseline** passed in r73/r77
through migration `0391`. Those receipts do not certify the later `0392` schema.
Forward catalog enrollment/tamper acceptance, native-first materialization and
revocation, normal lifecycle/UI integration and fresh current-candidate release
gates remain mandatory before any push or activation.

### Computed CRM read context, November 3, 2026 (local, unreleased)

Migration `0393` and the normal workspace/session/resource adapters now wire
the explicit registry into actual app reads. No membership, pipeline share or
board share is manufactured. A delegated session retains its real source-root
membership in `active_workspace_organization_id` and the original composite
foreign key; its separately checked `crm_view_workspace_organization_id` is the
CRM-only business selection. Login and switching resolve the current source,
rotate tokens normally, and return complete fail-closed module permissions.
Returning to an actual membership clears the delegated context. A default
workspace or browser-supplied actor is still not an access grant.

Computed readers see bound CRM pipelines and only registered managed CRM
cards, as viewers. A stale editor/private-board share cannot become active in
an otherwise unjoined workspace. A valid independent manual membership/share
retains its existing role. Projects denial removes inherited cards without
removing legitimate CRM reads. Login/listing cannot create replacement boards,
pipelines or provider provisioning for a computed root scope. The resource
resolvers also enforce their module permission before any default provisioning.

Registry/eligibility changes revoke affected delegated sessions, not re-parent
them; restoring a grant does not resurrect old tokens. Session authority writes
take the common control lock before row locks, including direct SQL writers.
Root/read metadata is re-evaluated on each request. Profile/timestamp-only user
updates do not invoke the root-session rescan.

The current pure contract passes 61 cases. Actual full-migration PostgreSQL 16
runtime acceptance passes 22 groups in
`root-employee-read-runtime-20261103-r102.log`, including real session issuance,
token rotation, retained FK, module denial, manual-share isolation, source
trash/suspension/demotion, immediate revocation and a blocked direct-writer race.
The same 22 runtime groups also pass on PostgreSQL 18 in r103. Normal user
Trash/Restore/login-address regression and the 21-group employee identity/access
gate pass in r105. Production-source TypeScript/build passes in r94/r101;
session/workspace contracts pass in r97/r100. Earlier r93 exposed a denied-module provisioning
fallback, corrected before r95/r98/r102. These are not browser/native ACL or
production evidence.

**Native integration and activation remain incomplete.** The computed root read
function deliberately refuses inheritance while native policy is enabled or a
native operation/transition is active. Native-first audience deltas and ordinary
user-management intent enrollment must be integrated before this can meet the
release requirement under activated native policy. The registry remains empty
by default; no hosted row, policy, identity or provider cursor was changed.
Forward schema attestation must cover `0392`/`0393` helpers, triggers, privileges
and ledger, followed by the full current-candidate gates and browser acceptance.
The older through-`0391` whole-suite/predeploy receipts do not certify this slice.

The subsequent native snapshot/publication integration uses the actual locked
root-source collector, including denied/disabled intent and exact registry
revisions, in both authority stages and the canonical new-email audience. It
does not fabricate a target membership or editor share. Removing an explicit
editor share while root readership remains produces an editor-to-viewer native
capability witness: retain reading and remove historical/future writes.
The 34-case PostgreSQL user-access regression passes in
`native-root-authority-user-20261103-r142.log`; its native receipts are synthetic,
not a substitute for actual SuiteCRM execution.

Prepared migration `0394` closes legacy independence exceptions for mapped
root-source changes. A denied target enrollment cannot silently revoke app
eligibility while leaving native reading behind; operator-owner demotion and
root type/parent/demo changes are fenced too. Unchanged native readership may
still add a real CRM-enabled target membership or update unrelated module/display
settings. Actual full-migration PostgreSQL 16 acceptance passes 26 groups in
`native-root-source-fences-20261103-r143.log`, including these cases. This is
still local/unreleased. Registry enrollment, first native identity linking,
native-enabled computed app reads and forward schema attestation remain open;
the protective holds above have not been presented as completed workflows.

The current real SuiteCRM acceptance receipt
`native-root-app-timed-20261103-r156.json` passes **eight** combined application
coordinator/PostgreSQL/OAuth/native-route cases on SuiteCRM 8.10.1, PHP 8.3.35
and MariaDB 11.4.13. It includes actual editor-share removal retaining inherited
reads while removing historical/future writes, and actual root-source CRM
denial/restoration preserving separate organization membership. No viewer share
is manufactured. Lost-response lease recovery is also exercised. The standalone
318-Email/12-principal native scale revoke/grant passed at 4671.365/4661.373 ms
under the unchanged five-second cap. This proves this isolated candidate flow,
not live/browser access, production scale or registry enrollment. The receipt
pins 65 production/test-source files and checks that none changed during the run.

The refreshed full-migration gate r157 also passes all 26 runtime groups on
**both PostgreSQL 16 and 18**, including direct source-statement/control-lock
ordering. R160 passes seven exact-publication SQL groups and r162 passes eight
mapped-settings groups with the canonical audience. Current production build
and TypeScript compilation pass r163. These remain local candidate evidence;
they do not close registry enrollment, browser/provider or production gates.

Post-r109 lock review found that denial-only session revocation must **not**
acquire control after a credential transaction has locked its user. That lock
was removed from revocation-only statements, browser revocation is permanent,
and support-mode entry locks control before its user read. The current r117
gate passes 24 actual runtime groups on **both PostgreSQL 16 and 18**, including
the credential/control-lock race and real support-mode entry/exit through a
delegated CRM context. Current production-source types pass r113; lifecycle and
identity regression pass r123, including the separate synthetic enabled-native
app-only lifecycle profile in r124. The earlier r101 full build predates that
last lock-order correction and is not the final current-candidate build.

The attempted r112 database run was stopped before starting a container by the
disk guard (11.32 GiB). The report-only r115 audit observed a lower transient
minimum; after headroom recovered above 25 GiB without agent deletion, r117
ran successfully. This is not evidence that the volatile storage cause has been
fixed. Do not override the floor or clean unrelated work/active Docker state.

### Local unshared-workspace enrollment checkpoint, November 2, 2026

Prepared migration `0391` addresses the ordinary Add organization access path
for an already mapped active user. A new member membership can be admitted only
in a real workspace where no pipeline—including disabled pipelines—names that
user as owner or intended member. It does not assign a native identity, alter
existing membership rows, grant a pipeline, share a private board or change
native policy pins. An active authority transition still freezes this path.
The app's normal owner/admin entrypoint now rechecks live management permission
and target ancestry inside the control-first transaction; a stale or trashed
administrator cannot apply an earlier request. Audit failure rolls the added
membership back with the transaction.

This is a local enrollment primitive, not implementation of automatic all-account
CRM visibility. Coordinated viewer grants, managed CRM-card selection and source
revocation/restoration across inherited scopes remain required. No live user,
workspace, permission, schema or production setting was changed.

### Local customer-folder implementation checkpoint, November 2, 2026

The local candidate now contains a separate customer-folder coordinator, Google Drive adapter, and PostgreSQL reservation adapter (`customerDriveFolders.ts`, `customerDriveFolderGoogle.ts`, `crmCustomerFolders.ts`, migration `0388`). It reserves all eight provider IDs before creating a folder, uses independent exact-ID readback, refuses name-only root adoption, reuses explicitly adopted roots/children without changing their metadata or sharing, and retains the original reservation across concurrent calls and lost create responses. The PostgreSQL adapter rechecks an active customer's Global ID, workspace/pipeline and editor authority; it does not enroll suppliers or workspace-root records. The shared Google client now preserves upstream HTTP status separately from its app-facing error status, so 404 absence is not confused with a 409 duplicate-ID conflict.

Evidence is recorded in ignored local artifact `output/local-validation/crm-customer-drive-20261102-r1.json`, including hashes for the seven new/changed implementation/test files. Thirteen coordinator/adapter checks and eight real PostgreSQL checks passed with synthetic Drive data and a minimal app schema. The existing twelve link-helper and fourteen React SSR/extracted-command/static checks also passed. Build-specific TypeScript, lint (three existing navigation warnings), adapter contracts, full build, and predeploy passed. The first SQL attempt exposed an unsupported PostgreSQL regex repetition bound, which was corrected and retested. The general test-inclusive TypeScript configuration still failed in test files; its failure is recorded, not counted as a passing gate.

This is **partial, inactive local implementation**, not a deployed capability. Account-creation enqueue/worker wiring, administrator parent/adoption configuration, card/CRM description write-through, Fractional folder-reference transport, signed-in browser checks and real Drive verification remain required. No live Drive folders, sharing, production schema, CRM permissions or records were changed. No push or deployment occurred. These checks do not establish completion of the broader email/calendar/user-access release.

### Local publication and automatic-job checkpoint, November 2, 2026 (r2)

The later local candidate connects verified reservations to the actual CRM Account staging/outbox/audit transaction and then the existing Project-card reconciliation path. Publication merges into the locked current description, retains the original account Global ID and Fractional URL, and tracks `pending`, `published`, or `manual_override`. A manual BPO link replacement or removal after publication is not overwritten or reinserted by a retry. An explicit root adoption can retain an existing operator shortlink without repointing it; a pre-existing unrelated BPO link blocks fresh creation before provider writes. Card reconciliation failure does not undo the committed CRM update or manufacture card success; retrying the same reservation runs reconciliation again without another publication.

Prepared migration `0389` adds opt-in workspace settings and one durable job per exact account. Only a new ClawPilot customer or an explicit non-customer-to-customer conversion queues automatically after settings are enabled. Old-customer edits, folder-description publication, suppliers, workspace roots, demos and external-source imports do not trigger a historical sweep. Account rollback also rolls back its queued job. The existing secret CRM outbox endpoint dispatches at most one folder job per request, using exact configuration revision and conditional lease settlement; transient provider retries are bounded and worker responses contain counts only. No settings are seeded or enabled by the migration.

Ignored artifact `output/local-validation/crm-customer-drive-20261102-r2.json` pins eighteen source/test files. Twenty-three focused coordinator/publication/worker/HTTP checks and fourteen actual PostgreSQL checks passed. The PostgreSQL fixture uses the actual CRM staging, sync outbox, audit writer, job worker and Project-card projection, with synthetic Drive/runtime ports and a minimal app schema; shortlink upkeep is excluded. The existing twenty-six link-helper/React SSR/extracted-command/static checks, supported build TypeScript, lint (three existing navigation warnings), adapter contracts and documentation checks passed. Injected publication rollback and post-commit card failure both recovered without duplicate folders/publications. Full build/predeploy evidence from r1 predates these edits and does not certify r2.

Still required: authenticated administrator setup/adoption/retry endpoints and UI, actual parent verification, signed-in app and real Drive checks, and Fractional folder-reference transport. Both current ClawPilot and Fractional gateway clients reject unknown company fields, so a folder field cannot be silently appended to that wire format. Root-employee read scope and the broader native/email/calendar release work also remain open. No production settings, folders, schema, permissions, records, push or deployment changed during this checkpoint.

### Administrator controls and Fractional receiver checkpoint, November 2, 2026

The later local candidate adds separate account-card setup/status controls and authenticated exact-account HTTP commands. The ClawPilot platform owner, also holding workspace administrator/editor authority, can verify the existing shared-drive `01 Customers` parent and enable or pause new jobs. Pipeline editors can create/retry/adopt only within that approved binding; they cannot choose an arbitrary parent accessible to the platform service account. Pausing does not require provider credentials. Commands use configuration/job versions and stable request identity; an ambiguous response retries the same command. Status polling does not overlap slow reads. The manual two-link description editor stays separate from automation and preserves its captured description hash and drafts.

Nine command/service/HTTP groups passed, including bounded streamed request handling. Eighteen actual PostgreSQL groups passed for reservation/publication/jobs/controls. The actual React/MUI browser fixture passed mobile light/dark, access-control, stale form, same-command retry, slow-read polling and manual-override scenarios with mocked API responses; screenshots are local artifacts. These component tests do not prove a signed-in app or real Drive flow.

The [Fractional gateway](fractional-crm-gateway.md#fractional-customer-folder-reference) now has a separate exact-source-customer folder-reference receiver, avoiding a breaking extra company field. It retains the Account Global ID, respects manual link changes, writes through the existing CRM description/outbox/audit transaction and retries post-commit card reconciliation. Twenty-five HTTP checks and sixty-eight PostgreSQL assertions passed, including actual machine HTTP → PostgreSQL → Project-card projection with original identity/comments retained (shortlink upkeep excluded). The Fractional source sender, signed-in/provider acceptance and downstream delivery are still required; this remains inactive local work, not a deployed capability. The broader root-employee/native-permission/email-recovery/calendar release gates remain open.

### Two-folder ownership and Fractional publication requirement

The customer has **two distinct Drive folders**, not two labels for one folder.
ClawPilot provisions the BPO customer folder in the **BPO Supply Chain shared
drive**, under its approved BPO `01 Customers` parent and established BPO
structure. Fractional independently provisions its customer folder in the
**Fractional shared drive**, using Fractional's own parent and structure. These
are separate shared drives and separate folder locations. Creating or publishing one
does not fulfill, replace, or repoint the other.

After Fractional has created and independently verified its folder, its exact
folder URL must be published to the same customer's Global-ID-linked Account
description and managed Project account card. Preserve the BPO URL, free-form
description, comments, and Account/card identities. Do not create another Drive
folder merely to populate the card, infer a match from a customer name, or use
an organization-wide folder default for either customer-specific link.

The November 2 read-only source review located Fractional's existing provisioning
receipt at `app/src/server/customer-setup.ts`: `customer.setup.drive` records
`status: ready`, the verified folder ID/URL, and `globalAccountId`. That receipt
is the source for the missing outbound publication. The current
`shared-crm-gateway.ts` does not yet send the separate `customer-folder` request.
A durable, idempotent sender must retain the verified URL and exact source
customer/account binding across transport failures, verify ClawPilot readback,
and hold manual link conflicts for review. A completed Drive setup must remain
completed if publication needs a retry; never rerun folder creation as a retry
mechanism. The receiver's local tests are not evidence that this missing sender
or either real provider flow has completed.

The November 3 read-only follow-up found that outbound implementation in the
canonical Fractional checkout: `customer-folder-publication.ts`, the separate
`shared-crm-folder-gateway.ts` client, and the worker's publication phase. It
retains the verified folder and immutable intent, reauthorizes before dispatch,
uses conditional publication and independent readback, and holds manual changes.
These sender/client/test files were still untracked when inspected. This
supersedes the earlier source-missing observation, not the outstanding release
and provider-verification gate. Do not create a second sender or claim either
shared drive has been provisioned from a source inspection.

The subsequent local gateway change also queues the **separate BPO** folder
when Fractional onboarding creates a genuinely new, verified, source-mapped
ClawPilot customer Account and BPO automation is already enabled. It uses only
the approved BPO shared-drive/parent configuration; Fractional's folder URL is
not a BPO provisioning destination. Account creation, source mapping, operation
receipt, and the one BPO job commit or roll back together. Reuse, operation
replay, ordinary edits, and Fractional folder-URL publication do not enroll
historical customers, reset the BPO job, or mark BPO provisioning complete.
Paused BPO automation leaves Fractional onboarding operational without queuing
new BPO provider work.

Local r43 evidence passes 77 actual PostgreSQL assertions through all migrations,
including the real Global-ID Project-card projection, separate Fractional URL
publication with the BPO job unchanged, duplicate-free concurrent creation and
replay, and transaction rollback. Folder HTTP checks also pass. These are local
synthetic provider references, not two real shared-drive folders or a completed
Fractional outbound sender.

Global application roles, organization roles, organization data scope, and board membership are separate concepts. A child-organization owner may also receive global application administration without being moved into the root organization or gaining unrelated tenant data. An invitation must assign the user to either the inviter's organization, an existing descendant organization, or a deliberately created descendant organization. It must not create a synthetic organization for each person. Ordinary boards require both active-workspace scope and board ownership or sharing. Managed CRM boards additionally require access to the organization-primary pipeline and bind to the active workspace membership. Users with more than one independent business switch between peer root workspaces; boards and CRM projections never combine those roots.
