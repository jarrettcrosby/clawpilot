---
id: cp-module-user-integrations
title: User Integrations and Credentials
summary: Per-user Maton connections, organization QuickBooks, Toast, carrier and commerce-channel access, Google Workspace administration, managed resources, and credential controls.
status: active
kind: module-contract
area: integrations
tags: [integrations, maton, quickbooks, toast, carriers, commerce, shopify, faire, google-workspace, credentials, tenancy]
app_visible: true
---

# User Integrations and Credentials

## Purpose

Keep user-owned Maton accounts separate from the platform Google Workspace credential. Secrets are encrypted before Postgres persistence and isolated between the development and production databases. They remain write-only unless a module contract below defines a narrower, audited organization-admin reveal workflow.

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
- ClawPilot encrypts the complete credential with AES-256-GCM and binds authenticated encryption to the organization, provider, and environment. Normal browser reads receive only the permanent integration Global ID, masked client/account suffixes, credential version, verification state, safe error code, and timestamps.
- An owner or administrator of the owning organization who also has **Manage operations** permission may explicitly reveal the current provider client ID and client secret. The values remain masked by default, the no-store response is removed from the page after 30 seconds, and the reveal is written to organization audit history before plaintext is returned. Ordinary members and users consuming delegated carrier rates cannot reveal the credential.
- The reveal workflow does not expose carrier billing account numbers, provider OAuth access tokens, refresh tokens, previous credential versions, or another organization's credentials. OAuth tokens remain non-exportable.
- OAuth access tokens are short lived and are neither returned to the browser nor stored in the credential table. Rotation replaces the encrypted credential, increments its version, and preserves an audit event without exposing the old or new secret.
- A first-time saved credential remains disabled after verification. Enabling an account is a separate operator action and performs another provider verification. Rotation preserves a deliberate active or disabled state; recovery from a failed verification returns to disabled and requires explicit re-enable. A live carrier adapter must resolve an account that is both `active` and `verified`; there is no cross-organization or platform-account fallback.
- **Disconnect** requires confirmation, removes encrypted credential material, and disables the non-secret integration account. Existing immutable shipment evidence remains intact.
- This credential workflow does not by itself certify rating, label purchase, void, manifest, or tracking. Those capabilities remain unavailable until the named direct adapter passes its sandbox, failure-injection, reconciliation, and authorized live-smoke release gates.

## Sales-Channel Integration Contract

