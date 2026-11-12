---
id: cp-fractional-crm-gateway
title: Fractional CRM gateway
summary: Scoped machine access to canonical ClawPilot company and contact records, conditional updates, and atomic onboarding resolution.
status: active
kind: module
area: crm
tags: [crm, fractional, global-id, tenant-isolation]
app_visible: false
---

# Fractional CRM gateway

November 2 local sender checkpoint: Fractional now has a separately gated durable publication worker and customer-facing status/recheck path for its **existing verified Fractional Shared Drive root**. It does not provision a substitute folder or overwrite the separate BPO link. Current sender TypeScript, 15 provider/transport tests, three consecutive PostgreSQL runs and mocked React/MUI mobile light/dark checks pass; evidence is retained as `fractional-folder-*-20261102-r64` through `r67` in `output/local-validation`. These separate sender/receiver tests are not combined real machine HTTP/card proof, live Drive verification, activation or deployment. Historical BPO-parent folders are not automatically treated as Fractional-drive roots. Current-source isolated build and remaining release gates stay open.

This gateway lets the independent Fractional application reuse ClawPilot's canonical company (`ga`) and contact (`gc`) records. PostgreSQL remains authoritative. Existing ClawPilot staging creates its normal SuiteCRM projection outbox; a gateway response does not attest to later native SuiteCRM delivery. Fractional retains its own organization/customer authorization, login accounts, local UUIDs, and shipping data. A Global ID identifies a record; it does not grant access.

The user approved the scoped gateway implementation and documentation. Source validation is local; this note does not claim a deployed gateway, registered production credential, cloud migration, successful hosted connector call, or a sent invitation. Enablement remains off until the reviewed release and credential configuration are applied.

## Configuration and registration

| ClawPilot environment variable | Contract |
| --- | --- |
| `FRACTIONAL_CRM_GATEWAY_ENABLED` | Must equal `1`; any other value keeps the gateway unavailable. |
| `FRACTIONAL_CRM_GATEWAY_ORIGIN` | Exact HTTPS origin, without path, credentials, or trailing slash. Incoming request origin must match. |
| `FRACTIONAL_CRM_GATEWAY_SOURCE_INSTANCE_ID` | Immutable registered source UUID; must match the request and credential. |

Apply migration `0372_fractional_crm_gateway.sql` through the existing migration owner. It creates empty registry/evidence tables and grants no access. A separately reviewed credential registration must bind one source instance, workspace organization UUID, pipeline UUID, root company Global ID, explicit customer-company allowlist, Fractional deployment UUID and organization ID, expiry, enabled state, and registered ClawPilot actor. That actor must remain an active owner/admin of the exact root workspace; the pipeline must belong to it and permit reference access. The root CRM record must be the active workspace root, not an arbitrary company with a similar name.

Use a fresh independent token in the `fcg_<32-hex-credential-UUID>_<43-base64url-secret>` format. Store only the domain-separated SHA-256 digest produced by `hashFractionalCrmGatewayToken`; store the raw token only in Fractional's protected secret configuration. Never reuse browser cookies, worker tokens, native CRM credentials, databases, or sessions. Do not put token values in command arguments, logs, docs, or receipts. Credential identity, digest, actor, source, and scope cannot be rebound: rotate with a new row and revoke the old row. Revocation, expiry, capabilities, company grants, and enabled state are checked again under a transaction lock before each operation or historical receipt replay.

Capabilities are independent: `crm.company.read`, `crm.contact.read`, `crm.product.read`, `crm.company.write`, `crm.contact.write`, `crm.onboarding.write`, and `crm.customer-folder.write`. Provision only those reviewed for the caller. Newly created onboarding companies are added to that credential's allowlist transactionally. This is not a wildcard grant to the pipeline. The historical `0373_fractional_crm_product_read.sql` is retained byte for byte. Migration `0403_fractional_crm_customer_folder_capability.sql` adds the folder capability without removing product-read from the accepted vocabulary or modifying any credential. Before using the revised `0403` on a retained database, verify that the earlier version is not recorded as applied; never rewrite the database ledger to bypass a checksum mismatch.

## HTTP and canonical fields

All paths start with `/api/integrations/fractional-crm/v1`. Each request requires `sourceInstanceId`, `workspaceOrganizationId`, `pipelineId`, and `rootCompanyGlobalId` query parameters matching the registered credential. Browser Cookie, Origin, and Sec-Fetch-Site authority is rejected. Responses are private and no-store; unexpected errors never return SQL, token contents, or arbitrary exception messages.

