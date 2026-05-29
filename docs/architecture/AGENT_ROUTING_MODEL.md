# AGENT_ROUTING_MODEL.md

## Canonical Product -> Execution Routing

Current runtime mapping (must match `app_src/lib/agents/routing.ts`):

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
- API: `POST /api/agents/threads`
- Required payload: `agentId`, `taskId`, `text`
- Non-`clawpilot` product agents execute real OpenClaw turns.
- `clawpilot` executes orchestration logic and can delegate.

## Writeback
After successful execution, task receives:
- `execution.executionStatus = completed`
- `execution.lastUpdatedAt`
- `execution.latestExecutionNote`
- `execution.lastResult` summary metadata
- execution comment + activity log entry
