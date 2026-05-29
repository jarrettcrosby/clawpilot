# Directive → Task Structured Mapping

This app maps automation/directive task creation into first-class task fields (not only freeform description).

## Endpoint
- `POST /api/tasks`

## Structured fields populated
- `title`
- `desc` (shortened summary)
- `status` (`backlog|todo|in-progress|review|done`)
- `priority` (`high|medium|low`)
- `category` (normalized app category)
- `tags` (array)
- `assignee` (optional)
- `dueDate` (optional)
- `checklist` (first-class checklist items)
- optional `initialComment`

## Delegation mapping
Current policy (Option 1):
- if delegated agents are provided (`delegatedAgents[]`) and `assignee` is omitted,
- set `assignee = "clawpilot"`
- append delegated agents to tags plus `agents` and `clawpilot`
- create checklist entries for delegated scopes with `agentId`

## Backward compatibility
- Existing tasks remain valid.
- Existing checklist shape remains valid; optional `agentId` is additive.
