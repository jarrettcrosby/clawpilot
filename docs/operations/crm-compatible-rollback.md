---
id: cp-ops-crm-compatible-rollback
title: CRM Shared-Email Compatibility Floor
summary: Local artifact certification, retained-schema rollback and finite rolling acceptance for the shared-email writer.
status: draft
kind: operations-runbook
area: operations
tags: [crm, rollback, postgres, suitecrm, local-acceptance]
app_visible: false
---

# CRM shared-email compatibility floor and local rollback artifact

Production promotion, migration 0374, legacy adoption, native publication and
the reviewed three-message recovery remain separate approval gates. These local
tools do not execute or authorize any of them. They never rotate credentials,
change permissions, start maintenance/adoption mode, or contact a provider.

This draft supplements the active [SuiteCRM Railway Runbook](suitecrm.md).
It does not replace that runbook or approve a release.

## What the artifact is

The artifact is an immutable, hash-pinned **source application snapshot** that
retains the shared-email database fence, scalar-primary bridge, compatible new
writer, reviewed/CAS identity preservation, native audience/publication gate,
and exact raw-catalog schema attester. It includes package/build inputs and native
bootstrap/security source. It is rebuildable source, not an installed service,
container image, proof of production delivery, or certification of native PHP.

Certification requires both a real synthetic PostgreSQL transition receipt and
a successful isolated Node 24 application build receipt for the same clean full
Git commit. A current uncommitted checkout, successful source-contract check,
mock receipt, arbitrary historical image or a green CI badge is insufficient.

Unmodified `b61192200b6d990adb320fd7f941a619976bc4af` is deliberately tested
as the **old writer**, not packaged or approved as a writable rollback target.
The old code does not maintain secondary company relationships or enforce the
current review/identity/native-publication contracts.

The first certified floor is this tested compatible candidate itself. Retaining
and restarting that same artifact is not a return to old features, an undo of
reviewed associations, or a database/native state restoration. Establish it as a
separately accepted canary baseline before activating shared-email recovery;
otherwise it cannot yet serve as a known-good earlier application version.

## Finite local certification sequence

1. Finish and independently review the coordinated application, native-gate and
   migration changes. Freeze migration bytes and the exact PG16/18 raw catalog
   enrollment. Preserve all prior catalog fingerprints and drift negatives.
   Commit the integrated result locally; do not push/merge/deploy as a side effect.
2. Coordinate the single disposable database lease with the operator. Use only
   already-installed PostgreSQL 16/18 images; the runner uses `--pull never` and
   the repository's guarded tmpfs/resource/cleanup helper. It accepts no general
   database URL, production env file or arbitrary server address.
3. Run the transition acceptance and isolated build below against that exact
   clean commit. The source check and artifact unit test may run earlier, but
   cannot emit a runtime certification receipt.
4. Build the immutable source artifact, retain its printed manifest SHA-256 in
   the independent release review record, and verify it using that exact digest.
   A digest read again from an untrusted artifact is not an independent anchor.

Local commands (the operator supplies the already-reviewed full commit SHA and
an existing private output parent outside the checkout):

```sh
node scripts/test-crm-compatible-rollback-artifact.mjs
node scripts/test-crm-rolling-rollback-postgres.mjs --check-source
node scripts/test-crm-rolling-rollback-postgres.mjs --check-transition
node scripts/test-crm-rolling-rollback-postgres.mjs --commit COMMIT_SHA40 --receipt /PRIVATE_OUTPUT/transition.json
node scripts/certify-crm-rollback-build.mjs --commit COMMIT_SHA40 --receipt /PRIVATE_OUTPUT/build.json
node scripts/build-crm-compatible-rollback.mjs --commit COMMIT_SHA40 --output /PRIVATE_OUTPUT/rollback-floor --acceptance /PRIVATE_OUTPUT/transition.json --build-receipt /PRIVATE_OUTPUT/build.json
node scripts/build-crm-compatible-rollback.mjs --verify /PRIVATE_OUTPUT/rollback-floor --manifest-sha256 APPROVED_MANIFEST_SHA256
```

`--check-transition` exercises the working-tree SQL against a disposable fixture
but deliberately emits no certification receipt. Only the clean, pinned
`--commit` invocation can qualify the rollback artifact.

