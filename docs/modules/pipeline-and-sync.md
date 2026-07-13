---
title: Pipeline and Synchronization
status: active
kind: module-contract
tags: [pipeline, google-sheets, outbox, projections]
app_visible: true
---

# Pipeline and Synchronization

## Purpose

Provide a user-owned pipeline workspace while preserving Google Sheets as the writable operator table.

## Current Contract

- Every active user receives a default pipeline space.
- A pipeline owner can share view or edit access with another active user.
- Railway Postgres stores ClawPilot-owned pipeline definitions, normalized rows, projections, sync outbox entries, and audit events.
- Google Sheets remains the operator-facing writable table.
- Pull synchronization updates durable normalized rows and a read projection.
- Push synchronization uses an outbox and worker heartbeat; the UI reports sync state instead of assuming a write succeeded.

## Durable Data

- `pipeline_spaces`
- `pipeline_space_members`
- `pipeline_sheet_rows`
- `pipeline_source_state`
- `sync_outbox`
- `audit_events`

## Operational Check

Use `/api/pipeline/sync-status` and the Railway health endpoint to verify the active projection and worker heartbeat after deployment.
