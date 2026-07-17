---
id: cp-ops-chatgpt-agent-auth
title: ChatGPT Agent Authorization
summary: Per-user Codex device authorization, credential isolation, environment requirements, and product-agent mapping.
status: active
kind: operations-runbook
area: operations
tags: [chatgpt, codex, oauth, credentials, agents]
app_visible: false
---

# ChatGPT Agent Authorization

ClawPilot can run its product-agent conversations with a signed-in user's ChatGPT/Codex authorization. OpenClaw is not required at runtime.

## Account Boundary

- `APP_LOGIN_EMAIL` is bootstrapped as the ClawPilot owner.
- The owner can invite or disable members from Settings > People.
- Each member signs in with their own email magic code.
- Each member must connect their own ChatGPT account from Agents.
- OAuth credentials and agent threads are scoped to the normalized ClawPilot email.
- Project boards and pipelines are private to their owner unless explicitly shared. Agent conversation transcripts are private to the initiating user; results intentionally written back to a shared task remain visible to collaborators on that board.

## Device Flow

1. ClawPilot requests a Codex device code from `auth.openai.com`.
2. The user opens the OpenAI verification page and enters the displayed code.
3. ClawPilot polls the device authorization endpoint and exchanges the approved code for access and refresh tokens.
4. Tokens are encrypted with AES-256-GCM before being stored in Postgres.
5. Agent requests use the Codex Responses backend and the connected account ID.
6. Hosted dev and production read the same restricted credential rows, and refresh-token rotation is serialized with a Postgres row lock.
7. Disconnect performs best-effort upstream revocation and always removes local credentials.

## Required Environment

```bash
CLAWPILOT_AGENT_PROVIDER=openai-codex
AGENT_CREDENTIAL_ENCRYPTION_KEY=<at-least-32-random-characters>
AGENT_CREDENTIAL_DATABASE_URL=<restricted-shared-Postgres-URL>
OPENAI_CODEX_AGENT_MODEL=gpt-5.4
```

Use the same credential database URL and encryption key in both hosted lanes. The database role should have only `SELECT`, `INSERT`, `UPDATE`, and `DELETE` on `agent_chatgpt_credentials` and `agent_chatgpt_pending_logins`. This keeps app data isolated by environment while preventing a second device login or refresh from invalidating another lane. Rotate the key only with a planned credential reset; existing ciphertext cannot be decrypted after an uncoordinated key change.

## Operational Notes

The ChatGPT/Codex authorization path is distinct from the public OpenAI API-key path. Model entitlements and usage limits come from the connected user's ChatGPT plan. A user whose authorization expires must reconnect.

The Codex backend and OAuth client behavior must be regression-tested during OpenAI/Codex upgrades because they do not have the same compatibility guarantees as the public API-key Responses endpoint.

## Product Agent Mapping

ClawPilot defines five product profiles: Projects, Pipeline, Docs, Calendar, and ClawPilot. Each profile contributes a distinct instruction and routing context, but all five use the initiating ClawPilot user's connected ChatGPT/Codex authorization. They are not separate Custom GPT objects in the user's ChatGPT sidebar.

The profile identity is deterministic for the normalized ClawPilot email and role, so the same user returns to the same logical agent across tasks. Provider requests remain stateless with `store: false`; the profile key is a cache boundary, not durable provider memory. ClawPilot reconstructs every prompt from the versioned role instruction, selected task thread, that user's private role memory, and active privacy-gated shared role principles. New users receive this mapping automatically when they connect their own ChatGPT account.

Task assignment and explicit `@Agent` card comments enqueue durable Postgres dispatch records. The Railway worker authenticates through its dedicated bearer secret, validates the queued operator and board claims, executes against that user's credential, retries transient failures, and writes the result to both the user's private task thread and the shared card. It does not manufacture, restore, or transmit a human browser cookie.

The Agents workbench keeps conversation and execution separate. **Discuss** sends a private task-scoped question and does not mutate shared task evidence. **Work** immediately persists the operator instruction, queues a durable dispatch, and lets the worker apply only evidence-backed task and document changes. A queued or running task rejects another Work request until the active dispatch finishes.

This response bridge is not repository authorization. It can reason over supplied task context and produce ClawPilot task artifacts, but repository changes require a separate sandboxed Codex runner with scoped source-control credentials and auditable writeback.
