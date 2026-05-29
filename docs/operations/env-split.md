# ClawApp Environment Split (Stable + Dev)

## Purpose
Keep daily stable runtime isolated from active dev runtime.

- **Stable**: `/Users/agentsuburbiasandwich/Desktop/clawd-app` on port **4001**
- **Dev**: `/Users/agentsuburbiasandwich/Desktop/clawd-app-dev` on port **4002**

## Required start path
Use control scripts from the stable repo:

```bash
cd /Users/agentsuburbiasandwich/Desktop/clawd-app
scripts/stable-start.sh
scripts/dev-start.sh
```

Do not manually run `next start` in the dev worktree unless all required dev isolation env vars are set.

## Dev isolation env vars (required)
- `TASKS_PATH`
- `PIPELINE_NORMALIZED_PATH`
- `PIPELINE_LOG_PATH`
- `AGENT_THREADS_PATH`
- `AGENT_ASSIGNMENTS_PATH`

`app_src/app/layout.tsx` enforces a fail-fast guard in dev worktree runtime if any required vars are missing.

## Status scripts
```bash
scripts/stable-status.sh
scripts/dev-status.sh
```

## Stop scripts
```bash
scripts/stable-stop.sh
scripts/dev-stop.sh
```

## Dev restart workflow
All development work must start the dev runtime using:

```bash
scripts/dev-start.sh
```

This script guarantees a clean Next.js build and prevents stale chunk errors.

Do **NOT** start dev using:
- `npm run start`
- `next start`
- `node server.js`