Use the bundled Node 24 runtime or its verified equivalent. The build wrapper
exports only committed source into a new private temporary directory, omits env
templates/runtime placeholders, reuses installed dependencies without installing,
and supplies no inherited provider/database credentials. It disables telemetry
and execution, hashes the actual compiled output, checks the original commit
again, and cleans up only its own temporary build directory. It does not alter
the checkout's existing Next output. Build or proof failure emits no successful
receipt; prior output files/directories are never overwritten.

The final artifact contains `source.tar` and `manifest.json`. The manifest binds
the commit/tree, exact archive bytes and tracked paths, protected source and
package-lock hashes, exact migration checksum, strict attestation version and
raw major-specific digests, and both canonical proof receipts. Env files,
runtime data, logs, backups, symlinks and submodules cannot enter the artifact.
Read-only file modes discourage accidental changes; the independently retained
SHA-256 is the actual verification anchor, not a permission or signing grant.

## What transition acceptance proves

The test runs the actual old `stageInteraction` declaration from the pinned
legacy Git object and the actual compatible persistence declarations against one
new, synthetic PostgreSQL database. It proves:

- Pre-migration legacy data is backfilled, and ordinary old scalar inserts and
  primary-company changes remain coherent through the database bridge.
- Old writes to an already-shared interaction, its contacts or its companies
  fail atomically without changing saved data. Child-row relocation into an
  already-shared interaction must also fail.
- The compatible writer can edit content while preserving the original local,
  provider and native identities, timestamps, primary company, contacts and all
  company links. Its private write context does not leak beyond the transaction.
- Reloading the committed compatibility-floor code against the retained schema
  still permits safe content edits. The actual native payload producer retains
  both companies and both selected contacts without calling SuiteCRM.

This is not a full production migration rehearsal or proof of provider delivery,
native ACL enforcement, migration duration on production-sized data, worker drain,
production audience, or compatibility with an arbitrary later application.
Full migration/attestation fixtures, native PHP/runtime tests, reader/reporting
tests and the exact candidate CI remain additional gates.

## Native profile remains a release blocker

The last read-only native review observed inheritance enabled and generated
module/global hooks. That profile is **unsupported by the current verifier**:
it requires `securitysuite_inherit_creator`, `securitysuite_inherit_assigned`
and `securitysuite_inherit_parent` to be explicitly false, and refuses the
relevant custom/generated hook inventories. Its refusal is intentional. The
local stub PHP and PostgreSQL fixtures do not establish that the installed
profile can publish safely. Empty SecurityGroups and a hash-matched hook
inventory do not establish an owner-only effective audience.

Until separately resolved and rechecked against fresh installed evidence, hold
production promotion, migration/activation, legacy adoption, recovery and native
publication. A certified application source artifact does not remove this gate.
The finite options requiring an explicit operator decision are:

- Retain the hold and keep this work local.
- Separately design and review narrow support for an exactly pinned native
  hook/configuration profile. Real SuiteCRM 8.10.1 acceptance must prove exact
  links/readback, effective readers before and after, no reader expansion, and no
  hook/workflow dissemination. Hash-matched stock files or today's sole admin
  audience alone are not a future per-company intersection guarantee.
- Separately approve targeted native configuration/hook remediation, with an
  impact review, rollback plan and canary acceptance before enabling publication.

None of these options authorizes broad hook deletion, access for a service
principal, credential changes, security-group or role grants, or weakening the
publication guard. Do not switch flags or remove generated files merely to make
the verifier pass.

### October 28 installed-policy and real-runtime findings

The read-only production metadata/source observations at **2026-10-28
16:31:39 UTC** and **16:40:09 UTC** identified SuiteCRM **8.10.1**, PHP
**8.3.35**, and MariaDB **11.4.13**. Both database observations used read-only
transactions and rolled back. They did not bootstrap the live application,
authenticate as another user, or copy customer email content into a fixture.

The installed policy has four nondeleted principals: an administrator, two
active principals with explicit module-deny roles, and a blank-status principal
without a role. That last principal has active employee status and no group or
portal restriction. Pinned `User::isEnabled()` does not require the status to
equal `Active`: blank status is not equivalent to disabled. This is an access
eligibility finding, **not proof of a successful login or possession of a
password/token**. It must not be silently excluded from the audience.

