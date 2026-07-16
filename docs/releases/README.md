---
title: Release Documentation Contract
status: active
kind: release-contract
tags: [releases, deployment, changelog]
app_visible: true
---

# Release Documentation Contract

Release documentation is part of deployment work and does not require a separate operator request. The implementation slice updates its owning module or operations contract; promotion adds the environment-specific release entry below. Promotion is incomplete if either layer is stale.

Each promoted deployment must create one idempotent release entry containing:

- commit hash and branch
- target environment
- short user-facing title and summary
- feature bullets
- bug-fix bullets
- deployment timestamp and provider identifier when available

Release copy explains observable product behavior. It must not expose secrets, internal tokens, raw prompts, or customer data. The in-app Versions surface is the canonical user-facing history; GitHub remains the engineering diff and review record.
