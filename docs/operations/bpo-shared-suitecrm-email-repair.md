---
id: cp-ops-bpo-shared-suitecrm-email-repair
title: BPO Gmail Repair with Shared SuiteCRM Readership
summary: Scoped recovery and release checks for BPO Gmail interactions with standard SuiteCRM sign-in.
status: draft
kind: operations-runbook
area: operations
tags: [crm, gmail, suitecrm, recovery]
app_visible: false
---

# BPO Gmail repair with shared SuiteCRM readership

ClawPilot keeps workspace and pipeline access separate. In SuiteCRM the boundary is an explicitly approved login: approved users can read the five reviewed emails. No new SuiteCRM roles, security groups, user mappings, or per-record denial rules are needed to express that decision. Do not provision a special excluded SuiteCRM user.

## Retire the superseded role path safely

- Leave the unshipped scoped SuiteCRM ACL/filter, sole-reader publisher, installer/Apache changes, and migration `0418` from the prior candidate out of this release. Preserve the original worktree for reference. Do not delete or rewrite applied migrations or retained recovery evidence.
- ClawPilot's normal publisher calls `EmailAudience.php` through its V8 route even when native authority activation is off. Production Railway readback on November 9 verified that the live SuiteCRM deployment is older than ClawPilot's and has neither the route nor its helper installed. The retained role package, write-scope helper and enrollment journals are also absent. Keep the stock login boundary and replace the app's unavailable proof with exact shared-login publication and readback. Do not install the superseded role package to make the queue pass.
- Follow-up acceptance for removing custom SuiteCRM role code: verify normal publishing and retry behavior in every live workspace (including Suburbia and EPISCS), and confirm no live authority transitions or enrolled native journals still need the old runtime. Then remove the old role-mutation and audience paths from the runtime and build, without removing stock SuiteCRM sign-in/API authentication, existing identity links, or ClawPilot workspace and pipeline access controls. Check the persistent SuiteCRM volume separately: remove only exact managed route/helper bytes after proving no deployed worker or retained recovery uses them. Preserve migration history, audit evidence, and existing failure holds.

## Keep the repair and recovery separate

- For the 19 failed jobs, the read-only planner is `node --test scripts/test-bpo-failed-email-repair-plan.mjs`. Pin the original 11 and later eight, plus both deployment/database origins. Match the exact latest job, the original native ID and Global ID, live/deleted aliases, relationships, content, and sidecars. An exact existing record should only settle the original ClawPilot interaction/job; create only after absence is proven. Unknown or conflicting states hold. The planner does not authorize writes or establish live absence.
- Production read-only inventory (November 9): 19 terminal jobs had distinct expected SuiteCRM UUIDs and Global IDs. The pinned SuiteCRM database returned zero active or deleted Emails at those UUIDs, zero Global ID aliases or matching custom rows, and zero matching text, bean, or address sidecars. This resolves the earlier timed-out duplicate scan. It is not a durable preimage pin or permission to write: recheck all required sidecars and receipts under the writer's exact-record guard and verify the approved SuiteCRM login boundary before creation.
- A separate read-only App Postgres preflight confirmed exactly 11 original and eight later terminal jobs, all at eight attempts. All 19 have a native assignee, from header, exact queued native/global identity and projection, and no retired or legacy hold. Managed native role mode is disabled. This preflight emits counts only and does not select a repair target.
- The exact 19 App identity/preimage hashes were captured privately and cross-checked against stock SuiteCRM, including deleted Email IDs, collated Global ID aliases, text/custom rows, both directions of relationships, address beans, parent references, notes, attachments, folders, and group links. All counts were zero. The receipt journal and optional email-template sidecar table were absent. Neither database was written.
- The reviewed Gmail trio and Casey pair are distinct from the 19. Preserve the reviewed message IDs, exact contact links, Globus as primary, and Airspace as a link to the same email. The preview patch is released separately. Refresh the exact preview after deployment, and keep signed-in workspace exclusion in ClawPilot and authenticated/anonymous boundary checks in SuiteCRM.

