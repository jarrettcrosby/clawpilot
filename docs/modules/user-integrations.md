---
id: cp-module-user-integrations
title: User Integrations and Credentials
summary: Per-user Maton connections, organization QuickBooks, Toast, and carrier access, Google Workspace administration, managed resources, and credential controls.
status: active
kind: module-contract
area: integrations
tags: [integrations, maton, quickbooks, toast, carriers, google-workspace, credentials, tenancy]
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

## Toast Organization Contract

- Toast is organization-scoped. An organization owner or an administrator with access-management permission can manage it; ordinary members cannot change credentials, locations, or schedules.
- Analytics and Standard API credentials are separate encrypted records. Encryption binds each secret to its organization and access type so one credential cannot be decrypted as the other or across tenants.
- Analytics discovers management-group restaurants and supplies reporting data. Standard access verifies each restaurant GUID and supplies location-scoped operational records.
- Selected restaurants synchronize through a leased, retryable Postgres outbox. Raw provider records are immutable snapshots; daily sales are normalized projections.
- Toast ingestion only creates sanitized POS projections and a reviewable accounting draft. It cannot post to QuickBooks. See [Toast POS and Accounting](toast-and-accounting.md) for the data flow and release boundary.

## QuickBooks Organization Contract

- QuickBooks authorization starts as a per-user Maton connection, but the selected company is explicitly bound to the active ClawPilot organization before any business data is read.
- A single provider connection cannot be bound to multiple organizations. Switching workspaces never reuses the previous organization's company, account catalog, product catalog, or Toast mappings.
- Settings exposes a read-only company, chart-of-accounts, and item catalog. A manager explicitly selects products or services to import into the active CRM and pipeline catalog.
- Selected Toast locations can map accounting categories to active QuickBooks accounts. Mapping changes are organization-scoped and audited.
- Disconnecting or rebinding clears cached provider catalog rows and invalidates stale accounting mappings. Provider writes remain disabled. See [QuickBooks Accounting Connector](quickbooks-accounting.md).

## Small Parcel Carrier Account Contract

- **Settings > Integrations > Shipping** is organization scoped. The organization owner or a user with explicit **Manage operations** permission can manage direct UPS, FedEx, and USPS credentials. That permission exposes Shipping without exposing Google, QuickBooks, Toast, or user-access administration.
- Provider developer and production environments are separate account records. The developer selection resolves to UPS CIE, FedEx Sandbox, or USPS TEM through fixed server-side endpoints; operators cannot supply or override these hosts. A verified developer credential never enables a production shipment capability, and changing the active workspace never reuses the prior organization's carrier account.
- Enter the provider client ID, client secret, and carrier billing account number. USPS does not require a billing account number in the current credential contract. ClawPilot verifies the candidate against the provider's fixed OAuth endpoint before saving it.
- ClawPilot encrypts the complete credential with AES-256-GCM and binds authenticated encryption to the organization, provider, and environment. The browser receives only the permanent integration Global ID, masked client/account suffixes, credential version, verification state, safe error code, and timestamps.
- OAuth access tokens are short lived and are neither returned to the browser nor stored in the credential table. Rotation replaces the encrypted credential, increments its version, and preserves an audit event without exposing the old or new secret.
- A first-time saved credential remains disabled after verification. Enabling an account is a separate operator action and performs another provider verification. Rotation preserves a deliberate active or disabled state; recovery from a failed verification returns to disabled and requires explicit re-enable. A live carrier adapter must resolve an account that is both `active` and `verified`; there is no cross-organization or platform-account fallback.
- **Disconnect** requires confirmation, removes encrypted credential material, and disables the non-secret integration account. Existing immutable shipment evidence remains intact.
- This credential workflow does not by itself certify rating, label purchase, void, manifest, or tracking. Those capabilities remain unavailable until the named direct adapter passes its sandbox, failure-injection, reconciliation, and authorized live-smoke release gates.

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
6. Confirm each Toast access type reports its own verified state, selected locations are correct, and accounting output remains a draft.
7. Confirm the QuickBooks company shown in Settings belongs to the active organization, catalog sync is current, and no financial posting controls are exposed.
8. Confirm each enabled carrier account belongs to the active organization, uses the intended sandbox or production environment, and reports `Verified`. Test the connection after provider-side rotation before enabling it.
9. Rotate credentials through Settings or the owning server environment as appropriate; never add plaintext keys, private keys, OAuth tokens, carrier account numbers, or full connection IDs to documentation, logs, or release copy.
