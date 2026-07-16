---
id: cp-ops-knowledge-vault
title: Knowledge Vault Organization
summary: Canonical vault structure, Maps of Content, metadata, authoring, indexing, vectors, history, and verification.
status: active
kind: operations-contract
area: knowledge
tags: [docs, obsidian, search, embeddings, postgres]
app_visible: true
---

# Knowledge Vault Organization

## Purpose

Keep ClawPilot product knowledge concise, navigable in Obsidian, and searchable in the application without treating historical build notes as current requirements.

## Source Boundaries

- The canonical vault is the ClawPilot repository root. [Vault Map](../README.md) is its human entry point.
- [Knowledge Index](../index.md) is the application-visible entry point and must cover every active application document. [ClawPilot Context Map](../maps/context-map.md) is the root Map of Content for cross-module retrieval.
- Active module and operating contracts describe current behavior.
- [Decision records](../decisions/index.md) explain durable tradeoffs but do not replace current contracts.
- Git history preserves superseded plans and implementation notes. Repository Markdown retains only historical incidents or audits with continuing operational value.
- The in-app Versions surface and [release catalog](../releases/catalog.json) describe shipped user-facing changes. GitHub preserves implementation history.

## Metadata Contract

Active documents use YAML frontmatter:

```yaml
---
id: cp-module-short-name
title: Human-readable title
summary: One sentence that makes the note useful in search results.
status: active
kind: module-contract
area: product
tags: [clawpilot, module]
app_visible: true
---
```

`id` is a unique stable `cp-...` identifier. `status` is one of `draft`, `active`, `superseded`, `historical`, or `generated`. `kind` controls note purpose, and `area` creates a retrieval cluster independent of folder placement. Only explicit `app_visible: true` notes enter the owner Docs catalog; omission and `false` both remain vault-only. Do not add active metadata to a legacy note without reconciling it with the current implementation.

## Knowledge Model

ClawPilot applies the useful parts of PARA and proto-Zettelkasten without turning the repository into a chronological notebook:

- Projects: active implementation and release work lives on project boards and in Versions.
- Areas: `docs/modules` and `docs/operations` hold maintained responsibilities and current contracts.
- Resources: `docs/maps`, `docs/decisions`, `docs/brand`, and bounded research connect reusable knowledge.
- Archive: retained incidents and Git history preserve historical evidence.

Maps of Content connect notes across those areas. A note may be relevant to CRM, tenancy, identity, and operations at the same time, so graph links carry the relationship instead of duplicating the file into several folders. The [context map](../maps/context-map.md) links the product, platform/data, operations, evolution, and decision maps.

## Repository To App Flow

1. The configured owner opens or refreshes ClawPilot Docs.
2. [`syncRepositoryDocuments`](../../app_src/lib/documents.ts) scans repository Markdown, skips runtime directories, and includes only notes with explicit `app_visible: true`. It derives status and category from structured frontmatter and path.
3. Each note is upserted into `app_documents` under that owner's email and content hash. Other users do not receive repository documents.
4. Postgres full-text search indexes title and content through [migration 0011](../../db/migrations/0011_knowledge_releases_checkpoints.sql).
5. A new or changed content hash queues `document_embedding_jobs` in the same statement. [Migration 0016](../../db/migrations/0016_document_vectors_and_ai_radar.sql) adds the queue, pgvector column, and cosine index.
6. The authenticated worker route at [`/api/docs/embeddings/process`](../../app_src/app/api/docs/embeddings/process/route.ts) calls the [embedding worker](../../app_src/lib/documentEmbeddings.ts). The default `local` provider records a deterministic 256-dimension vector without sending content outside ClawPilot.
7. The owner may switch between `Local` and `External` in **Settings > Integrations > Knowledge**. The audited database preference overrides `DOCUMENT_EMBEDDINGS_PROVIDER`, which remains the bootstrap fallback when no preference exists.
8. Search combines only same-model vector similarity with deterministic full-text ranking. External OpenAI embeddings require a dedicated `OPENAI_EMBEDDING_API_KEY`; without it, the API refuses to enable external mode.

The local vector model requires no external credential, sends no document content outside ClawPilot, and has no embedding-provider usage cost. When external embeddings are explicitly enabled, document content and semantic search input are sent to OpenAI, and `OPENAI_EMBEDDING_MODEL` defaults to `text-embedding-3-small`. The existing worker secret protects the process route. The general agent API key and user ChatGPT/Codex OAuth credentials are never reused for document embeddings.

## Authoring Workflow

1. Start at the closest Map of Content and find the owning active module or operations contract.
2. Put unprocessed observations in the [knowledge inbox](../inbox/README.md) only when they cannot be refactored immediately.
3. Update current behavior in the owning contract during the same implementation slice. Documentation is part of the definition of done and does not require a separate operator prompt.
4. Add a decision record only for a durable cross-module choice, and link it from the decision and topic maps.
5. Remove or correct superseded statements in the active contract. Keep line-level implementation detail in code and pull requests.
6. Update release copy when observable behavior reaches an environment.
7. Add a dated incident or audit only when preserving event evidence has future diagnostic, recovery, compliance, or decision value.
8. Link a newly active application document from both navigation indexes and at least one topic map.
9. Delete processed inbox notes and run `npm run verify:docs`.

## Implementation And Release Requirement

- A user-facing, operational, data, integration, security, or architecture change is incomplete until the owning active contract is current.
- The implementer owns that update automatically; the operator does not need to request it.
- A promoted deployment also requires an idempotent Versions entry and user-facing release copy.
- Pull requests and commits hold implementation evidence. Active contracts explain the resulting behavior and must not become chronological worklogs.
- If an active contract and the implementation disagree, stop promotion, reconcile the contract and code, and rerun the relevant validation gates.

## Historical Policy

Never delete historical Markdown first. Audit it for still-useful product, module, deployment, operating, recovery, and decision content; capture that content in the owning active contract; verify retained links and navigation; only then delete the superseded file. Git history remains the archive. Keep a historical file when the event itself still supports incident response, recovery, compliance, or an unresolved decision. Retained evidence uses explicit `status: historical` metadata and never overrides an active contract.

## Portable Obsidian State

The committed `.obsidian/` directory contains only link, note-location, appearance, core-plugin, and template defaults. Core graph, backlinks, outgoing links, properties, search, and templates support the workflow without a community-plugin dependency. Workspace layouts, hotkeys, cache, themes, snippets, and community plugins are ignored because they are machine- or user-specific. Add a plugin only after repeated use proves that the same result cannot be maintained simply.

## Verification

`npm run verify:docs` checks:

- unique stable IDs, summaries, areas, tags, statuses, and visibility metadata
- coverage of every active application document from both navigation maps
- broken local links and orphaned application-visible notes
- minimum link density for Maps of Content
- portable Obsidian settings with no committed workspace or community-plugin state
- the release catalog's minimum user-facing content contract
