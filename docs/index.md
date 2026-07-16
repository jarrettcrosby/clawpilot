---
title: ClawPilot Knowledge Index
status: active
kind: knowledge-index
tags: [clawpilot, architecture, operations, releases, search]
app_visible: true
---

# ClawPilot Knowledge Index

This repository is the canonical source for ClawPilot product, engineering, and operating knowledge. Use the [vault map](README.md) for Obsidian navigation. The Docs application indexes this catalog for the configured owner and keeps every other user's generated workspace documents private.

## Active Module Contracts

- [Application shell and access](modules/application-shell-and-access.md)
- [User integrations and credentials](modules/user-integrations.md)
- [Projects and tenancy](modules/projects-and-tenancy.md)
- [Pipeline and synchronization](modules/pipeline-and-sync.md)
- [CRM and workbook reporting](modules/crm-and-reporting.md)
- [Agents and execution](modules/agents-and-execution.md)
- [Knowledge, releases, and checkpoints](modules/knowledge-releases-and-checkpoints.md)
- [Shared short links](modules/short-links.md)

## Active Operating Contracts

- [Environments and deployment](operations/clawpilot-environments.md)
- [Knowledge vault organization](operations/knowledge-vault-organization.md)
- [Release documentation contract](releases/README.md)
- [ClawPilot identity](brand/clawpilot-identity.md)

## Authority Model

The active module contracts are the current product and architecture surface. The environment, knowledge, release, and brand contracts define how that product is operated. Operator-only Google Workspace, ChatGPT authorization, SuiteCRM, and Railway backup runbooks are linked from the [vault map](README.md). No deleted plan, review, or legacy OpenClaw note overrides these contracts; Git history is the source for superseded implementation evidence.

## Build And Release Trail

1. Read the relevant module contract for the behavior that should exist now.
2. Use [ClawPilot environments and deployment](operations/clawpilot-environments.md) for runtime topology and release gates.
3. Use the [release documentation contract](releases/README.md) and [release catalog](releases/catalog.json) for shipped user-facing changes.
4. Use the in-app Versions surface for the durable environment-specific deployment and checkpoint record.
5. Use GitHub pull requests and Git history for code-level evidence.

## Historical Archive

The [2026-03-20 stable-build incident](incidents/2026-03-20-stable-build-integrity-outage.md) is retained as searchable historical evidence because its committed-files-only build lesson remains part of release safety. Provider backup timestamps remain in the operator-only Railway backup runbook because they are recovery evidence.

Superseded product requirements, user guides, architecture proposals, setup handoffs, and stabilization worklogs were consolidated into the active contracts and removed. Their original contents remain available through Git history. Small compatibility pointers remain only where existing app or script configuration still names the path.

The separate legacy Obsidian/OpenClaw vaults are import sources, not live ClawPilot state. New implementation notes belong in the relevant module document or release copy; do not create a new top-level progress log.

## Retrieval Policy

ClawPilot stores user documents in Postgres, with an owner boundary, status, source, category, tags, content hash, and full-text search index. Repository Markdown is synchronized only into the configured owner's catalog; `app_visible: false` excludes a note from the application without removing it from the Obsidian vault.

When content changes, the same transaction queues an embedding job. The worker defaults to a deterministic 256-dimension local vector and combines same-model vector and full-text ranking. The owner can opt into External from **Settings > Integrations > Knowledge** only when a dedicated `OPENAI_EMBEDDING_API_KEY` is configured; external mode sends document content and semantic search input to OpenAI and may incur usage cost. See [Knowledge vault organization](operations/knowledge-vault-organization.md) for metadata, synchronization, privacy, and verification rules.
