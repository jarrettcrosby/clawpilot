# ChatGPT Agent Authorization

ClawPilot can run its product-agent conversations with a signed-in user's ChatGPT/Codex authorization. OpenClaw is not required at runtime.

## Account Boundary

- `APP_LOGIN_EMAIL` is bootstrapped as the ClawPilot owner.
- The owner can invite or disable members from Settings > User access.
- Each member signs in with their own email magic code.
- Each member must connect their own ChatGPT account from Agents.
- OAuth credentials and agent threads are scoped to the normalized ClawPilot email.
- Project and pipeline records remain shared collaboration data. Agent conversation transcripts are private to the initiating user; results intentionally written back to a shared task remain visible on that task.

## Device Flow

1. ClawPilot requests a Codex device code from `auth.openai.com`.
2. The user opens the OpenAI verification page and enters the displayed code.
3. ClawPilot polls the device authorization endpoint and exchanges the approved code for access and refresh tokens.
4. Tokens are encrypted with AES-256-GCM before being stored in Postgres.
5. Agent requests use the Codex Responses backend and the connected account ID.
6. Refresh-token rotation is serialized with a Postgres row lock.
7. Disconnect performs best-effort upstream revocation and always removes local credentials.

## Required Environment

```bash
CLAWPILOT_AGENT_PROVIDER=openai-codex
AGENT_CREDENTIAL_ENCRYPTION_KEY=<at-least-32-random-characters>
OPENAI_CODEX_AGENT_MODEL=gpt-5.4
```

Use the same credential encryption key anywhere the same Postgres credential rows must be readable. Rotate it only with a planned credential reset; existing ciphertext cannot be decrypted after an uncoordinated key change.

## Operational Notes

The ChatGPT/Codex authorization path is distinct from the public OpenAI API-key path. Model entitlements and usage limits come from the connected user's ChatGPT plan. A user whose authorization expires must reconnect.

The Codex backend and OAuth client behavior must be regression-tested during OpenAI/Codex upgrades because they do not have the same compatibility guarantees as the public API-key Responses endpoint.
