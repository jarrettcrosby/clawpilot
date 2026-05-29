# OpenClaw Deployment Template (Reusable)

This template captures the **standard deployment workflow** for any OpenClaw‑managed app.
Copy into a new app repo and replace placeholders.

## What to copy
- `deployment/` (contract + guard)
- `scripts/` (guard, manifest, verify, watchdog, promotion)
- `docs/operations/` pointers
- Memory/agent pointers (OpenClaw workspace)

## Placeholders to replace
- `ClawApp`
- `/Users/agentsuburbiasandwich/Desktop/clawd-app-dev`
- `/Users/agentsuburbiasandwich/Desktop/clawd-app-dev` / `/Users/agentsuburbiasandwich/Desktop/clawd-app-dev`
- `4002` / `4001`
- `data-dev` / `data`

## Required workflow (unchanged)
1. Preflight verification
2. Alignment dry‑run / apply
3. Promotion readiness
4. Promotion dry‑run
5. Unified runtime verification
6. Rollout freeze
7. Promotion execute (data/state)
8. Stable code deploy
9. Post‑rollout verification
10. Post‑push documentation reconciliation

## Guarding principles
- Operator‑gated prompts for any mutation
- Route‑aware verification
- Immutable audit manifests

See: `deployment/DEPLOYMENT_CONTRACT.md`.
