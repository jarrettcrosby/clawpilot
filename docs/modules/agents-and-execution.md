---
id: cp-module-agents-execution
title: Agents and Execution
summary: Agent identities, user authorization, task routing, execution evidence, and writeback behavior.
status: active
kind: module-contract
area: agents
tags: [agents, chatgpt, codex, execution, tasks]
app_visible: true
---

# Agents and Execution

## Purpose

Route task-specific work to stable ClawPilot agent roles and write the result back to the task thread.

## Agent Map

- **ClawPilot**: orchestrates task context and the next concrete move.
- **Projects**: plans and sequences project-board work.
- **Pipeline**: reviews pipeline work and drafts follow-up.
- **Docs**: drafts task-linked working documentation.
- **Calendar**: reviews scheduling work and proposed changes.

These are application roles, not separately created ChatGPT custom agents. Each role supplies a dedicated system instruction and task context to the authenticated user's Codex execution session. This avoids hidden external agent configuration while keeping role behavior consistent and reviewable in the repository.

## Stable Identity and Automatic Provisioning

- ClawPilot derives one stable profile ID from the normalized user email and role ID. The same user therefore returns to the same logical Projects, Pipeline, Docs, Calendar, or ClawPilot agent across tasks and sessions.
- Every active user receives the same five role definitions automatically. Connecting ChatGPT authorizes execution for that user; it does not require an administrator to recreate agents in the user's ChatGPT account.
- A profile ID is a ClawPilot identity and prompt-cache boundary, not an OpenAI-hosted custom GPT or durable provider-side conversation. ClawPilot sends the role instructions, current task, recent task thread, and durable context on every execution.
- Role instructions are versioned in the application. A release can improve a role once and make that behavior available to every connected user without changing their private credentials or data.

## Authorization Boundary

- Every ClawPilot user completes their own ChatGPT/Codex device authorization. The browser approval flow returns to ClawPilot after the user grants access.
- Access and refresh tokens are encrypted in the restricted credential database and keyed by normalized ClawPilot email.
- Development and production may share only that least-privilege credential store and encryption key. Boards, tasks, messages, runs, and results remain environment-specific.
- Expired or revoked authorization disables execution and asks that user to reconnect; ClawPilot does not fall back to another user's credential or a synthetic response.

## Current Contract

- Chat always has an explicit selected task and product agent. ClawPilot does not silently send a message against a hidden task.
- Assignment creates durable dispatch work. A later signed-user card comment creates another dispatch only when it explicitly addresses the assigned agent.
- The Railway worker claims dispatches, runs the selected role through the user's own ChatGPT/Codex authorization, and persists execution runs/results.
- Autonomous dispatch uses a structured task-execution contract. The role can repair a missing or generic task description, add deduplicated checklist items, set the next action, and record a specific blocker or required operator input.
- The agent reply and the exact persisted mutations are appended to the task thread as evidence. A provider response with no mutation is reported as no deliverable changed.
- A concrete `nextAction` from the structured result becomes the task `nextAction`.
- Every successful role response uses `Changed`, `Remaining`, `Waiting on`, and `Learned`. `Learned` contains one reusable operating lesson or `none`.
- Users can only see tasks and threads on boards they can access.
- Conversation replies use `responded`; autonomous task planning uses `triaged`; missing operator data uses `awaiting_input`; and unavailable capabilities use `blocked`. A successful HTTP/provider dispatch never means the requested work is complete.
- `completed` requires separate, persisted completion evidence. Transport success, prose, plans, suggestions, and a model's self-reported success cannot close a task.
- The current in-app executor does not have repository, GitHub, deployment, browser, mail, calendar, or arbitrary CRM tools. Work requiring one of those capabilities must name the missing capability and remain blocked rather than simulate completion.
- Repository implementation requires a separately authenticated, sandboxed Codex runner with repository scope and auditable GitHub writeback. The per-user ChatGPT device authorization used for role responses is not treated as repository authorization.
- Dispatch failures remain visible and retryable; no timeout or provider failure may leave the interface in an indefinite sending state.

## Layered Context

ClawPilot rebuilds each execution context from four explicit layers:

1. The repository-owned instruction for the selected role.
2. The selected task and its recent thread.
3. Private user-and-role memory, readable only when that same user runs that same role.
4. Active shared role principles that contain no user, organization, customer, URL, email, Global ID, or task-specific data.

Successful responses may add a bounded private lesson. A generic lesson can become a shared candidate, but it is inactive until the identical lesson has independent evidence from at least two organizations. Seeded and promoted shared principles improve the role for all users; private lessons never cross the user boundary. Unsafe or task-specific lessons remain private and are not considered for promotion.

The shared layer is deliberately an operating-principle layer, not a shared transcript. Raw task threads, customer records, documents, and credentials are never copied into shared role memory.

## Durable Data

- agent assignments and task threads
- `agent_dispatch_outbox`
- `execution_runs`
- `execution_results`
- `agent_context_memories`
- `agent_context_memory_evidence`
- encrypted per-user agent credential records in the credential database

Use the [ChatGPT agent authorization runbook](../operations/chatgpt-agent-auth.md) for device flow, environment variables, credential rotation, and reconnect behavior.
