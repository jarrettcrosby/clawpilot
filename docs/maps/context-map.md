---
id: cp-map-context
title: ClawPilot Context Map
summary: Primary Map of Content for product behavior, platform data, operations, decisions, and build evolution.
status: active
kind: map-of-content
area: knowledge
tags: [clawpilot, moc, context, navigation, second-brain]
app_visible: true
---

# ClawPilot Context Map

Use this note when the question spans more than one module. It is the root of the ClawPilot knowledge graph and links current behavior to the decisions and operating evidence that explain it.

## Start Here

- [Product Map](product-map.md): user journeys and module boundaries.
- [Platform and Data Map](platform-data-map.md): systems of record, identities, synchronization, and integration boundaries.
- [Operations Map](operations-map.md): environments, deployment, recovery, credentials, and provider runbooks.
- [Evolution Map](evolution-map.md): decisions, releases, incidents, and implementation evidence.
- [Decision Index](../decisions/index.md): accepted architecture and product decisions.
- [Distributed Operations Integration and Gap Map](distributed-operations-integration-gap-map.md): pre-activation DOM, WMS, 3PL, and adapter discovery.

## Context Graph

```mermaid
flowchart TD
  Context[ClawPilot Context Map] --> Product[Product Map]
  Context --> Platform[Platform and Data Map]
  Context --> Operations[Operations Map]
  Context --> Evolution[Evolution Map]
  Context --> Distributed[Distributed Operations Design]
  Product --> Modules[Module Contracts]
  Platform --> Data[Postgres, Sheets, SuiteCRM]
  Operations --> Runtime[Dev and Production]
  Evolution --> Decisions[Decision Records]
  Evolution --> Releases[Versions and Releases]
  Evolution --> Evidence[Incidents and Git History]
  Distributed --> Modules
  Distributed --> Data
  Distributed --> Runtime
```

## Retrieval Rules

1. Start in the closest map rather than searching folders by name.
2. Read an active contract for current behavior.
3. Read a decision record when the reason or tradeoff matters.
4. Read the Versions surface and release contract for what shipped.
5. Use incidents, pull requests, and Git history only for implementation or historical evidence.

The in-app Docs catalog vectors every note marked `app_visible: true`. Maps and decision records are therefore retrieval anchors as well as Obsidian navigation pages.
