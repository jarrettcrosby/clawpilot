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

Production promotion, legacy adoption, native permission activation/publication
and the reviewed five-message recovery remain separate approval gates. These local
tools do not execute or authorize any of them. They never rotate credentials,
change permissions, start maintenance/adoption mode, or contact a provider.

This draft supplements the active [SuiteCRM Railway Runbook](suitecrm.md).
It does not replace that runbook or approve a release.

## Current release boundary (2026-11-04)

The newest local mailbox correction is a separate owner-reviewed address
preview/confirm workflow, not historical recovery. A read-only live profile
observation found the selected Gmail profile and saved connection label differ;
it did not establish an immutable Google subject or modify the connection.
The local correction requires fresh signed Google identity plus an independent
selected profile, same existing subject, expiring HMAC review, current owner and
credential/connection/authority CAS, and atomic label/binding/audit writes.
Expiry and profile freshness are checked again after lock acquisition. Normal
intake remains mismatch-strict, and remote refresh retains a verified label only
for the same known grant revision and unchanged credentials. Unknown/changed
grant metadata deliberately falls back to remote metadata and re-verification.

The final correction passes 41 real PostgreSQL checks on each of versions 16
and 18 through all 386 migrations, including actual refresh/key-rotation paths,
late failure rollback, concurrent applies, retained historical evidence and the
real initial-enrollment source barrier. Google/profile inputs are synthetic in
those database fixtures; they prove neither real Google authentication nor
production recovery. Run `npm run test:crm-mailbox-label-repair:postgres` with
the supported Node 24 runtime and the normal guarded database lease. The gate
is included in the organization-communications test suite.

The historical recovery boundary is still **three plus two**, not five already
recovered Emails. Both Casey caches lack canonical mailbox/source IDs; neither
ordinary re-intake nor the fixed-three bridge may silently upgrade them. They
use a separately reviewed exact-two admission with retained/current evidence
equality, fresh verified mailbox, exact IDs/participants/companies, transaction
CAS and explicit unknown original provenance. This separate local implementation
uses `admissionScope: 'casey-reviewed-two-v1'`; it is not performed by address
repair. Its distinct proof pins the owner, connection, intake pipeline and both
retained cache IDs as well as the target pipeline/thread/companies. Generic
review, correction, late-contact, partial and mixed five-message commands cannot
obtain this admission. Replays retain the unknown-original marker and canonical
identity instead of treating a newly assigned mailbox ID as original provenance.

The historical pair passes actual candidate-GET/binding SQL and staged
transaction tests in the existing 24-group PG16 reviewed-admission fixture,
including pair rollback, stale CAS, both company relationships, unchanged reader
audience and replay. That fixture has reduced synthetic base schema plus the
reviewed 0374–0381 controls; it is not an independent full-catalog/0398 proof.
The existing fixed-three factory/validator/constants remain unchanged. The
metadata-only diagnostic now emits separate unsigned three-plus-two dry-run
drafts, never a combined five-message command. Live permissions, recovery,
provider readback and deployment remain unperformed.

### Retained terminal demo quarantine

The November 4 production SELECT-only observation classified all 132
nonsucceeded native jobs: 42 Product upserts and 90 Email-from-Note
reprojections, all in 15 disabled-reference pipelines of the fixed synthetic
demo workspace. Every row has the existing demo-seed quarantine marker,
`dead` state, infinite availability, a processed timestamp and no lease. Full
row fingerprints were unchanged across the independent metadata observations;
current aggregate/payload bindings and synthetic source markers also matched.
These are deliberately retained demo identity evidence, not 132 active workers
or unresolved BPO jobs. The demo seed and verifier require their retention.
Do not replay, delete or relabel them as successful to satisfy enrollment.

The forward-only local correction is migration `0400`. A private,
security-invoker SQL helper independently verifies the complete outbox
fingerprint, exact terminal state, fixed demo workspace/owner, disabled
pipeline, current aggregate binding, allowed operation/module transition and
synthetic source. Only that precise state is recognized by the original
reserve and replan-aware admission writer checks. Ordinary dead, failed,
processing, uncertain and User-identity work remain held.

The source snapshot function and shape remain byte-for-byte unchanged: every
retained job and full row fingerprint stays in the signed source. The private
operator uses one exact ID/fingerprint batch lookup rather than trusting a
caller-supplied quarantine flag. New control-first Product source fences freeze
the classification dependencies during the bounded enrollment maintenance
window. No native PHP, historical migration, job state or permission is changed
by this correction. The 0400 raw-catalog enrollment advances to v16 while
preserving the independently accepted historical v9–v15 fingerprints.

Both PostgreSQL 16 and 18 pass the complete raw-catalog gate: 336 tamper
refusals per version, historical v9–v15 fingerprints, OID independence,
unchanged snapshot bytes and the transaction-held schema lock. Each also
passes 15 initial-enrollment SQL groups, including 35 strict quarantine
near-misses and unchanged retained jobs through reservation, admission,
cancellation, replan and activation. The actual private operator passes 22
groups per version, including the real batch lookup and RSA issuer admission.
Native collection, signatures beyond that synthetic issuer, forecasts and
native execution remain fixture ports in these focused database gates.

This is local acceptance, not a production migration or activation. Two early
fixture-setup failures (a duplicate demo root and a forbidden active unmanaged
demo pipeline) are retained separately; the corrected fixtures use the one
canonical demo root and disabled historical pipelines without disabling guards.
The successful metadata inspection is not a native capability forecast,
retained production reservation, writer-drain proof or signed activation.

### Operator-owner authority with app-only employees

Migration `0401` closes a separate owner-source classification gap: an
operator-account owner's root or explicitly bound workspace membership remains
authority even when every employee is app-only. Retained disabled account and
binding intent is included. The existing employee, state-comparison and optional
target rules are unchanged; ordinary app-only employee edits remain independent.
The migration requires the exact prior function body, replaces only that
classifier and preserves its signature, invoker behavior, volatility, fixed
search path and public-execute revocation. Historical migrations and the initial
source snapshot are unchanged.

PostgreSQL 16 and 18 each pass 55 focused access groups with the corrected
fixtures. Owner role/status/trash/delete changes are rejected on root and bound
workspaces, while harmless settings and normal app-only lifecycle changes pass.
Real SQL reservation, admission and terminal guards remain enabled; native
snapshots and receipts in these focused tests are explicitly synthetic. Owned
database clones preserve independent-client tests and verify every baseline
public-table fingerprint on return. No native or production acceptance is implied.

The current certification contract is v17 through `0401`; v16 through `0400`
remains an exact historical comparison, never a fallback for a missing owner
fence. The final release still requires current raw-catalog acceptance, exact
candidate build/certification, CI and the separately reviewed live cutover.

The historical checkpoints below are retained evidence, not the current status.
The installed-state replacement path is now implemented: a cancelled initial
operation stays cancelled; a newly reserved operation captures fresh native
state and binds the original immutable installation plus complete signed
cancellation history. It never renews an expired approval or rebinds its installer.
The private `capture-replan-source` action requires the exact predecessor,
explicit predecessor/operation selections and the original source-artifact digest;
SQL and Native independently verify those anchors before a new approval.

Current local checks include PG16/18 repeated A-to-B-to-C DAL and SQL admission,
321 full schema/tamper refusals on each version, the compiled 23-module operator
contract, the full application build, and the publication/authority aggregate.
The aggregate is source/mock/PHP-contract evidence, not provider or delivery proof.
R488 additionally passes the actual PG18/native replacement-operation flow and
two distinct full service-image starts: 18 groups, 104 audited observations,
474 source hashes, two permanent cancellations and one native execution. A single
explicit fixture-only Email text edit proves B/C capture current content rather
than replaying A's obsolete matrix. Original source/installers and A/B tombstones
remain byte-for-byte unchanged across seven observation phases. Delayed A refuses
before and after C activation. All owned resources are cleaned. Artifact SHA-256:
`088c02665ea6583f5c1f9522121349a7a13e8239e397040b6f4db9f196757b0a`.
This is not Railway SSH, signed-in UI, provider, or production proof.

