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

This fixture does not authenticate an HTTP OAuth request, prove current
production policy, change native permissions, or prove atomic publication,
concurrency or policy-row locking. V8 service calls exercise the real native
service/serialization layer directly. Export and UI-list evidence are labeled
by the actual native call path rather than treating a raw SQL builder or an
ACL Boolean as a complete controller proof. The profile-hold check invokes
the real installed ClawPilot verifier; it does not make that profile safe.