## Local implementation boundary

The shared-login create primitive is deliberately not registered as an HTTP route or installed by startup. It accepts a verified create-only permit, locks and rechecks the stock native policy and exact absent identity, then commits one Email, its links, and a unique receipt in one MariaDB transaction. It does not apply a native role or membership delta. The receipt schema has no body, recipient data, or permission rows. A lost response is reconciled by exact receipt and native readback, never by generating a second Email. This is not yet the worker cutover or permission-code removal: the caller still needs independent origin and approved-login proof, exact PostgreSQL settlement, and local integration coverage before release.

The PostgreSQL readback adapter fingerprints the entire exact terminal interaction and job inside a read-only transaction, without returning message bodies. Its observations never authorize a repair or bypass the native locks.

Local checks now cover a fresh stock SuiteCRM 8.10.1 install: an approved non-admin reader sees the same Email via stock lists and both Account/Contact histories, a renewed attempt reads the original receipt, and unchanged roles/related records are verified. The exact existing observer also rejects content, identity and relationship drift. A separate PostgreSQL 18 fixture verifies exact job/interaction settlement after signed native readback, preservation of the other 18, and read-only resolution after an uncertain commit. These are local proofs, not deployment or production access evidence.

## Rollout order

1. Keep development hosted services off. Merge the historical review fix through green `dev`, then `main`; production ClawPilot autodeploy already waits for CI. After deploying the shared worker, generate new previews for the exact trio and the separate Casey pair.
2. SuiteCRM production currently has **no GitHub deployment trigger**. Use an attended deployment targeting the exact green `main` commit, not a restart/redeploy of its older image. No activation or native role package install is needed. The stock route installer only registers the OAuth-protected shared route when explicitly enabled; it does not run SQL. Observed production template sidecar setting is `0`.
3. Verify the exact native build and stock login boundary before selecting the one BPO workspace/pipeline in ClawPilot. Keep `CLAWPILOT_NATIVE_EMAIL_PUBLICATION_ENABLED` and `CLAWPILOT_NATIVE_EMAIL_AUTHORITY_ENABLED` off. The app uses the shared worker only for newly staged exact jobs in the approved pipeline; rollout does not revive terminal jobs.
4. Separately settle the pinned original 11 and later eight via exact production preimage and native readback. New Gmail work uses the normal shared worker; the historical trio and Casey pair are reviewed separately and never become part of the 19-record repair.

## Private 19-record execution

- Use `scripts/run-bpo-failed-email-repair.mjs candidate|inspect|repair <private-config-path> <config-sha256> <interaction-uuid>`. It selects one exact job on two pinned production Railway instances. It never enables hosted dev or requeues outbox work. Configure and verify the read-only path first; do not run `repair` from a new or unreviewed manifest. The command prints one digest/state, never the email content.
- Pin the candidate's current App row/job and physical DB fingerprint. Independently build the exact reviewed 11+8 manifest from candidate projection hashes, both deployments, and the native physical store. Stage the temporary App pins under root-only `/tmp/clawpilot-bpo-email-repair/`, and native pins under root-only `/var/lib/suitecrm/clawpilot-shared-repair/`. Set `writeEnabled` only for the reviewed write phase; use different transient create-approval and native-readback signing keys. Neither server receives private signing keys. The exact empty `shared-bpo-email-receipts.sql` journal is the only new native SQL object required; it has no role, ACL, user, or membership data.
- For an absent identity, App commits one dispatch claim and rechecks the exact preimage immediately before send. The native create rechecks absence and journals the email and links atomically. A prior claim with no confirmed native outcome is readback-only, never a new attempt. An exact pre-existing native record skips the create entirely. App settlement requires fresh signed native readback and compares both original hashes; a lost App commit response is read back using a fresh session. Stop on ambiguity instead of deleting or retrying records.
- After exact readback of all 19 jobs and the separate Gmail batches, remove only the protected temporary pin files and transient signing material. Keep the non-content audit receipts and the two CRM records for each Gmail message (one in each system); do not drop the journal or alter users or roles.