R502 extends that combined rehearsal with the lifecycle route selected before
the first source/package approval: 21 groups, 107 full native audits, 103 actual
commands and 475 source hashes. The stock OAuth middleware serves exact
Account/Contact/missing inspection on both distinct enrolled Apache containers;
unauthenticated and wrong-identity requests refuse. The disabled route also
refuses without changing its installed package. Lifecycle calls change no native
tables or application files; startup retains only the established Audit-cache
exception. Ancestor source/journals and signed cancellations remain intact, and
native execution stays exactly once. Owned containers, volume, networks and
database lease are independently confirmed absent. Artifact SHA-256:
`b16b2cb73c863505867b937f8b8f20b9e0bb328586d823a40a7beec9db9f9771`.
The [combined activation order](suitecrm.md#combining-deletion-sync-with-native-email-enrollment)
is required; running an installer during enrolled startup is not a workaround.

R521 adds the actual joined meeting path to that same PG18/native enrollment
and two-container restart: 22 groups, 554 source hashes, the prior 107 full native
audits plus 48 individually audited OAuth/V8 meeting requests. One controlled
Calendar event imports one local/native Meeting, ClawPilot and native scalar
edits produce exactly two Calendar PATCHes, and replay allocates no duplicate
identity or extra Calendar PATCH. The native Contact relationship and Global ID
remain stable. Pinned stock free/busy updates, exact parent timestamp touches,
and four unsent NULL-to-empty field normalizations are explicitly constrained;
all unrelated rows and 41,313 application files remain protected. Artifact
SHA-256: `b3fa1f5d86066cca152e2aedfc2f729c199de94eeaf3df248d416dc9d4265e8f`.
This is synthetic local fixture data with a controlled Calendar adapter, not
live Google Calendar, non-UTC portability, attendee/recurrence editing, signed-in
UI or production acceptance. Earlier failed fixture-audit attempts are retained
as failures, not counted as passes.

R489/R490 also pass the Shopify reconciliation-health regressions through all
386 migrations on PG16/18 without changing the six established catalog phases.
R491 passes the complete predeploy command, including its fresh application build.
A fresh production SELECT-only, rolled-back observation still finds the exact
five cached messages and zero interaction records; publication/schema/mailbox
identity holds remain. That observation neither recovers messages nor authorizes
permission activation. Browser access and the narrow Fractional worker publisher
handoff remain external acceptance dependencies; no comparison-runtime pin change
is needed for that worker-only sender.

The integrated source candidate was committed as `8e4b4d5e9`; its isolated
clean-commit build and nine-check PG18 rolling-transition receipts pass. Merge
`4d9db8b19` incorporates current `dev` without changing that candidate's
production files, retaining stronger legacy-contact protection tests. Its pure
and actual PG16/18 lifecycle gates pass. Those earlier receipts are not an
exact-commit certificate for subsequent test/documentation commits. Fractional
sender delivery remains unproven: its migration must be appended to the owner's
current sealed migration sequence, not collide with the existing migration 069.

Still required before release completion: the remaining current candidate gates,
the exact separately approved live permission change, five-message recovery,
authenticated calendar/deletion/Drive readback and the Fractional sender handoff.
Nothing in this runbook activates permissions, enables publication or deploys.

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

#### Offline installation and native-policy contention follow-up

At **2026-10-30 09:28:12 America/New_York**, the combined isolated run passed
**65 native checks**: the previous 50 plus seven offline-installer and eight
native-policy fence checks. The latter include **26 independent contention
probes** (13 native edits tested across commit and rollback releases). Receipt:
`native-offline-policy-fence-2026-10-30-r1.json`, SHA-256
`f91ee9babca04e7b44d24d25ebe9b61883744d62dd8a4009304c5deebecbc598`.
It records eleven fixture-file and seven runtime-candidate/test-source hashes.
Test containers, private network and shared database lease were removed.

The opt-in offline installer and fixture now share the exact five-file transform
and accepted output pins. The installer defaults to read-only, refuses running
native PHP/web/background workers, stages and lints every output, preserves
exact originals outside the application tree, and journals/syncs replacements.
Interrupted installation, input drift, symlinks and later operator edits hold;
exact restoration needs separate installation-specific approval. No image/startup
hook enables this installer. Restoring stock files would reintroduce the native
read bypasses and is not a safe automatic production rollback.

`NativeEmailTransaction.php` is an uninstalled/unrouted **immutable native-policy
primitive**, not the new publisher. It locks full reviewed policy index ranges
under REPEATABLE READ, including empty ranges and new-principal/default insertion
gaps. Independent observers prove real lock-timeout refusal, successful edits
only after release, and unchanged committed rows/readers; every observer edit is
rolled back. Tests also cover partial-acquisition failure, session restoration,
commit/restart detection, same-connection policy changes and an expired commit
deadline. A savepoint sentinel detects a caller's unexpected transaction end; it
cannot reverse changes that caller already committed outside the API.

The immutable snapshot includes `securitygroups_records`. A group-adding
publisher therefore cannot directly call this v1 helper: the next implementation
must validate only its explicitly admitted Email-group delta, preserve all other
policy rows, and prove complete native content/header/date/link readback in that
same transaction. Application membership generation/revocation, durable remote
commit reconciliation and drain of legacy writers remain separate requirements.
No current application publisher, permission default, production data or deployed
service was changed. The expanded live permission/default correction remains
subject to an exact fresh proposal and separate operator approval.

#### Prepared transactional publication and durable admission follow-up

The next local candidate adds an exact, pre-admitted single Email-to-group INSERT
to `NativeEmailTransaction`. Its default remains immutable. Admission cannot
adopt a prior/deleted/foreign link, change any other policy row, or substitute a
different native identity. A separate immutable-policy digest excludes record
links so successful publication does not invalidate its own pipeline binding.
The readback includes all eight stock group-link columns, including the two
nullable audit columns. Native metadata visibility recognizes only explicit
global privileges or the exact escaped current-schema grant; unrelated or
wildcard schema grants do not satisfy that proof.

`NativeEmailPublisher` uses the same real MariaDB transaction for native Email
content, Account/Contact links, the exact access link, identity enrollment, and a
durable operation receipt. Historical repair is existing-only and does not call
`Email.save()`. Existing updates compare a locked raw pre-image; they cannot
silently overwrite newer native changes. Exact retries revalidate the native
snapshot and readers without touching timestamps. A cancellation tombstone shares
the publication operation key and prevents delayed publication after a confirmed
cancellation. Resolution returns historical operation evidence, not proof of
current readability or of the latest app revision being synchronized.

The raw projection keeps the proven source separately from actual native values.
It preserves exact plain text with a parameterized, plain-column-only restoration
after stock save; rendered HTML remains native-sanitized. UTC dates, supported
header/display-name forms, ownership, lifecycle, Global ID, and Account/Contact
links are read back from native storage. It never saves/reparents Contacts. The
existing-record save uses stock `bean_fields_to_save` to restrict updates to
the reviewed Email columns. Unrelated native NULL metadata stays NULL; the
post-save comparison still checks every unmanaged column. Fixture raw mysqli
handles are function-local so they cannot replace SuiteCRM's global DBManager;
the runtime attestor also checks that manager identity before publication.
The first supported profile refuses existing normalized address-relation rows,
unknown raw source, and headers stock native code would lose (including quoted
commas/apostrophes); these holds are not permission to strip information.

Migration **0375** and the application admission store are **disabled by default**
and have a prepared, default-off application-worker integration. An admitted request is committed
before native I/O. A timeout, fetch abort, process restart, 404, or local completion
failure cannot release it. Only the same operation's validated committed receipt
or terminal cancellation can settle it. The same application transaction must
validate the raw receipt and finish the operation/outbox state. If content changed
in the meantime, retain the old operation's truthful outcome without marking the
new source revision synced; queue the new revision separately.
Before admission, the fixed wire protocol rejects coercible IDs, trailing
newlines, malformed Unicode, ambiguous PHP object/number forms and commands
exceeding either canonical UTF-8 or native escaped-JSON limits. A command that
cannot reach native cancellation must never acquire a durable admission.

Migration **0376** adds immutable work identity and separately fenced resolver
ownership. An outbox source/payload/attempt is distinct from a reviewed historical
manifest item. Registration shares the admission transaction; a deferred foreign
key and binding constraint check that relationship at commit. Expiry permits a
new authorized resolver to claim the stored operation, but never releases the
admission or resends publication. Settlement must verify its current owner/fence,
fresh application authority and the full native receipt in one short transaction.
An existing admission skips the admission validator, so a coordinator must recover
its stored context instead of assuming registration created a new lease.

The focused work-context gate passed nine pure/fake-SQL checks and nine guarded
PostgreSQL groups, including actual 60-second expiry, competing connections,
stale-owner refusal and rollback of failed settlement. Those authorization
callbacks are synthetic; this does not prove application-worker authorization.
The prepared worker obtains a mandatory live work-context lease before dispatch,
resolves stored uncertain outcomes ahead of fresh Email work, and never falls
back to the legacy writer while native mode is enabled. Unsupported native
delete/module-transition and historical repair operations remain held. Its new
audience check additionally honors organization-level CRM permissions and trashed
membership status; ambiguous or denied readers hold the whole candidate rather
than silently changing the reviewed audience. Existing legacy audience semantics
are unchanged. New generic claim, failure and enqueue guards preserve unresolved
publication evidence. Fresh Email jobs waiting behind another native operation
are not allowed to consume their retry budget merely for waiting.

The focused coordinator gate passed thirteen synthetic orchestration checks;
four audience, eight outbox-guard and two durable-intent checks are synthetic, not native or database
concurrency proof. The existing guarded PostgreSQL routing gate passed 34 checks
and the reviewed-Gmail gate passed 19 with the real default-off 0375/0376 controls.
These prove those synthetic local data paths, not recovery of the customer's
missing production messages or end-to-end publication by the app worker.
The new adapter's eight guarded PostgreSQL groups use its actual admission,
work-context, receipt verification and settlement SQL, with explicitly synthetic
audience and native receipt/enqueue callbacks. Current-source commit stores the
actual v2 receipt; superseded commit leaves the newer revision unsynced and
retains the old receipt for the next compare-and-swap baseline. Cancellation
respects the worker's current retry budget rather than stranding an unclaimable
failed job. Workbook refresh intent is inserted in the same settlement
transaction, so an enqueue failure rolls everything local back. A separate
actual pipeline/PostgreSQL gate verifies that intent rollback/replay and source
readiness waiting do not consume provider attempts or overwrite an unimported,
unverified existing Sheet. No Google Sheets provider write is part of these tests.
The authenticated app client adapter uses the existing service OAuth transport.
Native custom routes resolve a client-credentials token's original principal
from its persisted token row because the pinned native JWT has an empty subject.
They require the exact configured client and live matching assignment; the
publisher rechecks token revocation, expiry and ownership under transaction locks.

The complete disposable SuiteCRM 8.10.1/MariaDB candidate passed **113 native
checks** in `native-transactional-publisher-2026-10-30-r12.json`, including real
OAuth client-credentials HTTP publication/readers, same-process token revocation,
independent overlapping publish/cancel processes, storage-drift refusal, unchanged
historical content, exact native projection and prior access-regression stages.
The actual PHP receipt also passed the TypeScript command-hash/raw-receipt
verifier. The race resolved to cancellation in this run; it is not evidence that
both race winners were exercised. Fixture/service hashes were unchanged during
the run, and owned temporary containers were cleaned up. This is synthetic local
component acceptance, not app-worker end-to-end or production proof.

Interaction staging now excludes server-owned `suiteCrmEmailProjection` metadata
from the authored source hash while preserving the receipt in stored metadata.
Five focused regression tests cover identical restaging, actual content changes,
archive/caller protections and old completion after hash transition. Existing
hashes/jobs are not rewritten; the next authorized staging may transition a
receipt-inclusive legacy hash once. This is not permission for bulk requeue.

This first admission mode deliberately freezes authority changes globally while
enabled, even after an individual operation settles. It guards pipeline identity,
pipeline memberships, workspace memberships, and user identity/status, including
INSERT phantoms. It has no GUC or ordinary disable escape hatch. A real native-first
membership transition flow, exact activation/readback, and customer-facing handling
are still required; this conservative hold is **not** the completed membership UX
and must not be enabled to declare the work finished.
There is also a broader migration lock-order release gate: the 0375 statement
guards acquire the singleton even while disabled. Existing authority paths such
as pipeline provisioning and sharing can already hold a pipeline row before that
acquisition. The new generic CRM completion path is now control-first, but that
does not constitute a complete audit/correction of every existing authority
writer. Do not install this migration in production until that ordering audit
and the remaining native-first membership transition are addressed and tested.

Prepared native routes are not included by the existing installer and require a
separate explicit enable flag. No environment, native schema, binding, group,
permission default, application admission, mailbox cursor, or production record
is changed by these source additions. Full application-worker end-to-end proof,
fresh live inventory, drained old writers, membership transitions and the exact
approved production correction/recovery remain release gates. Local synthetic
receipts and the disposable protected HTTP acceptance cannot substitute for
those gates.

Whole-project `tsc --noEmit --incremental false` remains red in untouched test
sources (including TypeScript-extension import and fixture-type errors). Do not
report that invocation as a passing repository-wide typecheck. Scoped worker
type diagnostics and focused tests do not replace the full release gate.
At this checkpoint the focused publication command passes 63 checks, the eight
adapter/PostgreSQL groups pass, the ten changed production-module roots report
zero TypeScript diagnostics using project compiler options, and lint passes with
the three existing navigation warnings. Documentation and whitespace gates also
pass. The candidate remains local, uncommitted and unapproved for production;
the missing BPO emails have not been recovered by these tests.

## 2026-10-30 continuation: lock correction and current recovery inventory

The operator has now requested the remaining permission/database corrections,
the exact BPO email recovery, and production readiness. This supersedes the
earlier prepare/test-only task scope; it does not turn a stale inventory or a
synthetic receipt into permission to bypass the release gates below.

The unshipped 0375 migration now locks authority only for INSERT, DELETE,
TRUNCATE, and UPDATEs naming its exact protected columns. Actual-value row guards
still prevent an enabled-policy audience change. Routine login, profile,
pipeline-sync and provisioning timestamps no longer take this global lock.
Authority writers that prelock user/pipeline/membership rows now explicitly take
the control lock first. Invitation verification probes purpose without a lock,
then verifies the real code transactionally; a sign-in-to-invitation race rolls
back consumption and retries once control-first. Ordinary sign-ins do not take
the authority lock. This is a lock-order correction, **not** a membership-policy
bypass: enabled mode still needs the explicit native-first transition adapter.

Verified in this continuation:

- `npm run build` and `npm run verify:predeploy` passed, using the strict
  application `tsconfig.build.json`. Base whole-project tsc's prior test-source
  errors remain a separate result, not a successful full-project typecheck.
- Lint passed with the same three existing navigation warnings.
- Authority locking: four focused checks plus three actual PostgreSQL groups.
- Publication admission: 19 protocol/actual PostgreSQL checks; worker adapter:
  eight actual PostgreSQL groups; reviewed Gmail persistence: 19 actual SQL
  checks. These remain synthetic provider/native evidence.
- Real PostgreSQL user-lifecycle and invitation-acceptance tests passed with
  migration 0375 and the actual authority helper installed. The lifecycle test
  uses the shared cached PostgreSQL 18 image and no implicit image pull; cleanup
  uses the guarded disposable-container helper.
- The complete native candidate passed 134 checks in
  `native-authority-transition-2026-10-30-r14.json`: the prior 113 plus 14
  authority-contract checks and seven actual native authority-transition
  checks. The test replay comparison uses canonical JSON equality, preserving
  values, scalar types, key sets and list order while ignoring object key order.
  This run predates the subsequent signed-approval/HTTP bridge work and cannot
  validate that later work. The pure publication group passed 84 checks.

Fresh, bounded production reads at 2026-10-30 17:47–17:56 UTC established:

- App release `b61192200b6d990adb320fd7f941a619976bc4af`; health and persistence
  endpoints returned 200. Development services had no active deployments.
- Native SuiteCRM contained 318 undeleted Emails and four undeleted principals,
  with no active security groups or Email group assignments. This is metadata,
  not a fresh effective-ACL proof or a ready-to-apply permission manifest.
- All three allowlisted Gmail messages remain cached. Their actual headers map
  to the six reviewed Globus/Airspace contacts per message, with no existing
  corresponding CRM interactions, cache relationship links, or matching outbox
  jobs. BPO's canonical audience snapshot was native principal `1` only.
- Production lacks the new canonical mailbox/shared-Email/admission tables.
  There is therefore no current verified-mailbox record or enabled native
  publication policy. No recovery was applied and no mailbox cursor was reset.

A separate read-only Gmail connector check confirmed all three exact provider
message IDs still exist in the same reviewed thread: two received messages and
one sent reply, none labeled Draft, Spam or Trash. The connector's signed-in
profile is `jarrett@bposupplychain.com`. This header-only observation is not a
cryptographically verified ID-token/Maton binding, body-equality validation,
recovery dry-run digest or permission to create a mailbox binding by hand.

`inspect-bpo-email-recovery-readonly.cjs` takes a read-only, repeatable-read
transaction, emits bounded metadata without message bodies/subjects, and rolls
back. `run-bpo-email-recovery-readonly.mjs` targets the exact production service;
its explicitly selected public diagnostic fallback keeps credentials in process
memory and permits no apply mode. Private report artifacts are outside Git.
The collector's seven checks are local/synthetic; production snapshots remain
observations and must be revalidated by the actual recovery endpoint.

The authority-transition protocol now has a real PostgreSQL adapter and inert
migration **0377**, plus a separately authenticated, signed native approval
bridge. This is concrete implementation, not production activation. The adapter
supports exact pipeline-member additions/removals by an active workspace owner
who owns every changed pipeline; it does not silently authorize other user,
identity, workspace-role, owner, or membership-status changes. It preserves
unaffected binding scopes, exact original rows, native identities, historical
capability evidence and immutable phase receipts. Empty permission objects are
encoded without conflating them with arrays or changing the wire canonicalizer.

The updated `test:native-email-authority-postgres` gate passed seven lock checks;
the final standalone transition fixture passed twelve checks. It exercises actual PostgreSQL admission,
authorization, migration guards, one-time RSA signing, rollback, lease takeover,
stale-owner refusal, atomic app change/receipt, safe cancelled-revoke closure,
and a real coordinator resolve step. Native readbacks in this PG fixture are
explicitly synthetic. The worker adapter's eight PostgreSQL groups and reviewed
Gmail persistence's 19 checks also passed with migration 0377 installed but
native publication disabled.

Final review also found routine member metadata updates and local Email-module
changes could invalidate a transition after its native revoke committed. The
migration now pins the actual full-member preimages, bound workspace demo flag,
and known native-Email identity/eligibility while a transition is active. It
does not pin message body or unrelated content. Mutating staging/recovery,
participant enrichment, lead conversion and opportunity-comment transactions
take the control lock before source/advisory/authority locks. Nine focused
actual-function ordering checks passed, and the real PostgreSQL fixture covers
same-role UPSERT refusal, known-Email identity/eligibility refusal and allowed
content/normal metadata writes. Native publication/CRM production state remains
unchanged by these fixtures.

After the source-entry corrections, lint passed with only the three existing
navigation warnings, the complete focused publication group passed, the actual
routing/staging PostgreSQL suite passed 34 checks, and `verify:predeploy` passed
including its strict production build. The reviewed-Gmail 19 and worker eight
PostgreSQL checks were rerun against the final migration guards and passed.
These are local release checks, not a completed live correction or recovery.

The complete native candidate subsequently passed
`native-authority-approval-2026-10-30-r17.json`, including real authenticated
SuiteCRM HTTP, raw Email projection, rollback/concurrency, eight native
authority-transition checks, seven authority HTTP checks and 32 TS/PHP
capability-parity vectors. The app-side RSA issuer's actual signatures were
verified by PHP. These tests use disposable native records and synthetic
app-commit evidence; they do not establish an end-to-end production bridge or
production-sized timing. The strict application production build passed after
the signed approval, expiry-recovery and PostgreSQL adapter additions.

An expired, never-provisioned revoke cannot be resolved from time or a missing
row. The explicit `cancel-expired` native path accepts only the original signed
expired revoke proof, authenticates the current dedicated service, and commits
retained proof plus an exact terminal cancellation together. If the operation
already committed, it returns that committed result instead. It never renews a
proof or changes permissions/content. PostgreSQL still requires authenticated
readback, an owned resolution lease, the retained cancellation receipt and
unchanged app authority before closing the barrier. A cancelled grant remains
held; it cannot use this pre-app-change abort path.

The next local continuation integrated the explicit v2 capability policy into
the actual publication command, preparation, native transaction, terminal
receipt, PostgreSQL candidate and settlement paths. Migration **0378** starts
with no policies and no activation; policy changes require disabled publication
and invalidate prior activation evidence. Its versioned receipt constraint
rejects missing/null/changed capability pins and mixed-version outcomes. A new
Email uses an independently reviewed future policy; an existing Email retains
its own verified edit/delete rights, never an inferred future default. V1
publication cannot downgrade a v2-bound pipeline.

`native-capability-publication-2026-10-30-r18.json` passed the complete isolated
SuiteCRM candidate, including **11 actual v2 publication cases** for preserved
editors, denied viewers/outsiders, historical repair, rollback, drift,
cancellation and historical resolution. The read-only
`verify-native-email-publication-receipt-parity.mjs` verified **40 checks**
against its actual PHP output using the production TypeScript preparation and
full projection/receipt validators (five committed and two cancelled outcomes,
three preparations). This is actual cross-language native receipt proof, not a
simultaneous app-worker/two-database or production recovery test.

The actual PostgreSQL worker fixture passed **14 groups** with migration 0378,
including create/update/cancellation settlement, immutable historical rights,
invalid SQL receipt rollback and policy mutation refusal. Native receipts and
the audience/enqueue callbacks in that PG fixture remain synthetic. The full
focused publication suite and lint also passed (zero errors, the same three
existing navigation warnings).

A fresh **2026-10-30 19:11 UTC** production read-only transaction confirmed the
same three cached messages and **zero** corresponding interactions. It rolled
back and performed no recovery. The live holds are still native publication
not enabled, shared-email schema not installed, and verified mailbox identity
unavailable. The private artifact is
`bpo-exact-recovery-20261030T191129728Z-eb1a16e3.json`.

The v2 membership-transition continuation now advances reviewed native identity
capabilities and binding policies atomically with each revoke/grant receipt.
PostgreSQL advances all installed policy generations in the same settlement
transaction; partial updates, policy substitution, enrollment/downgrade and
receipt-only settlement are refused. Existing publication baselines replay the
exact completed authority history without rewriting their original content
fingerprint or substituting future-create rights. Replay is bounded to 256
completed transitions and holds on missing history or a larger chain.

Root-run gates passed **12 legacy PostgreSQL authority checks**, **13 v2
PostgreSQL authority checks**, and **14 PostgreSQL worker groups**, plus the
focused publication suite and lint (the same three existing warnings). Native
receipts in the PG fixtures remain synthetic. The complete isolated native
candidate passed `native-capability-authority-2026-10-30-r19.json`, including
**8 actual v2 authority lifecycle cases** and **30 pure PHP authority vectors**.
Actual PHP output passed **40 publication** and **47 authority** TypeScript
receipt checks; the latter includes a real same-transition revoke/grant chain,
non-null capability policy, cancellation and replay.

The separate r19 scale probe covered **318 enrolled Emails and 12 native
principals**. It exceeded the unchanged five-second commit deadline at about
6.50 seconds and proved full rollback (`deadline_held`). This is a performance
release hold, **not** a passing production-scale result. These local checks do
not establish a simultaneous app-worker/two-database production bridge.

Final continuation evidence is
`native-capability-authority-2026-10-30-r21.json`: all native functional stages,
**10 v2 authority cases**, **40 publication receipt** and **47 authority receipt**
cross-language checks passed. The retained optimization batches exact native
identity/link locks while preserving missing/duplicate-row refusal. A proposed
Email/session reuse optimization regressed the r20 scale test and was reverted;
the final executor again uses the original user-outer, fresh-Email native ACL
loop. Every principal and all five permission checks remain covered.

The final r21 scale probe still rolled back at the unchanged five-second
deadline: **318 Emails, 12 principals, 6095.24 ms, `deadline_held`**. The larger
12-principal fixture is not a timing measurement of the four-principal live
system, and no production-scale pass is claimed. Both native fixture containers
were removed by owner-checked cleanup. The full predeploy gate, including the
strict application build, passed after the v2 TS/PostgreSQL changes. Production
activation and email recovery remain blocked below.

A **2026-10-30 19:21 UTC** read-only live check found production health and
persistence healthy on release `b61192200b6d990adb320fd7f941a619976bc4af`.
No candidate deployment or live recovery was performed.

**Historical release hold (superseded by the dated checkpoints below).** The
following three-item assessment describes that earlier code/three-message
selection, not the current implementation inventory or recovery count. The
release remains unapproved, but current remaining gates and the reviewed
five-message selection are recorded in the latest checkpoint below.

1. Wire the supported authority coordinator into real user-management paths.
   The internal v2 transition is now tested, but `/api/workspaces` still calls
   direct SQL membership writers in `tenancy.ts`; no production caller uses
   the coordinator/issuer/authority client. Enabled authority guards are global
   across users, organization memberships, pipelines and pipeline membership.
   They would refuse ordinary onboarding/offboarding, permission, trash and
   login-email changes, including unrelated scopes. A newly created native user
   also changes the complete principal inventory; the current add/remove-only
   transition deliberately cannot repin that inventory. A BPO-only activation
   therefore is not genuinely isolated with this design. Safe refusal is not normal
   production lifecycle readiness. The enabled control cannot simply be
   toggled off again. Do not activate silently under an indefinite permission
   freeze or relax these guards. The current native transition also requires
   every managed binding to share its caller/owner and relies on existing native
   ACLs for editor rights. The PG unaffected-other-owner test is not native
   mixed-owner or editor-role-provisioning proof. General activation must not
   hide these limits behind a passing isolated test. Resolve the larger native
   inventory deadline hold without pruning principals or increasing the fence.
2. Rehearse the actual app worker and both databases together, including
   reviewed historical baseline adoption. A permission-only repair has no raw
   projection receipt; it cannot currently supply the baseline needed to
   resume content updates of a legacy Email. Do not substitute current native
   content or untrusted metadata for independently reviewed evidence. Prepare
   the exact historical native inventory/correction and independently reviewed
   legacy identity enrollment, drain old writers, provision the dedicated
   issuer/client, and verify installation/activation. The production SuiteCRM
   Docker/entrypoint installer currently packages only the audience verifier,
   not the prepared scope/publication/authority package and schemas. There is
   no non-test installer for reviewed bindings and activation. No runtime
   keys, client, new native route or permission policy was installed live.
3. Obtain the real verified mailbox identity/Maton binding and execute the
   exact three-message recovery with one Email per source, both reviewed
   companies and the verified contact/audience associations. Connector metadata
   is not a substitute for the required identity binding. The existing recovery
   preview/apply route is exact-message scoped; the broad outbox processor is
   not. Add or use a verified exact-identity publication claim, never `limit:3`
   as a substitute for the three selected messages.

No production permission, database record, mailbox cursor or email was changed
by these local gates. Do not describe the missing emails as recovered.
The operator approved expanding the work to complete normal user-access
integration before activation on 2026-10-30. This approval does not establish
that activation or live recovery has passed its technical gates.

### Approved user-access continuation (2026-10-30)

The deeper callsite audit corrected two overly broad statements above: app user
invitations do **not** create native SuiteCRM principals (identity sync finds an
existing native user), and verified login-email changes write a separate alias
table rather than changing the canonical app email. Migration 0379 therefore
allows provably independent, unmapped app-only account/membership changes while
retaining every native-mapped, pipeline-referenced and active-transition fence.
It never infers missing native bindings from an empty capability-policy table.

The native-enabled login bootstrap now creates/reuses the personal project
board, but only selects an **existing explicitly authorized** CRM pipeline. It
does not create a CRM pipeline, automatically grant editor access, or upgrade
an existing viewer. An account with no pipeline can sign in/use other modules;
the owner must explicitly arrange CRM access. Disabled-mode behavior is
unchanged. A nullable selected pipeline is intentional, not missing user data.

The existing pipeline-sharing functions now call an actual server-side
native-first member add/remove driver. It derives a plan from authenticated
native inspection plus a locked PG authority preview, uses a rollback-only
native policy forecast, signs only durable authorized plans, and includes the
permission-sync job and audit event in the app-change transaction. The enabled
path never falls back to the legacy SQL writer. This began as an add/remove
slice for already mapped native principals. The later mapped-user integration
below extends status/trash/access changes; retained pipeline-member role
changes, native principal enrollment, identity metadata changes and new native
write-role provisioning remain explicit release gates.

An owner-only exact-message publication preview/apply path was added at
`/api/crm/email-publication`. It binds the verified selected mailbox, exact
canonical message IDs, workspace/pipeline, payload/source/audience and policy
to an approval digest. It does not run global queue resume, reclaim unrelated
leases, substitute `limit:3`, or fall back to the legacy native Email writer.
This is a local operator implementation, not evidence that the three BPO
messages have been recovered or published.

Current local evidence for this continuation:

- Nine actual PostgreSQL app-only lifecycle/fence groups passed, including
  concurrency, cascade rollback, mapped-user refusal and unchanged policy pins.
- Actual user lifecycle and invitation-acceptance functions passed under a
  synthetic enabled control. Login bootstrap retained an existing viewer and
  returned no pipeline for an unshared user without implicitly granting CRM.
- Fifteen PostgreSQL v1 and seventeen v2 authority/ledger groups passed after
  0380, including concurrent append-only grant attempts, rejection of unknown
  outcomes as cancellation, and historical capability replay through the
  successful retry rather than its retained cancelled original.
- Seven actual PostgreSQL exact-publication groups passed, including concurrent
  claims, complete-batch refusal, tenant boundaries and idempotent success skip.
- Fourteen actual PostgreSQL publication-adapter groups passed with 0380/0381;
  this uses synthetic native receipts, not simultaneous two-database execution.
- Ten actual PostgreSQL identity-quiescence groups passed, including both
  concurrent activation/claim orders, exact dispatch claims, and refusal to
  activate over queued/failed/processing/dead native identity work.
- Native r23 artifact `native-user-lifecycle-2026-10-30-r23.json` passed the
  actual inspection/forecast HTTP checks and 14 v2 authority cases. Bounded
  ownership hydration matched independent full retrieval for large bodies,
  archived records and assigned/created-owner precedence. The 318-email/
  12-principal synthetic probe committed in **4025.94 ms**, below the unchanged
  five-second deadline. This is not production timing or a combined PG/native
  application-runtime rehearsal.
- The local production build and TypeScript check passed. Lint passed with
  three existing navigation warnings. The native publication/authority local
  gates passed, including eighteen runtime/planner mocked-I/O groups and
  actual TypeScript RSA grant-attempt signing. These are not live access proof.

Migration 0380 and the runtime/native grant-attempt protocol address the found
grant continuation gap: each retry has a fresh deterministic operation ID,
retains the exact cancelled predecessor and signed approval, and preserves the
original plan, revoke evidence, app receipt and final grant content. The old
operation cannot execute after cancellation. An ambiguous outcome must resolve
before retry, and TTL alone never releases the barrier. Subsequent publication
history uses the committed effective grant. Actual PG and local mocked-runtime
checks passed; r24 native execution reached the HTTP fixture but failed at
disabled-route discovery (404), before retry HTTP execution. The issuer's
eleven TS-to-PHP signing checks passed. Do not count r24 as a passing native
recovery rehearsal; its private failure artifact is retained.

Migration 0381 and claim/dispatch checks hold the legacy `upsert_user_identity`
worker whenever native Email policy is enabled. That worker changes native
Users rows included in the global policy fingerprint. Only that job type is
held; unrelated projections remain eligible. Activation also requires no
outstanding identity jobs. Queue completion is **not** proof that an earlier
timed-out native PATCH has stopped: offline/drained native activation and fresh
policy readback remain mandatory.

#### Mapped-user lifecycle implementation and evidence (2026-10-30)

The mapped-user runtime now routes scoped status, Trash/Restore, and module
access changes through typed native-first transitions. Intended pipeline
memberships remain intact. Effective access excludes inactive, trashed and
explicitly CRM-denied users without hiding missing or ambiguous identities.
Migration 0382 permits settings changes that cannot alter effective native
rights. Migration 0383 adds immutable exact user/membership deltas and requires
the native revocation receipt before the app commit. Scoped session revocation
and the audit event run in that same PostgreSQL transaction.

Restoration uses the latest actual committed eligibility revocation and its
retained effective grant/revoke receipts, exact native identity and unchanged
pipeline intent. It restores the user's original per-Email edit/delete subsets,
preserves other users' current rights and does not invent historical write
access on Emails created during suspension. Parent-organization management is
checked against the actor's active workspace and a pinned target-to-source
ancestry path. A different active actor scope cannot silently resume the plan.

Validated so far in this continuation:

- Eight actual PostgreSQL mapped-settings groups passed: defaults/module
  settings, malformed/ambiguous identity refusal, control-first serialization
  and frozen snapshots during active transitions.
- Eleven local workspace-user runtime/route groups passed with mocked store and
  provider I/O; these cover exact scope, resumable errors, scoped session/audit
  effects, alternate demo workspace IDs and no legacy fallthrough on failures.
- Native artifact `native-user-lifecycle-2026-10-30-r28.json` passed **23** real
  v2 authority cases, including authenticated and independently signed
  cross-owner revoke/restore, repeated grant expiry and lost-response recovery.
  The synthetic 318-Email/12-principal probe committed in **4035.56 ms** under
  the unchanged five-second deadline. Native publication remains owner-only;
  service-level transition authority does not change Email ownership.
- The r28 artifact passed **119** TypeScript/native authority receipt checks
  and **40** publication receipt checks. The actual TypeScript planner also
  accepted its recorded native inspection/forecast; this is not a combined
  live PostgreSQL/native application-runtime rehearsal or production proof.

The later actual PostgreSQL lifecycle gate passed after the parent-manager and
invitation changes, including exact-postimage rollback that preserves an
intervening Trash operation. The separate enabled invitation gate passed
scope-reduction/delivery races and exact-set acceptance. The user-eligibility
database gate passed 24 groups (17 baseline authority groups plus seven mapped
eligibility groups). Pending-change recovery passed nine mocked query/runtime
groups; the real React/MUI Playwright fixture passed clean-form resume, reload,
retry and Trash recovery with mocked APIs. The local production build and
TypeScript check passed; lint had zero errors and the same three existing
navigation warnings. These are separate proofs, not combined production proof.
The older r24 failure above is historical evidence, not the current native
result. No production principal, role, Email or policy was changed by r28.

Remaining activation limits are explicit: first native enrollment, identity
metadata changes, new pipeline enrollment, retained pipeline-member role edits,
owner transfer, and restoration without retained provenance are held rather
than granted by inference. Production packaging does not yet install the
opt-in native authority/publication routes, schemas, scope patch and reviewed
bindings/issuer identity. Historical legacy-Email adoption and a combined
application-runtime rehearsal also remain release gates. These are not
bypasses to be removed or proof that the missing emails were recovered.

The later read-only production collector
`bpo-exact-recovery-20261030T234539301Z-eaf1f0a9.json` still holds on native
publication not enabled, missing shared-email schema and unverified mailbox
identity. No activation, production change, deployment or email recovery was
performed during this continuation.

### CRM Account/Contact deletion continuation (2026-10-30)

The reported Suburbia Globus record `ga6i0qmt2qudss` is a different binding from
BPO Globus `gagmco24va588e`. No production record has been removed in this pass.
The cause was confirmed in source: incoming Account/Contact tombstones were
ignored, while local archive actions excluded those two entities.

Local implementation now includes:

- An exact-record Trash action for ordinary organizations/contacts, with editor
  permission and same-origin enforcement. Workspace and login-backed identities
  remain managed through Settings. Account deletion never infers contact deletion
  or removes retained email/meeting history. While native lifecycle support is
  disabled, this action returns a clear 409 without changing local records.
- Sticky local tombstones across explicit IDs, source/identity keys and contact
  aliases; active lists/counts, workbook and board projections and reference-link
  rebuilds omit deleted records. Outgoing provider dispatch serializes against
  local archive/import; stale payloads cannot publish or mark newer revisions
  synced. Board editing takes the same lifecycle lock before card/source locks.
- A bounded, independent scan of at most 100 **known local bindings** per run,
  not a provider-wide backfill or reset of the modified-time import cursor.
  Only exact native ID plus Global ID and positive deletion evidence can archive.
  Missing/404, permission errors, mismatches, duplicate bindings and managed
  identities are held. Both incoming deletion paths default off.
- A separate read-only native inspection endpoint and installer. Outgoing
  Account/Contact deletion first verifies its exact binding and then requires
  positive native deleted readback; HTTP 404 is never success proof. The
  Docker image packages the route, but entrypoint installs it only when
  `CLAWPILOT_NATIVE_RECORD_LIFECYCLE_ENABLED=1`. Runtime opt-in is required in
  **both app and SuiteCRM**; no production flag was changed. Native Email
  authority/publication activation remains separate and unresolved above.

Evidence: the focused local lifecycle gate covers browser UI, six route groups,
ten actual-function/SQL-model groups, eight reconciliation groups and nine
fake-HTTP/native-source groups. A separate actual PostgreSQL fixture passed
provider/archive serialization, no tenant/contact cascade, sticky local/source/
alias imports, exact completion/newer-revision fencing, protected identities and bounded scan/cursor SQL. Native provider
evidence in that fixture is mocked. PHP command/installer tests passed in an
isolated PHP 8.3 container. Seven actual mysqli checks also passed against seven
synthetic SuiteCRM-shaped tables in a disposable MariaDB: token/client/subject/
admin fencing, exact active/deleted/missing output, batch refusal, the 100-row
bound, transactional table requirements and caller-transaction ownership.
This does not exercise SuiteCRM's real OAuth HTTP middleware or SugarBean.
These are not signed-in production or live native
deletion proofs. The older full leads/campaigns HTTP fixture could not become
ready because its synthetic hosted runtime lacked required configuration and
current migrations; it is not counted as passing acceptance for this change.

Before activation: validate native runtime inspection on the pinned SuiteCRM,
deploy both services through the reviewed release path, enable the explicitly
reviewed flags, then verify the reported exact Suburbia account/contact bindings
and BPO isolation. Preserve tombstones and audit history on rollback; never clear
archive flags, reset mailbox cursors, infer deletions by name, or auto-recreate
native rows to make a synchronization error disappear.

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

## November 2 resource-owner sharing and exact recovery checkpoint

The local native-first sharing path now authorizes the **current pipeline
owner**, rather than requiring that person also to own the workspace. Active
member/admin pipeline owners retain their ordinary sharing workflow. The same
canonical eligibility helper still requires active, untrashed CRM access and
one verified native identity; a workspace administrator who does not own the
pipeline cannot share it through this path. The PostgreSQL adapter independently
rechecks the complete scope at admission and app commit. Pending-change discovery
uses the same resource-owner scope, and sharing never promotes the person's
workspace role. `npm run test:native-email-resource-owners-postgres` passed both
20-check member-owner and admin-owner runs, including actual pending discovery,
outsider denial, native-first ordering, rollback, retry and retained-role edits.
The 34-check user-eligibility PostgreSQL suite and production build also passed.
Native transport/receipts in those PostgreSQL tests are simulated; this does
not close the combined real app/PostgreSQL/native rehearsal gate above.

The SELECT-only production observation at `2026-11-02T20:20:15.859Z` inspected
exactly the original three reviewed messages plus Casey's
`1a18e03ea586cd7e` and `1a18f01749eb87a6`, all in the reviewed thread
`1a179e9e2743f926`. All five cached messages were present, had no message-level
mapping holds, and had zero existing interactions. The transaction was read-only
and rolled back. Shared-email schema, verified mailbox identity, and enabled
native publication were still missing; no recovery, schema, permission, cursor,
provider, or deployment change occurred. The observation is not provider freshness
or native ACL proof. Its private receipt SHA-256 is
`a74ba6f5e102ec4bb6080871fce2e6c56105eb5e64bf1c1cf78d5bf10671ab38`.
The collector now includes all five exact IDs and matches canonical explicit
app-only (`NULL` mapping plus numeric zero matches) eligibility; it still refuses
missing, malformed or ambiguous native mappings. Eleven collector parity and
scope checks passed locally. Do not infer that either the schema or native
permission activation has been approved by this observation.

### Combined sharing proof, November 2 at 21:29 UTC

`output/local-validation/native-app-pg-20261102-r9.json`, SHA-256
`f9389252adf57bdee9296426cf990223027ccbe38451e787c920196808fbd53b`,
passed the complete pinned native gate and a new **combined sharing** rehearsal.
The actual TypeScript sharing coordinator, planner, PostgreSQL adapter, RSA
issuer and transport drove real native OAuth and HTTP inspection, forecast,
approval, revoke and grant routes. Viewer-to-editor promotion and demotion
committed four real native phases with matching app generations/policy pins;
demotion preserved reads and removed historical writes. Repeating the completed
request made no extra native call or fixture audit/sync write. Native content,
ownership and unrelated role metadata stayed unchanged. All 18 combined HTTP
requests succeeded. The receipt pins 59 candidate files and 28 fixture files;
post-run verification found zero drift. Both native 318-Email/12-principal scale
phases also committed under the unchanged five-second limit (4873.40 ms revoke,
4686.85 ms grant). **Production scale remains unproven.**

This closes the separated app/PG/native proof gap for that successful sharing
cycle, not for every workflow. The downstream permission-sync/audit sinks use
fixture tables; there is no signed-in app/browser or production proof here.
Combined lost-response recovery, user-lifecycle and Email publication acceptance,
reviewed historical adoption, exact BPO recovery, and native package/activation
approval remain separate work. The earlier r8 demotion returned a generic 409;
that attempt did not have an internal hold-code log, so its exact cause is not
established by the later passing run. Do not relabel it a success or claim the
new logger fixed its cause.

The disposable orchestration acquires one normal guarded PostgreSQL lease first.
PostgreSQL uses 256 MiB tmpfs/512 MiB memory/0.5 CPU and an ephemeral **127.0.0.1**
port on Docker's default bridge; native MariaDB and PHP remain on an internal,
unpublished network, with their existing 640/1152 MiB and 0.5/1 CPU ceilings.
No extra swap, provider connection or production credential is used. Actual
native HTTP runs on container loopback through a bounded stdin tunnel. The
receipt therefore reports the entire workload as not fully network-isolated,
while explicitly recording the native network's isolation and PG's loopback-only
endpoint. All owned test containers were absent after cleanup; unrelated
BuildKit data was preserved. A transient disk-floor refusal stopped one attempt
before startup; the read-only audit and subsequent guard observed recovery above
15 GiB without deletion or threshold overrides.

Fast preparatory gates are `test:native-email-app-fixture` (pure legacy-role
baseline checks), `test:native-email-app-harness` (PHP CLI scope/configuration and
sanitized logging with framework stand-ins), and
`test:native-email-app-enrollment-postgres` (actual generation/policy guards and
atomic rollback against synthetic metadata). They do not replace the combined
native gate. Run that gate with:

```sh
npm run test:native-email-app-postgres -- \
  --source-zip=/absolute/path/SuiteCRM-8.10.1.zip \
  --output=/absolute/private/new-receipt.json
```

Native authority routes now log only a bounded internal hold code under
`CLAWPILOT_NATIVE_AUTHORITY_HELD`; unexpected errors use a generic code. Public
responses remain the same generic 409. No exception text, SQL, identity,
command, proof, token or email content is logged by this change. The actual PHP
catch/logging contract and full native HTTP gate passed with these bytes.

### Shared Shopify health compatibility checkpoint, November 2, 2026

The full local regression run found that prepared migration `0375` adds three
native authority triggers to `app_user_organization_memberships`, a table also
covered by Shopify's complete-trigger health inventory. Migration `0383` adds
the trash-metadata statement guard. Neither change alters the Shopify guards;
the old health catalog nevertheless rejected these legitimate additions.

The local health candidate now pins the exact `0375` and `0383` migration
checksums and their complete trigger-catalog phases, retaining every existing
function/schema/index/trigger check. There are no trigger-name exclusions or
prefix allowlists. A scratch-only catalog inspector collected the phases;
its diagnostic output is not acceptance. Actual PostgreSQL acceptance then
passed every intervening migration and the existing tamper suite, plus disabled
native guards, missing trash guards, forged phase checksums and a missing
admission prerequisite. Legacy checksum-fallthrough tests reconstruct the old
catalog only within rolled-back disposable transactions, including hiding the
later native phase journal rows and removing their later triggers.

No production migration, trigger, permission, record or deployment changed.
The earlier full root test attempts remain failed; a completed targeted repair
does not turn those attempts into a passing clean root-suite receipt.

The native candidate also reuses prepared SQL statements for historical
capability identity/permission writes. Each row is still independently rebound
and checked in the same transaction, complete readback remains mandatory, and
native ACL checks, row caps and the five-second deadline are unchanged. PHP
syntax and TS/PHP retained-role command contracts pass. The completed r11
acceptance receipt verifies all 59 candidate hashes without drift and six real
application/PostgreSQL/native coordinator checks, including lost-grant-response
recovery after the owned lease expires, no repeated app mutation/audit, and a
fresh demotion restoring matching app/native viewer rights. Both 318-email,
12-principal scale phases committed inside the unchanged five-second deadline
(4523.05 ms revoke / 4583.25 ms grant). This is disposable local proof, not
browser, provider-mailbox or production-scale acceptance. All owned containers
were absent on readback. Older r9/r10 evidence remains historical. Later SQL
enrollment changes require their own current acceptance and are not certified
by the r11 source manifest.

### Unshared-workspace admission and regression checkpoint, November 2, 2026

Prepared migration `0391` permits a new ordinary member membership for an
already mapped active user only when that real workspace contains no intended
pipeline membership or ownership for the user. It grants no pipeline or board,
remaps no identity, and leaves the existing native policy pins unchanged.
Every other branch of the existing authority row guard is source-compared
against `0383`; an active transition still freezes independent enrollment.
The normal Add organization access transaction now rechecks live actor and
target-management scope after acquiring the common control lock.

Twenty-one actual PostgreSQL employee/enrollment groups passed, including the
pre-migration refusal, unchanged migration state/audiences, the actual app
addition, duplicate request, sharing/remapping/owner/demo refusals, audit rollback
and a stale trashed administrator. A fresh 34-group coordinator/ledger/RSA
PostgreSQL run includes `0391` and proves that enrollment cannot bypass an
already admitted transition. Its native forecasts/receipts are synthetic.
The combined real-native fixture now applies and hashes `0391`, but has not yet
been rerun for those later fixture bytes. The r11 native proof above is retained
as source-scoped evidence, not certification of the newer SQL/fixture candidate.

The signed-in disposable CRM lifecycle API/mobile-browser run passes with a
synthetic canonically named native identity. Same-origin archive succeeds;
cross-site archive is rejected without removing the record. Calendar discovery
passes 85 actual PostgreSQL checks through the complete migration chain, with
provider responses mocked. Sales/all reporting, shared-company uniqueness,
legacy association fallback, archive/time boundaries and tenant isolation pass
actual PostgreSQL, authenticated-route and React/MUI checks. Lint, build and
predeploy passed for the current app source. None is real mailbox recovery,
Drive provisioning, provider calendar round-trip or production proof.

The ordered standard-suite continuation reached the production-cutover schema
attestation and remains **failed**, not a clean `npm test` pass. Its frozen v9
catalog includes `app_users`/workspace guards and does not yet enroll the newer
native authority, identity-retention and customer-folder dependencies. Do not
bump a hash or omit triggers to make it green. The scratch-only inspector
`scripts/inspect-crm-rebind-catalog.mjs` records each exact migration delta and
asserts that its pre-native catalog equals frozen v9 before collecting later
changes. It performs no target rebind and grants no attestation acceptance.
Ignored `crm-rebind-catalog-20261102-r25.jsonl` has the valid PostgreSQL 16
diagnostic; r24 used a different ledger column order and is not comparable to
the production-runner catalog. A reviewed forward attestation, both-major
tamper tests and a clean full suite remain required. Helper functions called
inside the new guards must be included explicitly where the catalog cannot
derive their PL/pgSQL dependencies; a source checksum alone is not runtime
function-body tamper proof.

Automatic root-employee scope grants and their coordinated runtime revocation remain
unimplemented. A later source/provenance contract checkpoint is recorded below;
it is not runtime authority. The existing CRM-employee identity toggle and mutable default
workspace are not safe substitutes for a stable, explicit account-wide access
grant: `0385` deliberately keeps identity changes independent of reader rights,
and `0382` treats default-workspace settings as audience-independent. Any root
scope integration must retain those distinctions, pin a stable reviewed account
anchor, and revoke inherited readers before changing the source authorization.
No hosted schema, native permission, live email, user membership or deployment
was changed by this checkpoint. Fractional's folder sender and provider-level
folder/calendar acceptance are also still required.

### Root-employee source/provenance contract checkpoint, November 2, 2026

The local candidate now contains `rootEmployeeCrmAccess.ts` and its regression
test. A root employee requires a separate explicit durable operator-account
anchor/access grant, active source-root membership with CRM access, current
operator ownership and exact operator business-workspace bindings. A mutable
default workspace, `crm_user_enabled`, shared domain or global administrator
role is never substituted. The output is viewer intent for workspace, pipeline
and registered managed-CRM-board resources only. Private Project boards,
disabled pipelines, foreign anchors, demos and explicit target denials are not
included. App-only users do not acquire a native identity; mapped users require
exactly one existing identity.

The companion edge planner records attachment/removal of the selected grant's
provenance. It removes effective inherited reads only when no independently
proven manual or other-source grant remains. It never promotes a user to owner
or editor, guesses that a changed row is a manual grant, or deletes another
source's provenance. Malformed/inconsistent input fails closed.

Nine pure groups/59 cases pass in
`output/local-validation/root-employee-contract-20261102-r69.log` and are now
included in `test:native-email-authority`. That full contract suite passes in
`crm-root-access-authority-contracts-20261102-r71.log`; full lint passes with
the same three existing navigation warnings in r70, and production build/full
TypeScript pass in `crm-root-access-build-20261102-r72.log`.

**These functions are not wired into authorization and create no grants.** A
complete locked source collector/registry, exact native-first multi-resource
app delta, normal source-eligibility lifecycle integration, persistent
membership/session handling, organization/pipeline selection and managed-card
runtime acceptance remain required. Native revocation must settle before the
source authorization changes; manual grants must remain independently proven.
Do not activate native policy or claim root-employee visibility from this pure
contract. The fresh whole `npm test` run is recorded separately as r73 and is
not a pass until its terminal result is inspected.

### Whole baseline passed; root registry remains an unreleased extension

The owned r73 `npm test` process terminated successfully. It includes the later
61-case root source contract, actual PostgreSQL 16/18 upgrade portability and
123 semantic catalog/ledger tamper refusals on each major, final lock checks,
provider-rebind fixtures, full-schema retirement and the docs catalog. The
r77 predeploy process also terminated successfully, including production build
and TypeScript. These are local **through-0391 baseline** receipts, not native
permission activation, production recovery or deployment proof.

The subsequent `0392` registry/collector extension is separate. It creates only
empty, private, revisioned operator/business-workspace/employee intent records,
with immutable source identities and common control-first write/read fencing.
`root-employee-registry-postgres-20261102-r88.log` passes the 61 pure cases and
nine actual full-migration PostgreSQL groups: exact peer-root/managed-card source
collection, no implicit membership/outbox changes, tenant/owner/admin boundary,
revision/history/source constraints, target denial, source suspension, lock
contention and refusal of every intent mutation under synthetic enabled native
policy. r78 is retained as a fixture parameter-type failure; it was corrected
before r79/r81/r84/r88. The actual source collector is still private/unwired and the
root native-first delta, provenance materialization and lifecycle/UI integration
remain incomplete. Do not substitute its preview for runtime authorization.

The v10 catalog is not certification of the later root registry: before release,
enroll the final root schema, helper bodies, triggers, privileges and exact
migration ledger in a forward verifier and rerun both-major semantic/tamper
acceptance. Do not omit new FK/guard dependencies or merely replace a digest.

The production exact-five-email inventory refresh at
`2026-11-03T03:05:50.791Z` failed **before any query**, at TLS connection setup
with `SELF_SIGNED_CERT_IN_CHAIN`. Receipt SHA-256
`08762df04c045cdffd453ffc1858d07bf62a43d004684372643bd73745a4e05f`
is in the private native-policy artifact directory. It proves neither current
email absence nor a database outage. No recovery/publication, TLS setting or
production row was changed, and insecure diagnostic fallback was not used.

### Computed root CRM session/read integration, November 3, 2026

The later local `0393` slice now uses the explicit root registry in real
workspace resolution, session issuance/switching and pipeline/managed-card
reads. It preserves the original actual-membership session FK: a delegated
CRM target is separate from the real source membership. There are no physical
reader shares to confuse with independent manual owner/editor permissions.
Module denial is checked before resource provisioning. Source/target intent
revocation kills delegated tokens; restoration never revives them. A statement
control lock fences even a direct SQL session writer before row locking.

`root-employee-read-runtime-20261103-r102.log` passes the pure 61 cases and 22
actual full-migration PostgreSQL 16 registry/session/resource groups. r93 is a
retained failed reproduction of denied-module fallback provisioning; the module
check fixed it before r95/r98/r102. Session/workspace contracts pass r97/r100;
production-source types and build pass r94/r101. The same 22 runtime groups pass
on PostgreSQL 18 in r103; ordinary Trash/Restore/login-address and employee
identity/access regression pass r105. Lint passes r99 with the three existing
navigation warnings, not new errors. r92 used the broad test-inclusive
tsconfig and failed on existing test typing/import-extension errors; it is not
a passing type receipt. The build uses the actual production-source config.

This does **not** certify native-enabled root access, user-management root-intent
enrollment, browser behavior, the final schema attestation, or production. Root
inheritance is held while native policy/operations are active until the native
audience integration is complete; do not activate it and claim the requirement
done. The full current-candidate suite, native acceptance, exact email recovery,
real calendar/provider edit checks, combined folder publication, final candidate
evidence and dev-to-main deployment remain open. No production mutation occurred.

### Current root runtime and exact BPO inspection, November 3, 2026

The post-r109 lock review removed control acquisition from denial-only session
revocation (credential workflows may already hold a user lock), forbids token
un-revocation, and takes control before support-mode user reads. Current r117
passes 24 actual root registry/session/resource groups on PostgreSQL **16 and
18**, including support-mode entry/exit and both grant/revocation lock races.
Current production-source types pass r113. Normal lifecycle and the 21-group
employee identity regression pass r123; the separate synthetic enabled-native
app-only profile passes r124. r101 is an earlier build, not final current-source
release proof. No native-root audience integration or release gate is waived.

The r112 attempt was refused before a database container started at 11.32 GiB
free. Report-only storage audit r115 found a still-lower transient minimum;
headroom subsequently recovered above 25 GiB without deleting any files, and
r117 ran normally. No floor override, Docker prune or unrelated builder cleanup
was performed. The transient disk cause is not established as fixed.

The exact-five production metadata inspection is now unblocked **without
disabling TLS verification**. Authenticated Railway SSH to the exact production
Postgres service identified its configured certificate and public CA. The
read-only runner validates the CA/leaf chain, dates, exact service scope and a
separately observed leaf fingerprint; its TLS connection verifies the chain,
the service certificate's `localhost` SAN and the exact pinned peer. URL SSL
options cannot replace that configuration. This is an explicit service pin for
this bounded diagnostic, not a general app hostname-validation exception.
The unused insecure public diagnostic fallback was removed. Synthetic X.509
and actual loopback TLS acceptance pass r120; all 12 existing collector checks
pass r121. No production TLS configuration or credentials were changed.

The successful read-only/rolled-back production snapshot is
`2026-11-03T11:35:03.866874Z`, app commit
`9b77b55970b1be7a0407f5b3d8f624c7f467543d`. Private receipt SHA-256:
`629febc52c527a3fbd0cc69dba647bee3af4535c936fbd995b93e1d1fd60e3a8`.
All **five** selected cache messages (including Casey's two Airspace messages)
are present, have header-derived association drafts without mapping holds,
have no cache interaction reference, and have **zero** matching CRM interactions.
The current intended/effective native audience is the single owner. Recovery
remains held: shared-email tables and native publication control/admission/work
are absent, and verified mailbox identity is unavailable. These are verified
schema/control prerequisites, not evidence that the messages were recovered.
No recovery, publication, cursor reset, mailbox replay, native activation, hosted
schema change or other production write occurred.
The collector now reports only whitelisted stage/runtime codes; twelve local
redaction/read-only checks pass in `bpo-readonly-diagnostics-20261102-r83.log`.
Obtain a trusted certificate path/identity before retrying that connection;
do not disable verification or treat the older successful inventory as fresh.

### Local v10 catalog acceptance checkpoint, November 2, 2026

The working candidate now enrolls the exact `0375`–`0391` migration checksums
and six explicitly called guard helpers in addition to the existing critical
relations, functions, privileges, indexes and triggers. The runtime verifier
has one fixed v10 inventory; the historical metadata reader is not an
attestation fallback. Unknown PostgreSQL majors and mismatched/missing objects
or ledger rows still fail closed.

The prior raw fingerprint included PostgreSQL's OID-suffixed internal FK trigger
names. Equivalent schemas in independently created databases therefore differed.
V10 canonicalizes only verified generated FK trigger name tokens, preserving
every other definition byte and complete FK descriptors: relations, ordered
columns/types/collations, equality operators, validation/enforcement, actions,
deferral, inheritance and backing index identity. Unexpected/user triggers,
missing or duplicate guards, and function text are not filtered or normalized
away. Sort keys are calculated once per row, not repeatedly per comparison.
Historical semantic projections are explicitly new v10 comparisons, not old
raw v6–v9 receipts. The diagnostic separately reconstructs and checks the old
byte-preserving v9 baseline before collecting the new descriptors.

`output/local-validation/crm-rebind-v10-semantic-acceptance-r41.log` records real
production-runner migrations on PostgreSQL 16 and 18, an independently created
second database on each major, the historical-prefix upgrade with different
generated trigger IDs, and **123 catalog/ledger tamper refusals per major**.
Both transaction-lock checks passed. The fixture stayed within 256 MiB tmpfs,
512 MiB memory and 0.5 CPU; idle first-database backends are closed before the
second-database check. R36's owned-container OOM and R38's malformed SQL tamper
fixture remain failed records; R39 was intentionally stopped for the sorter
optimization, not accepted as a passing run. All owned fixture containers were
cleaned up. The synthetic rollback-artifact gate passed 14 checks in r37; no
actual rollback artifact was built or certified from this dirty worktree.

Lint passed in r40 with three existing navigation warnings. Predeploy r40 was
refused at its disk floor; a later guarded r41 run, including its production
build, passed. No disk threshold was bypassed or data/cache deleted. The later
Fractional-new-customer BPO queue change is covered by r43's 77 actual PostgreSQL
assertions and the unchanged folder HTTP checks, but requires its own refreshed
lint/build/predeploy record. These checks do not constitute a clean full
`npm test`, root-employee integration, native activation, mailbox recovery,
provider folder/calendar acceptance or production deployment.

The refreshed r44 lint and predeploy gates, including production compilation
and TypeScript, passed after the new-account queue change. Lint still reports
the same three navigation warnings. The earlier r40 disk refusal and r36 OOM
remain historical failures; neither threshold was relaxed. R45 is an ignored
local subset checkpoint, not a final release or rollback certification.

### Root-native integration checkpoint, November 3, 2026 (not released)

Canonical Email publication and authority before/after snapshots now collect
the actual root registry/source inventory under control. Inherited readers do
not become physical target members or editors. Removing an explicit editor
while inheritance remains must retain reading and remove both historical and
future writes; the derived role witness is independently checked by the store.
The pure/runtime contracts pass r137/r138/r139 and the refreshed aggregate
authority gate r149. The 34-case actual PostgreSQL user/sharing lifecycle gate
passes r142. R141 was a failed test-module loader dependency, corrected by
loading the actual root modules rather than substituting an empty root audience.

Prepared `0394_crm_native_root_source_fences.sql` prevents the legacy unshared
enrollment/settings exceptions from changing root native authority outside an
exact transition. It covers denied target insertion, required-source removal,
operator-owner demotion and registered workspace type/parent/demo changes.
Native-independent settings and allowed target enrollment remain writable.
The full migration chain and 26 actual PostgreSQL 16 groups pass r143; this
does not prove actual native ACL execution. Current TypeScript and lint pass
r145/r146; lint retains three existing navigation warnings.

Full native candidate r144 is **failed**, not certified: its first combined
editor grant hit the unchanged five-second transaction commit deadline. The
owned isolated containers were cleaned up; no production change occurred.
The subsequent candidate avoids constructing a second identical native Email
for each framed edit/delete read check only when the existing fresh per-user
bean exactly matches the locked minimal database preimage. It re-enters native
view/list actions on that same bean; no ACL result or cross-user/stage bean is
cached. Ordinary UI/API beans retain independent hydration. The source/helper
pins are updated together and the framed path is compared against the full
fresh-per-user reference matrix. This change still requires its own passing
full native execution; the deadline is not relaxed.

R151 then stopped on the exact fixture-helper byte-parity check before the
candidate permission cases, because the mirrored reference helper had not yet
been updated. The mirror now contains identical candidate bytes and that check
also runs before expensive native startup. Neither failed run is accepted as
proof of the revised helper or the new root lifecycle cases.

R154 passed seven combined real-native sharing/recovery/root-editor-removal
cases, then held on a native commit deadline in the new root lifecycle case;
the aggregate run is failed. Bounded internal stage timings were added without
record/identity/credential data or any deadline/admission change. R155 again
passed seven combined cases and recorded native scale revoke/grant at
4963.706/4564.390 ms for 318 Emails and 12 principals. Its later transport loss
had no native deadline profile and the disposable app had exhausted the old
180-second aggregate handoff window. The expanded fixture now has a bounded
300-second handoff and 600-second parent lifetime, with an explicit expiry
marker. These are whole-suite budgets only; native transaction commits still
have the same five-second hard cap. R155 is not an aggregate pass.

**R156 is a complete passing native candidate receipt**, captured at
`2026-11-03T12:56:13.637Z` in
`output/local-validation/native-root-app-timed-20261103-r156.json`. All eight
actual app/PostgreSQL/OAuth/native-route cases passed, including removal of an
editor share while root reading remains, and native-first source-root CRM
denial/restoration with independent organization membership retained. No manual
viewer share was created. The original full native fixture also passed its
318-Email/12-principal scale revoke and grant at 4671.365/4661.373 ms, below the
unchanged five-second cap. Exact source/image/fixture hashes are recorded and
65 candidate-source files were rechecked unchanged at completion. All owned
app/MariaDB/PostgreSQL containers were removed; the unrelated buildkit container
was preserved. This does not certify browser/provider/production behavior or
activate the still-held normal registry/identity enrollment workflows.

R157 passes the 61 pure source/provenance cases and all 26 actual full-migration
runtime groups on **PostgreSQL 16 and 18**, including direct source-statement
lock ordering. Canonical exact-publication SQL acceptance passes seven groups
in r160 and mapped-settings/audience SQL acceptance passes eight in r162.
R158/r159 pass the harness and bounded internal-diagnostic contracts. Current
production compilation and TypeScript pass r163. These refreshed gates do not
upgrade the earlier whole-suite/v10 schema receipts into final release proof.
The refreshed `npm run verify:predeploy` also passes r164, including its build;
it does not replace current full-suite, forward catalog-attestation, browser or
provider acceptance. No push, hosted schema/native activation or email recovery
was executed by these local gates.

Native-on computed app reads, ordinary registry enrollment and first existing
native-identity linking remain held pending exact integration. Forward schema
attestation must include `0392`–`0394`; the through-`0391` v10 receipt is not a
current candidate receipt. The five-message recovery, browser/provider calendar
proof, final full release gates and production promotion remain outstanding.

### First existing-account identity proof and source planning, November 3, 2026

R172 (`native-identity-metadata-20261103-r172.json`) is a passing real native
candidate run, including the combined PostgreSQL/OAuth/native-route cases. Its
new identity check uses the real InnoDB `Users`/`Users_cstm` metadata: exact
canonical username and issued Global ID, case-folded duplicate rejection,
complete locked index coverage, an independent connection's duplicate-insert
lock refusal, and in-pass metadata drift detection. Its fixture-only metadata
mutations roll back. No native account is created, renamed or linked by this
proof. The five-second native transaction cap is unchanged. R172's source
freeze predates the following app-source/planner edits and is not final
whole-candidate acceptance.

The local `user_identity_link_v1` contract restricts a first local mapping to
NULL native ID/username becoming one exact existing native ID and the user's
unchanged issued Global ID as username. Status, role, permissions, default
workspace and every real membership stay unchanged. `previewUserIdentityLink`
now derives before/after authority from the actual locked source, complete
retained memberships/pipeline intent, actor authority and explicit ancestry.
It rejects an already claimed native ID. Root projections acquire only their
independent inherited viewer scope; a target CRM denial remains effective.
Only an independent, eligible retained manual editor share supplies editor
intent. It does not fabricate target memberships or native principals.

R175/R177 pass **28 full-migration registry/session/resource groups each on
PostgreSQL 16 and 18**, including the new first-link source projections. R176
passes 32 pure source-delta cases and three exact planner cases (root viewer,
manual editor, explicit denial). Both phase commands retain the same exact
identity witness; existing historical/future writer subsets stay unchanged.
R178 passes all 34 actual PostgreSQL user/sharing/ledger regression groups and
the refusal of identity hints on the existing action kinds. These tests do
not prove normal first-link execution: the admission path intentionally still
holds this new action until its SQL delta ledger, resumable normal-user runtime
and native managed-write-scope enrollment are integrated and tested together.

The app claim query also compares native IDs case-insensitively, matching the
native database's identity semantics instead of missing a retained mixed-case
mapping. R184/R186 pass the same 28 actual PostgreSQL 16/18 groups with this
additional collision case. The pure authority aggregate passes r182 and the
32-case/three-plan contract passes r188. TypeScript passes r179, lint passes
r181 with three existing warnings, and predeploy including the production
build passes r187. R185 was a refused overlapping disposable-DB lease, not an
application pass: the owned PG test completed and cleaned up normally before
the successful serial retry. No lease or disk threshold was bypassed.

No production permissions/schema, provider records, mailbox cursor or recovery
records were changed. R165 remains a historical checkpoint; it must not be
used as the exact release candidate for these later edits. The full objective,
including normal access/enrollment, native-on computed reads, forward catalog
attestation, five-message recovery, calendar/Drive round trips, final browser
and full-suite gates, dev-to-main promotion and production verification remains
open.

### Existing-native-user execution and forward catalog work, November 3, 2026

The first-link candidate now has its SQL `0395` exact user-row ledger, normal
user-sync coordinator, provider-independent pending recovery, and native
managed-write-scope enrollment. It links a verified **existing** native account;
it does not create or rename one, change membership/role/status, or grant an
inherited root viewer editor rights. Sessions for the linked app identity are
revoked in the same app transaction as its mapping and audit effects.

The first real combined run exposed an accidental omission of `0384`'s exact
retained-role snapshot exception from the new migration draft. It also needed
to retain `0391`'s independent enrollment exception. Both are restored, and
`test-native-email-identity-guard-continuity.mjs` compares their complete prior
bodies against the narrowly extended replacements. R214 passes that check;
r215 passes all **34 actual PostgreSQL user/sharing/ledger groups with `0395`
installed**, rather than certifying the older migration subset. R206 separately
passes **29 full-migration root/identity groups on PostgreSQL 18**. Their native
receipts are synthetic; they do not prove native execution.

R216's combined real-native run now passes the previously failing editor grant,
idempotent repeat, demotion, lost native grant response, lease-expiry receipt
resolution and fresh demotion. It then **fails** the next native grant at the
unchanged five-second transaction cap: commit recheck was **5256.735 ms**.
The failed artifact is retained; this is not complete combined acceptance and
does not certify the later normal identity-link case. No deadline or fixture
inventory was reduced. The performance candidate removes redundant recursive
matrix hashing and a duplicate first-action refresh while still forcing fresh
native actions for every principal/pass and evaluating every surface. R223
passes 96 actual PHP comparison vectors plus focused refresh-sequencing checks;
the full native timing/ACL gate must still pass against those exact new bytes.
R230 retests the optimized candidate and still fails the same grant-phase cap,
now at **5065.360 ms**. Its before/after ACL scans end at 2495.065/5009.479 ms;
the improvement is not a pass or adequate timing margin. Preserve both failed
receipts and profile the remaining scan cost before another native execution;
do not increase the deadline, reuse ACL decisions, reduce the tested inventory,
or repeat the unchanged run in hope of a different outcome.
Runtime and offline-installer helper pins change together with that candidate.

The forward **v11** attester now includes exact `0392`–`0395` migration bytes,
direct relation fingerprints for native ledgers, root registry/session sources
and customer-folder identities, plus the complete referenced helper bodies.
Historical metadata comparison retains its old relation inventory; it is not a
fallback. OLD/NEW row-trigger predicates use PostgreSQL's full trigger renderer,
because `pg_get_expr` cannot render expressions spanning both transition rows.
The v11 target digests are derived from separately migrated PostgreSQL 16/18
diagnostics r219/r220. R224 passes 120 PG16 tamper
cases before a test-only source/action FK selector bug; r227 reruns the full
suite after that selector correction and adds an actual WHEN-clause tamper
probe. **R227 passes all 154 tamper refusals and the final transaction-lock
check on each major**, including the OLD/NEW qualification probe and a second
database upgraded from the historical schema with different generated OIDs.
This certifies the local through-0395 v11 catalog, not a production database.

R225 lint passes with zero errors and three existing navigation warnings.
R226 predeploy is **not a pass**: the disposable database guard correctly
refused an overlapping test lease. Run predeploy serially after the owned
schema/native tests finish; never remove or bypass the live lease.

R228 passes the focused pure authority aggregate and r229 passes the bounded
framework/CLI harness. A subsequent UX review found first identity links were
not included in saved-change discovery even though the normal Sync button
could resume them. Discovery and the existing Resume action now include that
typed action, reveal only the same bounded owned metadata, and dispatch the
saved selection to the provider-independent receipt resumer. R233 passes all
12 recovery groups (mock query/runtime); r238 passes the actual React/MUI
desktop/mobile fixture including reload discovery and held/retry Resume for
an identity link (mock APIs). The combined native fixture r230 now exercises
that actual recovery module against PostgreSQL/native HTTP too, but the run
stops at the earlier timing hold and has not reached this ninth case. A terminal
pass of the full case remains required. No browser form can submit a new native identity to
this Resume path. The first-link success message also correctly says the
existing account was linked rather than claiming no local mapping changed.

R231 production build passed before this final discovery/UI change. R237 then
passes the exact `tsconfig.build.json` declared in `next.config.ts` for the
new source. The unscoped `tsconfig.json` diagnostic r236 is not a pass: it also
checks separate test-runner imports/fixtures and reports errors there. Do not
use its unrelated diagnostics as release-source proof or weaken either config;
the complete test-suite gate is still required. R239 subsequently passes serial
predeploy, including its PostgreSQL diagnostics/image-worker tests and a fresh
production build with the final recovery/UI source. R241 refreshes the pure
authority aggregate; r242 lint passes with the same three warnings; r243 passes
the expanded rendered UI case, including the truthful first-link success text.

The through-0391 v10 and r190 source checkpoints remain historical. Root
registry enrollment under enabled native policy and native-on computed app
reads, the exact five-message recovery, provider calendar/Drive round trips,
browser/full-suite/build acceptance and production promotion remain open.
No production schema/permission/recovery/provider write or push is represented
by these local results.

### Native prepared-query and bounded-write work, 2026-11-03 (unreleased)

R246's rollback-only actual-native profiler measured all 318 Emails, 12
principals and five actions. Fresh hydration was a small fraction of the full
scan; direct constructors were measured only, not substituted for native bean
creation. The optional prepared SecurityGroups query path retains one fresh
query per call and delegates ordinary requests, other modules and strict rights
to the pinned stock path. Its real-native regression changes a membership on
the same connection and requires the next call to observe both removal and
restoration; no ACL result or group decision is cached.

R251 failed at the independent lifecycle fixture's stale stock SecurityGroup
pin. That fixture now independently pins all six prepared stock outputs,
checks manifest values against those pins, and refuses symlinks. The new
`test-native-email-lifecycle-pins.mjs` source contract passes and is included
in the ordinary authority aggregate. This is not a substitute for the native
installer, ACL or timing gate.

R252 reached the combined fixture but failed an owner/reader selection
assertion before any combined transition. Bounded count-only diagnostics were
added; no assertion was waived. R255 independently selected one owned v2
scope with a real read-only member, then failed the first actual native grant
at **6330.960 ms**, including **1774.554 ms** between the memberships and
permission-row stages. Its rollback-only full scan measured 2037.938 ms and
18743 prepared executions. Those numbers do not prove a performance fix, a
passing transition, or completion of the later first-link/recovery case.

The new candidate batches identity CAS updates and independent permission
upserts into groups of 25. Every changed identity retains its exact binary
preimage and required affected-row count; a complete identity readback follows.
All independent permission preimages are validated before their upserts, and
a complete ordered readback verifies every matrix, source kind, operation ID
and full command hash. Inventory/principal coverage and the five-second
transaction cap are unchanged. R258 passes 14 actual MariaDB tests against
production DDL/helpers, including 318/500 rows, late CAS refusal, corrupt
independent permission preimages and rollback of all mutations. The test does
not claim authentication, native ACL, policy-fence or production proof. R256
was a test-container logging-option failure; r257 exposed a fixture using
text-protocol numeric types rather than the production prepared-read types.
R258 corrects those fixture issues without relaxing the production readback.

R253 was refused before native startup by the 15 GiB disk floor. The read-only
storage audit r254 deleted nothing. Available space later recovered alongside
lower OS swap usage, without cleanup or a guard override; r259 was admitted
above the 25 GiB warning threshold. R259 is the current full native/app-PG
candidate run. Its terminal result and source hashes must be inspected; this
entry does not count a live run as a pass. Root registry/native-on computed
reads, the exact five-message recovery, provider calendar/Drive round trips,
whole-release gates and production promotion remain open.

R259 subsequently terminated successfully. All **nine** combined actual-app,
PostgreSQL, native OAuth/HTTP cases passed, including root CRM denial/restore
and the normal first existing-account link with saved-change discovery,
lost-response Resume, no provider rediscovery, no duplicate grant/audit and
historical/future viewer-only rights. The separate native scale revoke and
grant committed at **3418.723 ms** and **4344.616 ms**, respectively, covering
318 Emails and 12 principals under the unchanged five-second cap. The real
fresh-membership/strict-rights prepared-query probe also passed. All 70
candidate and 28 fixture hashes were checked against current files after the
terminal receipt. R260 then passes the focused authority aggregate, including
the new independent lifecycle pin contract. No production/browser/provider
proof is implied: the combined fixture uses real coordinators/store/native
routes but fixture account discovery and audit/downstream sinks. Native-on
root intent enrollment and computed app reads remain separate unfinished work;
this passing existing-intent lifecycle case does not certify their completion.

### Receipt-bound computed root reads, 2026-11-03 (unreleased)

The forward `0396` candidate adds a private proof helper and a partial index
for committed native receipt lookup. It does not activate native policy,
create an operator account, bind a business or enroll any employee grant.
Existing explicit owner/source/target membership, status, demo, denial and
immutable-anchor checks remain. A mapped employee's computed business context
also requires exact current native execution proof for each visible pipeline:
control generation/fingerprint and retained phase receipt must match, the
binding must select that pipeline/workspace, and historical plus future
view/list/export matrices must include the employee. Duplicate native claims,
ambiguous/malformed proof and missing reads fail closed. A committed revoke
can preserve unaffected readers but cannot grant a new reader before the
exact native grant. Ordinary publication does not itself revoke root sessions.

R263/r264 pass 31 actual full-migration PostgreSQL 16/18 groups, including
enabled-policy delegated session switching, actual viewer-only resource access,
and rollback-only adversarial proof changes. R267/r268 refresh those groups
with explicit revoke-window checks: an unaffected native reader remains proved,
while a new account remains unproved even after its local mapping commits but
before native grant. Native receipts in these PostgreSQL cases are synthetic.
R265 separately passes the full actual-native candidate: all nine combined
app/PostgreSQL/native HTTP cases, now asserting computed root reads after
editor-share removal, denial/restoration and first-link receipt recovery.
Its 71 candidate hashes match the run; 318-Email/12-principal scale revoke/grant
committed at 3542.354/3719.450 ms under the unchanged five-second deadline.
No browser-layout or production/provider verification is claimed.

R269/r270 independently diagnose the complete v12 catalogs on PostgreSQL
16/18. Each exactly preserves its enrolled v11 digest immediately before
`0396`, then changes only one lookup index, the added proof helper and the
replaced root-read function. The reviewed v12 digests are respectively
`1f168c782a8b4debb70c9227d3f567196944d99ac7b1c037198b688f45a4774a`
and `2e30ee54c523693e2d4332e560ced93a669b3a5cd0839cc6b59bd75c4c543008`.
The attester/rollback floor now includes exact migration `0396`, its helper
body and index; r266 passes the synthetic rollback-source contract. R271
completed all 157 PostgreSQL 16 catalog/ledger tamper refusals, the final
transaction-lock check and the second-database historical/OID-portability
upgrade. Its PostgreSQL 18 launch was refused at 12.08 GiB by the disk floor;
that refusal was not a PostgreSQL 18 test result. R272 later completed the
same 157 PostgreSQL 18 tamper refusals, final transaction-lock check and
second-database historical/OID-portability upgrade without a disk override.

New root registry enrollment/binding changes under enabled native policy
remain correctly held, not bypassed. Their exact admission/apply/recovery and
normal user-management wiring are the next required implementation. The five
reviewed BPO/Casey recoveries, provider calendar/Drive round trips, full current
release gates, exact permission activation approval and dev-to-main/production
promotion remain outstanding. No live permission, schema, recovery, provider
write or push occurred in this slice.

### Exact root registry source previews, 2026-11-03 (unreleased)

R273 passes 33 strict proposed-change checks for immutable account, binding
and employee identities, canonical rows, explicit before/after images,
next-revision enabled toggles and exact root actor scope. This contract is
included in the focused authority aggregate. It is not native admission or
permission to write registry rows.

The new private registry preview reads actual owner/root membership and the
complete bounded account/binding/grant inventory under the existing control
lock. It overlays only exact proposed registry rows in SELECT statements.
New accounts/grants are disabled, explicitly absent identities in the before
projection, not temporary database records. Users, memberships, pipeline flags
and workspace metadata still come from actual SQL. The complete before/after
source and context fingerprint survive an exact app-stage replay and native
generation changes. Unchanged existing source/registry hashes retain their
ordinary collector representation. Foreign owners, demo roots/targets,
missing pipeline coverage, stale rows, duplicate employees and conflicting
active bindings are held. A mutable default organization is not an anchor.
The shared source collector now also rejects case-folded native ID claims,
matching the native database's identity comparison.

R274/r275 pass 37 PostgreSQL 16/18 groups. R276 passes the production TypeScript
configuration, r277 the focused authority aggregate, and r278 lint with zero
errors and the three existing navigation warnings. The added native alias
fixture initially violated the required gu/username schema in r279; r280
corrects the fixture without changing constraints and passes 38 PostgreSQL 16
groups. R281 also completed all 38 PostgreSQL 18 groups. Preview tests prohibit SQL
writes by the preview client and compare registry, control and downstream
counts before/after; adversarial setup changes are rolled back in the owned
disposable database.

This is still a private source preview, not normal UI enrollment. The native
first exact registry admission/apply ledger, saved recovery and normal
user-management wiring remain required; enabled-policy raw registry writes
remain rejected. R282 refreshes the full actual-native candidate after the
collector change: all nine combined actual-app/PostgreSQL/native OAuth/HTTP
checks passed, including saved recovery, root denial/restore and first existing
account linking. Its 71 candidate and 28 fixture hashes match current files.
The 318-Email/12-principal revoke and grant committed at 3918.364/4184.874 ms
under the unchanged five-second deadline. This does not exercise the new
registry preview as an enrolled native change and is not browser/provider or
production proof. The five
reviewed email recoveries, calendar/Drive provider round trips and whole
release/deployment gates are still outstanding. No production mutation or
push occurred in this preview slice.

### Native-first root registry apply and saved recovery, 2026-11-03 (unreleased)

Forward migration `0397` adds an exact, permanent root-change ledger and strict
JSON row validator. A source change must match the immutable account, owner,
root, row identity and next enabled-state revision. Admission checks current
preimages and the actual active owner/root membership. Registry writes under
native policy require the same applying transaction, committed native revoke,
current generation/fingerprint/receipt and one unapplied matching ledger row.
Complete coverage and actual postimages are checked at transaction completion;
partial app state cannot commit. Historical rows cannot be deleted. Proposed
new sources are also pinned while the transition is active, before they exist
in the ordinary registry. Existing membership/lifecycle/identity actions and
their guards remain in the forward definitions.

The actual store now builds complete root before/after snapshots while retaining
unrelated operator sources, applies only the approved registry rows, and runs
audit effects atomically. R290/r291 pass 44 full-migration PostgreSQL 16/18
groups, including account/binding/grant creation, audit rollback, refusal before
native revoke, lost-grant lease/receipt recovery, viewer-only native matrices,
and a second revision that disables all four intent rows without deleting
history or touching memberships. Native evidence in these PostgreSQL cases is
synthetic, not an actual SuiteCRM execution. R284 caught a CASE-expression SQL
syntax error; it was fixed before the passing migration/store runs.

Every newly added v2 reader now enrolls the exact managed writer restriction,
even when a root-registry change carries no role-change or first-link array.
Managed-scope-disabled admission holds rather than retaining broader native
module rights. The helper pin is
`e5acae3f23ff7c2c46ea28d01968fb3aac7f9d842aa2c5903eb5f49391113e0a`.
R295 passes 16 actual MariaDB SQL checks, including that generic-reader hold
and exact scope/permission enrollment. R293 exposed an over-escaped JSON value
in the added test fixture; only that fixture serialization was corrected.
Neither MariaDB batching acceptance nor a source pin is native ACL proof.

The private root coordinator now uses the existing native approval/phase
protocol and owner-scoped saved discovery/Resume. It returns only bounded
metadata and reconstructs the exact saved plan; it never creates native Users,
reconnects providers, activates policy or accepts browser-supplied matrices.
The combined actual-native runner includes two new root coordinator/recovery
cases, which still require a current terminal run. Normal owner/user-management
request building, API/UI controls and their runtime/browser checks remain open.

R297/r300 diagnose PostgreSQL 16/18 v13 catalogs and independently preserve the
frozen v12 digest immediately before `0397`. The forward change adds one ledger,
eight columns, two indexes, twelve triggers and five new functions, replacing
three existing guard bodies. PostgreSQL 18 separately represents seven
additional constraint rows. The v13 digests are
`25c7846bd06775cfb2250fb499d9dc1149230db223bee341699b142adeb16b46` and
`76c645447e1f94937130785916e71606c2b563b0c1e910fd50f2efac81c421f9`.
R302 subsequently completed all 163 catalog/ledger tamper refusals, final lock
checks and second-database historical/OID-portability upgrades on each of
PostgreSQL 16 and 18. The rollback floor protects `0397` and rejects v12 or older
metadata; r296 passes its 14 synthetic local-source checks. R292 passes the
focused authority aggregate and r301 the production TypeScript configuration.

The PostgreSQL 18 diagnostic r298 was refused before launch at 5.34 GiB by the
disk floor. R299 was a read-only storage audit; no files or caches were removed.
At the same time the OS reported about 32 GiB used swap; later free space
recovered to about 24 GiB as swap fell, without cleanup or an override, allowing
r300. Do not infer persistent disk headroom or permission to prune caches.

The full release is not complete. The five reviewed email recoveries,
calendar/Drive provider round trips, normal root management wiring, current
whole-release gates, exact production permission proposal approval and
dev-to-main/production promotion remain required. No production mutation,
provider write or push occurred in this slice.

R304 refreshes the production TypeScript check after early actual-root
authorization was added before any provider configuration/inspection (including
the disabled-policy return). R305 passes seven mocked early-authorization and
read-only recovery groups; r306 passes the refreshed focused authority aggregate
including those checks, and r307 focused source lint. None is a substitute for
the actual SQL/native evidence.

R308 then completed the expanded actual-native gate: all **eleven** combined
application/PostgreSQL/native OAuth/HTTP cases passed. The two new cases use
the real private root-registry coordinator, actual native revoke/grant, owned
saved discovery, lost-response/live-lease refusal and receipt-only Resume.
Unrelated native scopes and Email content remain unchanged; restored historical
and future rights are viewer-only, not editor rights. All 75 candidate and
28 fixture hashes were checked against current files after termination.
The separate 318-Email/12-principal scale revoke/grant committed at
4150.148/4150.344 ms under the unchanged five-second deadline. Native account
discovery and downstream audit/sync sinks remain fixture edges. This is not
normal owner/user API/UI, browser, external calendar/Drive or production proof.
The next required implementation is server-derived owner/user requests and
their normal controls/recovery display, not another activation shortcut.

### Normal root owner controls and app-only lifecycle, 2026-11-03 (unreleased)

The candidate now includes `/api/crm/root-access`, its owner-authorized DAL,
strict browser-safe choice DTOs, and the themed **Settings → People →
Company-wide CRM access** panel. Requests carry business/employee choices and a
registry version, never client-supplied native identities, account authority
rows or a default-workspace hint. The source owner and actual business
ownership are rechecked under the control lock. Disabled-policy writes require
exact preimages, one-row readback and atomic audit; enabled-policy writes use
the existing native-first coordinator. Saved recovery is owner scoped.

While wiring this workflow, the normal-user test found that an unlinked root
employee's membership edits were unnecessarily held under idle native policy.
The still-unreleased, untracked candidate migration `0397` now permits ordinary
membership UPDATEs only for an unmapped non-operator employee while there is no
publication or transition. It does not permit insertion, deletion, rebinding,
operator demotion, mapped-user changes or drift during an active plan. Existing
session revocation remains in force. Migration `0397` now hashes to
`1ec2eedefb1241cc126f51c0dd26576f1389780ec9b442c47895045bf56d4852`;
r309 and the preceding v13/native receipts are historical, not proof of these
amended bytes. No released migration was rewritten or applied remotely.

Current local evidence: r316 passes **55 actual PostgreSQL 16 groups**, including
the new owner DAL choices/setup, employee enrollment/soft-disable, stale and
foreign input refusals, audit rollback, safe metadata, explicit native dispatch
and saved Resume. Native dispatch is mocked in those new DAL cases; the
existing PostgreSQL transition cases remain actual SQL. R319 passes five
actual-route/parser/same-origin groups with mocked session/DAL boundaries.
R321 passes six real React/MUI browser groups with mocked API responses,
including unknown-write/read-failure locking, receipt-only Resume, stale forms,
wrong-organization responses and mobile light/dark layouts. The screenshots
were visually inspected. R330 passes the full People-dialog fixture with the
new panel, parent busy fencing and saved readback alongside the existing
login/identity/Trash/sharing recovery checks. R328 production TypeScript and
r322 focused source lint pass. None is signed-in production or provider proof.

R320/r323 independently reproduce the frozen pre-0397 v12 fingerprints on
PostgreSQL 16/18. The amended v13 diagnostics are respectively
`22808494dbdc3510bdccb57fe0a491344a1e8bc57195594d089cdf568e63842e` and
`f0685b9f82de44c3c1cf1c10e4ce077c43d1040992234e551e338311160f3e64`.
The app-only membership helper is now an explicit critical function and is
subject to the same body-tamper refusal as every other critical helper. These
diagnostic enrollments subsequently passed terminal full acceptance in r325:
**164 catalog/ledger tamper refusals per major**, historical/OID-independent
readback and final transaction-lock checks. The earlier r302 digest receipts
remain historical. The combined native fixture has also been extended to run
the actual owner settings API/DAL through the real native coordinator, rather
than relying only on a private-runtime call; its refreshed execution is still
required. Session authentication and downstream sinks remain declared fixture
edges in that gate.

The full release remains incomplete: current native acceptance, PostgreSQL 18
owner tests, whole-release checks, five reviewed email recoveries, calendar and
Drive provider round trips, the exact production permission approval, and
dev-to-main/production verification remain. No provider write, production
permission activation, push or deployment occurred during this slice.

R331 also passes the current focused authority aggregate, and r332 passes the
14 synthetic rollback-artifact checks after the normal owner controls and
their private runtime were added to the protected-source inventory. The latter
is not certification of a built rollback artifact from this dirty worktree.

R333 now passes the same **55 full-migration PostgreSQL 18 groups** as r316 on
PostgreSQL 16. The refreshed actual-native owner API/DAL gate was then started
as r334, alone after the schema and PostgreSQL gates terminated. Its process
must be observed to terminal completion and its frozen candidate hashes
read back before any native pass is claimed. Do not restart it merely because
an observation call yields; this paragraph records launch, not acceptance.

R334 was subsequently interrupted after ten combined cases, before it emitted
a terminal acceptance artifact. Its absent process/handle and exact leftover
resource labels were checked; only its two disposable databases, empty private
network and owner-marked extracted source were removed. No user data or volume
was removed, and guarded admission recovered the retained dead-owner lease.
It is not a full passing receipt. R336 then held before any app changes because
the starting native audience had no completely read-only employee. That state
is consistent with a scale revoke having committed while a grant held, but the
intermediate bootstrap output was not retained, so that causal explanation is
an inference, not a captured scale receipt. The runner now validates both actual
scale receipts before handing off to app tests and retains bootstrap output on
failure. It does not change native deadlines, coverage, principals or rights;
r341 exercises the new handoff refusal with held/missing/duplicate receipts.

R344 finally completed all **eleven** actual application/PostgreSQL/native
OAuth/HTTP cases. Its two owner cases now enter through the actual settings API
and DAL, verify revoke readback, discover the saved lost-response grant, refuse
a live lease and Resume its retained receipt without repeating native execute,
app writes or audit. Restored historical/future permissions remain viewer-only.
R345 rechecks all **80 candidate and 28 fixture hashes**, plus the pinned source
archive; the artifact hashes to
`786e9df09307fa2bc8ef351ba7a1275db8c1cb1a294cbaf08527dfe9edb07184`.
The full 318-Email/12-principal revoke/grant committed at 4211.324/4202.766 ms
under the unchanged native five-second cap. Session authentication and existing
account discovery remain fixture edges; audit/sync sinks use fixture tables.
This is not signed-in browser, calendar/Drive or production proof.

The read-only public production version endpoint reported
`9b77b55970b1be7a0407f5b3d8f624c7f467543d` (PR345). Its separate CRM deletion
runtime protections were retained. Five missing deletion fixture/runbook files
were restored byte-for-byte from that commit, together with its named native
test command and runbook link; no existing local runtime file was replaced.
R338 verifies actual PostgreSQL sales/all activity, shared-email uniqueness,
legacy associations, time/archive boundaries and isolation, including restored
production archived-Contact capacity/reporting regression coverage. R339 passes
the reporting source/real server-rendered MUI scope controls, not a browser flow.
R343 passes the real CRM React/MUI drawer/table and Trash browser fixture with
mocked HTTP: Supplier Type is distinct from the internal external-organization
role in both themes, and confirmation/cancel/failure/retry, protected identities,
viewers and mobile layout remain covered. A fixture selector initially expected
`Type` alone; diagnostic DOM readback confirmed MUI's actual accessible name is
`Type Supplier`, and the corrected test checks that exact label/value pair.

The full objective remains active: current broader release gates and source
review, exact production permission approval/activation, the five reviewed
email recoveries, provider Calendar/meeting and separate customer-folder round
trips, dev-to-main promotion and final production verification are not complete.

### November 3 current release gates and fresh read-only inventory

R346 passes full lint with zero errors and the same three existing navigation
warnings. R347 passes documentation/catalog consistency. R348 passes the full
predeploy command, including optimized production compilation. R349 passes the
auth/user lifecycle aggregate, including both PostgreSQL majors and actual
React/MUI settings fixtures. R350 passes organization communications and its
85-check actual-PostgreSQL Calendar discovery fixture. R351 passes customer
folder/card controls, including eighteen actual-PostgreSQL groups. Provider
ports remain synthetic in those fixtures; these are not signed-in or live
Calendar/Drive round trips.

R356 completed all eleven combined application/PostgreSQL/native cases using
PHP 8.3.36 and MariaDB 11.4.13, with the actual owner settings API/DAL enabled.
Its full 318-Email/twelve-principal revoke/grant committed at 3394.967/3479.891 ms
under the unchanged five-second native deadline. All 82 candidate hashes
matched on readback. The local image is Alpine/arm64; matching the production
PHP patch does not establish an identical production OS, architecture or speed.
Subsequent named scale-fixture changes make that receipt historical for the
affected harness files, not evidence for a newer fixture.

Fresh production observations r352, r357/r358 and r360 were SELECT/file-read-only;
the successful database transactions explicitly confirmed read-only mode and
rolled back. No SuiteCRM bootstrap, authentication-as-another-user, permission
change or application write occurred. R357 stopped on an overstrict local
SELECT guard matching the literal Email action name `delete`; it rolled back.
R358 corrected the diagnostic guard and completed. The observations found:

- All six offline-patcher stock inputs match the reviewed hashes; the scope
  helper is absent. Native inheritance flags are still true and the managed
  write-scope flag is not installed. No inheritance flag or hook was changed.
- Four nondeleted native principals remain: the administrator, two explicitly
  module-denied principals, and the unroled blank-status principal. Blank status
  is not treated as disabled. All five Email defaults remain `90=all`.
- Zero active SecurityGroups, group-user/Email links, default rules, active
  workflows, database triggers or events were observed. Maps has no enabled
  settings row. These metadata counts are not full live ACL execution proof.
- All **329** active native Emails match exactly one app Email identity and
  Global ID across three pipelines. They remain administrator-assigned/created.
  The target employee's authorized Suburbia pipeline retains **27** Emails,
  including six app-archived rows. BPO has **126**; the third pipeline has
  **176**, including one app-archived row. The target's explicit editor share is
  present only in the 27-Email pipeline. No archive, ownership or relationship
  was changed. No root employee registry tables are installed yet; do not infer
  cross-business enrollment from an email domain or this historical allowlist.
- R359 reverified the exact five reviewed cached messages, six matched contacts
  and two company references per message, with zero existing interactions for
  those provider IDs. Publication/schema/mailbox-identity gates still hold;
  this is recoverability metadata, not a fresh provider digest or recovery.

The proposed production permission cutover therefore remains explicit: retain
administrator and existing module denials; preserve the target's exact 27-row
editor scope and archived state; prevent foreign reads to the other 302 rows;
install the six hash-gated native corrections/helper and managed publisher;
change only the five Email defaults to group-scoped view/list/export (80) and
owner-scoped edit/delete (75), with exact managed capability rows preserving
legitimate editors. Root employee business-wide visibility remains an explicit
owner setting, not an automatic expansion during repair. Writer drain, retained
exact before/after identities, durable receipts, canary readback and separately
approved activation are required. Removing restrictive controls is not a safe
rollback because it would restore the observed foreign-Email exposure.

The independent review also reproduced an actual Calendar source authorization
gap: a nonowner membership with explicit `viewCrm=false` could retain a source
for a pipeline it still owned. The two source/settings predicates now use the
existing membership-owner override and CRM permission semantics, plus explicit
untrashed membership. Calendar red r358 fails before the runtime edit; green
r359 passes **103 actual-PostgreSQL checks**, including provider dispatch refusal,
unchanged durable state, owner override, Trash denial and restore. Calendar
r360-r363 pass presentation, discovery, import-route and focused ESLint gates.
The earlier r348 full build predates this four-line runtime correction and
must be refreshed. No provider or production mutation occurred during this fix.

The live count now exceeds the old 318-row fixture. A separate named synthetic
334-row profile covers the observed 329 plus the five intended recoveries while
retaining the original 318 profile, full twelve-principal coverage, rollback
assertions and five-second deadline. Its running or retained source is not a
passing receipt; record its terminal result before certification. This is not
a maximum-capacity or production-performance claim.

R361 subsequently completed that named **334-Email/twelve-principal** profile
on PHP 8.3.36, including all eleven actual app/PostgreSQL/native cases and both
owner API/DAL cases. Revoke/grant committed at **4829.048/4707.385 ms** under
the unchanged five-second deadline. This leaves little local timing margin;
one synthetic pass is not a production performance guarantee. R365 verifies all
82 candidate and 28 fixture hashes against retained artifact SHA-256
`1ba577058af0c294248b2f8f3a2cac814a7a5e160e9322adfe2a517934764269`.
All owned fixture containers were absent after cleanup. R364 independently
checks all **53** relevant production stock-source inputs against the reviewed
hashes without bootstrapping SuiteCRM or connecting to its database; all match.
R363 refreshes documentation/catalog validation. These results do not close
the initial-enrollment implementation gate below.

#### Initial production enrollment is still an implementation gate

The November 3 independent source audit found no production-capable initial
enrollment executor. The offline scope installer changes only reviewed files;
`install-email-audience.php` does not install the prepared publication/authority
routes. Initial native groups, bindings, historical managed identities and
capabilities are currently seeded only by disposable fixtures. The combined
PostgreSQL enrollment helper explicitly forbids production use and records a
synthetic receipt. Existing authority/user coordinators operate on already
enrolled scopes; their passing tests do not fill this bootstrap gap.

Therefore this candidate is **not ready for production activation merely upon
permission approval**. Finish a bounded, journaled initial-cutover implementation
and rehearse it against actual native/PostgreSQL runtimes before presenting the
executable live change. It must carry the exact reviewed 329-row preimage and
legitimate capabilities, enforce writer quiescence and fresh policy/source
checks, install all required endpoints deliberately, recover partial phases
without replaying ambiguous writes, and enable PostgreSQL publication only
against independently verified non-synthetic native enrollment receipts. Never
reuse fixture bootstrap SQL, synthetic activation hashes or a hand-written
`enabled=true` update as production proof. R362 retains the current exact-row
source hashes, target scope and five-default impact as a preparation-only
snapshot; it is not an apply command or approval.

The first bounded implementation slice is now
`app_src/lib/crm/nativeEmailInitialEnrollment.ts`, with six pure contract groups
in `scripts/test-native-email-initial-enrollment.mjs`. It validates complete
independent source shapes, exact identity/content/archive preservation, unique
mappings, separately reviewed future policies and exact historical revocations;
it forbids historical grants and implicit root enrollment. Its result is always
`executable:false` and `activationReceipt:null`. Supplied completeness flags are
not authenticated evidence. This is not the executor, ledger, signing, drain,
installer or PostgreSQL activation path described above.

R366 predeploy passed during arrival of that new module and is not its stable
source proof. The explicit post-freeze r367 build found an indexed-unknown
TypeScript error in its matrix validator. Validated local reader/writer arrays
correct that narrowing without relaxing runtime checks. R369 repeats all six
pure groups; r371 focused ESLint passes; **r370 refreshed full predeploy passes**,
including the production build and TypeScript on the frozen corrected source.
The Calendar source remains at SHA-256
`19b413f24cd3bdfeff4fd053444d793612f5882096f87fd558baec18633d6bbc`.
No push, deployment, production DDL, permission activation or recovery occurred.

### Initial-cutover component checkpoint, November 3

The later local candidate adds the native initial-policy delta, executor and
retained terminal schema, plus explicit source/installed/ordinary-after runtime
profiles. Forecasts are labelled forecasts; signed execution and terminal
receipts are separate. Explicit expired-operation cancellation retains a
tombstone after complete unchanged-before verification; it is not an automatic
timeout unlock or reversal of committed permissions. R406 executes eight PHP
syntax checks, six typed-delta groups, five initial-plan/RSA groups and one
actual TypeScript-to-PHP signature interoperability check in cached PHP 8.3.36.
This is **pure PHP/crypto proof, not native database/ACL execution**. Earlier
r361 steady-state receipts predate the transaction/runtime extension and must
not certify these new bytes.

The separate file-only runtime installer packages all route/helper dependencies
and retains the existing lifecycle route. Root/offline installation uses an
independently approved package hash, exact preimages, protected originals and
staging, router-last replacement and retained forward recovery. Startup reads
journals before any normal bootstrap write and prevents legacy installers from
overwriting the managed router. R393 passes six actual isolated Linux/PHP
filesystem groups, including linked VERSION negatives after the independently
reviewed leaf-check defect was reproduced in r392 and fixed. R379 retains the
nine local record-lifecycle fake-HTTP/source groups. These tests use synthetic
package contents, not the real service image, database or permission system.
Pre-manifest interruption requires the separately reviewed recoverable
quarantine procedure documented in the scope package; it is not automatically
recoverable from a nonexistent install ID.

The app initial-approval signer has a distinct RSA-3072 purpose/domain and
short-lived envelope. It requires a trusted durable source-reservation store,
the exact independently reviewed plan, native forecast and installation-journal
pins; it never creates keys, activates policy or returns an unpersisted approval
after a failed store commit. R385 passes five actual signer/contract groups
using a synthetic store/forecast; r386 TypeScript and r387 focused ESLint pass.
The real DAL/coordinator is still required.

Review found the initial barrier must precede offline installation, forecasting
and signing. Migration 0398 is therefore being revised around a separate
immutable source reservation, followed by one final plan/approval binding and
trusted committed/cancelled settlement. Its earlier eight-group PostgreSQL
16/18 results certify the earlier draft only, not the subsequent revision.
Old first-enable fixture shortcuts must be updated, not reopened in the guard.

Fresh read-only production metadata r388/r390/r391 resolves the apparent
419-versus-329 discrepancy: all ninety extra synced app rows are verified
`is_demo=true` workspaces with `source='demo'` and `synthetic=true`, using six
seeded placeholder IDs across fifteen pipelines. Those six IDs are absent from
all native Email states and the inspected other native modules. Exactly 329
non-demo synced app Emails match the complete 329 active native inventory. No
record was deleted, reassigned or repaired. The initial SQL source must match
the existing non-demo publication scope, not infer exclusions from names or ID
prefixes; complete active native inventory validation remains mandatory.

Subsequent local evidence closes several component gates, not the release:

- R411 passes three fresh actual PHP 8.3.36/MariaDB 11.4.13 initial scenarios:
  commit/fresh resolve/replay, expired cancellation/late-execute refusal, and
  complete rollback after an explicit-ALL mismatch. Each uses 329 Emails across
  27/126/176 scopes, four principal classes including the blank-status unroled
  user, six archives and nonempty shared-company/contact relationships. The
  five-second limit is unchanged. The app store/source port remains synthetic.
- Revised 0398 passes eleven actual PostgreSQL groups on each of 16 and 18
  (r398k/l). The real SQL DAL, actual RSA issuer and private operator coordinator
  pass nine groups on both majors (r427/r428), including actual application
  rollback and committed-response loss. Native forecast/resolve is synthetic in
  those SQL runs. Eight pure coordinator groups separately cover dispatch order,
  explicit cancellation, unknown outcomes and retained terminal status without
  replaying the old manifest after legitimate later generations.
- V14 enrolls the exact 0398 source and full new source/ledger/outbox catalog.
  Both PostgreSQL majors pass 314 catalog/ledger tamper refusals, historical
  upgrade/OID portability and transaction-lock checks. Historical v13 pins are
  preserved. The rollback source floor now requires v14/0398 and the native
  runtime/initial/maintenance dependencies; fourteen synthetic artifact checks
  pass. These are not a clean committed release artifact or build certificate.
- Restrictive maintenance starts before PHP/bootstrap and serves liveness with
  `ready:false`, not application readiness. Seven real entrypoint/Python and six
  isolated Apache routing groups pass on the Mac. The production image and
  trusted startup-release path remain unverified. The image base is pinned to
  the independently observed official PHP 8.3.36 Bookworm manifest, rather than
  a floating PHP minor tag.

R429 is a fresh SELECT-only, explicitly read-only/rolled-back production
observation: 329 active native Emails, zero managed tables, MariaDB 11.4.13,
and database defaults `utf8mb3`/`utf8mb3_general_ci`. Its utf8mb4 connection is a
separate setting. The independent installer profile must match the actual
database defaults; no production charset/default is changed to fit a fixture.

R430d independently creates the fixed eight-table schema in a fresh local
MariaDB database with those production-matching defaults; r430e passes nine
actual DDL/config recovery groups against the resulting shipped profile. This
covers each implicitly committed CREATE interruption, config rename recovery,
no adoption and exact schema/preimage drift checks. R417 passes five actual PHP
CLI parser/protected-file/key guard groups, not cold native bootstrap. The CLI
uses one image-canonical helper dependency graph after verifying the installed
package bytes, avoiding duplicate PHP declarations from different include paths.
The actual cold CLI/DBManager/cache path and combined native+PG run remain open.

Still open: the production config/schema journal and cold CLI integration,
genuine unmanaged-source native+PG rehearsal, verified startup release and
enrolled restart, explicit cancellation/replan installation lineage, current
whole-release gates/clean candidate and all live/provider acceptance. A source
reservation without final admission remains held for explicit forward recovery;
expiry is never an unlock. No live maintenance, role, credential, schema,
mailbox, provider, deployment or recovery write occurred.

### Cold bootstrap and private operator checkpoint (2026-11-03)

R447 completes an actual fresh-process source/session observation using the
fixed CLI bootstrap and stock SuiteCRM DBManager: all 329 Emails are captured,
all 232 raw table hashes and critical file bytes remain unchanged. Stock empty
Audit vardef cache replacement is explicitly recorded (same bytes, mode,
owner and single link; atomic replacement changes inode/times and its parent
directory times). Eighteen negative cases reject other cache/file changes.
This is not a claim of zero cache writes. The bounded storage diagnostic shows
452,556 KiB allocated by extraction and about 0.45 GiB less free space, not the
earlier unexplained transient six-GiB drop. No disk guard was bypassed.

The observation independently pins native verification to utf8mb3/general_ci
with stock DBManager's non-strict SQL mode. Explicit DDL installation retains
its original strict utf8mb4 session profile. The verifier never changes a
native connection to make its expected profile pass. R448 passes ten actual
MariaDB installation/recovery groups, including each CREATE interruption,
config CAS/no adoption, unchanged schema checks, files-only checks before
configuration includes, and refusal of the wrong native session. Full cold
installed project/prepare/execute/resolve remains a separate gate.

The private operator now has an actual TypeScript-compiled CommonJS entrypoint
and fixed authenticated Railway-SSH argv adapter. It uses the real SQL
collector, source reservation, durable RSA issuer, coordinator and post-COMMIT
origin issuer; no public action/route or runtime TypeScript test loader is
added. Its build manifest fingerprints 22 application modules. Eight compiled
contract groups pass with explicitly synthetic remote command responses, plus
focused ESLint. These include an actual owned child ignoring SIGTERM, bounded
unknown-outcome handling/forced cleanup, rejection of PG URL query overrides,
and exact signed origin reuse after a lost publication response. Those tests
do **not** establish real PG/native transport,
permission activation, Railway authentication or provider behavior. The new
root-only artifact transport passes four actual Linux protected-file/parser
groups plus PHP 8.3.36 syntax, but its full staging-to-native runtime path is
still unverified.

The enrolled startup path now checks nine retained bootstrap leaves and the
installed package/config journals before includes, then requires a typed
origin and a completed fresh current-native invariant inspection. It skips
legacy bootstrap writers and launches Apache only on fixed port 8080;
background workers remain off. The nine leaves are not a complete PHP include
closure or a filesystem-administrator/supply-chain security boundary. Twenty
pure PHP value groups, actual PHP 8.3.36 syntax, static ordering, three shell
refusals and the existing seven maintenance process/HTTP groups pass. A real
enrolled cold restart/full image remains unverified.

R450 then closes the actual fixed cold-CLI component gate at 329 Emails/four
principals: genuine offline installers, project/prepare with the same verified
journal tuple, signed execution, fresh resolution and replay all pass with the
unchanged five-second transaction limit. Only execution changes the exact nine
allowed ACL/group/managed tables; all other stages preserve database content
and critical files. Sixty-two source hashes are rechecked. The host app/PG
approval edge in this run remains explicitly synthetic: this is not the
combined real app/native cutover, Railway transport or production activation.

The release still requires the combined real SQL/native/operator run, explicit
cancellation/replan lineage and reservation-forward recovery, current whole
release gates/clean candidate, exact approved live cutover, five-message
recovery and authenticated calendar/folder/provider acceptance. No production
write or deployment is implied by this checkpoint.

R451d/R452 close the compiled SQL-operator component on PostgreSQL 16 and 18:
fifteen groups pass on each (ten pure/contract, five actual CLI/SQL groups).
The emitted private CLI uses an actual Pool for owner authorization, source
preview, approved reservation, immutable retry and wrong-actor/source refusal.
The real compiled collector derives all three future policies and the actual
RSA issuer admits the independently pinned material; source fences refuse
drift. Both runs recheck the 22-module build/output manifest and migration
inventory before/after. Native responses remain synthetic, with dispatch and
activation explicitly false. These results must not be combined with r450 by
assertion: a single genuine two-database rehearsal remains required.

The operator separately approved removing only this worktree's generated
`app_src/.next` output (2,366,584 KiB allocated, about 2.26 GiB). That exact
untracked directory was removed after confirming no local ClawPilot listener;
the running Next server belonged to the separate BPO website checkout and was
left alone. No source/configuration/database/worktree/Docker path was removed.
The output is regenerable, not recoverable from Trash. Free-space readings
remained volatile; APFS inspection also observed a roughly 12.9-GB VM volume.
That observation does not prove the cause of each transient drop. Standard
15-GiB guards and single-fixture scheduling remain mandatory; no override was
used and the latest source changes still need a new whole-release build.

### Joined initial enrollment and database health checkpoint (2026-11-03)

R455 closes the first genuine combined PostgreSQL 16/native rehearsal using
the compiled private operator, real SQL reservation/collector/issuer, actual
protected artifact staging and separate-process native CLI. Eight groups pass
at 329 Emails/four principals/three pipelines. A deliberately lost native
COMMIT acknowledgement is resolved by fresh native readback and actual SQL
activation, without a second execution. The post-COMMIT origin is signed and
published with exact-byte replay. Twenty-nine actual transport calls are
audited; only execution changes the nine allowed tables. The artifact SHA-256
is `955ed70e4a965bc8e14ff62b1997d6b2c29dbe04d096a5f2e0f61b80fc3f04a4`.
This uses a local Docker argv adapter, not authenticated Railway SSH.

R461 repeats the genuine joined path on PostgreSQL 18 and adds same-operation
source recovery after installation, protected origin status/readback and a
fresh PHP process completing the typed-origin/current-native startup
inspection. Ten groups pass with 37 audited calls and 446 source hashes
rechecked. Startup inspection preserves all 240 table hashes and critical
file bytes, records only the previously bounded stock Audit cache touches,
and confirms rollback. Execution count remains one. The artifact SHA-256 is
`067755a6f48fd1fe5cf2b87492d44e1feeefc8c6672b0ed0564ea44e63a18d2a`.
Owned containers, networks and the guarded database lease were cleaned.
This is component readiness evidence, not the full Apache wrapper/service
image, Railway transport or production readiness proof.

Same-operation recovery now verifies the exact retained source digest between
two actual SQL collections; it does not recapture stock source after installing
runtime changes, clear a reservation or reissue approval. Resume/cancel use
retained SQL execution facts. Origin recovery preserves the original signed
bytes. A genuinely cancelled operation followed by a new operation still
needs a separately verified installation-lineage path; same-operation forward
recovery must not be represented as that replacement-operation proof.

R458/R459 independently pass the complete Shopify reconciliation-health gate
on PostgreSQL 16 and 18 after all 385 migrations. Trigger predicates referring
to both OLD and NEW are attested with trigger-aware definitions instead of
the invalid `pg_get_expr` call. Exact catalog/checksum pins cover the six
native-email phases, including 0393/0394/0397/0398 and prerequisite closure;
historical pins remain unchanged. Missing, disabled, ALWAYS, rebound, extra
and predicate-only trigger drift, plus current/prior migration-ledger drift,
are refused. No production schema or health call was made by these runs.

Remaining release gates are the actual full service image/enrolled Apache
startup, the cancellation/replan decision and applicable proof, current whole
release gates and a curated candidate, authenticated calendar/folder/provider
acceptance, exact approved live permission activation, five-message recovery,
and dev-to-main promotion with production readback. Neither component test
success nor this checkpoint authorizes those live actions.

R462 subsequently builds the actual Linux/amd64 service image successfully,
using the pinned PHP base/archive and bounded two-CPU/two-GiB build steps with
no additional container swap. Its immutable image ID is
`sha256:104cc44dac07c7c2d20663360b412115db58badd63696de862feccb5dbd84629`;
the configured entrypoint is `/usr/local/bin/entrypoint.sh`. The build metadata
SHA-256 is `75895fa69cc23710f9bd4a0dc06ea2308b53507c0eccbb8913e3ff633ffb86c5`.
This closes image compilation only, not enrolled startup or provider proof.

R463's whole-application lint exposed generated CommonJS operator bundles
under the already Git-ignored `app_src/dist` directory. The narrow ESLint
generated-output ignore now excludes that directory, while an actual ESLint
API check confirms the operator/CRM TypeScript sources remain included with
the original require-import rule enabled. R464 reruns the whole lint gate:
zero errors and three existing internal-navigation warnings, exit zero. Its
log SHA-256 is `aef7830131e2b2fda23f2a2a05d87cc262ad8f67c4c1f513f768bf9a6c70b5d0`.
No source lint rule was disabled and no generated bundle was added to Git.

The user-authorized Fractional coordination confirmed that the Airspace
successor chat does not own the Desktop publisher. This ClawPilot thread's
own retained apply-patch record at 2026-11-03T01:48:17.971Z establishes authorship
of the narrow Desktop/Fractional sender/index/worker changes. Preserve all
unrelated Desktop and Airspace work. The existing Fractional comparison
runtime pin omits those sender modules, so a default pinned Next build is not
evidence for the current sender candidate. A separately selected current-source
candidate and real sender-to-receiver acceptance are still required; do not
modify another owner's immutable comparison runtime to make a check pass.

R466 closes the actual full service-image/enrolled-entrypoint and true
container-restart gate on PostgreSQL 18 with the immutable R462 image. Eleven
groups pass at 329 Emails/four principals/three pipelines. Thirty-nine actual
transport/startup observations are audited and 472 source hashes are checked;
native execution remains exactly once. The test removes the construction
container, starts the image's unmodified configured entrypoint, then removes
and recreates a distinct second container on the same exact owner/token-labelled
native app-data volume. Both starts complete the actual current-native
inspection before Apache becomes PID1, with five www-data children, no
background workers, port 8080 liveness and port 80 refused. Liveness still
reports `ready:null`; this is not signed-in web UI, provider or Railway proof.
The complete table/file audits retain the existing bounded Audit-cache
exception only. App data peaks at 509,435,904 bytes within the reviewed
640-MiB observed budget, not a claimed volume hard quota. All owned containers,
the named volume, networks and guarded lease are cleaned; the parent separately
confirms labelled Docker resources are absent. Artifact SHA-256:
`e4b2f5382d057450efa07aa90d87dfc24aeedf758f80a3ef62e07b521d16f209`.

The earlier R465 failure is retained, not counted as a pass. It reached real
Apache liveness but rejected the Apple Silicon Rosetta child-process argv
format. R465b records the actual raw PID/UID/parent/argv evidence. The fixture
now admits only the observed exact Rosetta child tuple with all four UIDs 33
and parent PID1; the root master remains exact direct Apache/PID1/parent0.
R465c passes three valid and sixteen altered/invalid process-profile cases.
No application/runtime permission check or five-second native limit changed.

The cancellation/replan gate is confirmed to be functional availability work,
not optional polish. An issued, never-executed initial approval expires after
120 seconds by default (maximum 300); retries return the original envelope.
Real cancellation leaves a permanent native tombstone and the immutable
installation still bound to the original operation. No supported new-operation
path currently connects that cancelled state to successful enrolled startup.
Do not activate live while this recovery path is missing. The bounded next
implementation is a private signed-plan installation lineage with fresh
installed-state capture, preserving original installation/source bytes and
cancellation history. It must not renew old approval, treat absence as
noncommit, replay an obsolete capability matrix as current, or rebind the
original installer journal.

R467 begins that recovery implementation with a strict pure installation-lineage
value contract only. Twelve test groups, a focused strict TypeScript check and
focused ESLint pass. The helper binds all root/predecessor/fresh-source anchors,
rejects mixed first/repeated lineage forms and returns a frozen canonical copy.
It is not yet wired into plan admission, the native CLI or startup and supplies
no cancellation, authority or recovery proof. The contract source SHA-256 is
`1b75862afc7db429b91080608db636c92ec83e401d97448db285fb551bd28b12`;
the focused log SHA-256 is
`8a38774c1a58b7b4edb0148a8dd382fe74e0d0f25e8dd5835245cd1481cf35ca`.
Fresh source capture must precede appending its digest to the plan lineage,
avoiding a self-referential source artifact. Historical cancellation observation
must verify actual permanent tombstones and their original signed approvals
without replaying the ancestor's obsolete capability/content matrix as current;
the replacement operation then independently captures the current installed,
unenrolled state. The complete cancelled-A-to-B recovery gate remains open.
