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
- The Agents workbench has two explicit interaction modes. **Discuss** keeps questions and scope refinement in the initiating user's private task thread without changing card evidence. **Work** creates a durable dispatch that may update the task, checklist, next action, and working document only through the structured execution contract.
- A signed-user Work request commits the task state and dispatch outbox transaction before it is acknowledged as queued. The matching thread request uses a deterministic ID and can be reconstructed by the worker if its post-commit thread write is interrupted. The interface then follows the durable dispatch through queued, working, input-needed, blocked, and review states instead of holding one ambiguous request open.
- A task may have only one queued or running agent dispatch. Users resume the recorded next action or retry a failed run after the active dispatch has stopped; duplicate clicks cannot create parallel task mutations.
- Assignment creates durable dispatch work. A later signed-user card comment creates another dispatch only when it explicitly addresses the assigned agent.
- The Railway worker claims dispatches, runs the selected role through the user's own ChatGPT/Codex authorization, and persists execution runs/results.
- Autonomous dispatch uses a structured task-execution contract. The role can repair a missing or generic task description, add deduplicated checklist items, set the next action, and record a specific blocker or required operator input.
- Autonomous task work is a bounded continuation sequence rather than a single prose reply. Each successful step receives the prior persisted deliverable and checklist evidence, may complete at most one evidenced checklist item, and queues the next step only while concrete unchecked work remains. A task stops after eight continuations, on completion, on a specific operator decision, or on a real capability blocker.
- Research and design work must persist the actual comparison, recommendation, specification, or decision brief as its deliverable. A summary that only says research should happen is not substantive progress and cannot complete a checklist item.
- A substantive user-authored description is immutable to agent execution. Dispatch retries restore the already-persisted semantic result, and a stale dispatch cannot mutate a task after a newer assignment or comment has been queued.
- Substantive research, comparison, design, and specification output is written to one task-and-agent working document. Each continuation prepends an idempotent, timestamped work-log entry to that same document; dispatch retries cannot duplicate an entry.
- The card receives a concise agent comment with status, persisted changes, next action, waiting state, and a clickable link to the working document. Full deliverables remain in the agent thread, execution result, and working document instead of being split across long card comments.
- Discussion responses never create card comments, task documents, checklist mutations, or completion evidence. A user must choose Work when they want the agent to act on the task.
- The exact persisted task mutations are appended to the task thread as evidence. A provider response with no mutation is reported as no deliverable changed.
- A concrete `nextAction` from the structured result becomes the task `nextAction`.
- Every successful Work result records changed evidence, remaining work, waiting state, and one reusable learned principle or `none`. Discuss replies remain natural task conversation and do not create execution evidence.
- Users can only see tasks and threads on boards they can access.
- Conversation replies use `responded`; autonomous task planning uses `triaged`; missing operator data uses `awaiting_input`; and unavailable capabilities use `blocked`. A successful HTTP/provider dispatch never means the requested work is complete.
- `completed` requires separate, persisted completion evidence. Transport success, prose, plans, suggestions, and a model's self-reported success cannot close a task.
- The conversational executor does not have deployment, browser, mail, calendar, or arbitrary CRM tools. Work requiring one of those capabilities must name the missing capability and remain blocked rather than simulate completion.
- An editor can explicitly request **Generate patch** for a selected, assigned task when the repository runner is enabled. ClawPilot records the exact `dev` commit, dispatches a fixed GitHub Actions workflow, and returns a validated patch artifact plus changed paths and checks to the task. It does not push, create a branch or pull request, merge, or deploy.
- Repository patch generation uses a separate GitHub App and a separate GitHub Actions OpenAI API key. The per-user ChatGPT device authorization used for product-agent discussion and task work is never transmitted to the repository runner.
- A patch-ready result moves an unfinished task to review and records evidence; it never marks the task complete. Publication remains a separate operator-authorized step.
- Dispatch failures remain visible and retryable; no timeout or provider failure may leave the interface in an indefinite sending state.
- The Dashboard `Agent attention` metric counts assigned tasks whose durable execution status is `blocked` or `awaiting_input`. It does not expose the all-time execution-result row count as an action metric; historical runs and results remain available as execution evidence.

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
- `repository_bindings`
- `repository_runs`
- task-linked agent working documents in `app_documents`
- `agent_context_memories`
- `agent_context_memory_evidence`
- encrypted per-user agent credential records in the credential database

Use the [ChatGPT agent authorization runbook](../operations/chatgpt-agent-auth.md) for device flow, environment variables, credential rotation, and reconnect behavior.
