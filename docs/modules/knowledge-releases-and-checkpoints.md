---
id: cp-module-knowledge-releases
title: Knowledge, Releases, and Checkpoints
summary: Private documents, repository knowledge, hybrid search, release history, checkpoints, and AI opportunity briefs.
status: active
kind: module-contract
area: knowledge
tags: [docs, releases, backups, search]
app_visible: true
---

# Knowledge, Releases, and Checkpoints

## Purpose

Turn operating data into private, readable briefs and make shipped changes visible without exposing infrastructure controls to every user.

## Documents

- Documents are owned by a user and never listed across owners.
- ClawPilot generates Build, Project Board, Pipeline, and AI Opportunity briefs for that user's currently selected accessible board and pipeline.
- A user can tap **New document**, choose the brief type, and select an accessible board or pipeline when that document needs a resource. ClawPilot refreshes the source data and creates a uniquely named point-in-time snapshot instead of overwriting an earlier user-generated report.
- On-demand snapshots use the user's locale and timezone in the title, retain the selected resource relationship, and are tagged `generated-on-demand`. The API rechecks signed-user board and pipeline access before generation.
- The configured owner also receives the curated repository knowledge catalog.
- Status and source distinguish current contracts from historical evidence.
- Repository contracts explain current behavior; pull requests and Git history retain implementation detail. Superseded progress notes are not kept in the active catalog after their durable conclusions are consolidated.
- Maps of Content connect product, platform/data, operations, decisions, and evolution without duplicating notes across folders. Stable metadata creates consistent vector and full-text retrieval clusters.
- Only repository notes explicitly marked `app_visible: true` enter the configured owner's catalog. Vault-only templates, provider runbooks, and compatibility pointers remain available in Obsidian without polluting in-app search.
- Postgres full-text search indexes titles and content; tags remain searchable.
- Every changed document queues a pgvector embedding job. Hybrid search combines 256-dimension vector similarity with deterministic full-text ranking.
- Knowledge embeddings default to `Local`, a deterministic hashing vector that requires no external credential, sends no document content outside ClawPilot, and incurs no embedding-provider cost.
- The owner controls `Local` or `External` from **Settings > Integrations > Knowledge**. The persisted Settings choice takes precedence over the environment bootstrap default and is recorded in the audit log.
- `External` uses OpenAI semantic embeddings only when the server has a dedicated `OPENAI_EMBEDDING_API_KEY`. The option is unavailable without that key. Enabling it sends document content and semantic search input to the configured external provider and can incur provider usage costs.
- The general agent API key and each user's ChatGPT/Codex OAuth authorization are never reused for knowledge embeddings. Local remains the baseline unless the owner decides external semantic quality justifies the privacy and cost tradeoff.
- The AI Opportunity Radar ingests bounded official OpenAI, GitHub, Vercel, and Railway feeds and refreshes each active user's private research brief.

## Releases

- A deployment records commit, environment, summary, features, and fixes in Postgres.
- Owners/admins with full-history privilege can review the complete catalog.
- Members see user-facing releases from the last 30 days.
- Hosted release history never depends on a `.git` checkout inside the running container.

## Checkpoints and Provider Backups

- An application checkpoint is a checksummed logical snapshot for audit and recovery preparation.
- Only users with backup-management privilege can create or view checkpoints.
- Checkpoints are rate- and size-limited, and ClawPilot retains the latest 20 logical snapshots.
- Railway provider backups are the disaster-recovery control for the Postgres service. A checkpoint stored in the same database is not represented as a replacement for that provider backup.

## Documentation Ownership

Every implementation updates the owning active module or operations contract without waiting for an operator prompt. Every promoted deployment adds release copy and a durable Versions entry. See the [knowledge vault policy](../operations/knowledge-vault-organization.md) for metadata, retention, navigation, and verification rules.