The isolated real runtime reproduces the relevant policy using synthetic
principals and no production data. With zero SecurityGroups, the unroled
blank-status principal receives the native module defaults (`89=enabled`,
`90=all`) and passes actual Email `ACLAccess('view'|'list'|'export')` on both an
unsaved and saved owner-assigned bean. The two explicitly denied principals do
not. Consequently the observed policy cannot establish the proposed
pipeline-owner-only audience, even **before** a second company is associated.
Changing inheritance flags alone would not repair that mismatch.

Concrete native surfaces also matter: the fixture exercises V8 direct/list
services, the UI's `ListViewData` path, and the export helper separately, rather
than equating those paths with a bean-level ACL boolean. In the adversarial
company-group fixture, principals denied direct Email view and UI/export still
receive that Email through the real V8 list service. A per-record `ACLAccess`
union is therefore not a complete audience proof for that group configuration.
This is isolated native behavior, not a claim that such groups are currently
configured in production (the read-only observation found none).

The same real save/retrieve and V8 service test also invalidates the former
echo-style readback assumptions:

- `Email::save()` fills an empty `description_html` from the plain body, adding
  line-break markup.
- The V8 attribute serializer strips angle-bracket addresses from named
  From/To/Cc/Bcc strings even though the retrieved Email bean retains them.
- V8 serializes the database date/time as an offset-bearing ISO value rather
  than returning the submitted database string verbatim.

The existing strict client correctly refuses these differences; it must not be
declared compatible or changed to accept arbitrary transformations. A future
candidate needs an explicit, pinned normalization/raw-native-readback contract,
with independent exact header/body/instant checks and tests. A separate atomic
publication design is also needed before relaxing the current profile gate:
two HTTP audience observations around multiple writes are not a transaction
over native policy and publication. Neither design is implemented or accepted
by these observations.

The targeted source/config review also found Maps effectively disabled (no
`jjwg` category settings, pinned false default) and the exact ElasticSearch hook
switch `search.ElasticSearch.enabled` explicitly false. Those facts narrow this
observation; they do not authorize enabling either dissemination path or
allowlisting arbitrary hooks. Source hashes prove code identity, not reader
authorization.

Sanitized evidence is retained outside Git. The first installed observation's
SHA-256 is `483ca2cf88d65ce6088ab8c4ed5e586bc826c8b0f48255d77773859d9f5b0653`;
the targeted observation's is
`9339d8619cbd449dfa939afe31802d15e7315a13e0774ed9088f0d9ae60b63ae`.
The exact release ZIP is pinned to
`b72da32ca7702452537cdd11e1157bc41a283accdadca66ef88f42684a571ef7`.
Runtime receipts record immutable PHP/MariaDB image IDs and distinguish a
partial golden observation from the complete native-behavior fixture. These
tests are not HTTP OAuth, signed-in UI, live native ACL execution, production
publication, concurrent-policy safety, or successful recovery evidence.
The complete native-behavior run at **2026-10-28 16:44:58 UTC** passed its seven
checks while explicitly retaining the audience **hold**. Its receipt SHA-256 is
`1c485db0b6ccd14c7a8b8f8ae5705b660ac403f586f8b8dd790e36a59e917a84`.
A successful safety-blocker reproduction is not publication acceptance.

The local real-runtime fixture is deliberately opt-in:

```sh
node scripts/test-suitecrm-native-acceptance.mjs --source-zip=/ABSOLUTE/SuiteCRM-8.10.1.zip --output=/PRIVATE_OUTPUT/native-behavior.json
```

Prepare the dependency image from
`scripts/fixtures/native-email-audience-real/Dockerfile` using exact PHP
`8.3.35`, plus MariaDB `11.4.13`, before running. The runner verifies the ZIP,
uses an internal network with no host ports, tmpfs-backed disposable runtime and
database, bounded memory/CPU/logs, and the shared owner-checked database lease.
It does not download dependencies or override the 15 GiB disk floor. Do not run
PostgreSQL fixtures concurrently, bypass a busy lease, or broadly prune caches
or volumes. Verify cleanup independently after a failed or interrupted run.

