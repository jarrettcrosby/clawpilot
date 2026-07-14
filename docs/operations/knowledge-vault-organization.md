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
- Unclassified notes, dated audits, incidents, reviews, and prior architecture files remain historical evidence.
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
7. Search combines only same-model vector similarity with deterministic full-text ranking. External OpenAI embeddings require the explicit `DOCUMENT_EMBEDDINGS_PROVIDER=openai` opt-in and a dedicated `OPENAI_EMBEDDING_API_KEY`.

The local vector model requires no external credential. When external embeddings are explicitly enabled, `OPENAI_EMBEDDING_MODEL` defaults to `text-embedding-3-small`. The existing worker secret protects the process route. The general agent API key and user ChatGPT/Codex OAuth credentials are never reused for document embeddings.

## Authoring Workflow

1. Find the owning active module or operations contract from the [Vault Map](../README.md).
2. Update current behavior there. Keep implementation detail in code and pull requests.
3. Update release copy when the behavior reaches an environment.
4. Add a dated incident or review only when preserving event evidence has future value.
5. Link a newly active application document from both navigation maps.
6. Run `npm run verify:docs`.

## Historical Policy

Historical notes stay in place so links and Git history remain intact. Search can surface them under Archive, but their status prevents them from presenting as current contracts. When a historical conclusion is still valid, summarize it in the owning active document and link the evidence rather than rewriting the archive.

## Portable Obsidian State

The committed `.obsidian/` directory contains only link, note-location, appearance, and core-plugin defaults. Workspace layouts, hotkeys, cache, themes, snippets, and community plugins are ignored because they are machine- or user-specific.

## Verification

`npm run verify:docs` checks:

- required active contracts and frontmatter
- coverage of every active application document from both navigation maps
- broken local links in current documents and maps
- portable Obsidian settings with no committed workspace or community-plugin state
- the release catalog's minimum user-facing content contract
