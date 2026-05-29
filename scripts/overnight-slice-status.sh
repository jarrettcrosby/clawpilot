#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

format="text"
fail_on_dirty=0

for arg in "$@"; do
  case "$arg" in
    --json)
      format="json"
      ;;
    --fail-on-dirty)
      fail_on_dirty=1
      ;;
    *)
      echo "Usage: $0 [--json] [--fail-on-dirty]" >&2
      exit 2
      ;;
  esac
done

branch="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "unknown")"
short_sha="$(git rev-parse --short HEAD 2>/dev/null || echo "unknown")"
remote_name="$(git remote 2>/dev/null | head -n 1 || true)"
if [[ -z "$remote_name" ]]; then
  remote_name="none"
fi

tracked_changed="$(git diff --name-only --diff-filter=ACMR | wc -l | tr -d ' ')"
staged_changed="$(git diff --cached --name-only --diff-filter=ACMR | wc -l | tr -d ' ')"
untracked_changed="$(git ls-files --others --exclude-standard | wc -l | tr -d ' ')"

if [[ "$tracked_changed" -eq 0 && "$staged_changed" -eq 0 && "$untracked_changed" -eq 0 ]]; then
  working_tree="clean"
else
  working_tree="dirty"
fi

if [[ "$working_tree" == "dirty" ]]; then
  next_action="commit-only-the-intended-slice"
else
  next_action="safe-to-start-next-slice"
fi

export ROOT_DIR branch short_sha remote_name working_tree tracked_changed staged_changed untracked_changed next_action

if [[ "$format" == "json" ]]; then
  python3 - <<'PY'
import json
import os

payload = {
    "repo": os.environ["ROOT_DIR"],
    "branch": os.environ["branch"],
    "head": os.environ["short_sha"],
    "remote": os.environ["remote_name"],
    "working_tree": os.environ["working_tree"],
    "tracked_changes": int(os.environ["tracked_changed"]),
    "staged_changes": int(os.environ["staged_changed"]),
    "untracked_changes": int(os.environ["untracked_changed"]),
    "next_action": os.environ["next_action"],
}
print(json.dumps(payload, indent=2))
PY
else
  printf 'OVERNIGHT_SLICE_STATUS\n'
  printf 'repo=%s\n' "$ROOT_DIR"
  printf 'branch=%s\n' "$branch"
  printf 'head=%s\n' "$short_sha"
  printf 'remote=%s\n' "$remote_name"
  printf 'working_tree=%s\n' "$working_tree"
  printf 'tracked_changes=%s\n' "$tracked_changed"
  printf 'staged_changes=%s\n' "$staged_changed"
  printf 'untracked_changes=%s\n' "$untracked_changed"
  printf 'next_action=%s\n' "$next_action"
fi

if [[ "$fail_on_dirty" -eq 1 && "$working_tree" == "dirty" ]]; then
  exit 1
fi
