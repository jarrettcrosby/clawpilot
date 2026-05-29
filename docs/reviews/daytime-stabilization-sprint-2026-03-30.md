# Daytime Stabilization Sprint — 2026-03-30

## Lane / Guardrails
- repo: `/Users/agentsuburbiasandwich/Desktop/clawd-app-dev`
- lane: dev-only (4002)
- production pushes/promotions: none
- infra changes: none

## Completed Slices (so far)
1. Agents task-chat usability: improved task-linked routing and reduced agent-switch context loss.
2. Dashboard actionability: added manual snapshot refresh control.
3. Projects card hardening: explicit ButtonBase import for card quick actions reliability.
4. Projects scanability: added per-card freshness chip (Active/Aging/Stale) for faster real-work recency triage.
5. Dashboard trust/actionability: added stale in-progress metric + one-click stale escalation CTA in Execution & Nightly.
6. Agents task-chat stale continuation: prioritized stale-again active cards in conversation targeting and surfaced inline stale labels in card picker.
7. Board cleanliness / real-work visibility: added explicit “Needs owner” chip on active unassigned cards so unowned work is immediately scannable.
8. Projects scanability/card usefulness: reduced low-signal card metadata by hiding default ClawPilot category chips and low-priority chips in active card metadata rows.
9. Dashboard trust/actionability follow-up: clarified stale escalation cue with owner context, dynamic action label, and quick stale-list jump from Execution & Nightly.
10. Board cleanliness / real-work visibility follow-up: highlighted active stale cards with stronger stale border + `Needs update` chip for faster triage in Projects board views.
11. Agents task-chat usability follow-up: added one-click `Open chat (pick agent)` affordance for unassigned stale cards and preserved unassigned card context in task chat targeting.
12. Dashboard trust/actionability follow-up: added `Verified/Needs verify` confidence chip + explicit last successful verification timestamp in Execution & Nightly.
13. Projects scanability/card usefulness follow-up: removed redundant low-signal metadata tag chips (`needs-quality`, `stale-again`) from card metadata row where dedicated visual cues already exist.
14. Agents task-chat usability follow-up: reduced conversation target picker noise by showing only the top 12 most relevant cards (selected unassigned context first, stale-first priority, recency tie-break) and surfacing a hidden-count hint when additional recent cards are suppressed.
15. Dashboard trust/actionability follow-up: added `View verification evidence` quick-link from Execution & Nightly that deep-links to Docs `promotion-reports` for direct verification context.
16. Projects scanability/card usefulness follow-up: reduced card metadata-row noise by showing only one high-signal freeform tag and collapsing additional tags into a muted `+N tags` indicator.
17. Board cleanliness/real-work visibility follow-up: filtered low-signal system/assignment tags (`projects`, `pipeline`, `docs`, `calendar`, `jarrett`, `clawpilot`) from card metadata chips so active views emphasize actionable work tags.

## Regression Discipline
- After each material slice: `./scripts/regression-all.sh`
- Latest result: `REGRESSION_ALL_OK` (3:50 PM EDT)

## Latest Slice Update
- time: 2026-03-30 3:50 PM EDT
- slice completed: Board cleanliness/real-work visibility follow-up — filtered low-signal system/assignment tags (`projects`, `pipeline`, `docs`, `calendar`, `jarrett`, `clawpilot`) from card metadata chips so active views keep actionable tags visible.
- files changed:
  - app_src/components/projects/KanbanCard.tsx
- regression result: `REGRESSION_ALL_OK` via `./scripts/regression-all.sh`
- remaining blockers: none
- next slice: Dashboard trust/actionability follow-up (add latest verification report timestamp near `View verification evidence` for faster trust checks).

## Quality / Hygiene
- No synthetic tasks left active (regression-created tasks are archived by scripts).
- No blocker currently preventing continued daytime stabilization work.

## Remaining Priority Queue
1. Dashboard trust/actionability follow-up (assess whether verification evidence link should include direct latest report timestamp).
2. Agents task-chat follow-up (only if conversation picker relevance regresses after additional board/dashboard signal changes).
3. Board cleanliness spot-check (confirm no future low-signal/system tags reappear in active card metadata rows).
