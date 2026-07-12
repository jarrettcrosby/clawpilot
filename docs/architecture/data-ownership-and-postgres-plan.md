# Data Ownership and Postgres Plan

Status: implemented baseline
Date: 2026-05-29

## Decision

ClawPilot will use two persistence systems with explicit ownership boundaries:

- Google Sheets remains the operator-editable system for the pipeline table where human spreadsheet editing is part of the workflow.
- Railway Postgres becomes the durable application database for app-owned objects, workflow state, sync bookkeeping, and projections that should not live in Sheets.

The existing local JSON files stay as the local fallback during the transition. They are no longer the target architecture.

## Implemented State

The pipeline integration is writable through Maton and durable through Postgres:

- `app_src/lib/pipelineSync.ts` pulls Google Sheets data into a Postgres projection or local fallback.
- `app_src/app/api/pipeline/opportunity/[id]/route.ts` commits opportunity projections and queues Sheet updates/interactions.
- `app_src/lib/pipelineOutboxWorker.ts` performs queued Maton writes with retries and dead-letter handling.
- `app_src/lib/pipelineDropdownSync.ts` pulls and pushes dropdown catalogs while Postgres stores the durable cache.

Local files remain the development fallback and compatibility import source:

- `data-dev/tasks.json` and `data/tasks.json` hold file-mode task/work-item state.
- `agents/assignments.json` is the file-mode assignment projection.
- `agents/threads.json` stores file-mode agent conversations.
- `agents/*.jsonl` files store file-mode execution runs/results.
- `pipeline/normalized/current.json` is the file-mode pipeline projection cache.
- `logs/*.jsonl` files store file-mode runtime and pipeline events.

## Ownership Map

| Domain | Owner | Runtime source | Notes |
|---|---|---|---|
| Pipeline rows | Google Sheets | Sheets plus Postgres projection | Sheets remains the human-editable table until explicitly replaced. |
| Pipeline interactions | Google Sheets initially | Sheets append plus Postgres audit/projection | Interactions can be dual-written through the sync outbox after the first DB slice. |
| Pipeline dropdowns | Google Sheets initially | Sheets plus local/Postgres cache | App can still push catalog changes back to Sheets. |
| Tasks/cards/work items | ClawPilot app | Postgres | Move off JSON first. |
| Assignments | ClawPilot app | Postgres projection from tasks | `assignments.json` should become a compatibility artifact only. |
| Agent threads/messages | ClawPilot app | Postgres | Keep the existing thread JSON shape as payload during migration. |
| Execution runs/results | ClawPilot app | Postgres append tables | Replace JSONL with append-only rows. |
| Activity/audit events | ClawPilot app | Postgres append tables | Use for operator review and sync traceability. |
| Sync jobs/outbox | ClawPilot app | Postgres | Required before request-path Sheet writes are removed. |
| Docs/vault indexes | ClawPilot app | Postgres metadata plus filesystem/vault source | Vault files remain content source; Postgres stores indexes and state. |

## Sync Pattern

The target pattern is repository plus outbox:

1. UI/API validates a command.
2. API writes the app-owned state to Postgres inside a transaction.
3. API enqueues a sync outbox row when a Sheet write is required.
4. A worker performs the Maton/Google Sheets write.
5. The worker records success/failure and updates sync metadata.
6. A scheduled pull reconciles operator edits made directly in Sheets.

This removes fragile direct writes from request paths while preserving Sheets as the writable operator table.

## Google Sheets Row Identity

Postgres projection rows must keep stable Sheet metadata:

- `sheet_id`
- `tab_name`
- `row_number`
- `external_id` when the Sheet has a durable identifier
- `sheet_hash`
- `last_synced_at`
- `last_sheet_updated_at` when available

The normalized projection stores `sheetRowNumber`; legacy file-mode writes retain name/org/owner matching as a compatibility fallback.

## Migration Sequence

1. Add Postgres schema and migration runner.
2. Add repository interfaces with file-backed implementations as the default.
3. Add Postgres implementations behind `CLAWPILOT_STORAGE=postgres`.
4. Migrate tasks/cards/work items first.
5. Migrate assignments as a derived projection from tasks.
6. Migrate agent threads/messages.
7. Migrate execution runs/results and audit events.
8. Store pipeline rows as a Postgres projection while keeping Sheets as the operator-owned table.
9. Add sync outbox workers for Sheet writes. Completed with Railway polling, leased claims, retries, and dead-letter handling.
10. Remove local JSON writes after parity checks pass.

## Non-Goals

- Do not remove Google Sheets from the pipeline workflow without an explicit product decision.
- Do not push legacy runtime data to GitHub as source code.
- Do not make Vercel responsible for durable writes.
- Do not require a live database for local dev until the Postgres path is proven.

## First Refactor Boundary

The first runtime slice is task and agent-thread persistence:

- Keep the existing task JSON shape as the compatibility payload.
- Add extracted columns for status, priority, category, assignee, dates, and archival state.
- Keep the existing agent thread/message JSON shape as the compatibility payload.
- Keep route behavior unchanged for file-backed dev.
- Enable Postgres only when both `DATABASE_URL` and `CLAWPILOT_STORAGE=postgres` are set.
