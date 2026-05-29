#!/usr/bin/env bash
set -euo pipefail

REPO="/Users/agentsuburbiasandwich/Desktop/clawd-app-dev"
cd "$REPO"

REQ_DOCS=(
  "PRODUCT_REQUIREMENTS.md"
  "REQUIREMENTS_TRACEABILITY.md"
)

ROUTING_DOC="docs/architecture/AGENT_ROUTING_MODEL.md"
USER_GUIDE_DOC="USER_GUIDE.md"

changed_files=$(git show --name-only --pretty='' HEAD)

needs_docs=false
needs_routing_doc=false
needs_user_guide=false

while IFS= read -r f; do
  [[ -z "$f" ]] && continue
  if [[ "$f" =~ ^app_src/lib/agents/routing\.ts$ ]] || [[ "$f" =~ ^app_src/app/api/agents/ ]] || [[ "$f" =~ ^app_src/app/api/tasks/.*/claim/route\.ts$ ]] || [[ "$f" =~ ^app_src/components/ ]]; then
    needs_docs=true
  fi
  if [[ "$f" =~ ^app_src/lib/agents/routing\.ts$ ]]; then
    needs_routing_doc=true
  fi
  if [[ "$f" =~ ^app_src/components/ ]] || [[ "$f" =~ ^app_src/app/api/agents/threads/route\.ts$ ]]; then
    needs_user_guide=true
  fi
done <<< "$changed_files"

if [[ "$needs_docs" != true ]]; then
  echo "INFO: no behavior-sensitive files in HEAD; doc coherence gate skipped"
  exit 0
fi

missing=()
for d in "${REQ_DOCS[@]}"; do
  if ! grep -qx "$d" <<< "$changed_files"; then
    missing+=("$d")
  fi
done

if [[ "$needs_routing_doc" == true ]] && ! grep -qx "$ROUTING_DOC" <<< "$changed_files"; then
  missing+=("$ROUTING_DOC")
fi

if [[ "$needs_user_guide" == true ]] && ! grep -qx "$USER_GUIDE_DOC" <<< "$changed_files"; then
  missing+=("$USER_GUIDE_DOC")
fi

if (( ${#missing[@]} > 0 )); then
  echo "ERROR: documentation coherence gate failed for HEAD commit"
  echo "Missing required doc updates:"
  for m in "${missing[@]}"; do echo " - $m"; done
  exit 1
fi

echo "OK: documentation coherence gate passed"
