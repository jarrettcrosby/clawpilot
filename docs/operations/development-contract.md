# Development Contract (Pointer)

This repository adheres to the **System Operating Contract** for ClawApp development.

**Canonical contract source:** OpenClaw system prompt + latest owner contract message.
**Global deployment contract:** `docs/deployment/DEPLOYMENT_CONTRACT.md` (OpenClaw workspace)

## Summary
- Dev-only work on **port 4002**
- Stable runtime **4001** untouched unless explicitly instructed
- Dev data in **data-dev/**, stable data in **data/**
- One slice = one commit
- Verification must target **4002**
- Promotion readiness must follow `docs/operations/promotion.md`
- Full regression is mandatory before push/promotion: `scripts/regression-all.sh` must be green
- Promotion preflight must include task eligibility gate: `scripts/verify-promotion-task-eligibility.sh` (blocks dev-only/test/validation cards)
- Any slice touching UI actions is incomplete unless UI-visible acceptance passes (`scripts/ui-acceptance.sh` via `scripts/regression-all.sh`)
- **Freshness rule:** any slice that changes app code or routes must rebuild/restart the dev runtime before verification is reported complete
- **Route-aware verification:** if a slice adds/changes a route, verification must hit that route on **4002** after restart
- **Verification diagnostics:** `scripts/dev-verify.sh` must fail with endpoint, HTTP code, and a short response-body snippet for health/runtime probe failures so overnight blockers are triageable without rerunning manually
- **Promotion behavior:** current promotion workflow updates **data/state only** (stable code remains whatever is deployed in the stable repo); code deployment requires a separate stable build/commit update

This document exists to prevent drift; refer to the canonical contract for full details.
