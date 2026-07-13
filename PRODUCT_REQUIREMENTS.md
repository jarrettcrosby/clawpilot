# PRODUCT_REQUIREMENTS.md

## Purpose
Define runtime-true requirements for agent routing, assignment, execution, writeback, and documentation coherence in clawd-app dev lane (4002).

## PR-001 Documentation Coherence (Permanent)
- Any behavior-changing slice is incomplete until required docs are updated.
- Required docs after behavior changes:
  - PRODUCT_REQUIREMENTS.md
  - REQUIREMENTS_TRACEABILITY.md
  - USER_GUIDE.md (if user-facing behavior changed)
  - Agent routing model doc (if routing changed)
- Every slice must include a Reality Check:
  - behavior change
  - mapped requirement
  - docs updated
  - evidence

## PR-002 Product Agent Routing
- Canonical product agents: `projects`, `pipeline`, `docs`, `calendar`, `clawpilot`.
- Canonical execution mapping:
  - projects -> projects
  - pipeline -> pipeline
  - docs -> docs
  - calendar -> calendar
  - clawpilot -> clawpilot-exec
- Legacy aliases are normalized (e.g. `projects-agent`, `pipeline-agent`, `main`, `builder`).

## PR-003 Assignment Model
- Assignment records live in `data-dev/agents/assignments.json`.
- Assignment API normalizes to canonical product agent IDs.
- Task claim persists:
  - `task.assignedAgent` (product agent)
  - `task.execution.assignedAgent` (execution agent)

## PR-004 Execution + Writeback Model
- `/api/agents/threads` requires `agentId + taskId + text`.
- Non-clawpilot product agents execute real OpenClaw agent turns.
- `clawpilot` uses structured decision flow (`delegate` or `respond`).
- Execution results must write back to task:
  - execution status + timestamps + latest note
  - execution summary comment + activity entry
  - execution next action (explicit or derived fallback)
  - docs log append when execution agent is `docs`

## PR-007 UI Agent Surface Coherence
- UI surfaces (Projects, Agents, Drawer, Dashboard controls) must only expose product agents:
  - projects, pipeline, docs, calendar, clawpilot
- Execution/internal agents (`main`, `builder`, etc.) must not appear as selectable/visible UI actors.
- Assignment dropdown values must always resolve to canonical product-agent IDs.

## PR-008 Agent Experience Quality
- Agent replies in task chat must be contextual, human-readable, and action-oriented.
- Every agent response must answer:
  - what changed,
  - what remains,
  - what is waiting on input (if any).
- Zero-fluff output rule (hard):
  - Abstract language is forbidden in execution/writeback output.
  - Disallowed phrases (case-insensitive):
    - `summarized context`
    - `extracted assumptions`
    - `made progress`
    - `prepared next step`
    - `looked into`
    - `reviewed`
    - `investigated`
- Required response structure for execution agents (hard):
  - `Changed`
  - `Remaining`
  - `Waiting on`
- Action-first + blocker behavior (hard):
  - Agent must take at least one concrete forward step before requesting additional input.
  - `Waiting on` appears only when input is truly required.
  - If the same missing input was already requested in-thread, do not repeat the same request; escalate (`Escalation: missing X... owner input required now`).
- Actionable Intake Guard UX micro-polish (dev):
  - When move-to-active is blocked for missing actionable fields, UI must open the card drawer and guide immediate repair inline.
  - Missing owner highlights the assignee control.
  - Missing next action focuses and highlights the next-action input for immediate typing.
  - Inline helper text must echo guard reason (`Missing: ...`) near the editable controls.
  - No rule change: guard criteria remain owner + next action for active columns.
- Task-to-chat flow must be explicit and deterministic:
  - no hidden task auto-selection,
  - chat opens only against an explicit selected task,
  - failures to load/send thread state must surface visible operator feedback (no silent failure).
- Assigned product agent must be visibly shown in task/chat surfaces (no ambiguous assignment state).
- Only product-agent identity is user-visible; execution-agent/internal labels must not leak in user UX.
- ClawPilot responses must follow operator format (no system narration):
  - Current status
  - Blockers
  - Next step
  - Optional delegation suggestion
- Chat UI must preserve multi-line response formatting so status/blocker/next-step structure remains readable (including mobile width).

## PR-009 Operator Priority Panel
- Dashboard must show a "Do This Now" panel with top 3–5 actionable tasks only.
- Ranking must use existing task data:
  - priority
  - due date
  - execution status
  - board position