The unresolved operator decision is therefore **targeted native-principal
remediation or retaining the hold**, not a general sharing grant. Any approved
remediation needs exact-target impact review and fresh audience testing. No
native role, user status, group, hook, flag, token, or credential was changed as
part of this local test work. Promotion, migration 0374, legacy adoption, and
the three-message recovery remain unauthorized and unexecuted here.

### October 29 approved local remediation candidate

The operator explicitly approved **preparing and testing a targeted permission
correction**, preserving users' legitimate organization access and presenting
the exact live change separately. This is not approval to apply production
roles/groups, change user status, migrate 0374, adopt messages, or publish email.

The isolated pinned SuiteCRM/PHP/MariaDB runner now offers
`--remediation-candidate`. It runs the unchanged seven-check baseline, then
tests a fresh-process candidate with eight additional passing checks. The run
at **2026-10-29 21:42:25 America/New_York** produced private receipt
`native-remediation-candidate-2026-10-29-r1.json`, SHA-256
`eb39ae4bb406a8f8e0fbeff4d701f26582d0de5f25fcd55e093ff1936e32061c`.
All temporary containers/network/DB lease were absent after cleanup.

The candidate's exact kinds of changes are:

1. Add native Email view/list restrictions **before** V8 module-list queries and
   counts, and recheck each returned Email before serialization. Apply the same
   restriction to related-Email queries before pagination/counts. Other modules
   keep their existing paths. The patcher requires exact stock checksums for
   `Api/V8/Service/ModuleService.php` and `RelationshipService.php`; it writes
   only the disposable fixture's `/app` directory, not repository runtime or
   production files.
2. For the synthetic counterpart of the previously unroled principal, attach
   one Email-only role: access enabled; view/list/export/edit/delete restricted
   to native group/owner scope. Attach one group containing only the explicitly
   authorized own-workspace Email. Do not disable the person, elevate them,
   change other module actions, alter service denials, or add them to BPO.
3. Verify own-workspace read/edit/export, denial of BPO direct/UI/V8-list/export
   reads and edits, related-list filtered counts, unchanged administrator and
   denied-service behavior, unchanged other-module action levels and user
   status, and reversible removal of the two candidate memberships. Message
   data, assignment and lifecycle are unchanged.

This identifies a viable **local canary**, not a production-ready publisher or
general multi-company permission-intersection proof. A production role alone
is insufficient: the unchanged baseline reproduces the V8 list bypass. Native
group/owner rules may also admit an assigned/created-by user, so exact live
ownership and existing/default/inherited groups must be reviewed, not inferred
from account names or principal status.

Before presenting an executable production change for approval, capture fresh
read-only inventory identifying the exact target principal, existing roles,
groups, native Email IDs/Global IDs and owning ClawPilot workspace. Build the
own-workspace allowlist from verified mappings; hold ambiguous/unmapped rows.
Preserve all existing legitimate own-workspace access, with a before/after
matrix and exact membership rollback record. The initial historical target
was Olivia Kiraly's native principal, not a new user or a service account; this
must be reverified rather than applied from this dated note.

The fresh read-only inventory at **2026-10-29 21:53–21:55 America/New_York**
reverified that target and its active Suburbia membership, editor membership in
one pipeline and ownership/readership in another. The two installed V8 service
hashes exactly match the candidate's stock inputs. All **311** active native
Emails have matching Global IDs and resolve to exactly one ClawPilot pipeline;
all are assigned to and created by the administrator, with no native group
links. The prepared private proposal
`native-permission-proposal-2026-10-29-r1.json` (SHA-256
`49fb2651574d1b23743ec63b2a3a2da766d2a138ce5aa19698a3999d15c4822a`)
contains the exact native IDs, Global IDs and pipeline/workspace bindings:

- Preserve access to **27** Emails in the verified authorized Suburbia
  pipeline, including **six** already app-archived historical rows. Do not
  restore, unarchive, reassign or rewrite those rows.
- Restrict this non-member's access to **108 BPO** Emails and **176** Emails in
  another pipeline. Administrator and explicitly denied service access remain
  unchanged. Do not grant access based only on a workspace name.
- Add one Email-only group-scoped role to this target and one new group for
  that exact authorized pipeline, containing only the target and those 27
  native Email links. Apply the tested V8 list/related-list correction; a role
  alone leaves the reproduced API bypass open.

