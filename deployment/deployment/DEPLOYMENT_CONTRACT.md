# ClawApp Deployment Contract (Template)

This is the mandatory OpenClaw deployment workflow. Replace placeholders and keep ordering intact.

## Required workflow (Dev → Prod)
1) Preflight verification
- `/Users/agentsuburbiasandwich/Desktop/clawd-app-dev/scripts/dev-verify.sh`
- `/Users/agentsuburbiasandwich/Desktop/clawd-app-dev/scripts/dev-align-from-prod.sh --dry-run --report`
- `/Users/agentsuburbiasandwich/Desktop/clawd-app-dev/scripts/dev-promotion-check.sh`
- `/Users/agentsuburbiasandwich/Desktop/clawd-app-dev/scripts/promotion-dry-run.sh`
- `/Users/agentsuburbiasandwich/Desktop/clawd-app-dev/scripts/runtime-verify-all.sh` with route‑aware checks

2) Rollout freeze (required)
- `/Users/agentsuburbiasandwich/Desktop/clawd-app-dev/scripts/freeze-enable.sh "production rollout"`

3) Data/state promotion (operator‑gated)
- `/Users/agentsuburbiasandwich/Desktop/clawd-app-dev/scripts/promotion-execute.sh` (type `PROMOTE`)

4) Stable code deployment (operator‑gated, if needed)
- `/Users/agentsuburbiasandwich/Desktop/clawd-app-dev/scripts/stable-code-deploy.sh --commit <sha>` (type `DEPLOY`)

5) Post‑rollout verification (required)
- `/Users/agentsuburbiasandwich/Desktop/clawd-app-dev/scripts/stable-verify.sh` (or direct route checks)
- `/Users/agentsuburbiasandwich/Desktop/clawd-app-dev/scripts/runtime-verify-all.sh`

6) Freeze disable (required)
- `/Users/agentsuburbiasandwich/Desktop/clawd-app-dev/scripts/freeze-disable.sh`

7) Post‑push documentation reconciliation (required)
- update ops docs + Governance/SOP surfaces + memory pointers
