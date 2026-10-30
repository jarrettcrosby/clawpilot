# Real native Email acceptance fixture

This is an opt-in, disposable **SuiteCRM 8.10.1 / PHP 8.3.35 / MariaDB 11.4.13**
fixture. It installs the real checksum-pinned release and calls its actual
beans, SecurityGroups, ACL actions, V8 services, list and export code. It does
not replace native classes with test doubles or use production data/config.

The public dependency preparation is deliberately separate from the runner:

```sh
docker pull php@sha256:8dbeb51c352cf1f70d5d50f3642c9fbed311e914475ea2382f5bc1525bef7bb3
docker pull mariadb:11.4.13
docker build --pull=false \
  --tag clawpilot-suitecrm-native-acceptance:8.10.1-php83 \
  --file scripts/fixtures/native-email-audience-real/Dockerfile \
  scripts/fixtures/native-email-audience-real
```

Download the official `SuiteCRM-8.10.1.zip` release package to an explicitly
owned temporary directory. The runner refuses any package whose SHA256 is not
`b72da32ca7702452537cdd11e1157bc41a283accdadca66ef88f42684a571ef7`.
It never downloads dependencies, reads an environment file, or connects to a
provider or an existing CRM/database.

```sh
node scripts/test-suitecrm-native-acceptance.mjs \
  --source-zip=/absolute/owned/SuiteCRM-8.10.1.zip \
  --output=/absolute/owned/native-acceptance.json
```

`--golden-only` runs only the installed-principal clone and native body/header
save/readback goldens. It is a partial proof, not the complete acceptance run.
The output is created exclusively (an existing receipt is never overwritten).

`--remediation-candidate` is a separately opted-in experiment, approved for local
preparation/testing on 2026-10-29. It first runs the complete unchanged baseline,
then starts a fresh PHP process after checksum-verifying all five stock inputs
before patching the two V8 services, `EmailUIAjax.php`, `Email.php`, and
`SugarFolders.php` inside `/app` tmpfs. The candidate adds native Email
view/list SQL restrictions before module-list, related-list, imported-search
and folder pagination/counts, plus fresh per-record checks before serialization.
Legacy native-Email previews authorize every requested ID before rendering;
native relationship changes and quick-create authorize source Email access
before any side effect. V8 unlink checks the exact requested related Email,
not an arbitrary allowed sibling. It scopes one synthetic
previously unroled principal's Email actions to native group/owner permissions
and explicitly grants only the synthetic own-workspace Email group. Other
module action levels, user status, service denials and administrator access are
checked unchanged. Related-list totals must exclude the hidden Email. Removing
the two synthetic memberships tests rollback; message/owner rows stay intact.

The candidate then starts a loopback-only PHP server **inside** the isolated
container. Actual V8 OAuth password grants and legacy cookie logins exercise
four synthetic principal classes: administrator, scoped user, and two denied
services. Eighteen HTTP checks cover allowed and forbidden content, pagination,
five allowed legacy UID-render paths, forbidden detail access, mixed-UID
requests, imported search, mixed folders/counts, and denied relationship and
quick-create changes. Email body/header/ownership/relationship fingerprints and
target Task rows must remain unchanged after reads and denied writes. Tokens,
cookies and generated authentication material never enter the result receipt.
The existing-session check signs in and reads both fixture Emails under the
original default-all policy, applies the synthetic correction, and proves that
the same cookie and token immediately lose foreign access without another login.
The Email candidate refreshes native ACL actions once per user per HTTP request;
this is not a long-lived worker or mid-request revocation guarantee.

The following frozen-policy lifecycle rehearsal exercises actual native saves
and group relationships in real MariaDB transactions. An independent connection
must see no partially committed Email/group state. Existing history is repaired
without saving its Email bean or changing content, links, ownership or archive
metadata; retries revalidate exact identity and current readers. New messages use
the same exact pipeline group. Injected failures roll back real native writes;
versioned membership revocation applies to both old and new Emails. This requires
transactional tables, a pinned runtime and known hooks, disabled sending and
workflows, and a frozen policy. It is **not** a production publisher or a proof
that unrelated native administrators/application database writers are fenced.

The final defaults rehearsal evaluates a separate, unapproved-for-production
policy for future unroled users: Email view/list/export defaults use group/owner
scope; edit/delete default to owner-only. It must not grant edit/delete merely
because a new viewer belongs to a read group. Existing explicit role overrides
and administrator privileges remain native; unexpected broad roles or changed
default rows remain release blockers, not automatic permissions to repair.

```sh
node scripts/test-suitecrm-native-acceptance.mjs \
  --source-zip=/absolute/owned/SuiteCRM-8.10.1.zip \
  --output=/absolute/owned/native-remediation-candidate.json \
  --remediation-candidate
```

This is not a production installer or an approved native profile. The live
publisher, native audience verifier and deployment files are unchanged. A pass
does not establish current live record ownership or production HTTP/session behavior,
atomic publication, intersection audiences, native serialization readback,
or permission to migrate/recover/publish. Both `--golden-only` and the candidate
flag together are rejected so a partial baseline cannot masquerade as a full
remediation check.

The synthetic installed-profile clone intentionally includes an unroled user
whose native status is blank, two Active direct deny-all users, and an Active
administrator. These are role/status classes, not copied production users.
An observed extra reader is a **safety blocker**, not a compatible-profile pass.
A successful harness can prove that the current policy is incompatible.

## Isolation and proof boundary

The runner shares the owner-checked disposable database lease, enforces the
15 GiB disk floor, publishes no ports, and uses an internal-only Docker
network. Source/fixture mounts are read-only; application and database state
use bounded tmpfs. Containers have bounded CPU, memory, PIDs and logs, no
additional swap and no anonymous volumes. The app and DB limits are 1152 MiB
and 640 MiB respectively; they must not be raised without review. Cleanup
attempts every exact owner-checked container, network, lease and extracted
source directory and reports all cleanup failures. Cached public dependency
images and the explicitly supplied archive are retained, never pruned.

The default baseline uses direct V8 service calls; the separately opted-in
candidate additionally authenticates actual local HTTP requests. Neither mode
proves current production policy, changes live native permissions, or proves
production atomicity, cross-database concurrency or complete native-policy
fencing. Export and UI-list evidence are labeled
by the actual native call path rather than treating a raw SQL builder or an
ACL Boolean as a complete controller proof. The profile-hold check invokes
the real installed ClawPilot verifier; it does not make that profile safe.

Allowed `getEmail2DetailView` rendering is explicitly excluded: the pinned stock
implementation dereferences a null `DetailView` before initialization. Forbidden
requests must still return denial before that renderer. No browser layout,
SMTP/IMAP delivery, or exhaustive native write-route acceptance is claimed.

**Live release remains held.** Static groups for existing Emails do not ensure
future legitimate pipeline access: the current publisher writes no verified
SecurityGroup links. Ongoing exact-audience assignment/revocation and atomic
publication must be implemented and proven before restricting a live user.
The candidate does not add runtime hooks or relax the production verifier.

`npm run test:native-email-access-repair` separately tests the pure application
review planner. It is included in the interaction test gate. Its manifests are
always non-executable: they require fresh complete inventories, preserved
local/native/Global IDs, exact verified pipeline bindings, record/policy/writer
fingerprints, and a drained legacy writer. Missing native history, duplicates,
unknown sharing, stale/revoked membership and incomplete inventories hold the
whole plan. Missing-email recovery is a separate reviewed workflow; this planner
never recreates a historical Email or unarchives a record.
