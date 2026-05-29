# USER_GUIDE.md

## Agents Dashboard (Task-linked chat)

### What is guaranteed now
- Agent chat is task-bound: send requires `agent + task + message`.
- Product agents run real execution (not fallback stubs): Projects, Pipeline, Docs, Calendar.
- Responses write back to the task execution record with status, summary, and next action, plus comment/activity entries.
- UI selectors and assignment controls expose product agents only (no internal execution agent IDs).

### How assignment works
- Assigning from UI/API stores canonical product agent IDs.
- Claiming a task records both product ownership and execution assignment metadata.

### Known behavior for ClawPilot
- ClawPilot in thread mode responds in operator format:
  - `Current status`
  - `Blockers`
  - `Next step`
  - optional `Delegation suggestion`
- ClawPilot avoids system/debug wording and focuses on action.

### Chat experience
- Task-linked chat now requires explicit task context (no hidden auto-selection).
- Clicking an agent without a specific task prompts explicit task selection before chat opens.
- Task context card (title/status/priority/assigned product agent) is shown before sending.
- Send action is disabled until a task is selected, preventing ambiguous messages.
- Thread load/send failures are surfaced in UI notices (no silent failure).
- Internal debug/execution-agent labels are hidden from chat UI; users see product-agent identity only.
- Multi-line agent responses are rendered with preserved line breaks for easier scanning on mobile and desktop.
- Execution-agent replies now enforce zero-fluff concrete format:
  - `Changed`
  - `Remaining`
  - `Waiting on`
- `Changed` must contain concrete visible work (steps/plan/result), not abstract status language.
- Banned abstract phrases are blocked/replaced:
  - `summarized context`
  - `extracted assumptions`
  - `made progress`
  - `prepared next step`
  - `looked into`
  - `reviewed`
  - `investigated`
- Agents make one concrete forward move before requesting additional input.
- `Waiting on` appears only when required input is actually needed.
- If required input is missing, replies ask for one specific item in context (not generic “more details”).
- If the same missing input was already requested in-thread, replies escalate instead of repeating the same request.
- Actionable Intake Guard UX (Projects):
  - If moving a card to active is blocked, the drawer opens automatically for that card.
  - Inline guidance shows the exact missing requirement (`Missing: owner`, `Missing: next action`, or both).
  - Missing owner highlights assignee control.
  - Missing next action focuses and highlights next-action input so you can type immediately.
  - After fixing fields, retry move succeeds without additional workflow steps.

### Dashboard: Do This Now
- Dashboard includes a "Do This Now" panel with only the top priority actions (max 5).
- Each action shows:
  - task title
  - why it matters now
  - blocker (if present)
  - next action (specific imperative)
  - assigned agent
- Each action row includes lightweight controls:
  - Open task
  - Open agent chat (when assigned)
  - Assign agent (when unassigned)
- Ranking combines priority, due date, execution status, and board position using existing task/execution data.
- Completion-awareness is derived at runtime:
  - completed-and-verified work is excluded from Do This Now
  - likely-done work is shown lower unless other urgency signals dominate.

### Task drawer completion hint
- Cards can show lightweight reality labels:
  - Completed (verified)
  - Likely done
- Labels include reconciliation reason text so operators know why closure is recommended.

### Dashboard completion reconciliation
- Dashboard shows a completion reconciliation block that separates:
  - Ready to close
  - Likely complete
- This is recommendation-only: tasks are never auto-closed.

### Task creation policy (containment)
- Task creation requires explicit contract metadata on `POST /api/tasks`:
  - `_createSource`
  - `_actor`
- Missing either field is rejected (`400`).
- Allowed manual create sources:
  - `manual-ui`, `manual-api`, `manual-operator`, `manual-user`
- Automation is default-deny during containment:
  - only defined automation source is `automation-clawpilot-approved`
  - it is allowed only when `ENABLE_AUTOMATION_TASK_CREATE=true`
- Agents never create tasks directly; they can only suggest/propose work.
- Unknown sources and agent-originated create attempts are blocked.
- Suggestion-to-task conversion remains default-deny unless explicitly enabled (`ENABLE_SUGGESTION_TASK_CREATE=true`).
- Every successful create writes an audit event (`timestamp`, `source`, `actor`) to `data-dev/task-creation-audit.jsonl`.
- If more than 3 tasks are created in under 1 minute, an anomaly warning is logged.
- Dashboard now shows task-creation visibility:
  - Tasks created (24h)
  - Last task created (source + actor)
- Existing assignment/chat/execution/reconciliation flows continue to work without enabling new automatic card creation.

### Canonical work-item behavior
- Tasks are the canonical work-item source of truth.
- Canonical state includes:
  - status
  - assigned agent
  - next action
  - blocker
  - activity
- Agent thread responses now include canonical work-item context for the selected task.
- Assignment list is a projection of task state (not an independent source of truth).
- Pipeline API now exposes pipeline-scoped work-item projections from canonical tasks.

### Hard task quality + board hygiene behavior
- Task creation is hard-blocked if quality is insufficient (placeholder title/description, missing meaningful title, missing description, missing acceptance criteria/equivalent).
- Blocked create response includes:
  - `policyCode: TASK_INVALID_QUALITY`
  - `operatorMessage: Task must include meaningful title, description, and acceptance criteria.`
- Tiered board behavior:
  - hard-block junk cards are hidden from active backlog/todo intake
  - governance-labeled but salvageable cards remain visible for cleanup
- Hard-block handling is non-destructive:
  - task is not deleted
  - task is not auto-completed
  - governance activity note is appended for operator action