- Each row must include:
  - title
  - why this matters now (one sentence)
  - blocker (if any)
  - next action (imperative one sentence)
  - assigned agent
- Each row should support lightweight direct actions where relevant:
  - open task
  - open agent chat
  - assign agent when unassigned
- Panel tone must be operator guidance, not analytics dump.

## PR-010 Task Reality State (derived)
- System must derive a runtime task reality state from existing signals (no new persistence fields):
  - `execution.lastResult`
  - `execution.executionStatus`
  - task activity history
  - blocker presence
- Supported states:
  - ACTION_REQUIRED
  - IN_PROGRESS
  - BLOCKED
  - DONE_CONFIRMED
  - DONE_UNCONFIRMED
- Do This Now behavior:
  - exclude DONE_CONFIRMED tasks
  - de-prioritize DONE_UNCONFIRMED tasks
- Completion reconciliation behavior:
  - detect prior-slice effective completion candidates
  - categorize into ready-to-close vs likely-complete vs still-active
  - surface recommendations without auto-closing tasks
- Task drawer should display lightweight completion-awareness labels when relevant:
  - Completed (verified)
  - Likely done

## PR-011 Task Creation Policy (containment)
- Task creation must require explicit contract metadata on every create request:
  - `_createSource`
  - `_actor`
- Requests missing either field are hard-rejected with `400`.
- Canonical allowed manual create sources:
  - `manual-ui`
  - `manual-api`
  - `manual-operator`
  - `manual-user`
- Canonical automation source is defined but default-deny:
  - `automation-clawpilot-approved`
  - requires `ENABLE_AUTOMATION_TASK_CREATE=true`
- Unknown sources are blocked by default.
- **Agents never create tasks. They only propose work.**
  - Agent-originated create attempts are blocked (`TASK_CREATE_AGENT_FORBIDDEN`).
- Suggestion-to-task conversion is default-deny unless explicitly enabled (`ENABLE_SUGGESTION_TASK_CREATE=true`).
- Blocked creation attempts must return operator-readable reason metadata (`policyCode`, `operatorMessage`).
- Every successful creation must append an audit record with timestamp/source/actor to `data-dev/task-creation-audit.jsonl` (dev lane).
- Creation anomaly guard: if more than 3 tasks are created in under 1 minute, flag anomaly and log warning.
- Policy documentation of allowed/blocked paths is canonicalized in `docs/governance/TASK_CREATION_POLICY.md`.

## PR-012 Canonical Work Item Enforcement
- Canonical work-item source of truth is `tasks.json`.
- Canonical fields are:
  - `status`
  - `assignedAgent`
  - `nextAction`
  - `blocker`
  - `activity`
- Task persistence paths must canonicalize and store `task.workItem` from canonical task/execution state.
- Agents and Pipeline surfaces must consume projected canonical work-item state from tasks (view context differences allowed; divergent ownership/status/next-action truth not allowed).
- Dev verification must include invariant checks for:
  - `task.status` == `task.workItem.status`
  - `task.assignedAgent` == `task.workItem.assignedAgent`
  - derived next action == `task.workItem.nextAction`
  - assignment projection parity (`agents/assignments.json` vs task assignment)

## PR-013 Hard Task Quality + Board Hygiene Enforcement
- Task creation is hard-blocked (`400`) when quality requirements are not met:
  - meaningful title (>=3 meaningful chars)
  - non-empty description
  - acceptance criteria (or equivalent checklist)
  - no placeholder values (e.g., `x`, `test`, `tmp`)
- Blocked creation response contract:
  - `policyCode: TASK_INVALID_QUALITY`
  - `operatorMessage: Task must include meaningful title, description, and acceptance criteria.`
- Tiered board gating:
  - **hard-block junk only** (placeholder/empty title, or no meaningful description + no acceptance criteria) is hidden from active backlog/todo intake
  - governance-labeled salvageable cards remain visible for operator cleanup (no silent quarantine)
- Invalid task auto-repair is non-destructive:
  - append activity: `Task blocked due to missing required fields`
  - do not auto-delete
  - do not auto-complete
- Promotion dry-run/execute must enforce board hygiene gate and block with:
  - `PROMOTION_BLOCKED_BOARD_HYGIENE`
  - gate applies to hard-block junk in active intake
- Dev verification must fail if active intake board contains hard-block junk.

