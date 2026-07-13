#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd -P)"
REPO="$(cd "$SCRIPT_DIR/.." && pwd -P)"
cd "$REPO"

changed_files="$(git show --name-only --pretty='' HEAD)"
required_docs=()
behavior_change=false

require_doc() {
  local candidate="$1"
  local existing
  for existing in "${required_docs[@]:-}"; do
    [[ "$existing" == "$candidate" ]] && return
  done
  required_docs+=("$candidate")
}

while IFS= read -r file; do
  [[ -z "$file" ]] && continue
  case "$file" in
    app_src/*|scripts/*|db/migrations/*|railway.json)
      behavior_change=true
      require_doc "docs/index.md"
      ;;
  esac
  case "$file" in
    app_src/app/HomeClient.tsx|app_src/app/login/*|app_src/app/welcome/*|app_src/app/api/auth/*|app_src/app/api/invitations/*|app_src/app/api/users/*|app_src/components/AppHeader.tsx|app_src/components/Navigation.tsx|app_src/components/settings/*|app_src/lib/auth*|app_src/lib/invitations.ts|app_src/lib/users.ts|app_src/proxy.ts)
      require_doc "docs/modules/application-shell-and-access.md"
      ;;
    app_src/components/projects/*|app_src/components/dashboard/*|app_src/app/api/tasks/*|app_src/app/api/workspaces/*|app_src/lib/tenancy.ts|app_src/lib/persistence/tasks.ts)
      require_doc "docs/modules/projects-and-tenancy.md"
      ;;
    app_src/components/pipeline/*|app_src/app/api/pipeline/*|app_src/lib/pipeline*|app_src/lib/persistence/pipeline.ts|scripts/pipeline-outbox-poller.mjs)
      require_doc "docs/modules/pipeline-and-sync.md"
      ;;
    app_src/components/agents/*|app_src/app/api/agents/*|app_src/lib/agents/*|app_src/lib/agentDispatch*|app_src/lib/persistence/agentDispatch.ts|app_src/lib/persistence/execution.ts)
      require_doc "docs/modules/agents-and-execution.md"
      ;;
    app_src/components/docs/*|app_src/components/versions/*|app_src/app/api/docs/*|app_src/app/api/versions/*|app_src/lib/documents.ts|app_src/lib/releases.ts|scripts/record-release.mjs|scripts/verify-doc-*.mjs)
      require_doc "docs/modules/knowledge-releases-and-checkpoints.md"
      ;;
    railway.json|app_src/vercel.json|scripts/start-railway.sh|scripts/vercel-build.mjs|scripts/db-migrate.mjs)
      require_doc "docs/operations/clawpilot-environments.md"
      ;;
  esac
done <<< "$changed_files"

if [[ "$behavior_change" != true ]]; then
  echo "INFO: no behavior-sensitive files in HEAD; doc coherence gate skipped"
  exit 0
fi

missing=()
for document in "${required_docs[@]}"; do
  if ! grep -qx "$document" <<< "$changed_files"; then
    missing+=("$document")
  fi
done

if (( ${#missing[@]} > 0 )); then
  echo "ERROR: documentation coherence gate failed for HEAD commit"
  echo "Missing required current contract updates:"
  for document in "${missing[@]}"; do echo " - $document"; done
  exit 1
fi

echo "OK: documentation coherence gate passed"
