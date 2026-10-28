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