## PR-014 Promotion Workflow Authority
- Manual promotion is forbidden.
- All promotions must pass through canonical promotion workflow scripts and gates.
- If `promotion-execute` fails at any gate, the process must stop immediately with no fallback path.

## PR-005 Timeout / Hang Safety
- OpenClaw invocation must be subprocess-hardened:
  - spawned process with controlled stdio
  - explicit timeout watchdog
  - deterministic non-zero exit handling

## PR-006 Nightly Reconciliation
- Nightly run must reconcile docs vs code for routing, assignment, and execution flows.
- If mismatch found: log discrepancy and ship smallest safe fix (docs or code).

## PR-014 Stale Task Triage Panel (Projects, dev lane)
- Stale definition is intentionally simple and runtime-derived:
  - task status is `in-progress`
  - not archived
  - not already tagged `blocked`
  - no update/activity for at least `STALE_TASK_HOURS` (24h)
- Projects view must show a lightweight `Needs Attention` panel for top stale tasks (max 5) in dev.
- Panel actions must be fast (1–2 clicks):
  - Mark blocked (requires short reason)
  - Re-scope (requires next step)
  - Move to todo
  - Archive
- Every action must update canonical task state and append a short triage note/activity via normal task update flow.
- UX should avoid heavy workflow/modals except minimal required input capture for blocked reason / next step.

## PR-015 Canonical State Truth
- System must derive one deterministic, canonical task-state interpretation from existing task/work-item signals (no new persistence model):
  - `Moving`
  - `Waiting`
  - `Blocked`
  - `Ready to close`
- Canonical function: `deriveStateTruth(...)` in `app_src/lib/workItemModel.ts`.
- Deterministic precedence (no overlap):
  1. `Blocked` when blocker exists.
  2. `Ready to close` when checklist is complete OR execution is completed with no next action.
  3. `Waiting` when waiting-on exists or execution is awaiting input.
  4. `Moving` when recent concrete action exists and there is no blocker/awaiting-input state.
- UI must render consistent operator format `[State Chip] — Reason` across:
  - Projects card + drawer
  - Agents task context summary
  - Dashboard priority panel

## PR-016 Next Action Guidance
- System must derive one deterministic next-step recommendation from canonical state/work-item signals using shared logic only.
- Canonical function: `deriveNextActionGuidance(...)` in `app_src/lib/workItemModel.ts`.
- Uses existing canonical fields only:
  - `stateLabel`
  - `waitingOn`
  - `lastConcreteAction`
  - `nextAction`
  - `blocker`
- Mapping rules:
  - `Moving` → one triage action only (checklist/required input), never multi-path suggestions
  - `Waiting` → "Provide X to unblock"
  - `Blocked` → "Resolve blocker: …"
  - `Ready to close` → "Review and close task"
- UI surfaces (lightweight, same task = same guidance):
  - Dashboard top-priority panel
  - Projects card + drawer
  - Agents task context
- Display format: `👉 Next: <action>`

## PR-017 Closure Authority + Single Triage Path
- Closure authority is binary and deterministic for each task:
  - `Closable`
  - `Not closable`
- `Closable` only when:
  - checklist is complete, OR
  - execution is complete and there is no next action.
- If closable, the only allowed operator action text is:
  - `👉 Next: Review and close task`
- If not closable, exactly one triage action is shown:
  - `Provide X to unblock`, OR
  - `Resolve blocker: ...`, OR
  - `Complete checklist item Y`.
- Competing closure interpretation labels must be suppressed in task decision surfaces (e.g., remove `Likely done` parallel signals in drawer/dashboard).

## PR-018 Now Working Neutral No-Recent-Run State
- Shared Now Working derivation logic remains canonical and unchanged.
- When derived state is `No recent run`, UI must render a neutral empty-state card:
  - do not emphasize a specific task title,
  - do not imply an active owner/execution thread.
- `Continue in Agents` action must only be shown when Now Working has meaningful active/waiting context:
  - allowed for `Now working` and `Waiting on`,
  - hidden for `No recent run`.
- Behavior must remain unchanged for `Now working` and `Waiting on` states.

## PR-019 Resolve Stale In-Progress Batch Action
- Stale in-progress task definition (dev Projects batch action):
  - `status === in-progress`
  - no recent agent thread activity
  - no recent execution/activity evidence (same evidence sources as Now Working)
  - age threshold strictly greater than 72 hours
- Projects must expose a small explicit batch action surface:
  - label: `👉 Resolve stale work`
