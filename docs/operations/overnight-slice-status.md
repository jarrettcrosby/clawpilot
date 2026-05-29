# Overnight Slice Status Script

## What changed
Added `scripts/overnight-slice-status.sh` to print a one-command snapshot of branch, HEAD, remote, and working tree dirtiness before/after an overnight slice.

## Why
Overnight cadence needs a fast, repeatable status check that does not mutate state and helps keep commits narrowly scoped.

## Usage
```bash
./scripts/overnight-slice-status.sh                  # plain text (human-readable)
./scripts/overnight-slice-status.sh --json           # JSON (automation-friendly)
./scripts/overnight-slice-status.sh --fail-on-dirty  # exit 1 when working tree is dirty
```

## Expected output
### Text mode
A plain-text block beginning with `OVERNIGHT_SLICE_STATUS` and key/value lines for:
- repo
- branch
- head
- remote
- working_tree
- tracked/staged/untracked change counts
- next_action hint

### JSON mode
A JSON object with the same fields, suitable for ingestion by guard scripts or nightly reporting automation.

## Guard behavior
`--fail-on-dirty` does not change output format; it only changes the exit code:
- exits `0` when working tree is clean
- exits `1` when working tree is dirty
