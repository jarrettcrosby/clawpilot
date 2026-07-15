---
title: Agents and Execution
status: active
kind: module-contract
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

## Authorization Boundary

- Every ClawPilot user completes their own ChatGPT/Codex device authorization. The browser approval flow returns to ClawPilot after the user grants access.
- Access and refresh tokens are encrypted in the restricted credential database and keyed by normalized ClawPilot email.
- Development and production may share only that least-privilege credential store and encryption key. Boards, tasks, messages, runs, and results remain environment-specific.
- Expired or revoked authorization disables execution and asks that user to reconnect; ClawPilot does not fall back to another user's credential or a synthetic response.

## Current Contract

- Chat always has an explicit selected task and product agent. ClawPilot does not silently send a message against a hidden task.
- Assignment creates durable dispatch work. A later signed-user card comment creates another dispatch only when it explicitly addresses the assigned agent.
- The Railway worker claims dispatches, runs the selected role through the user's own ChatGPT/Codex authorization, and persists execution runs/results.
- The agent reply is appended to the task thread.
- A concrete `Remaining` action from the result becomes the task `nextAction`.
- Users can only see tasks and threads on boards they can access.
- Agents can reply, analyze, and propose a next move, but they do not create project tasks. Any later write capability remains explicit, permission-checked, task-scoped, and auditable.
- Dispatch failures remain visible and retryable; no timeout or provider failure may leave the interface in an indefinite sending state.

## Durable Data

- agent assignments and task threads
- `agent_dispatch_outbox`
- `execution_runs`
- `execution_results`
- encrypted per-user agent credential records in the credential database

Use the [ChatGPT agent authorization runbook](../operations/chatgpt-agent-auth.md) for device flow, environment variables, credential rotation, and reconnect behavior.
