---
title: Knowledge Vault Organization
status: active
kind: operations-contract
tags: [docs, obsidian, search, embeddings, postgres]
app_visible: true
---

# Knowledge Vault Organization

## Purpose

Keep ClawPilot product knowledge concise, navigable in Obsidian, and searchable in the application without treating historical build notes as current requirements.

## Source Boundaries

- The canonical vault is the ClawPilot repository root. [Vault Map](../README.md) is its human entry point.
- [Knowledge Index](../index.md) is the application-visible entry point and must cover every active application document.
- Active module and operating contracts describe current behavior.
- Git history preserves superseded plans and implementation notes. Repository Markdown retains only historical incidents or audits with continuing operational value.
- The in-app Versions surface and [release catalog](../releases/catalog.json) describe shipped user-facing changes. GitHub preserves implementation history.

## Metadata Contract

Active documents use YAML frontmatter:

```yaml
---
title: Human-readable title
status: active
kind: module-contract
tags: [clawpilot, module]
app_visible: true
---
```

`status` is one of `draft`, `active`, `superseded`, `historical`, or `generated`. Set `app_visible: false` for a vault-only navigation note. A Markdown file without explicit status is classified as historical, except for the repository root README. Do not add active metadata to a legacy note without reconciling it with the current implementation.

## Repository To App Flow

1. The configured owner opens or refreshes ClawPilot Docs.
2. [`syncRepositoryDocuments`](../../app_src/lib/documents.ts) scans repository Markdown, skips runtime directories and notes with `app_visible: false`, and derives status and category from frontmatter and path.
3. Each note is upserted into `app_documents` under that owner's email and content hash. Other users do not receive repository documents.
4. Postgres full-text search indexes title and content through [migration 0011](../../db/migrations/0011_knowledge_releases_checkpoints.sql).
5. A new or changed content hash queues `document_embedding_jobs` in the same statement. [Migration 0016](../../db/migrations/0016_document_vectors_and_ai_radar.sql) adds the queue, pgvector column, and cosine index.
6. The authenticated worker route at [`/api/docs/embeddings/process`](../../app_src/app/api/docs/embeddings/process/route.ts) calls the [embedding worker](../../app_src/lib/documentEmbeddings.ts). The default `local` provider records a deterministic 256-dimension vector without sending content outside ClawPilot.
7. The owner may switch between `Local` and `External` in **Settings > Integrations > Knowledge**. The audited database preference overrides `DOCUMENT_EMBEDDINGS_PROVIDER`, which remains the bootstrap fallback when no preference exists.
8. Search combines only same-model vector similarity with deterministic full-text ranking. External OpenAI embeddings require a dedicated `OPENAI_EMBEDDING_API_KEY`; without it, the API refuses to enable external mode.

The local vector model requires no external credential, sends no document content outside ClawPilot, and has no embedding-provider usage cost. When external embeddings are explicitly enabled, document content and semantic search input are sent to OpenAI, and `OPENAI_EMBEDDING_MODEL` defaults to `text-embedding-3-small`. The existing worker secret protects the process route. The general agent API key and user ChatGPT/Codex OAuth credentials are never reused for document embeddings.

## Authoring Workflow

1. Find the owning active module or operations contract from the [Vault Map](../README.md).
2. Update current behavior there during the same implementation slice. Documentation is part of the definition of done and does not require a separate operator prompt.
3. Remove or correct superseded statements in the active contract. Keep line-level implementation detail in code and pull requests.
4. Update release copy when observable behavior reaches an environment.
5. Add a dated incident or audit only when preserving event evidence has future diagnostic, recovery, compliance, or decision value.
6. Link a newly active application document from both navigation maps.
7. Run `npm run verify:docs`.

## Implementation And Release Requirement

- A user-facing, operational, data, integration, security, or architecture change is incomplete until the owning active contract is current.
- The implementer owns that update automatically; the operator does not need to request it.
- A promoted deployment also requires an idempotent Versions entry and user-facing release copy.
- Pull requests and commits hold implementation evidence. Active contracts explain the resulting behavior and must not become chronological worklogs.
- If an active contract and the implementation disagree, stop promotion, reconcile the contract and code, and rerun the relevant validation gates.

## Historical Policy

Never delete historical Markdown first. Audit it for still-useful product, module, deployment, operating, recovery, and decision content; capture that content in the owning active contract; verify retained links and navigation; only then delete the superseded file. Git history remains the archive. Keep a historical file when the event itself still supports incident response, recovery, compliance, or an unresolved decision. Retained evidence uses explicit `status: historical` metadata and never overrides an active contract.

## Portable Obsidian State

The committed `.obsidian/` directory contains only link, note-location, appearance, and core-plugin defaults. Workspace layouts, hotkeys, cache, themes, snippets, and community plugins are ignored because they are machine- or user-specific.

## Verification

`npm run verify:docs` checks:

- required active contracts and frontmatter
- coverage of every active application document from both navigation maps
- broken local links in current documents and maps
- portable Obsidian settings with no committed workspace or community-plugin state
- the release catalog's minimum user-facing content contract
