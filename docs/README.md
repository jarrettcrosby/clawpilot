---
title: ClawPilot Vault Map
status: active
kind: vault-map
tags: [clawpilot, documentation, navigation, obsidian]
app_visible: false
---

# ClawPilot Vault Map

Open the repository root, not the `docs/` folder, as the Obsidian vault. Start with the [canonical knowledge index](index.md). Portable vault settings are committed; window layout, hotkeys, themes, and community plugins remain local.

## Current Contracts

Current behavior is defined only by documents with `status: active` and `app_visible: true`.

### Modules

- [Application shell and access](modules/application-shell-and-access.md)
- [User integrations and credentials](modules/user-integrations.md)
- [Projects and tenancy](modules/projects-and-tenancy.md)
- [Pipeline and synchronization](modules/pipeline-and-sync.md)
- [CRM and workbook reporting](modules/crm-and-reporting.md)
- [Agents and execution](modules/agents-and-execution.md)
- [Knowledge, releases, and checkpoints](modules/knowledge-releases-and-checkpoints.md)
- [Shared short links](modules/short-links.md)

### Operations

- [ClawPilot environments and deployment](operations/clawpilot-environments.md)
- [Knowledge vault organization](operations/knowledge-vault-organization.md)
- [Google Workspace integration](operations/google-workspace-integration.md)
- [SuiteCRM Railway runbook](operations/suitecrm.md)
- [Release documentation contract](releases/README.md)
- [ClawPilot identity](brand/clawpilot-identity.md)

### Architecture

The active module contracts above are the current architecture surface. Files under `docs/architecture/` have no active metadata and remain transition decisions or historical references until an owner deliberately refreshes and promotes them. This prevents an older file-backed or OpenClaw design from silently becoming authoritative.

## Build And Release Trail

Use this order to understand progress without reconstructing it from dated worklogs:

1. Read the relevant active module contract for current behavior.
2. Read the [environment contract](operations/clawpilot-environments.md) for the deployed topology and validation gates.
3. Read the [release contract](releases/README.md) and [release catalog](releases/catalog.json) for user-facing shipped changes.
4. Use the in-app Versions surface for durable environment-specific releases and checkpoints.
5. Use GitHub pull requests and Git history for implementation-level evidence.

## Historical Archive

Unclassified notes and dated audits remain searchable evidence, not current requirements. The main archive areas are `docs/architecture/`, `docs/incidents/`, `docs/integrations/`, `docs/operations/`, `docs/ops/`, and `docs/reviews/`. Do not mass-edit these files merely to make them appear current. Promote useful conclusions into an active module or operations contract and preserve the original note as evidence.

## App Search Flow

The configured owner receives the repository catalog in ClawPilot Docs; other users receive only their own generated and user-owned documents. A changed repository note is stored in Postgres, indexed for full-text search, and queued for a 256-dimension vector. The worker defaults to a deterministic local vector. External OpenAI embeddings require an explicit provider opt-in and dedicated embedding credential. See [Knowledge vault organization](operations/knowledge-vault-organization.md) for the complete flow.

## Authoring Rule

Update the owning module contract and release copy instead of creating another top-level progress log. Add a dated incident or review only when the event itself is useful evidence. Run `npm run verify:docs` before committing documentation changes.
