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

Current product behavior is defined by active module and operating contracts. Operator-only runbooks also use `status: active` but set `app_visible: false` so provider procedures and infrastructure details remain in the repository/Obsidian vault rather than the in-app catalog.

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
- [ChatGPT agent authorization](operations/chatgpt-agent-auth.md)
- [Google Workspace integration](operations/google-workspace-integration.md)
- [Railway Postgres backups](operations/railway-postgres-backups.md)
- [SuiteCRM Railway runbook](operations/suitecrm.md)
- [Release documentation contract](releases/README.md)
- [ClawPilot identity](brand/clawpilot-identity.md)

### Authority

The active module contracts above are the current product and architecture surface. Operator runbooks contain provider procedures but do not redefine product behavior. Deleted file-backed and OpenClaw designs remain available in Git history and must not be treated as current requirements.

## Build And Release Trail

Use this order to understand progress without reconstructing it from dated worklogs:

1. Read the relevant active module contract for current behavior.
2. Read the [environment contract](operations/clawpilot-environments.md) for the deployed topology and validation gates.
3. Read the [release contract](releases/README.md) and [release catalog](releases/catalog.json) for user-facing shipped changes.
4. Use the in-app Versions surface for durable environment-specific releases and checkpoints.
5. Use GitHub pull requests and Git history for implementation-level evidence.

## Historical Archive

Retain historical Markdown only when the event itself has continuing operational value. The [stable-build integrity incident](incidents/2026-03-20-stable-build-integrity-outage.md) remains searchable because it explains a release-safety control. Provider backup evidence remains in the Railway backup runbook. Superseded plans, reviews, requirements matrices, and setup handoffs are removed after their useful conclusions are incorporated into active contracts; Git history preserves their original wording.

## App Search Flow

The configured owner receives the repository catalog in ClawPilot Docs; other users receive only their own generated and user-owned documents. A changed repository note is stored in Postgres, indexed for full-text search, and queued for a 256-dimension vector. Knowledge defaults to Local with no external content transfer or embedding-provider cost. The owner can select External in **Settings > Integrations > Knowledge** only after a dedicated `OPENAI_EMBEDDING_API_KEY` is configured; external mode sends document content and semantic search input to OpenAI. See [Knowledge vault organization](operations/knowledge-vault-organization.md) for the complete flow.

## Authoring Rule

Every implementation and release updates its owning active contract and release copy as part of the work, without waiting for an operator prompt. Do not create another top-level progress log. Add a dated incident or audit only when the evidence will remain useful. Run `npm run verify:docs` before committing documentation changes.
