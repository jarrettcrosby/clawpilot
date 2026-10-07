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

Capabilities are independent: `crm.company.read`, `crm.contact.read`, `crm.company.write`, `crm.contact.write`, and `crm.onboarding.write`. Provision only those reviewed for the caller. Newly created onboarding companies are added to that credential's allowlist transactionally. This is not a wildcard grant to the pipeline.

## HTTP and canonical fields

All paths start with `/api/integrations/fractional-crm/v1`. Each request requires `sourceInstanceId`, `workspaceOrganizationId`, `pipelineId`, and `rootCompanyGlobalId` query parameters matching the registered credential. Browser Cookie, Origin, and Sec-Fetch-Site authority is rejected. Responses are private and no-store; unexpected errors never return SQL, token contents, or arbitrary exception messages.

| Method and path | Behavior |
| --- | --- |
| `GET /companies/{ga}` | Pure canonical company read. |
| `GET /companies/{ga}/contacts` | Company-scoped contact list, default 50, maximum 100, opaque scoped cursor. |
| `GET /companies/{ga}/contacts/{gc}` | Pure contact read with exact parent validation. |
| `PATCH /companies/{ga}` | Conditional allowlisted company-field update. |
| `PATCH /companies/{ga}/contacts/{gc}` | Conditional contact-field update without reparenting. |
| `POST /onboarding/resolve-or-create` | Atomic company/contact resolution and optional creation under the registered source scope. |

Bodies are limited to 64 KiB and a ten-second read deadline. PATCH requires a strong quoted `If-Match` version and `Idempotency-Key`; the key is 8–160 ASCII letters, digits, underscores, or hyphens. Envelopes echo schema/source/scope, canonical and requested IDs, immutable record UUID, parent company, opaque content version, management, and `canPush`. Workspace-managed companies and app-user-managed contacts remain read-only. An alias can be read with explicit canonical resolution; PATCH requires the canonical ID.

Company fields are `companyName`, `website`, `email`, `phone`, `addressLine1`, `addressLine2`, `city`, `region`, `postalCode`, and `countryCode`. Contact fields are `displayName`, `email`, `phone`, and `jobTitle`. Only work phone is mapped; mobile, notes, opt-outs, ownership, and unrelated native fields remain unchanged. A structured first/last name cannot be silently reconstructed from a changed display name. Emails normalize only case and surrounding whitespace during matching; writes require canonical input. No plus-address or dot rewriting occurs.

Raw canonical PostgreSQL text is retained, including apostrophes and literal entities. Missing data is `null`; an address that cannot map losslessly to at most two lines or a non-ISO stored country is explicitly unavailable with retained source text. Unavailable fields must not clear known Fractional fields. Requested fields must match the committed canonical readback exactly or the transaction rolls back.

## Onboarding and durable evidence

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

On Node 24.21.0, focused model/HTTP tests passed 20/20; the actual PostgreSQL fixture passed 36 assertions with all repository migrations and production CRM staging/outbox code. Coverage includes tenant/parent denial, pure reads, conditional writes, stable receipt replay, private-field preservation, aliases, retired ancestry, null email clearing, parallel exact retry, atomic pair review, immutable attribution, token-identity immutability, and permission revocation. The concurrency fixture observes a native ancestor archive waiting on the gateway transaction's lock, then verifies later descendant access is denied. No provider network calls occur. Owned disposable PostgreSQL cleanup completed. Existing CRM contact-identity regression and focused ESLint passed. Production build and CI receipts belong to the release record; they are not implied by these targeted results.

`npm run test:fractional-crm-gateway` executes model, HTTP/auth, and guarded actual PostgreSQL acceptance; it is included in the existing `npm test` CI path. Use the normal local storage preflight and owned disposable database guard. Do not point this test at a saved or hosted database.

Source: `app_src/lib/fractionalCrmGatewayAuth.ts`, `fractionalCrmGatewayHttp.ts`, `crm/fractionalGatewayModel.ts`, `persistence/fractionalCrmGateway.ts`, the exact integration route, and migration `0372_fractional_crm_gateway.sql`. The narrow `persistence/crm.ts` changes provide contact create-only persistence and preservation of locked owner metadata. See [CRM and reporting](crm-and-reporting.md) and [organization-rooted tenancy](../decisions/0002-organization-rooted-tenancy.md) for existing authority and access conventions.
