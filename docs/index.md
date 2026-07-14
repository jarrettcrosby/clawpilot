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
- [Agents and execution](modules/agents-and-execution.md)
- [Knowledge, releases, and checkpoints](modules/knowledge-releases-and-checkpoints.md)
- [Shared short links](modules/short-links.md)

## Active Operating Contracts

- [Environments and deployment](operations/clawpilot-environments.md)
- [Knowledge vault organization](operations/knowledge-vault-organization.md)
- [Release documentation contract](releases/README.md)
- [ClawPilot identity](brand/clawpilot-identity.md)

## Architecture Status

The active module contracts are the current architecture surface. Documents under `architecture/` are retained as transition decisions and historical references because none is currently marked active. They must not override an active module or operating contract.

## Build And Release Trail

1. Read the relevant module contract for the behavior that should exist now.
2. Use [ClawPilot environments and deployment](operations/clawpilot-environments.md) for runtime topology and release gates.
3. Use the [release documentation contract](releases/README.md) and [release catalog](releases/catalog.json) for shipped user-facing changes.
4. Use the in-app Versions surface for the durable environment-specific deployment and checkpoint record.
5. Use GitHub pull requests and Git history for code-level evidence.

## Historical Archive

Dated audits, incidents, worklogs, and stabilization plans are historical evidence. They are searchable under Archive but do not define current behavior. `AGENT_MEMORY.md` and `SPEC.md` are historical entry points retained only to redirect old links. Git history preserves their original content.

Older product requirements, user guides, architecture notes, and operations runbooks remain searchable as historical evidence. They are not promoted from this index because several describe the pre-Postgres or legacy OpenClaw application.

The separate legacy Obsidian/OpenClaw vaults are import sources, not live ClawPilot state. New implementation notes belong in the relevant module document or release copy; do not create a new top-level progress log.

## Retrieval Policy

ClawPilot stores user documents in Postgres, with an owner boundary, status, source, category, tags, content hash, and full-text search index. Repository Markdown is synchronized only into the configured owner's catalog; `app_visible: false` excludes a note from the application without removing it from the Obsidian vault.

When content changes, the same transaction queues an embedding job. The worker defaults to a deterministic 256-dimension local vector and combines same-model vector and full-text ranking. External OpenAI semantic vectors require `DOCUMENT_EMBEDDINGS_PROVIDER=openai` and a dedicated `OPENAI_EMBEDDING_API_KEY`. See [Knowledge vault organization](operations/knowledge-vault-organization.md) for metadata, synchronization, and verification rules.
