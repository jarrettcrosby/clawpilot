# Task Creation Containment Audit — 2026-03-17 (dev 4002)

> Canonical policy now lives at: `docs/governance/TASK_CREATION_POLICY.md`.

## Root-cause / suspected unsafe paths

Primary unsafe paths identified:
1. **Dev suggestion test panel** in Agents module had a direct "Create task" action posting to `/api/tasks`.
2. **Suggestion conversion path** in `PATCH /api/tasks` (`_suggestionAction.action = "task"`) could create new tasks from suggestion payloads.
3. **No explicit intent requirement** on `POST /api/tasks` allowed non-specific create calls.

These paths could produce cards without clear user intent boundaries in day-to-day operation.

## Allowed task creation paths (after containment)

- `POST /api/tasks` with explicit create source metadata (`_createSource` or `x-claw-task-create-source`) and manual allowed source:
  - `manual-ui`
  - `manual-api`
  - `manual-operator`
  - `manual-user`
- Explicit automation path is defined but gated:
  - `automation-clawpilot-approved` + `ENABLE_AUTOMATION_TASK_CREATE=true`

## Blocked/disabled task creation paths (after containment)

- Missing source metadata on `POST /api/tasks`.
- Unknown/unapproved `_createSource` values.
- Automated task creation by `ClawPilot` via `POST /api/tasks` (blocked by default unless `ENABLE_AUTOMATION_TASK_CREATE=true` with approved automation source).
- Suggestion-to-task conversion via `_suggestionAction.action="task"` (blocked by default unless `ENABLE_SUGGESTION_TASK_CREATE=true`).
- Agents dev suggestion test-panel "Create task" action disabled in UI.
- Blocked API responses include operator-readable reason fields (`policyCode`, `operatorMessage`).

## Safety notes

- No blind auto-close introduced.
- No assignment/chat/execution/reconciliation regressions expected from containment guards.
- Containment is reversible via explicit env toggles when safe automation policy is finalized.
