# Offline native Email scope patch

This package is **not enabled or applied at startup**. Its source and offline
tools are now included in the prepared service image; image presence is not
installation or activation. Startup reads any retained installation journals
before normal bootstrap writes and holds on incomplete or unverified state.
It installs files only: no SuiteCRM bootstrap, database connection, role/group
changes, user status changes, publication, or historical repair. The existing
audience verifier and publication holds remain unchanged.

`Patch.php` is the shared exact six-file transform. Its output hashes are pinned
to `native-future-history-2026-10-30-r2.json`. `Scope.php` deliberately retains the
fixture's original bytes and internal candidate function names. The fixture
patcher checks byte parity with its frozen helper copy before using this package.

The offline CLI is `../install-native-email-scope.php`. With no operation it runs
`check`, which reads the version, files and any existing journal; it creates no
directories, locks, temporary files or receipts. An installed package is not
automatically removed when a flag is omitted; there is no enabling flag or boot
hook in this slice.

## Explicit operations

The defaults are application root `/var/lib/suitecrm/app` and protected state
`/var/lib/suitecrm/clawpilot-native-email-scope-v1`. State must be outside the
application tree, root-owned mode `0700`, and on the same filesystem. Original
files and the manifest are mode `0600`; they are never stored under `public`.

`apply --quiescent` is permitted only as root on Linux, after the operator has
stopped Apache, PHP workers, supervisor, scheduler and Messenger. The process
check rejects those process classes even when `--quiescent` is supplied; it
exempts only its own PID. This check and the installer lock are not a fence
against an uncooperative administrator starting a new process afterward. The
operator must maintain exclusive offline access through completion. No live
hotpatch is supported: this service has `opcache.validate_timestamps=0`.

Every stock input must match the exact SuiteCRM 8.10.1 hash. The helper must
previously be absent. Symlinked paths, hard-linked files, unknown overrides and
unrecorded prior patches hold. All outputs are staged and linted before native
files change. The manifest records each exact relative target, original
presence, original/output SHA-256 and size, UID/GID, permission bits and mtime.
It does not promise restoration of inode, ctime or atime. Atomic individual
renames and directory syncs are journaled; the six-file operation is deliberately
offline, not represented as a single atomic filesystem transaction.

An interrupted `prepared`, `applying` or `restoring` journal reports
`recovery-required` (CLI exit 2). Normal apply refuses it. Unknown current bytes,
metadata or missing/changed backups refuse recovery. Failure before the first
manifest leaves only protected staging/backups and no native modifications;
that unjournaled state requires manual review, never automatic cleanup/adoption.

## Separate native runtime file package

`../install-native-email-runtime.php` installs the prepared publication and
authority PHP dependencies, their explicitly gated OAuth routes and inert SQL
source files. It never executes SQL, bootstraps SuiteCRM, changes configuration,
sets feature flags, creates keys, alters permissions or activates publication.
Its default `check` creates no directories, locks, temporary files or receipts.
The package hash binds every source/target byte and the retained lifecycle-route
choice. `apply --quiescent --approve-package=<independently reviewed hash>` is
an explicit root/offline operation. The protected state defaults to
`/var/lib/suitecrm/clawpilot-native-email-runtime-v1`, outside the application.

Every helper is staged and syntax-checked before publication. The aggregate
router is replaced last; the original audience route and existing record
lifecycle include are retained. Native `Patch.php` is installed in the sibling
include location required by the runtime, not silently omitted. Exact ordinary
preimages, absence, metadata and root-protected originals are journaled. Unknown
helpers, unjournaled prior runtime routes and operator/symlink/backup/staged-file
drift hold. Individual replacements are durable, not one atomic filesystem
transaction. A partial package requires explicit forward recovery with both the
same package hash and retained install ID; no automatic restore or broad prune
is offered. Interruption before the first manifest is a distinct safe hold:
only protected staging/originals may exist, with no native target replacement.
There is no install ID yet, so normal apply/recover deliberately refuses that
state. An operator must separately reconcile every live target with the
independently retained approved preflight metadata, inspect the exact protected
directory and its ownership, then quarantine that one directory recoverably
before retrying. Missing preflight evidence or any target drift requires further
review; do not infer an empty/unchanged installation merely from a missing
manifest, delete the directory, or prune a broader parent. This manual phase is
not covered by the automatic post-manifest forward-recovery claim.

`../native-email-startup-check.php` observes these journals before the service's
URL/config, OAuth, global-ID or cache bootstrap. A verified installed runtime
prevents the legacy installers from overwriting its aggregate router. Initial
enrollment state and activation flags remain held until the separate trusted
PostgreSQL/native settlement and startup-release verifier are implemented.
An elapsed timeout, omitted flag or self-asserted ready JSON does not release a
hold. This startup-release integration is still a release requirement; the file
package and its filesystem tests do not prove it.

Run `node scripts/test-native-email-runtime-installer.mjs` from the repository
root with the cached PHP 8.3.36 test image. Six isolated Linux/root filesystem
groups exercise no-write checking, real other-PHP-process refusal, package
apply/idempotency/router ordering, exact interrupted recovery, drift and startup
holds. Package contents in that fixture are synthetic; it is not native API,
database, real service-image startup, permission or production proof.

`restore --quiescent --approve-restore=<exact-installId>` is a separate explicit
operation. The installation ID is returned by `check`. Restore verifies the
entire manifest and all current/backup files before replacing anything. It
restores only that manifest's originals and removes only its exact new helper,
retaining originals and the journal. Interrupted restoration can resume with the
same explicit approval; a fully restored package cannot be reapplied implicitly.

**Restoring stock files reintroduces the native permission bypasses.** File
restoration is not a secure rollback policy or authorization to perform it.
Review that operation separately, keep service traffic stopped, preserve the
database/volume recovery checkpoint, and prefer a reviewed roll-forward. An image
rollback alone cannot restore files on the persistent volume.

## Local acceptance

In a dedicated disposable root PHP 8.3 Linux container, with no PHP/Apache
workers, mount `services/suitecrm` read-only at `/source`, the original extracted
SuiteCRM 8.10.1 tree read-only at `/stock`, and
`scripts/fixtures/native-email-scope-installer.php` at
`/fixture/native-email-scope-installer.php`. Use disposable `/tmp` storage and run:

```sh
CLAWPILOT_NATIVE_SCOPE_INSTALLER_TEST=1 php /fixture/native-email-scope-installer.php /stock
```

The seven checks cover no-write inspection, actual other-PHP-process refusal,
six-file apply/idempotency, explicit exact restore, interruption after the first
replacement, operator drift, and input/version/symlink refusals. The existing
real native HTTP fixture must separately consume this shared transform to prove
permission behavior. Neither gate grants production deployment authority or
proves a production runtime/profile, publisher, audience repair, or live access.