- Batch action is explicit and safe (no silent automation):
  - operator must choose either `Move to todo` or `Mark waiting on`
  - `Mark waiting on` requires a short reason before apply
- Apply behavior updates canonical task records through existing task patch flow only (no new model):
  - `Move to todo` -> status becomes `todo`
  - `Mark waiting on` -> status stays `in-progress` with awaiting-input execution state + reason note
- Changes must reflect immediately across Projects, Dashboard, and Agents by canonical task state refresh.
- Existing intake guard, state truth logic, next action guidance, and zero-fluff behavior must remain unchanged.

## PR-020 Shared Live State Derivation Consistency
- Projects card surface, Agents task context, and Dashboard priority/now-working surfaces must use the same live-state derivation helper for a given task snapshot.
- Canonical helper: `deriveLiveState(...)` in `app_src/lib/liveState.ts`.
- No surface may apply divergent fallback logic that changes the rendered state chip/reason/next guidance for the same task.
- Promotion readiness requires cross-surface consistency so release candidate UX matches across lanes.

## PR-021 Projects Mobile Card Usability (production hotfix)
- On mobile widths (<=600px), Projects board must prioritize card visibility and tap usability over auxiliary operator panels.
- Supplemental panels (`Now Working`, `Agent-ready`, stale batch banner) are hidden on mobile so the card lanes render in the initial viewport.
- Board container must allow vertical recovery scroll on mobile (`overflowY: auto`) while preserving desktop behavior.
- No desktop/tablet redesign is allowed in this fix; scope is mobile card visibility/readability/tap usability.

## PR-022 Trello-style Card Interaction + Agent Hand-off
- On touch devices, tapping a card opens its detail drawer directly (card focus + open in one action).
- Assigned cards expose a direct `Open chat` action from the card to jump into the task-linked Agents thread.
- Interaction must stay explicit and task-bound: chat hand-off includes both `taskId` and assigned product agent context.
- Goal is fewer clicks and faster task-to-agent collaboration without changing board structure.

## PR-023 Agents Context Auto-Bind
- In Agents, when a product agent is selected and no task is currently selected, system auto-binds to that agent’s most recently updated assigned task.
- This auto-bind must not override an explicit user-selected task.
- Goal is immediate, actionable chat context with one fewer manual selection step.

## PR-024 Projects Card Quick Advance + Scanability
- Projects cards should stay glanceable: owner and last activity are presented on one compact line (no extra source noise on card face).
- Cards expose a lightweight `Next` action that advances status along canonical flow:
  - backlog -> todo -> in-progress -> review -> done
- Quick advance must use existing task patch API and preserve current board/state governance behavior.

## PR-025 Agents Default Focus Mode
- Agents default view should prioritize task-linked collaboration controls over low-frequency utilities.
- Non-essential utilities (docs bootstrap / consolidation proposal) are hidden behind an explicit `Show tools` toggle by default.
- Core daily path (select agent -> confirm task context -> send task-linked message) must remain first-class and immediately visible.

## PR-026 Projects Stale Focus Filter
- When stale in-progress cards are detected, Projects must provide a one-click `Focus stale only` toggle in the stale banner.
- Enabling stale focus temporarily filters the board to only stale in-progress candidates, so owners can triage stale work without manual multi-filter setup.
- Stale focus must auto-reset when no stale candidates remain.

## PR-027 Simplified Operational Workflow (supersedes PR-019 through PR-026)
- Projects is one kanban workflow: create, search/filter, assign, edit, drag status, review, complete, and archive.
- Cards show only title, description, priority/category, assigned agent, due date, next action, checklist progress, and a task-linked chat action.
- Governance flags, legends, consolidation proposals, now-working panels, stale detection, startability filters, auto-pickup, execute-once, dispatch audits, and quick-advance controls are removed from Projects.
- Reading tasks must never mutate, hide, retag, or move cards. An attempted active-state move that lacks an owner or next action is rejected explicitly and leaves the card unchanged.
- Backlog creation requires only a meaningful title. Acceptance criteria supplied by an API client are stored as checklist items when no checklist is provided.
- A task has one product-agent assignment. Agent threads must match that assignment and persist messages and result writeback against the task.
- Agent status reflects the hosted provider truthfully. OpenAI Responses API is used only with a valid server-side API key; otherwise messaging is disabled and no synthetic reply is generated.
- Custom GPTs are not treated as an externally callable runtime. ChatGPT-side Actions or MCP integration is a separate reverse-integration path.
