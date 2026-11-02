---
id: cp-ops-crm-record-deletion
title: CRM Record Deletion Synchronization
summary: Scoped Account and Contact Trash actions, positive native deletion evidence, and guarded release verification.
status: active
kind: operations-runbook
area: crm
tags: [crm, suitecrm, deletion, synchronization]
app_visible: false
---

# CRM record deletion synchronization

This release is independent of the unfinished native Email permission and
publication work. It adds no database migration, Email permission change,
mailbox backfill, or organization-data migration.

## Scope and behavior

Ordinary CRM organizations and contacts have a confirmed **Move to Trash**
action. Editor permission and a same-origin browser request are required.
Workspace organizations and login-backed contacts remain managed in Settings.
One record is removed from active views; related contacts, accounts, meetings,
emails and audit history are not deleted automatically.

The reported Suburbia Globus account `ga6i0qmt2qudss` and BPO Globus account
`gagmco24va588e` are distinct identities. Never match a deletion by company name.
Deleting an account does not authorize deletion of its contacts.

Deleted identities retain tombstones so old workbook, provider or local imports
cannot recreate them. Active counts, workbook exports, project cards and
reference links exclude archived records. Dispatch checks the exact durable
lease, payload, identity and revision before provider writes; stale completions
cannot mark newer revisions synchronized.

SuiteCRM deletion detection scans at most 100 known local bindings per run
using an independent rotating cursor. Only an exact native ID plus Global ID
and positive native deleted state may archive a local record. Missing rows,
HTTP 404, permission failures, identity mismatches and ambiguous bindings hold.
It never resets the ordinary modified-time or Gmail cursors.

## Release and activation

1. Preserve current paired SuiteCRM/MariaDB recovery checkpoints and verify the
   selected production services and their current release identities.
2. Promote this focused change through a feature PR to `dev`, passing CI, then
   the normal `dev` to `main` promotion PR. Keep all Email activation flags off.
3. Deploy SuiteCRM with the packaged lifecycle installer and endpoint. Set
   `CLAWPILOT_NATIVE_RECORD_LIFECYCLE_ENABLED=1` on SuiteCRM only after confirming
   the reviewed package is present. Its startup installs the owned route before
   traffic. Unrecognized custom routes or symlinked paths refuse installation.
4. Verify authenticated read-only inspection for the exact reported bindings.
   The endpoint requires the configured service OAuth client and a current,
   unrevoked token bound to its active administrator owner.
5. Deploy the matching app release. Verify version, health and persistence.
   Enable the same exact flag on the app only after native inspection works.
   With the flag absent, organization/contact Trash requests return 409 without
   changing records. Both incoming deletion paths are also disabled.
6. Verify the already-deleted Suburbia bindings disappear from active views,
   remain archived in durable storage, and do not affect BPO. A signed-in UI
   check and native/app readback are required before calling this live-complete.
   Do not create or delete unrelated production records as a test.

Rollback disables the app lifecycle flag first and retains all tombstones,
audits, native IDs and queued outcomes. Do not restore archived rows, remove
native tombstones, or clear cursors to simulate a code rollback. The native
route can remain installed but disabled.

After the first tombstone is written, keep this release's visibility and
stale-import guards even with the feature disabled. An older application
binary without those guards is not a compatible rollback: it may republish
archived project cards or overwrite archive markers during an import.
Rollback is flag-only unless a separately validated compatible binary retains
these guards. No whole-database restoration is authorized by this runbook.

## Validation and proof boundaries

The focused candidate passed lint (three existing navigation warnings), the
production build, six mocked-auth route groups, the real React/MUI confirmation
flow with mocked HTTP, ten actual-function SQL-model groups, eight scanner
groups and nine native-client fake-HTTP/source groups.

A disposable PostgreSQL fixture passed archive/provider serialization,
cross-pipeline/contact isolation, stale local/source/alias import protection,
exact completion/newer-revision checks, managed identities, and bounded cursor
SQL. Provider evidence in this PostgreSQL fixture is mocked.

The opt-in real native fixture installs checksum-pinned SuiteCRM 8.10.1 in
PHP 8.3.35 with MariaDB 11.4.13, using an internal-only network and no host
ports. Seven groups passed real OAuth and default-off denial, exact
Account/Contact/missing inspection, wrong-client/identity refusal, real V8
Account deletion with no contact/BPO cascade, real V8 Contact deletion with
no account cascade, token revocation, command bounds and runtime disable.
All fixture data and credentials are synthetic. The installer also passed
standalone, existing-managed-route, read-only, idempotency and owned-path tests.

These local results do not establish production activation or recovery of the
missing BPO emails. That separate work remains held on its permission,
packaging and exact-publication release gates.

Run the focused local and PostgreSQL gates with
`npm run test:crm-contact-identity`. The real native gate separately requires
the cached pinned PHP/MariaDB images and an explicitly downloaded official
`SuiteCRM-8.10.1.zip` with SHA-256
`b72da32ca7702452537cdd11e1157bc41a283accdadca66ef88f42684a571ef7`:

`npm run test:crm-record-lifecycle:native -- --source-zip=/absolute/owned/SuiteCRM-8.10.1.zip`