The native and application inventories used read-only transactions and
rolled back. The 90 application Email mappings without an active native Email
were not classified as missing messages or repaired: historical/deleted native
records require separate lifecycle review. Revalidate the exact inventory and
policy immediately before any approved execution; this is not an apply
script. Production rollback also needs a separate exposure review: removing
the new memberships alone reproduces the original foreign-email exposure and
must not be copied from the synthetic rollback test into production.

#### Authenticated candidate follow-up; live proposal remains held

The initial two-file proposal above is **not sufficient for execution**. A
follow-up review found legacy preview/search/folder paths and relationship
mutations that needed the same record-level enforcement. The candidate now
requires exact stock hashes for five files, checks all inputs before patching,
and changes only the isolated fixture:

- V8 `ModuleService.php` and `RelationshipService.php`: view/list filtering
  before counts/pagination; exact requested related Email authorization before
  unlink, rather than authorization of an arbitrary allowed sibling.
- `modules/Emails/EmailUIAjax.php`: authorize every native Email ID before
  preview/batch rendering, `relateEmails`, or `saveQuickCreate`. Quick-create
  denial occurs before even creating its related Task or other target record.
- `modules/Emails/Email.php` and `include/SugarFolders/SugarFolders.php`: native
  view/list scope before imported-search and folder row/count queries, with
  fresh row checks before serialization.

At **2026-10-29 22:26:55 America/New_York**, the complete isolated run passed
**32 checks**: seven unchanged baseline checks, eight native permission-candidate
checks, and seventeen actual HTTP checks. The HTTP stage uses real V8 OAuth
password grants and real legacy cookie sessions for four synthetic principal
classes, not mocked authentication or injected sessions. Private receipt:
`native-http-candidate-2026-10-30-r2.json`, SHA-256
`4a574d80a3bb87c0b248d6453cf525ccd2546c56ed07526f3705f3bf43a80bb8`.
No fixture containers, network or shared database lease remained after cleanup.

Allowed legacy `getEmail2DetailView` rendering is excluded because the pinned
stock implementation dereferences a null `DetailView`; forbidden detail calls
still must deny before rendering. Five other permitted legacy UID-render paths,
forbidden/mixed-ID paths, imported-search and folder contents/counts, and denied
relationship/quick-create writes passed. The denied quick-create test confirms
unchanged target Task rows (including deleted rows) as well as unchanged Email
body/header/ownership/relationship fingerprints. This is not exhaustive native
write-route, browser-layout, current-production or email-delivery proof.

**New release blocker: preserving future legitimate access.** The 27-message
allowlist preserves current Suburbia records only. The current publisher writes
no verified SecurityGroup links. Restricting the user now would hide subsequent
administrator-created Suburbia Emails; the strict replacement publisher would
hold those writes rather than supply the missing authorization. Do not apply
the role/group correction while that writer remains active.

The minimum compatible follow-up must:

1. Bind an app-managed Email group to the exact workspace, pipeline, audience
   fingerprint and generation. Members must be the exact eligible pipeline
   readers, not all organization members or users sharing a domain. Reject
   ambiguous mappings and unknown inherited/default/unmanaged grants.
2. Validate policy, attach the managed group, save Email content/relationships,
   prove native readback and effective audience, and commit in one native
   transaction. A write-then-grant sequence or separated before/after checks
   does not prove atomicity. Do not bypass the existing verifier to obtain a pass.
3. Fence membership and native policy changes against publication, including
   new default-all principals. App-side PostgreSQL locks alone do not lock
   SuiteCRM's MariaDB policy. Drain all legacy writers before coordinated cutover.
4. Test a new authorized Suburbia Email, a hidden BPO Email, a hidden different
   pipeline within the same workspace, idempotent retry, revocation/addition,
   mid-write rollback, stale/missing identities and concurrent policy changes.
   Repeat the authenticated read/edit matrix after those transitions.

Also still required: fresh hashes for all five live inputs, a hash-gated
persistent-volume installer with a fail-closed recovery plan, verified search
backend reachability (Basic versus unscoped Elastic), pinned native profile
support without relaxing unknown-hook/workflow holds, faithful native
body/header/time readback, writer drain and exact live approval. A service image
rollback alone does not restore patched persistent-volume PHP or native roles.
Do not remove the restrictive role as a shortcut: that restores foreign access.

