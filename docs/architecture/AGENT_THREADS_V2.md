# Agent Threads v2 Architecture

Status: Proposed / docs-ready

## Goal
Define the next iteration of agent thread persistence and execution semantics so multi-turn conversations remain durable, deterministic, and migration-safe while we stay on file storage now and can move cleanly to SQLite/Postgres later.

---

## Data model (v2)

Primary storage remains JSON-on-disk, but with explicit envelopes and metadata for forward compatibility.

Path (current): `data/agents/threads.v2.json`

```json
{
  "version": 2,
  "updatedAt": "2026-03-05T14:05:00.000Z",
  "threads": [
    {
      "threadId": "thread_docs-agent_general",
      "agentId": "docs-agent",
      "taskId": null,
      "status": "active",
      "createdAt": "2026-03-05T14:00:00.000Z",
      "updatedAt": "2026-03-05T14:05:00.000Z",
      "lastMessageAt": "2026-03-05T14:05:00.000Z",
      "tags": ["docs", "bootstrap"],
      "routing": {
        "responder": "stub",
        "channel": "internal",
        "priority": "normal"
      },
      "context": {
        "summary": null,
        "lastUserMessageId": "1741183312000-ab12cd",
        "messageCount": 1,
        "tokenEstimate": 24
      },
      "messages": [
        {
          "id": "1741183312000-ab12cd",
          "role": "user",
          "text": "Please update docs module",
          "createdAt": "2026-03-05T14:05:00.000Z",
          "taskId": "12345",
          "status": "committed",
          "meta": {
            "source": "api",
            "requestId": "req_abc123"
          }
        }
      ]
    }
  ]
}
```

### Required thread fields
- `threadId` (string): stable identifier (`thread_<agentId>_<taskId|general>`)
- `agentId` (string)
- `taskId` (string|null)
- `status` (enum; see lifecycle below)
- `createdAt`, `updatedAt`, `lastMessageAt` (ISO)
- `messages` (ordered append-only list)

### Optional/derived thread fields
- `tags` (string[])
- `routing` (object): responder selection metadata
- `context` (object): cached summary/counters for prompt assembly

### Message fields
Required:
- `id` (string)
- `role` (`user|agent|system|tool`)
- `text` (string; may be empty for tool-only messages if later needed)
- `createdAt` (ISO)
- `status` (`pending|committed|failed`)

Optional:
- `taskId` (string)
- `meta` (object, open schema)
- `parentId` (string; supports branching/retries in future)

---

## Status lifecycle

### Thread status
- `active`: default; accepts new user input
- `paused`: temporarily not responding (manual hold or backpressure)
- `resolving`: responder currently running
- `done`: complete/closed but readable
- `error`: last responder attempt failed; recoverable by retry
- `archived`: hidden from default list, immutable except admin operations

Allowed transitions:
- `active -> resolving -> active`
- `active|paused -> done`
- `active|resolving -> error`
- `error -> resolving` (retry)
- `done -> archived`
- `paused <-> active`

### Message status
- `pending`: accepted but not yet durably committed
- `committed`: persisted and part of canonical history
- `failed`: write or responder-stage failure marker

Notes:
- Write path should only expose `committed` messages in normal reads.
- On failure after user commit but before agent reply commit, thread should move `error` with an audit entry.

---

## Responder routing rules

Routing chooses *which responder implementation* handles a turn.

Evaluation order (first match wins):
1. **Explicit thread override**: `thread.routing.responder`
2. **Agent default**: configured by `agentId`
3. **Task policy**: optional task-level specialization by `taskId`
4. **Global fallback**: `stub` (safe no-op acknowledgement)

Required routing invariants:
- Deterministic for the same `(agentId, taskId, thread routing)` input.
- Unknown responder id must not crash; fallback to global default and emit warning.
- Routing decision should be logged in message `meta` for auditability.

Suggested responder IDs:
- `stub` (current)
- `local-llm`
- `openclaw-bridge`
- `rules-only`

---

## Context assembly rules

Prompt/context is assembled from canonical thread history, not ephemeral UI state.

Assembly order:
1. System preamble (agent identity + constraints)
2. Optional thread summary (`context.summary`) when present
3. Recent committed messages (windowed from tail)
4. Current user message

Rules:
- Exclude `failed` messages from prompt by default.
- Include `system` and `tool` roles only when flagged relevant by responder policy.
- Use `context.messageCount` / `tokenEstimate` as hints; never source-of-truth.
- If token budget exceeded: summarize oldest segment, store into `context.summary`, then trim oldest raw turns from active window (raw remains in persistence unless explicit compaction is introduced).

---

## File-store implementation requirements (v2)

- Atomic writes (`tmp + rename`)
- Lock file guard (`threads.v2.json.lock`)
- Single-writer in-process queue
- Versioned read/write with migration adapters:
  - v1 (`threads.json`) -> in-memory v2 model
  - v2 writes only to `threads.v2.json` once migration cutover flag is enabled

---

## Future storage path: SQLite/Postgres

v2 schema intentionally maps 1:1 to relational tables.

### Proposed relational mapping
- `threads(thread_id PK, agent_id, task_id, status, created_at, updated_at, last_message_at, tags_json, routing_json, context_json)`
- `messages(id PK, thread_id FK, role, text, created_at, status, task_id, meta_json, parent_id)`
- Indexes:
  - `messages(thread_id, created_at)`
  - `threads(agent_id, updated_at)`
  - `threads(task_id)`

### Migration strategy
1. Introduce storage interface (`ThreadStore`) with file-backed implementation.
2. Add SQLite implementation behind feature flag.
3. Dual-read (prefer DB, fallback file) during bake-in.
4. Optional dual-write during confidence window.
5. Cut over to DB primary; keep file export tooling for rollback.
6. Later: Postgres adapter using same interface.

### Why this works
- Stable v2 field names avoid translation drift.
- Explicit statuses and routing metadata map cleanly to SQL columns/JSON fields.
- Thread/message split keeps hot queries index-friendly.

---

## Acceptance notes

v2 docs are acceptable when the following are true:
- Team can implement store/responder behavior without inferring missing states.
- All lifecycle transitions are explicit and finite.
- Routing precedence is deterministic and testable.
- Context assembly source-of-truth is unambiguous.
- File format and relational mapping are compatible enough for a no-redesign DB migration.

Recommended implementation tests:
- Transition validation tests (`active -> resolving -> active`, retry from `error`).
- Routing precedence tests (override > agent default > task policy > fallback).
- Context assembly tests with token-window trimming and summary injection.
- Migration adapter tests from v1 sample fixtures.

---

## Rollback notes

If v2 rollout causes regressions:
1. Disable v2 feature flag and route writes back to v1 path.
2. Keep v2 file read-only for forensic debugging.
3. Re-run v1 responder path (`status` collapses to supported v1 states).
4. If needed, regenerate v1 snapshot from v2 using adapter script (lossy for v2-only metadata like routing/context).

Rollback risk:
- No message loss if append + atomic write guarantees are preserved.
- Potential metadata loss (`routing`, `context`, `tool role`, extended statuses) when reverting to v1.
