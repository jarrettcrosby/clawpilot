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

## Current Contract

- Assignment creates durable dispatch work. A later user comment creates another dispatch only when it explicitly addresses the assigned agent.
- The Railway worker claims dispatches, runs the selected role through the user's own ChatGPT/Codex authorization, and persists execution runs/results.
- The agent reply is appended to the task thread.
- A concrete `Remaining` action from the result becomes the task `nextAction`.
- Users can only see tasks and threads on boards they can access.

## Durable Data

- agent assignments and task threads
- `agent_dispatch_outbox`
- `execution_runs`
- `execution_results`
- encrypted per-user agent credential records in the credential database