- **Settings > Integrations > Sales channels** is organization scoped and available to the owner or a user with explicit **Manage operations** permission. Shopify and Faire are commerce/sales-channel connections for Distributed Operations, not restaurant POS accounts and not cart modules.
- Both providers use user-owned custom integrations. Settings presents the provider-side application checklist before credential entry and distinguishes **API connection established** from optional receipt or synchronization activation. ClawPilot does not create the provider application, silently request every provider scope, or start a multi-merchant marketplace OAuth flow.
- The current singleton connection boundary permits one Shopify account and one Faire account per organization and environment. A candidate shop or brand identity is verified against a fixed provider origin before it is saved. That immutable provider identity remains on the nonsecret integration-account tombstone after disconnect; the same Global ID cannot be rebound to another shop or brand. Account replacement and multi-store generations require a later coordinated workflow.
- Shopify custom integration setup requires the merchant to create a merchant-owned app in Shopify Dev Dashboard, create and release an app version, install it on a store owned by the same Shopify organization, and then enter the permanent canonical `store-name.myshopify.com` domain plus that app's client ID and client secret in ClawPilot. The API-only app may use Shopify's default app-home URL. Shopify Admin-created legacy apps and pasted Admin API access tokens are unsupported; other-merchant public or custom-distribution apps require a future OAuth installation flow.
- ClawPilot exchanges Shopify Dev Dashboard credentials for a 24-hour access token whenever it verifies the connection and never persists or returns that short-lived token. Admin GraphQL is pinned to version `2026-07`; a Shopify development/test store may use the `sandbox` classification, but there is no alternate arbitrary API host. The least-privilege receipt-evidence profile requires `read_products` and `read_inventory`; order, customer, fulfillment, return, and write scopes are not requested for connection proof. Scope audit treats a granted write scope as satisfying its paired read scope and separately catalogs stable inventory-shipment received-item scopes without claiming the unstable physical-inventory preview.
- Faire custom integration setup requires a brand to create an unpublished app in the Faire Developer Portal and copy the app's APA token. In **Brand Portal > Settings > Integrations > Have an unpublished integration?**, the brand enters the APA token and continues to generate the final brand API key. If that self-service option is unavailable, the operator uses **Start a request** in Faire's linked guide to contact Faire Support. ClawPilot accepts the final key generated for the brand, not the APA token, and verifies the production brand profile at the fixed External API v2 origin. Retailer accounts cannot use this path. Faire has no documented public sandbox or webhook contract, and its current published OpenAPI does not expose direct-token grant details; a successful authorized brand-profile probe remains the compatibility gate before the credential is saved, with unresolved access failures escalated to `developers@faire.com`.
- Credentials are AES-256-GCM encrypted with organization, provider, environment, and immutable provider identity in authenticated data. Browser reads receive only a masked client-ID or token suffix, monotonic credential generation, verification state, safe configuration, capability/scope evidence, and timestamps. There is no credential-reveal action.
- Disconnect removes ClawPilot's encrypted credential and disables the local account while retaining immutable operational evidence. It does not uninstall a Shopify app or revoke/remove a Faire integration; the operator must complete provider-side decommissioning separately.
- A first-time connection remains runtime-disabled after API verification, but Settings reports the API connection itself as established. For Shopify, Settings then shows the account-specific callback URL, accepted topics, granted and missing receipt-profile scopes, webhook verification state, and every activation blocker. One valid signed `app/scopes_update`, product, or inventory delivery verifies the exact stored credential generation and is retained as encrypted `held` evidence while disabled. ClawPilot does not yet register the shop-specific subscription; synthetic delivery proves signing only, not real subscription health. An owner or operations administrator may separately enable **Shopify signed receipt intake** only after the receipt-profile scopes and signed-delivery evidence are current. A successful connection re-test or signed `app/scopes_update` that proves a receipt-profile scope is missing atomically disables intake and holds the triggering receipt; restoration requires the provider scope change, a current verification, and explicit re-enable. Order/customer topics are rejected until retention, erasure, privacy-response, and canonical processing exist.
- Faire reports **API connection established — synchronization unavailable** after its profile probe. It cannot be enabled until its polling, mapping, retention/erasure, reconciliation, and import workers exist. Multi-brand Faire OAuth, Shopify multi-merchant OAuth, shop-specific webhook registration/reconciliation, and Shopify zero-downtime dual-secret rotation remain future work.
- Provider failures return safe structured codes. Settings preserves those codes and supplies setup-specific remediation for same-organization Shopify ownership, app installation, scope approval, credential mismatch, Faire APA-token versus final-key confusion, brand eligibility, and environment encryption readiness.
- Shopify receipts authenticate against the exact raw request bytes, require the connected shop domain and event ID, deduplicate exact re-deliveries, reject event-ID/payload conflicts, persist the immutable credential generation, and stream-enforce the body limit before retaining the raw body as encrypted evidence. Receipt insertion locks and rechecks the current credential and account status, so rotation, disconnect, and disable cannot be crossed by a stale in-flight delivery. The public receipt route does not accept a browser session or carry user authorization.
- Capability UI separates what the provider offers, the provider scopes involved, and what ClawPilot has implemented. Unsupported or unimplemented capabilities remain visible as such; no scope list or successful connection probe is production-activation evidence.

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
9. For Shopify, confirm the merchant-owned Dev Dashboard app is released and installed on a store in the same Shopify organization, the canonical domain is correct, and the receipt profile reports no missing scopes before optional intake activation. For Faire, confirm the operator used the developer-app APA token only in Faire Brand Portal and pasted the final generated brand API key into ClawPilot; if the self-service option was unavailable, confirm they contacted Faire Support through **Start a request** in the official guide. Then confirm each immutable shop/brand identity is correct, tokens remain masked, and the capability audit distinguishes provider availability from implemented behavior. Shopify receipt intake may be active; commerce domain workers must still report inactive.
10. Rotate credentials through Settings or the owning server environment as appropriate; never add plaintext keys, private keys, OAuth tokens, carrier account numbers, or full connection IDs to documentation, logs, or release copy.