The actual publisher and `EmailAudience.php` verifier remain unchanged and held.
No production credential, role, group, hook, inheritance flag, Email row,
deployment or recovery was changed by this work. Approval to prepare and test,
and requests to resume that work, are not approval for this expanded live change.

#### Historical and ongoing access rehearsal

At **2026-10-29 23:00:31 America/New_York**, the combined disposable run passed
**50 native checks**: seven baseline, eight permission-candidate, eighteen
authenticated HTTP, eleven historical/future lifecycle and six future-user
default checks. Receipt: `native-future-history-2026-10-30-r2.json`, SHA-256
`200dcb463987d0411cd5780dc1c91e48ed2b2595df87968dfdc5a7470114d2e6`.
The receipt records ten fixture-file hashes and the pinned native inputs.
Containers, network and shared test-database lease were removed after the run.

- An existing authenticated cookie and OAuth token lose foreign Email access
  after the synthetic correction, without another login. The first request
  after correction is a legacy preview, before a V8 call can refresh ACL state.
  Request-local refresh does not prove mid-request or long-running worker
  revocation.
- Real checked MariaDB transactions and an independent connection prove no
  partial Email/group visibility and rollback after an injected native write
  failure. Existing history retains its exact native/Global IDs, content,
  headers, ownership, relationships and application archive metadata. A repair
  does not save the existing Email bean or recreate absent native history.
- Ongoing synthetic publication uses the same exact pipeline group. Idempotent
  retries recheck identities and current effective readers; stale policy,
  missing/duplicate identities and unexpected readers hold the whole batch.
  Versioned membership removal affects both historical and new records.
- The future-user experiment uses group scope for Email view/list/export and
  owner-only edit/delete defaults. A pipeline reader must not automatically
  become an editor. Explicit broad roles, changed default rows, and role-action
  recreation remain blockers. This expanded default policy is **not approved
  for production**; the experiment rolls back all its changes.

The separate pure application planner passes **18 checks** and is included in
`test:suitecrm-interactions`. It emits a non-executable review manifest only,
requires fresh complete inventory and drained writers, and never changes roles,
ownership, content or lifecycle. Its group-binding contract is not yet wired to
the native fixture or publisher. A corrected-policy snapshot must come from an
isolated rehearsal or fenced cutover, not an unfenced live permission change.

These results prove local behavior under frozen synthetic policy, not concurrent
production policy fencing, cross-database atomicity, complete production
body/header/date fidelity or live deployment. The native transactional endpoint,
durable binding/reconciliation path, safe persistent-volume installer, fresh
live inventory and separately approved coordinated cutover remain required.
Historical access correction and exact-message Gmail recovery are distinct
operations; passing the access rehearsal does not mean missing BPO messages
have been recovered.

## Approved-transition design; no production execution here

The scalar bridge is a drain-time compatibility measure, not permission to keep
old/new publishers overlapping after shared activation. The old native publisher
cannot enforce the new audience and readback contract. A production plan must
explicitly identify and drain **all** old writers/publishers, including web
instances, worker loops and in-flight outbox leases. Application feature flags
alone cannot fence an old binary. The DB shared-row fence protects local writes;
it does not stop an old process from publishing a previously queued payload.

Only after the separately approved migration/application transition is verified
may the operator consider mailbox identity/legacy adoption, the exact reviewed
recovery and native publication. Keep those approvals bounded to explicit
messages, associations, current audience and exact native projection targets.
`/api/crm/outbox/process` has a global claim scope; `limit: 3` is not an exact-three
filter. Do not substitute the broad integration worker or a backfill for a
bounded publication plan.

Rollback retains migration 0374, canonical evidence, review/audience decisions,
relationships, native identities, outbox evidence and audits. Restore only the
verified compatible application artifact, never an unmodified scalar-only build.
Do not drop the join table, edit a historical migration checksum, delete native
Emails/links, broaden permissions, or restore a whole database to simulate a
code rollback. Any data restoration or provider compensation requires its own
explicit scope and recovery plan.
