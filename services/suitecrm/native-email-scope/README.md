# Offline native Email scope patch

This package is **not enabled, copied into the service image, or called at startup**.
It installs files only: no SuiteCRM bootstrap, database connection, role/group
changes, user status changes, publication, or historical repair. The existing
audience verifier and publication holds remain unchanged.

`Patch.php` is the shared exact five-file transform. Its output hashes are pinned
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