| Method and path | Behavior |
| --- | --- |
| `GET /companies/{ga}` | Pure canonical company read. |
| `GET /companies/{ga}/contacts` | Company-scoped contact list, default 50, maximum 100, opaque scoped cursor. |
| `GET /companies/{ga}/contacts/{gc}` | Pure contact read with exact parent validation. |
| `GET /organization/contacts` | Paginated staff contact list for the credential's exact active organization root. |
| `GET /organization/contacts/{gc}` | Pure staff contact read with exact root parent validation. |
| `POST /organization/contacts/resolve-or-create` | Reuse or create a root contact by verified staff email, with an idempotent command receipt. |
| `GET /products` | Active canonical products in the credential's exact pipeline; default 50, maximum 100, scoped cursor. |
| `GET /products/{gp}` | Canonical product read, with exact pipeline and retired-record checks. |
| `PATCH /companies/{ga}` | Conditional allowlisted company-field update. |
| `PATCH /companies/{ga}/contacts/{gc}` | Conditional contact-field update without reparenting. |
| `GET /companies/{ga}/customer-folder?customerId={id}` | Read the exact mapped Fractional customer's folder-reference state and opaque version. |
| `PATCH /companies/{ga}/customer-folder?customerId={id}` | Conditional, idempotent publication of that customer's authoritative Fractional folder reference; no folder provisioning. |
| `POST /onboarding/resolve-or-create` | Atomic company/contact resolution and optional creation under the registered source scope. |

Bodies are limited to 64 KiB and a ten-second read deadline. PATCH requires a strong quoted `If-Match` version and `Idempotency-Key`; the key is 8–160 ASCII letters, digits, underscores, or hyphens. Envelopes echo schema/source/scope, canonical and requested IDs, immutable record UUID, parent company, opaque content version, management, and `canPush`. Workspace-managed companies and app-user-managed contacts remain read-only. An alias can be read with explicit canonical resolution; PATCH requires the canonical ID.

Company fields are `companyName`, `website`, `email`, `phone`, `addressLine1`, `addressLine2`, `city`, `region`, `postalCode`, and `countryCode`. Contact fields are `displayName`, `email`, `phone`, and `jobTitle`. Only work phone is mapped; mobile, notes, opt-outs, ownership, and unrelated native fields remain unchanged. A structured first/last name cannot be silently reconstructed from a changed display name. Emails normalize only case and surrounding whitespace during matching; writes require canonical input. No plus-address or dot rewriting occurs.

Raw canonical PostgreSQL text is retained, including apostrophes and literal entities. Missing data is `null`; an address that cannot map losslessly to at most two lines or a non-ISO stored country is explicitly unavailable with retained source text. Unavailable fields must not clear known Fractional fields. Requested fields must match the committed canonical readback exactly or the transaction rolls back.

The product routes require `crm.product.read`; company, contact and folder capabilities do not imply it. Responses label prices as `stored_catalog_value` and `invoiceDefaultVerified: false`: a catalog value is not a verified invoice rate.

### Fractional customer-folder reference

This is a separate schema-version-1 subresource; the existing company/contact field allowlists and response shapes are unchanged. Its query requires the four normal scope parameters plus exactly one `customerId`. The dedicated `crm.customer-folder.write` capability covers this subresource's conditional PATCH and exact GET readback. Legacy clients can continue to use `crm.company.read` for this GET and `crm.company.write` for this PATCH. If the current locked credential has both write grants, this endpoint uses the narrow path. The folder grant by itself does not permit profile reads or writes, onboarding, or a company `canPush` result. Both folder methods require the exact canonical Account Global ID and an existing immutable `fractional_crm_source_mappings` company mapping for this source instance, deployment, organization and customer. A company allowlist entry alone, a company-name match, a contact grant or an alias does not authorize folder publication. The mapped Account must be an active, non-workspace Customer. Current credential, ancestry, actor membership/module access and source mapping are rechecked before even a historical command receipt can replay.

PATCH requires `If-Match` from this subresource (not the company envelope), a stable `Idempotency-Key`, and exactly:

```json
{
  "schemaVersion": 1,
  "folderUrl": "https://drive.google.com/drive/folders/example_folder_id",
  "assertedFractionalActor": {
    "userId": "fractional-user-id",
    "organizationId": "credential-bound-fractional-organization",
    "customerId": "query-customer-id"
  }
}
```

