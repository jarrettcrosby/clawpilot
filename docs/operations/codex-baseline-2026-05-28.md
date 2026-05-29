# Codex Baseline - 2026-05-28

## Purpose

Establish the current Codex handoff baseline before deeper ClawPilot refactor work.

This document records verified source mapping, runtime health, existing dirty-state risk, and validation evidence for the dev lane.

## Source Map

- Dev lane: `/Users/agentsuburbiasandwich/Desktop/clawd-app-dev`
- Dev port: `4002`
- Dev branch at original baseline: `dev/worktree`
- Dev branch after project setup: `dev`
- Dev commit at baseline: `2b2094e`
- Stable/prod lane: `/Users/agentsuburbiasandwich/Desktop/clawd-app`
- Stable/prod port: `4001`
- Stable/prod git state: detached at `5970420`
- ClawPilot Obsidian vault: `/Users/agentsuburbiasandwich/Desktop/Jarrett Crosby - ClawPilot`
- Eigen Racing Obsidian vault: `/Users/agentsuburbiasandwich/Desktop/Jarrett Crosby - Eigen Racing OS`

## Operating Rules Confirmed

- `4002` is the default development lane.
- `4001` is protected stable/prod and must not be mutated without explicit approval.
- The ClawPilot vault is CTO/product operating memory, not code or runtime truth.
- Code and implementation behavior are verified from the repo and live runtime.
- Runtime facts are verified through status scripts and `/api/runtime` / `/api/health`.

## Runtime Baseline

- `bash scripts/dev-status.sh`: running on port `4002`, health ok, lane ok, runtime port ok.
- `GET http://127.0.0.1:4002/api/runtime`: lane `dev`, port `4002`, repo path `/Users/agentsuburbiasandwich/Desktop/clawd-app-dev`.
- `GET http://127.0.0.1:4002/api/health`: `ok`.
- Stable/prod `4001` was not started or changed during this baseline pass.

## Existing Dirty State

The dev worktree was already dirty before this baseline document was added.

Tracked state before this doc:

- 34 tracked files changed.
- Diff size before this doc: 6509 insertions, 14544 deletions.
- Large data churn exists in `data-dev/tasks.json`, `data-dev/deleted-tasks.json`, `data/tasks.json`, and related agent/pipeline data files.
- Several March audit/review docs are untracked under `docs/operations/` and `docs/reviews/`.

The ClawPilot vault was also dirty before this pass, mostly generated mirror/session/status files. Those files were inspected but not edited.

## Validation Evidence

Commands run from `/Users/agentsuburbiasandwich/Desktop/clawd-app-dev` unless noted.

- `cd app_src && npm run lint`
  - Pass, 0 errors, 13 warnings.
- `cd app_src && npm run build`
  - Pass.
  - Existing Next.js warning: `middleware` file convention is deprecated in favor of `proxy`.
- `cd app_src && npm run test:threads`
  - Pass: `PASS test-agent-thread-store`.
- `bash scripts/dev-verify.sh`
  - Pass: `VERIFY_OK`.
- `bash scripts/regression-all.sh`
  - Pass: `REGRESSION_ALL_OK`.

Regression created and archived validation tasks as part of normal test behavior, so additional data-file churn after this baseline is expected.

## Browser Smoke Evidence

Checked the live app in the Codex in-app browser on `http://127.0.0.1:4002`.

- Dashboard rendered with `Promotion Readiness` and `Do This Now`.
- Projects rendered with task counts and `Now Working`.
- Agents rendered with 5 agents and task-linked collaboration controls.
- Pipeline initially showed loading skeletons, then rendered after the data request completed.
- Pipeline final state showed:
  - Pipeline Value: `$2,031,595`
  - Weighted Value: `$420,277`
  - Open: `12`
  - High Priority Open: `4`
  - Closed: `30`
  - Sync status: `In sync`
- Browser console error count during smoke: `0`.
- Screenshot evidence: `/Users/agentsuburbiasandwich/Documents/Codex/2026-05-28/i-have-an-application-that-i/clawpilot-pipeline-loaded.png`

## Refactor Risk Register

High-risk areas for the next slices:

- File-backed task persistence and concurrent mutation boundaries.
- Assignment projection parity between task state and agent assignment files.
- Agent thread storage and task-scoped thread isolation.
- Runtime status/start scripts and dev/stable environment split.
- Promotion scripts that cross the dev/control repo boundary.
- Large dirty data files that should not be casually promoted.

Lower-risk cleanup areas:

- Remaining lint warnings in docs helpers, `KanbanBoard`, `ReadOnlyChecklist`, `responder.mjs`, `autoPickupService.ts`, and `pipelineDropdownSync.ts`.
- The Next.js `middleware` to `proxy` migration warning.

## Recommended Next Slice

Next slice: task persistence boundary review.

Objective:

- Map all write paths into `tasks.json`, assignment files, deleted-task files, and agent thread files.
- Identify which routes still do read-modify-write outside one serialized repository boundary.
- Propose the smallest implementation slice that centralizes mutation without changing user-facing behavior.

Acceptance:

- No stable/prod mutation.
- Keep dev runtime on `4002`.
- Preserve existing task/agent behavior.
- Run `npm run lint`, `npm run build`, `npm run test:threads`, `bash scripts/dev-verify.sh`, and `bash scripts/regression-all.sh`.
