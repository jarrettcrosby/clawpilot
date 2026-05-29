# Agent Threads File Format (v1 legacy + v2 reference)

Primary reference for the new model is now:
- `docs/architecture/AGENT_THREADS_V2.md`

This file remains as a v1 format reference and migration anchor.

## v1 Path
`data/agents/threads.json`

## v1 Purpose
Persist in-app agent chat threads safely for task-linked and general conversations.

## v1 Top-level model
```json
{
  "threads": [
    {
      "threadId": "thread_docs-agent_general",
      "agentId": "docs-agent",
      "createdAt": "2026-03-05T14:00:00.000Z",
      "updatedAt": "2026-03-05T14:05:00.000Z",
      "taskId": null,
      "status": "active",
      "tags": ["docs", "bootstrap"],
      "messages": [
        {
          "id": "1741183312000-ab12cd",
          "role": "user",
          "text": "Please update docs module",
          "createdAt": "2026-03-05T14:05:00.000Z",
          "taskId": "12345"
        }
      ]
    }
  ]
}
```

## v1 field definitions
- `threadId` (string): deterministic key (`thread_<agentId>_<taskId|general>`)
- `agentId` (string): target agent id
- `createdAt` (ISO string): thread creation timestamp
- `updatedAt` (ISO string): last write timestamp
- `taskId` (string|null): optional task context
- `status` (string): `active|paused|done|error` (currently defaults to `active`)
- `tags` (string[]): optional labels
- `messages` (array): ordered thread messages

Message fields:
- `id` (string): unique message id
- `role` (`user|agent|system`)
- `text` (string)
- `createdAt` (ISO string)
- `taskId` (string|undefined)

## v1 safety guarantees
- Atomic write (`temp file + rename`)
- Lock file guard (`threads.json.lock`) for concurrent writers
- In-process single-writer queue to serialize mutations
- Legacy migration on read for older shape (`agentId + updatedAt + messages`)

## v2 migration note
v2 expands the model with:
- envelope `version`
- richer status lifecycle (`resolving`, `archived`, etc.)
- responder routing metadata
- context assembly metadata
- message-level status/meta fields

For all new implementation work, use `AGENT_THREADS_V2.md`.

## Acceptance notes
- This file is acceptable as long as it clearly marks itself as **v1 legacy** and points implementers to v2.
- v1 should still be sufficient to parse/read historic thread data during migration.

## Rollback notes
If v2 rollout is reverted, this v1 format becomes the active write target again (`data/agents/threads.json`).
Be aware that v2-only metadata may be dropped when converting back to v1.
