---
title: Knowledge, Releases, and Checkpoints
status: active
kind: module-contract
tags: [docs, releases, backups, search]
app_visible: true
---

# Knowledge, Releases, and Checkpoints

## Purpose

Turn operating data into private, readable briefs and make shipped changes visible without exposing infrastructure controls to every user.

## Documents

- Documents are owned by a user and never listed across owners.
- ClawPilot generates Build, Project Board, Pipeline, and AI Opportunity briefs for that user's currently selected accessible board and pipeline.
- The configured owner also receives the curated repository knowledge catalog.
- Status and source distinguish current contracts from historical evidence.
- Postgres full-text search indexes titles and content; tags remain searchable.
- Every changed document queues a pgvector embedding job. Hybrid search combines 256-dimension vector similarity with deterministic full-text ranking.
- The worker defaults to a deterministic local hashing vector without external credentials. OpenAI semantic vectors require an explicit provider opt-in and dedicated embedding key; an agent-provider key never enables document export.
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
