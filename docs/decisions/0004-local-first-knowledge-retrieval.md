---
id: cp-decision-0004
title: Local-First Knowledge Retrieval
summary: Canonical Markdown uses MOCs and metadata; ClawPilot indexes it with local vectors by default and external embeddings only by owner choice.
status: active
kind: decision-record
area: knowledge
date: 2026-07-15
decision_status: accepted
tags: [clawpilot, decision, knowledge, obsidian, embeddings, privacy]
app_visible: true
---

# 0004 - Local-First Knowledge Retrieval

## Context

ClawPilot needs a connected engineering second brain without recurring manual reorganization, uncontrolled plugin complexity, unnecessary provider cost, or external transfer of private notes by default.

## Decision

The repository root is the Obsidian vault. Active contracts describe current truth; Maps of Content connect topics; decision records explain durable choices; releases and incidents preserve selected historical evidence. Only notes explicitly marked `app_visible: true` enter the owner catalog. Hybrid retrieval uses Postgres full-text search plus deterministic local vectors by default. External OpenAI embeddings are an owner-controlled option requiring a dedicated key.

## Consequences

- Folder placement helps browsing but links and MOCs carry topic relationships.
- Templates standardize recurring note types without requiring community plugins.
- Superseded progress notes are consolidated rather than left as competing truth.
- New canonical notes require stable metadata, inbound links, and documentation verification.

## Connected Notes

- [ClawPilot Context Map](../maps/context-map.md)
- [Knowledge Vault Organization](../operations/knowledge-vault-organization.md)
- [Knowledge, Releases, and Checkpoints](../modules/knowledge-releases-and-checkpoints.md)
- [Evolution Map](../maps/evolution-map.md)
