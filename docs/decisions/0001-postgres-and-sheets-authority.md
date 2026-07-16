---
id: cp-decision-0001
title: Postgres and Sheets Authority
summary: Postgres owns application data while a managed Google Sheet remains the writable pipeline operator table.
status: active
kind: decision-record
area: data
date: 2026-07-13
decision_status: accepted
tags: [clawpilot, decision, postgres, google-sheets, pipeline]
app_visible: true
---

# 0001 - Postgres and Sheets Authority

## Context

Users value a familiar Google Sheet for pipeline entry and reporting, while ClawPilot needs durable tenant-scoped objects, reliable synchronization, and application-owned history.

## Decision

Railway Postgres is authoritative for app users, organizations, resources, task state, CRM projections, documents, audit records, execution evidence, and outboxes. Each managed Google Sheet is the writable operator table for its pipeline opportunity rows. Synchronization is explicit, idempotent, and observable.

## Consequences

- A Sheet API credential alone does not replace the service-account identity needed to create and share files.
- Pipeline writes pass through a durable outbox and reconcile back into Postgres.
- CRM and reporting consume the normalized projection rather than scraping arbitrary workbook tabs.
- Recovery requires Postgres backup controls and Google resource reconciliation.

## Connected Notes

- [Pipeline and Synchronization](../modules/pipeline-and-sync.md)
- [CRM and Workbook Reporting](../modules/crm-and-reporting.md)
- [Google Workspace Integration](../operations/google-workspace-integration.md)
- [Railway Postgres Backups](../operations/railway-postgres-backups.md)
