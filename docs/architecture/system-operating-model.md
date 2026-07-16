---
id: cp-legacy-system-operating-model
title: Historical System Operating Model Pointer
summary: Compatibility pointer from the retired local operating model to the current environment contract.
status: superseded
kind: compatibility-pointer
area: archive
tags: [historical, compatibility, operations]
app_visible: false
---

# Historical System Operating Model Pointer

Use [ClawPilot environments and deployment](../operations/clawpilot-environments.md) for the current branch, runtime, validation, promotion, and rollback contract. This path remains only because `scripts/dev-align-from-prod.sh` still checks it as a compatibility guard. The retired OpenClaw and local `4001` operating model remains in Git history.
