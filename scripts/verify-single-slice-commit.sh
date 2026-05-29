#!/usr/bin/env bash
set -euo pipefail

# verify-single-slice-commit.sh
# Ensures a commit is a small, focused "single-slice" change.

MAX_FILES=12
ALLOW_DATA=0

usage() {
  cat <<'EOF'
Usage: scripts/verify-single-slice-commit.sh [--max-files N] [--allow-data]

Checks staged changes in the current git repo and fails when:
- No files are staged
- Staged file count exceeds --max-files (default: 12)
- Staged files include data/ or data-dev/ artifacts (unless --allow-data)
- Staged files span multiple top-level areas (except docs + tests adjuncts)

Top-level area is the first path segment (e.g., app_src, scripts, docs).
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --max-files)
      MAX_FILES="${2:-}"
      shift 2
      ;;
    --allow-data)
      ALLOW_DATA=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown arg: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "SINGLE_SLICE_FAIL: not inside a git repo" >&2
  exit 2
fi

staged=()
while IFS= read -r line; do
  [[ -n "$line" ]] && staged+=("$line")
done < <(git diff --cached --name-only)
count=${#staged[@]}

if (( count == 0 )); then
  echo "SINGLE_SLICE_FAIL: no staged files"
  exit 1
fi

if (( ALLOW_DATA == 0 )); then
  data_paths=()
  for p in "${staged[@]}"; do
    if [[ "$p" == data/* || "$p" == data-dev/* ]]; then
      data_paths+=("$p")
    fi
  done

  if (( ${#data_paths[@]} > 0 )); then
    echo "SINGLE_SLICE_FAIL: staged data artifacts detected (use --allow-data to override)"
    printf 'Data files:\n'
    printf ' - %s\n' "${data_paths[@]}"
    exit 1
  fi
fi

if (( count > MAX_FILES )); then
  echo "SINGLE_SLICE_FAIL: too many staged files ($count > $MAX_FILES)"
  printf 'Staged files:\n'
  printf ' - %s\n' "${staged[@]}"
  exit 1
fi

areas_raw=""
for p in "${staged[@]}"; do
  area="${p%%/*}"
  [[ "$p" == *"/"* ]] || area="(root)"

  case "$area" in
    docs|test|tests|__tests__)
      # docs/tests are adjuncts and don't establish primary slice ownership
      continue
      ;;
  esac

  areas_raw+="$area\n"
done

primary_areas="$(printf "%b" "$areas_raw" | sed '/^$/d' | sort -u)"
primary_count=$(printf "%s\n" "$primary_areas" | sed '/^$/d' | wc -l | tr -d ' ')

if (( primary_count == 0 )); then
  echo "SINGLE_SLICE_OK: staged files are docs/tests only ($count files)"
  exit 0
fi

if (( primary_count > 1 )); then
  echo "SINGLE_SLICE_FAIL: staged files span multiple primary areas"
  printf 'Primary areas: %s\n' "$(printf "%s" "$primary_areas" | tr '\n' ' ')"
  printf 'Staged files:\n'
  printf ' - %s\n' "${staged[@]}"
  exit 1
fi

primary_area=$(printf "%s\n" "$primary_areas" | head -n 1)
echo "SINGLE_SLICE_OK: $count staged file(s), area=$primary_area"