- Promotion and verification enforce board hygiene on hard-block junk:
  - promotion blocked with `PROMOTION_BLOCKED_BOARD_HYGIENE`
  - dev verify fails on active hard-block hygiene violations

### Reliability behavior
- Agent turn invocation has watchdog timeout protection and deterministic failure behavior.
- If an execution turn fails, the request does not hang indefinitely.

### Projects: Needs Attention (stale triage)
- In dev Projects view, stale in-progress tasks are surfaced in a `Needs Attention` panel.
- Stale means no meaningful update/activity for 24h+ on an in-progress task.
- Panel is intentionally short (top 5) for quick triage.
- Available quick actions:
  - **Mark blocked** (requires short blocker reason)
  - **Re-scope** (requires concrete next step)
  - **Move to todo** (resets execution to awaiting input)
  - **Archive** (for legacy/invalid stale cards)
- Actions update immediately and write a short triage comment/note so board history stays clear.

### State Truth (single-glance status)
- Tasks now show a canonical state-truth line in key surfaces:
  - Projects card
  - Projects drawer
  - Agents task context
  - Dashboard Do This Now panel
- Format: `[State Chip] — Reason`
- States are deterministic:
  - `Blocked` (blocker exists)
  - `Ready to close` (checklist complete, or execution complete with no next action)
  - `Waiting` (waiting-on present or awaiting input)
  - `Moving` (recent concrete action, no blocker, not awaiting input)
- This does not replace detailed fields (status, last action, waiting on); it gives a canonical interpretation so operators do not need to manually reconcile signals.

### Next Action Guidance
- Tasks now include a single recommended next step derived from canonical state/work-item data.
- Format: `👉 Next: <action>`
- Guidance is deterministic and state-aligned:
  - Ready to close → `Review and close task`
  - Blocked → `Resolve blocker: ...`
  - Waiting → `Provide X to unblock`
  - Not closable active work → one triage action only (`Complete checklist item Y` or required input)
- Shown in:
  - Dashboard (Do This Now)
  - Projects card
  - Projects drawer
  - Agents task context

### Now Working neutral state
- `Now Working` uses shared derivation logic across Projects and Dashboard.
- If state is `No recent run`:
  - UI shows neutral empty-state text,
  - no specific task is highlighted as current work,
  - `Continue in Agents` is hidden.
- If state is `Now working` or `Waiting on`:
  - task title, agent, and latest evidence are shown,
  - `Continue in Agents` remains available.

### Resolve stale in-progress work (Projects)
- Projects shows a contextual batch action when stale in-progress cards exist:
  - `👉 Resolve stale work`
- Stale means:
  - task is `in-progress`,
  - no recent agent thread activity,
  - no recent execution/activity evidence,
  - older than 72 hours.
- Batch apply requires explicit operator choice:
  - `Move to todo` (no extra input), or
  - `Mark waiting on` (short reason required).
- No silent automatic changes are applied.
- After apply, board/task truth updates immediately and other surfaces (Dashboard/Agents) reflect the updated state from canonical tasks.

### Closure authority (unambiguous done vs triage)
- Each task has exactly one closure interpretation:
  - Closable, or
  - Not closable
- Closable only when checklist is complete OR execution is complete with no next action.
- If closable, UI shows only:
  - `👉 Next: Review and close task`
- If not closable, UI shows exactly one triage action.
- Conflicting interpretation labels (e.g., parallel `Likely done` decision banners) are suppressed in decision surfaces.

### Shared live state across Projects, Agents, Dashboard
- Projects cards, Agents task context, and Dashboard now use the same live-state derivation source.
- For the same task snapshot, state label/reason/next guidance should match across those surfaces.
- This removes previous cross-surface drift where one view could show outdated fallback interpretation.

### Projects mobile hotfix (card visibility)
- On mobile widths (<=600px), Projects now hides auxiliary operator panels (Now Working, Agent-ready, stale batch banner) so cards remain visible and usable first.
- The board container allows mobile vertical recovery scroll, preventing card lanes from being pushed out of reachable view.
- Desktop/tablet behavior remains unchanged for this hotfix scope.

### Trello-style card interactions and agent hand-off
- On touch devices, tapping a card opens the card drawer directly (one action instead of focus-then-open).
- Assigned cards now include `Open chat`, which jumps directly into task-linked chat in Agents for that card.
- This keeps collaboration card-centric: open card → hand off to agent thread without extra navigation steps.

### Agents quick context auto-bind
- In Agents, if you pick an agent and no card is currently selected, the chat automatically binds to that agent’s most recently updated assigned card.
- Explicit card selections are still respected; auto-bind only fills the empty-context case.

### Projects card quick actions (daily flow)
- Card surface is simplified for faster scanning: owner + last activity are shown in one compact line.
- Cards now include a `Next` quick action to move forward through normal board flow:
  - backlog → todo → in-progress → review → done
- Assigned cards still provide direct `Open chat` hand-off into task-linked agent conversation.

### Agents default focus mode
- Agents now defaults to a collaboration-first view.
- Utility actions like `Run Docs Agent` and `Propose Consolidation` are moved behind `Show tools`.
- This keeps the main task-chat workflow front-and-center for daily use.

### Projects stale focus filter
- When stale in-progress cards are detected, the stale banner includes `Focus stale only`.
- Turning it on narrows the board to stale candidates so you can triage old work without building manual filters.
- The header shows `· stale only` while active, and focus mode clears automatically once stale candidates are gone.