`folderUrl` is the authoritative existing HTTPS reference. Only the legacy write path accepts `null` for an explicit clear. The narrow path accepts the canonical Google Drive folder URL produced by the Fractional sender; it can publish an initial link, adopt an already matching manual link, or repeat the same link. It cannot clear a link, replace an existing verified reference, or overwrite a manual change. ClawPilot validates the URL as data and never fetches it; the sender verifies Drive ownership. No Drive folder, sharing permission, customer or human login is created. The response contains schema/source/scope, entity `customer-folder`, Account UUID and Global ID, Fractional customer ID, `folderUrl`, `status` (`unlinked`, `published`, `manual_override`) and opaque `version`; no service-account or credential details are returned.

Migration `0390_crm_fractional_customer_folders.sql` creates the one-Account/one-source-customer reference binding. The binding identity is immutable. Publication locks the current Account description and uses the existing CRM staging/outbox/audit transaction, preserving notes and the BPO link. The version includes the current description, so an old request cannot discard an intervening note. Matching pre-existing references may be adopted; different manually entered references, later replacements/removals, or malformed/duplicate labels require explicit review. Retries do not reinsert a removed link.

The narrow path updates only pre-existing, synchronized cards for that Account on eligible CRM boards already bound to the same workspace and pipeline. It commits any exact card-description update with the Account, binding, and receipt. It does not create a board/card, grant access, or run pipeline-wide card or short-link reconciliation. A missing, conflicting, or stale exact card returns `FOLDER_CARD_REVIEW_REQUIRED`; use normal authenticated CRM/Projects operations to verify and reconcile that card before retrying. Exact adoption of an already matching card leaves its contents and timestamps unchanged.

A new link that changes the description requires an existing synchronized SuiteCRM Account baseline; otherwise it returns `FOLDER_ACCOUNT_REVIEW_REQUIRED` without altering any records. It preserves the Account profile and source identity and queues only the dedicated `patch_account_description` operation, not a native create, full Account upsert, or whole-workbook projection. Previous workers exclude this operation from their claim allowlist, so an older or rolled-back worker leaves it pending for a compatible worker instead of falling back to a generic upsert. Native dispatch checks the existing Account ID, Global ID and previous description, sends only the description, and reads back the same Account; a missing record, different identity or unexpected description holds the patch. A verified already-applied description does not write again. The native V8 lookup and patch are separate operations, not provider-side compare-and-set. The legacy path retains its existing post-commit card reconciliation and retry behavior. `published` proves local publication, not downstream SuiteCRM delivery or destination access.

For a later verified replacement, an administrator should confirm the Fractional folder in its own Shared Drive and explicitly edit the **Fractional Customer Folder** link on the correct ClawPilot Account/card, preserving the independent BPO link. Reopen the Account and card to verify the replacement. The gateway records this as a manual override and leaves it untouched; re-establishing automated ownership requires a separately reviewed reconciliation, not broadening the credential or replaying the old publication.

Do not provision the new grant during a mixed-version deploy. Confirm that every SuiteCRM outbox worker is on the compatible release before authorizing narrow publication; an old worker does not recognize the restricted patch payload.

The November 3 read-only source review found Fractional's separate sender in `app/src/server/customer-folder-publication.ts`, its exact folder gateway client, and worker wiring in the canonical Fractional checkout. The sender retains an immutable publication intent, verifies the existing ready Drive folder, uses conditional PATCH plus independent GET readback, and holds manual conflicts without recreating the folder. Those source files were still untracked at inspection; their presence is not a release, test receipt, enabled connector, or provider proof. Coordinate that source's release evidence rather than implementing a duplicate sender. This ClawPilot receiver is not verified automatic cross-application synchronization until both releases and the signed-in/provider flow are confirmed. No hosted schema or connector is activated by these source changes.

## Onboarding and durable evidence

Organization staff contact reads require `crm.contact.read`. Resolution or creation requires `crm.onboarding.write`, a verified Fractional acceptance staged by the calling application, and an `Idempotency-Key`. The exact registered organization root supplies the parent. An existing same-email root contact is reused. A collision elsewhere is held for review, preserving the contact's existing parent. A new contact uses the existing canonical staging and native projection outbox. Fractional manages invitations and login permissions separately.

The body contains `schemaVersion`, `sourceInstanceId`, immutable Fractional `origin` identifiers, persisted company/contact snapshots, optional explicit existing Global IDs, reviewed verified identifiers, `allowCreate`, optional `reviewDecisionToken`, and asserted actor attribution. The origin deployment and organization must match the credential. Existing source mappings take precedence; explicit IDs and administrator-accepted identifier evidence must agree. Names and websites are candidate hints, never automatic identity proof. Contact email matching is limited to the chosen company and authorized discovery scope. A matching contact under another permitted company requires relationship review and is never reparented.

