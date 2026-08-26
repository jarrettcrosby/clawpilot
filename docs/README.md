---
id: cp-vault-map
title: ClawPilot Vault Map
summary: Human entry point for the canonical repository vault and its current contracts, maps, operations, and history.
status: active
kind: vault-map
area: knowledge
tags: [clawpilot, documentation, navigation, obsidian]
app_visible: false
---

# ClawPilot Vault Map

Open the repository root, not the `docs/` folder, as the Obsidian vault. Start with the [canonical knowledge index](index.md). Portable vault settings are committed; window layout, hotkeys, themes, and community plugins remain local.

## Maps Of Content

- [ClawPilot context map](maps/context-map.md)
- [Product map](maps/product-map.md)
- [Platform and data map](maps/platform-data-map.md)
- [Operations map](maps/operations-map.md)
- [Evolution map](maps/evolution-map.md)

Maps connect topics across folders. The repository uses PARA semantics rather than a disruptive PARA folder migration: active board and release work is Projects, module and operating contracts are Areas, maps, decisions, brand, and research are Resources, and retained incidents plus Git history are Archive.

### Accepted Decisions

- [Decision index](decisions/index.md)
- [Postgres and Sheets authority](decisions/0001-postgres-and-sheets-authority.md)
- [Organization-rooted tenancy](decisions/0002-organization-rooted-tenancy.md)
- [CRM Global Identity and synchronization](decisions/0003-crm-global-identity-and-sync.md)
- [Local-first knowledge retrieval](decisions/0004-local-first-knowledge-retrieval.md)
- [Multi-workspace user membership](decisions/0005-multi-workspace-membership.md)
- [Native distributed operations authority and adapter boundaries](decisions/0006-native-distributed-operations-authority.md)

## Current Contracts

Current product behavior is defined by active module and operating contracts. Operator-only runbooks also use `status: active` but set `app_visible: false` so provider procedures and infrastructure details remain in the repository/Obsidian vault rather than the in-app catalog.

### Modules

- [Application shell and access](modules/application-shell-and-access.md)
- [User integrations and credentials](modules/user-integrations.md)
- [Toast POS and accounting](modules/toast-and-accounting.md)
- [QuickBooks accounting connector](modules/quickbooks-accounting.md)
- [Shipping](modules/shipping.md)
- [Projects and tenancy](modules/projects-and-tenancy.md)
- [Pipeline and synchronization](modules/pipeline-and-sync.md)
- [CRM and workbook reporting](modules/crm-and-reporting.md)
- [Agents and execution](modules/agents-and-execution.md)
- [Knowledge, releases, and checkpoints](modules/knowledge-releases-and-checkpoints.md)
- [Shared short links](modules/short-links.md)
- [Career-site submissions](modules/career-site-submissions.md)

### Operations

- [ClawPilot environments and deployment](operations/clawpilot-environments.md)
- [Codex task continuity](operations/codex-task-continuity.md)
- [Demo account](operations/public-demo-environment.md)
- [Agent security and integration isolation](operations/agent-security-and-isolation.md)
- [Knowledge vault organization](operations/knowledge-vault-organization.md)
- [ChatGPT agent authorization](operations/chatgpt-agent-auth.md)
- [Repository patch runner](operations/repository-patch-runner.md)
- [Google Workspace integration](operations/google-workspace-integration.md)
- [Infrastructure and cost control register](operations/infrastructure-and-cost-control-register.md)
- [Railway Postgres backups](operations/railway-postgres-backups.md)
- [SuiteCRM Railway runbook](operations/suitecrm.md)
- [Sales pipeline EPISCS migration](operations/sales-pipeline-episcs-migration.md)
- [Printing, carrier billing, and GL Coding](operations/printing-carrier-billing-and-gl-coding.md)
- [Local print agent](operations/local-print-agent.md)
- [Release documentation contract](releases/README.md)
- [ClawPilot identity](brand/clawpilot-identity.md)

### Distributed Operations Design

These documents define the accepted authority boundary and staged activation design for DOM, WMS, shipping, and 3PL billing. Bounded development workflows exist for order execution, read-only carrier rating, carrier-bill import, GL Coding, settlement evidence, and local print delivery; they do not claim production commerce or carrier mutations, accounting export, invoice/AR, payments, optimization, or live warehouse workers.

- [Distributed operations integration and gap map](maps/distributed-operations-integration-gap-map.md)
- [Distributed operations domain and architecture contract](modules/distributed-operations.md)
- [Distributed operations delivery, migration, and test plan](architecture/distributed-operations-delivery-plan.md)
- [Brokered parcel and LTL carrier adapters](architecture/brokered-parcel-and-ltl-carrier-adapters.md)
- [Distributed operations runbook](operations/distributed-operations-runbook.md)
- [Native distributed operations authority and adapter boundaries](decisions/0006-native-distributed-operations-authority.md)

### Authority

The active module contracts above are the current product and architecture surface. Operator runbooks contain provider procedures but do not redefine product behavior. Deleted file-backed and OpenClaw designs remain available in Git history and must not be treated as current requirements.

## Build And Release Trail

Use this order to understand progress without reconstructing it from dated worklogs:

1. Start with the [context map](maps/context-map.md) when the question spans modules.
2. Read the relevant active module contract for current behavior.
3. Read a decision record when the reason or tradeoff matters.
4. Read the [environment contract](operations/clawpilot-environments.md) for the deployed topology and validation gates.
5. Read the [release contract](releases/README.md) and [release catalog](releases/catalog.json) for user-facing shipped changes.
6. Use the in-app Versions surface for durable environment-specific releases and checkpoints.
7. Use GitHub pull requests and Git history for implementation-level evidence.

## Historical Archive

Retain historical Markdown only when the event itself has continuing operational value. The [stable-build integrity incident](incidents/2026-03-20-stable-build-integrity-outage.md) remains searchable because it explains a release-safety control. Provider backup evidence remains in the Railway backup runbook. Superseded plans, reviews, requirements matrices, and setup handoffs are removed after their useful conclusions are incorporated into active contracts; Git history preserves their original wording.

## App Search Flow

The configured owner receives notes explicitly marked `app_visible: true` in ClawPilot Docs; other users receive only their own generated and user-owned documents. A changed repository note is stored in Postgres, indexed for full-text search, and queued for a 256-dimension vector. Knowledge defaults to Local with no external content transfer or embedding-provider cost. The owner can select External in **Settings > Integrations > Knowledge** only after a dedicated `OPENAI_EMBEDDING_API_KEY` is configured; external mode sends document content and semantic search input to OpenAI. See [Knowledge vault organization](operations/knowledge-vault-organization.md) for the complete flow.

## Authoring Rule

Every implementation and release updates its owning active contract and release copy as part of the work, without waiting for an operator prompt. Temporary capture belongs in the [knowledge inbox](inbox/README.md) and must be refactored before promotion. Use the committed Obsidian templates for recurring note types. Do not create another top-level progress log. Add a decision, incident, or audit only when its evidence will remain useful. Run `npm run verify:docs` before committing documentation changes.
