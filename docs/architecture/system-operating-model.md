# System Operating Model (ClawApp)

This repository follows the **System Operating Contract** defined in the main operating instructions for ClawApp development.

**Canonical contract location:** OpenClaw system prompt + the latest contract message from the owner (Jarrett Crosby).

## Key pointers
- Dev runtime: port **4002**
- Stable runtime: port **4001**
- Dev data: **data-dev/**
- Stable data: **data/**
- Checklist-first execution model is canonical
- Governance vocabulary: `app_src/lib/governance/vocab.ts`
- Promotion readiness workflow: `docs/operations/promotion.md`
- Dev runtime freshness rule: rebuild/restart on code/route changes; route-aware verification required
- Rollout freeze: `scripts/freeze-enable.sh` / `scripts/freeze-disable.sh` block write operations during production push
- Promotion execution updates **data/state only**; stable code stays at current stable repo commit until a separate code deploy (`scripts/stable-code-deploy.sh`)

## Governance Rules
- Follow the operating contract in this repository and the latest owner guidance.
- No stable (4001) changes without explicit approval.
- Post‑rollout verification: run `scripts/stable-verify.sh` and `scripts/runtime-verify-all.sh`, recover by restarting stable if health fails.
- Use checklists, verify before reporting completion, and document results.
- Prefer smallest safe change and keep data recoverable.

## Agent Routing Model
- main: architecture, prioritization, decisions
- builder: implementation slices
- docs: documentation updates
- infra: reliability and operations
- calendar: scheduling/coordination

This file is a pointer so future agents follow the same operating contract without drift.
