---
id: cp-module-user-integrations
title: User Integrations and Credentials
summary: Per-user Maton connections, Google Workspace administration, managed resources, credential storage, and knowledge provider controls.
status: active
kind: module-contract
area: integrations
tags: [integrations, maton, google-workspace, credentials, tenancy]
app_visible: true
---

# User Integrations and Credentials

## Purpose

Keep user-owned Maton accounts separate from the platform Google Workspace credential. All secrets are write-only in the UI, encrypted before Postgres persistence, and isolated between the development and production databases.

## Maton Account Contract

- Settings stores the user's Maton login email for account identification.
- A Maton API key is encrypted with AES-256-GCM before it is written to Postgres. Encryption is bound to the owning ClawPilot email, and API responses return only key status, version, rotation time, and the final four characters.
- A candidate API key is validated against Maton before a set or rotation is committed. The same transaction replaces stale connection metadata with the sanitized connections returned for the new key.
- Connection metadata is scoped by owner email and connection ID. ClawPilot stores provider, status, account email, and one selected connection per application without storing provider OAuth tokens.
- Settings accepts any valid Maton application ID and provides common application suggestions. Google Sheets and Drive remain available for legacy connections, but new managed pipeline files use the native Google Workspace integration. Maton authorization URLs must use `https://connect.maton.ai`.
- Disconnect removes encrypted key material and connection metadata while retaining the user's Maton login email.

## Runtime Credential Selection

- User-owned Maton operations resolve the signed-in user's encrypted credential and an `ACTIVE` connection for the requested Maton application.
- Sign-in and invitation email is a platform operation. It always uses the Railway `MATON_API_KEY` plus exact `MATON_GMAIL_CONNECTION_ID`, verifies that `stewards@eigenracing.com` is an accepted Gmail send-as identity, and never falls back to a user's selected personal connection.
- CRM sales email and calendar actions are user operations. They use the signed-in user's encrypted Maton credential and selected `google-mail` or `google-calendar` connection, so another ClawPilot user must authorize their own providers. CRM action dialogs show the selected account email before submission, and provider attempt summaries retain the verified Gmail sender or selected Calendar organizer for audit.
- Development and production store user integration records in their own Railway Postgres environments. Import or configure the platform owner in both environments; do not copy database rows between environments.

## Google Workspace Contract

- Google Workspace is an owner-managed platform integration, not a Maton connection.
- Settings stores the standard Google API key separately from the service-account credential and supports independent rotation.
- The API key associates eligible requests with the Google Cloud project but does not authorize private Drive or Sheets data.
- The service-account JSON is validated before an atomic update. ClawPilot stores only the required metadata plus encrypted private-key material and never returns the private key or full API key.
- Native Google requests use short-lived service-account OAuth tokens. Service-account token exchange is restricted to Google's OAuth endpoint; Drive and Sheets calls are restricted to their official HTTPS API origins.
- A selected Shared Drive is required because a service account cannot use personal Drive storage as the owner of managed files. Settings lists only Shared Drives visible to the configured service account.
- Credential rotation for the same service-account email keeps managed pipelines active. Replacing the service account fails closed for existing managed pipelines until their binding is explicitly re-established.

## Managed Pipeline Resources

- Provisioning is an explicit pipeline-owner command.
- ClawPilot creates `ClawPilot Data/<environment>/Organizations/<ga organization>/Contacts/<gc user>/Pipelines/<gc pipeline>/` in the configured Shared Drive.
- The private workbook contains the CRM input, generated entity projections, calculations, dashboard, and dropdown tabs expected by the sync adapters.
- Postgres remains the durable normalized projection, membership, audit, outbox, and conflict store. Only the Opportunities table is writable; SuiteCRM owns the other CRM entities.
- The generated short link resolves to the private Sheet but does not bypass Google permissions.
- Pipeline sharing reconciles the managed folder to the exact ClawPilot membership: editors receive Google writer access, viewers receive reader access, and public, domain, group, or anyone permissions are rejected.
- Existing owner-only legacy Sheets can continue through the legacy Maton path until migrated. New managed tenant pipelines never fall back to a global Maton credential.

## Knowledge Embeddings Contract

- **Settings > Integrations > Knowledge** is an owner-controlled platform setting. Members and non-owner administrators cannot change the embedding provider.
- `Local` is the default and keeps document content inside ClawPilot. `External` is an explicit opt-in for improved semantic retrieval when its expected value justifies external processing and usage cost.
- External mode is disabled until the server environment has a dedicated `OPENAI_EMBEDDING_API_KEY`. Settings stores only the selected provider and audit metadata; it never stores or returns the key.
- External mode sends document content and semantic search input to OpenAI's embedding endpoint. The agent API key, Maton key, Google credential, and user ChatGPT/Codex authorization are never substituted for the dedicated embedding key.
- `DOCUMENT_EMBEDDINGS_PROVIDER` supplies the bootstrap default when no database preference exists. A valid owner selection in Settings becomes the effective provider for later document jobs and semantic queries.

## Operational Checks

Use the [Google Workspace integration runbook](../operations/google-workspace-integration.md) for Cloud credential, Shared Drive, environment setup, and rotation steps.

1. Confirm the owner Settings Integrations tab reports a verified Google service account and selected Shared Drive.
2. Confirm each user who needs Maton reports a configured key and the required selected `ACTIVE` connections.
3. Confirm pipeline provisioning reaches `ready`, exposes its short link, and enables Sheet sync.
4. Check `/api/pipeline/sync-status` and the worker heartbeat after a pull or queued write.
5. Confirm Knowledge remains `Local` unless the owner deliberately enables `External` and the dedicated key is configured.
6. Rotate credentials through Settings or the owning server environment as appropriate; never add plaintext keys, private keys, OAuth tokens, or full connection IDs to documentation, logs, or release copy.
