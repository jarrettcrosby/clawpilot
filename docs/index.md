---
id: cp-knowledge-index
title: ClawPilot Knowledge Index
summary: Application-visible index of canonical ClawPilot maps, contracts, decisions, releases, and retained evidence.
status: active
kind: knowledge-index
area: knowledge
tags: [clawpilot, architecture, operations, releases, search]
app_visible: true
---

# ClawPilot Knowledge Index

This repository is the canonical source for ClawPilot product, engineering, and operating knowledge. Use the [vault map](README.md) for Obsidian navigation. The Docs application indexes this catalog for the configured owner and keeps every other user's generated workspace documents private.

## Maps Of Content

- [ClawPilot context map](maps/context-map.md)
- [Product map](maps/product-map.md)
- [Platform and data map](maps/platform-data-map.md)
- [Operations map](maps/operations-map.md)
- [Evolution map](maps/evolution-map.md)

## Accepted Decisions

- [Decision index](decisions/index.md)
- [Postgres and Sheets authority](decisions/0001-postgres-and-sheets-authority.md)
- [Organization-rooted tenancy](decisions/0002-organization-rooted-tenancy.md)
- [CRM Global Identity and synchronization](decisions/0003-crm-global-identity-and-sync.md)
- [Local-first knowledge retrieval](decisions/0004-local-first-knowledge-retrieval.md)
- [Multi-workspace user membership](decisions/0005-multi-workspace-membership.md)
- [Native distributed operations authority and adapter boundaries](decisions/0006-native-distributed-operations-authority.md)
- [Wearable picking Phase 1](modules/wearable-picking.md)
- [Meta Wearables Device Access](integrations/meta-wearables-device-access.md)

## Active Module Contracts

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

## Distributed Operations Design

The following set defines the accepted authority boundary and implementation/operating contract for DOM, WMS, shipping, commerce sales channels, and 3PL billing. Bounded development workflows and the Shopify/Faire credential/capability evidence control plane are implemented for development; hosted deployment evidence is recorded separately. Canonical commerce workers, production provider mutations, and accounting delivery remain pre-activation.

- [Distributed operations integration and gap map](maps/distributed-operations-integration-gap-map.md)
- [Distributed operations domain and architecture contract](modules/distributed-operations.md)
- [Distributed operations delivery, migration, and test plan](architecture/distributed-operations-delivery-plan.md)
- [Distributed operations runbook](operations/distributed-operations-runbook.md)
- [Printing, carrier billing, and GL Coding](operations/printing-carrier-billing-and-gl-coding.md)
- [Local print agent](operations/local-print-agent.md)
- [Native distributed operations authority and adapter boundaries](decisions/0006-native-distributed-operations-authority.md)

## Active Operating Contracts

- [Environments and deployment](operations/clawpilot-environments.md)
- [Infrastructure and cost control register](operations/infrastructure-and-cost-control-register.md)
- [Demo account](operations/public-demo-environment.md)
- [Agent security and integration isolation](operations/agent-security-and-isolation.md)
- [Knowledge vault organization](operations/knowledge-vault-organization.md)
- [Printing, carrier billing, and GL Coding](operations/printing-carrier-billing-and-gl-coding.md)
- [Local print agent](operations/local-print-agent.md)
- [Repository patch runner](operations/repository-patch-runner.md)
- [Release documentation contract](releases/README.md)
- [ClawPilot identity](brand/clawpilot-identity.md)

## Authority Model

The active module contracts are the current product and architecture surface. The environment, knowledge, release, and brand contracts define how that product is operated. The environment contract fixes the accepted target and hosted release ordering: Railway becomes the sole production runtime and migration authority only after exact-commit production acceptance and the gated removal of legacy production-scoped variables from the application Vercel project. The September 5, 2026 Vercel audit shows that retirement is still pending, so Vercel must not yet be described as operationally preview-only. After retirement, any independent Vercel check is a protected compile/UI preview of the exact reviewed commit and never a `dev` or `main` production deployment, persistence check, provider check, or managed-mail check. Operator-only Google Workspace, ChatGPT authorization, SuiteCRM, and Railway backup runbooks are linked from the [vault map](README.md). No deleted plan, review, or legacy OpenClaw note overrides these contracts; Git history is the source for superseded implementation evidence.

## Build And Release Trail

1. Start with the [context map](maps/context-map.md) when the question spans modules.
2. Read the relevant module contract for the behavior that should exist now.
3. Read a decision record when the reason or tradeoff matters.
4. Use [ClawPilot environments and deployment](operations/clawpilot-environments.md) for runtime topology and release gates.
5. Use the [release documentation contract](releases/README.md) and [release catalog](releases/catalog.json) for shipped user-facing changes.
6. Use the in-app Versions surface for the durable environment-specific deployment and checkpoint record.
7. Use GitHub pull requests and Git history for code-level evidence.

## Historical Archive

The [2026-03-20 stable-build incident](incidents/2026-03-20-stable-build-integrity-outage.md) is retained as searchable historical evidence because its committed-files-only build lesson remains part of release safety. Provider backup timestamps remain in the operator-only Railway backup runbook because they are recovery evidence.

Superseded product requirements, user guides, architecture proposals, setup handoffs, and stabilization worklogs were consolidated into the active contracts and removed. Their original contents remain available through Git history. Small compatibility pointers remain only where existing app or script configuration still names the path.

The separate legacy Obsidian/OpenClaw vaults are import sources, not live ClawPilot state. New implementation notes belong in the relevant module document or release copy; do not create a new top-level progress log.

## Retrieval Policy

ClawPilot stores user documents in Postgres, with an owner boundary, status, source, category, tags, content hash, and full-text search index. Repository Markdown is synchronized only into the configured owner's catalog, and only explicit `app_visible: true` notes enter that catalog. Vault-only maps, templates, compatibility pointers, and provider procedures can remain in Obsidian without becoming competing search results.

When content changes, the same transaction queues an embedding job. The worker defaults to a deterministic 256-dimension local vector and combines same-model vector and full-text ranking. The owner can opt into External from **Settings > Integrations > Knowledge** only when a dedicated `OPENAI_EMBEDDING_API_KEY` is configured; external mode sends document content and semantic search input to OpenAI and may incur usage cost. See [Knowledge vault organization](operations/knowledge-vault-organization.md) for metadata, synchronization, privacy, and verification rules.
