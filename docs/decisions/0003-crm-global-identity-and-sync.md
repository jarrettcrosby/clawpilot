---
id: cp-decision-0003
title: CRM Global Identity and Synchronization
summary: Permanent random Global IDs connect ClawPilot records, short links, provider actions, project cards, and SuiteCRM projections.
status: active
kind: decision-record
area: crm
date: 2026-07-15
decision_status: accepted
tags: [clawpilot, decision, crm, global-id, suitecrm, outbox]
app_visible: true
---

# 0003 - CRM Global Identity and Synchronization

## Context

CRM objects need stable human-shareable identifiers across ClawPilot, SuiteCRM, email markers, calendar events, project cards, and short links. Sequential placeholders and provider-specific IDs are not durable product identities.

## Decision

Each CRM module allocates a random seven-digit Global ID under a fixed prefix. Allocated IDs remain in a permanent registry and are never reused. ClawPilot stages tenant-scoped projections and action state in Postgres, writes SuiteCRM changes through an idempotent outbox, and reconciles supported inbound SuiteCRM changes without echoing them back. SuiteCRM remains the CRM module and history authority described by the active CRM contract.

Audit events are written only when a new outbox operation is actually inserted. Re-reading an unchanged CRM record must not create another queue event.

## Consequences

- Global IDs are searchable SuiteCRM fields and organization-scoped short-link slugs.
- Account and contact relationships are projected in both top-level fields and SuiteCRM subpanels.
- Email and calendar markers can resolve records independently of provider record IDs.
- Outbox idempotency keys and audit event keys prevent repeated reads from looking like repeated work.

## Connected Notes

- [CRM and Workbook Reporting](../modules/crm-and-reporting.md)
- [Shared Short Links](../modules/short-links.md)
- [SuiteCRM Railway Runbook](../operations/suitecrm.md)
- [Platform and Data Map](../maps/platform-data-map.md)
