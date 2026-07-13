# AGENT_ROUTING_MODEL.md

## Canonical Product Profiles

Current profile mapping (must match `app_src/lib/agents/routing.ts`):

- `projects` -> `projects`
- `pipeline` -> `pipeline`
- `docs` -> `docs`
- `calendar` -> `calendar`
- `clawpilot` -> `clawpilot-exec`

## Legacy ID Normalization
Accepted aliases are normalized to canonical product IDs, including:
- `projects-agent` -> `projects`
- `pipeline-agent` -> `pipeline`
- `docs-agent` -> `docs`
- `calendar-agent` -> `calendar`
- `main` -> inferred from task context or `clawpilot`
- `builder` -> `pipeline`

## Execution Thread Behavior

- Direct thread API: `POST /api/agents/threads` with `agentId`, `taskId`, and `text`.
- Automated triggers: a new assignment or an explicit card `@Agent` comment.
- Automated work is inserted into `sync_outbox` as `agent_runtime` / `agent_task` and claimed with a Postgres lease.
- Each run uses the initiating app user's own connected ChatGPT/Codex credential and private thread history.
- The profile changes instructions and routing context; it does not create or invoke a separate Custom GPT object.
- OpenClaw remains an optional local provider and is not required for the hosted runtime.

## Writeback
After successful execution, task receives:
- `execution.executionStatus = completed`
- `execution.lastUpdatedAt`
- `execution.latestExecutionNote`
- `execution.lastResult` summary metadata
- execution comment + activity log entry
- `execution.agentDispatch` queue/running/success/failure state
