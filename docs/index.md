---
title: ClawPilot Knowledge Index
status: active
kind: knowledge-index
tags: [clawpilot, architecture, operations, releases]
app_visible: true
---

# ClawPilot Knowledge Index

This repository is the canonical source for ClawPilot product, engineering, and operating knowledge. The Docs application indexes this catalog for the configured owner and keeps every other user's generated workspace documents private.

## Active Contracts

- [Application shell and access](modules/application-shell-and-access.md)
- [Projects and tenancy](modules/projects-and-tenancy.md)
- [Pipeline and synchronization](modules/pipeline-and-sync.md)
- [Agents and execution](modules/agents-and-execution.md)
- [Knowledge, releases, and checkpoints](modules/knowledge-releases-and-checkpoints.md)
- [Environments and deployment](operations/clawpilot-environments.md)
- [Release documentation contract](releases/README.md)
- [ClawPilot identity](brand/clawpilot-identity.md)

## Releases

- The in-app Versions surface is the user-facing deployment and checkpoint record.
- Release copy is recorded only after the Railway runtime passes its own health contract.

## History Policy

Dated audits, incidents, worklogs, and stabilization plans are historical evidence. They are searchable under Archive but do not define current behavior. `AGENT_MEMORY.md` and `SPEC.md` are historical entry points retained only to redirect old links. Git history preserves their original content.

Older product requirements, user guides, architecture notes, and operations runbooks remain searchable as historical evidence. They are not promoted from this index because several describe the pre-Postgres or legacy OpenClaw application.

The separate legacy Obsidian/OpenClaw vaults are import sources, not live ClawPilot state. New implementation notes belong in the relevant module document or a dated release entry; do not create a new top-level progress log.

## Retrieval Policy

ClawPilot stores user documents in Postgres, with an owner boundary, status, source, category, tags, content hash, and full-text search index. Repository documents are synchronized into that catalog without mixing them into another user's workspace. Semantic embeddings are intentionally deferred until the historical corpus is classified and a credential/cost policy is approved; the current index is deterministic and auditable.
