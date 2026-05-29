# ClawPilot App — System Structure (v1)

## Goal
Build this app as the primary operating interface where Jarrett + ClawPilot + agents coordinate work.

## Principles
1. App is the source of operational truth for task execution state.
2. External data (Sheets, Drive, etc.) is ingested into local normalized data.
3. Every state-changing action logs activity.
4. Mobile-first and resilient (no blank/spinner lock states).

## Proposed Folder Structure

```text
clawd-app/
  app_src/
    app/
      api/
        tasks/
        pipeline/
        agents/
        auth/
      (ui sections)
    components/
      dashboard/
      projects/
      pipeline/
      agents/
      auth/
    lib/
      domain/
      services/
      adapters/
      validators/
  data/
    tasks.json
    pipeline/
      raw/
      normalized/
    agents/
      sessions.json
      activity.json
    auth/
      users.json
      sessions.json
  integrations/
    sheets/
      sources.json
      mappings.json
      sync-state.json
  docs/
    architecture/
    data/
    product/
  scripts/
    sync-pipeline.ts
    validate-data.ts
```

## Core Domains
- **Projects**: Kanban cards, comments, checklist, activity, archive.
- **Pipeline**: Lead/opportunity records normalized from Google Sheets.
- **Agents**: Agent runs, ownership, status, handoffs, outputs.
- **Auth (design now, implement later)**: identity model, roles, session policy.

## Data Flow
1. Read source sheets via integration adapter.
2. Map to normalized records (`data/pipeline/normalized/*.json`).
3. Render Pipeline UI from normalized data.
4. Agent actions update app state through API routes.
5. Activity feed captures all writes with actor + timestamp.

## Auth System Design (deferred implementation)
- Local user model with role-based access:
  - owner (Jarrett)
  - operator (ClawPilot)
  - agent (service identity)
- Session records stored in `data/auth/sessions.json`
- Permission gates by API route (read/write/admin)
- Audit entries for auth events

## Build Sequence
1. Pipeline ingest + normalized schema.
2. Pipeline UI (list, stage board, detail drawer).
3. Agents panel (status, active tasks, last output).
4. Unified work feed (tasks + pipeline + agent actions).
5. Auth scaffolding endpoints + docs.

## Non-Negotiables
- No deploy that can leave app in permanent spinner state.
- Rebuild + restart + health check after every release change.
- Commit each working increment with clear message.

## Related Docs (2026-03-05)
- `docs/architecture/AGENT_MODULE_ARCHITECTURE.md`
- `docs/architecture/CALENDAR_MODULE_SPEC.md`
- `docs/architecture/EPISCS_SECOND_BRAIN_STRUCTURE_DECISIONS.md`
- `docs/operations/OPERATIONS_RUNBOOK_BACKUPS_VERSIONING_HEALTHCHECKS.md`