Resolve the complete company/contact pair before staging either. A review response contains only authorized candidate IDs, versions, and bounded canonical display name/email/company-name labels; it writes no CRM records, source mappings, or outbox jobs. Success returns `resolved` or `created`, per-record `reused`/`created` outcomes, matching basis, and canonical envelopes. Exact retries return the immutable original receipt with `replayed: true`, after fresh authorization. Request/key conflicts fail instead of changing the original intent.

Operations retain request hashes, response evidence, and clearly marked untrusted asserted Fractional actor/origin attribution. Current record metadata alone is not the audit trail. Source mappings and operation receipts are immutable. No login account, invitation, access grant to a human, or email is created by this endpoint.

Onboarding uses a three-second bounded exclusive CRM-table lock to fence existing non-gateway import writers before resolution/create. Ordinary record access locks and revalidates the exact ancestor path through commit, so a native ancestor archive/reparent cannot race an authorized descendant write. These locks can return a retryable failure under competing work; no lock-timeout override is configured here.

## Current limits

- Discovery is bounded to 1,000 granted companies and 10,000 contacts. Larger authorized sets fail explicitly; results do not pretend to cover omitted candidates.
- Discovery never searches ungranted companies. Avoid overlapping independent onboarding credentials with disjoint discovery grants when duplicate prevention requires shared visibility; global name uniqueness is not asserted.
- Legacy ClawPilot contact email identity is unique across the pipeline. An ungranted collision returns generic `IDENTITY_CONFLICT`, without revealing or reparenting the hidden contact. Separate same-email contact creation requires a broader reviewed identity change.
- Approved identifier records and review decisions have storage/validation, but their operator issuance workflow is not implemented here. Selecting a permitted existing ID can be submitted as a new reviewed command. A caller boolean cannot bypass ambiguity, and separate-contact review does not override legacy uniqueness.
- Credential provisioning/rotation UI, hosted acceptance, external connector activation, and native projection delivery are separate release checks. Login email and user permissions are never inferred from a matched contact.

## Verification and source map

November 2 local candidate: 25 HTTP/auth/route/merge checks and 68 actual PostgreSQL assertions passed on Node 24.22.1. The PostgreSQL fixture applies all migrations and uses actual native-control locking, CRM staging/outbox/audit, immutable source mappings and folder binding. Its folder flow runs actual authenticated machine HTTP → actual PostgreSQL publication → actual Project-card reconciliation; the card retains its identity and comments. Shortlink upkeep is excluded. Added cases cover commit rollback, lost successful response, stale description CAS, source-customer/account/alias mismatch, manual removal, changed grants/module access and immutable binding. New Fractional-created companies are explicitly typed Customer; existing company classifications are preserved. Separate HTTP tests use synthetic persistence to inject post-commit card-reconciliation failure/retry. None of these tests is real Fractional sender, signed-in browser, native delivery or hosted acceptance.

On Node 24.21.0, focused model/HTTP tests passed 20/20; the actual PostgreSQL fixture passed 36 assertions with all repository migrations and production CRM staging/outbox code. Coverage includes tenant/parent denial, pure reads, conditional writes, stable receipt replay, private-field preservation, aliases, retired ancestry, null email clearing, parallel exact retry, atomic pair review, immutable attribution, token-identity immutability, and permission revocation. The concurrency fixture observes a native ancestor archive waiting on the gateway transaction's lock, then verifies later descendant access is denied. No provider network calls occur. Owned disposable PostgreSQL cleanup completed. Existing CRM contact-identity regression and focused ESLint passed. Production build and CI receipts belong to the release record; they are not implied by these targeted results.

`npm run test:fractional-crm-gateway` executes model, HTTP/auth, mocked native transport/worker, and guarded actual PostgreSQL acceptance; it is included in the existing `npm test` CI path. Use the normal local storage preflight and owned disposable database guard. Do not point this test at a saved or hosted database.

Source: `app_src/lib/fractionalCrmGatewayAuth.ts`, `fractionalCrmGatewayHttp.ts`, `crm/fractionalGatewayModel.ts`, `crm/fractionalFolderBoardProjection.ts`, `persistence/fractionalCrmGateway.ts`, the exact integration route, and migrations `0372_fractional_crm_gateway.sql`, `0390_crm_fractional_customer_folders.sql`, and `0403_fractional_crm_customer_folder_capability.sql`. The narrow Account description outbox is implemented in `persistence/crm.ts` and `crm/suiteCrmClient.ts`. See [CRM and reporting](crm-and-reporting.md) and [organization-rooted tenancy](../decisions/0002-organization-rooted-tenancy.md) for existing authority and access conventions.
