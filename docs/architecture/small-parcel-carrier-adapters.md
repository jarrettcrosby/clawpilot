---
id: cp-architecture-small-parcel-carrier-adapters
title: Small Parcel Carrier Adapter Architecture
summary: Provider-neutral rating, shipment, label, tracking, and reconciliation boundary for UPS, FedEx, USPS, and optional RocketShipIt transport.
status: draft
kind: architecture
area: distributed-operations
tags: [clawpilot, shipping, carriers, ups, fedex, usps, rocketshipit]
app_visible: false
---

# Small Parcel Carrier Adapter Architecture

## Decision

ClawPilot owns the canonical carrier contract. UPS, FedEx, USPS, and RocketShipIt are replaceable provider adapters; no provider payload becomes the shipment, package, rate, label, or tracking authority.

The initial production target remains direct UPS REST, FedEx REST, and USPS REST adapters. RocketShipIt is an optional aggregator adapter that can accelerate coverage or provide an approved fallback. Using RocketShipIt must not prevent a customer from binding a direct carrier account later.

The operator-supplied RocketShipIt PHP 1.0 guide is useful historical context, but new work targets the current RocketShipIt 2.x Cloud API. RocketShipIt documents one `POST https://api.rocketship.it/v1` endpoint with `Content-Type` and `x-api-key` headers, and explicitly states that `/v1` is version 1 of its 2.x API rather than legacy RocketShipIt 1.x.

## Canonical Adapter Boundary

Every adapter declares:

- provider, adapter version, environment, and supported carriers;
- address-validation, rating, transit, label, void, tracking, manifest, pickup, customs-document, proof-of-delivery, and reconciliation capabilities;
- account and service eligibility obtained from an organization-scoped integration account;
- supported package, label, currency, country, and special-service constraints;
- timeout, retry, circuit, and reconciliation behavior.

Canonical requests use:

- immutable ClawPilot Global IDs for order, package, shipment, provider account, and command identity;
- canonical millimeters and grams at the adapter boundary;
- ISO currency and country codes;
- minor-unit or decimal money inside ClawPilot, never binary floating-point arithmetic;
- UTC timestamps plus explicit facility-local cutoff context;
- a durable idempotency key and correlation Global ID for every side effect.

Provider-specific units, field names, service codes, and money representations are translated only inside the adapter. The exact sanitized request and response snapshot is retained with provider, account reference, environment, adapter version, carrier, service, package version, and occurrence time.

## Provider Strategy

| Provider | Role | Initial capabilities | Production evidence required |
| --- | --- | --- | --- |
| UPS REST | Direct | OAuth, address, rating, transit, shipping/label, void, tracking | UPS app/account verification, sandbox contracts, authorized live smoke |
| FedEx REST | Direct | OAuth, address, rating, transit, shipping/label, cancellation, tracking | FedEx project/account verification, sandbox contracts, authorized live smoke |
| USPS REST | Direct | OAuth, address, pricing, service standards, labels, tracking | USPS app, Enterprise Payment Account/label approval where required, test-label contracts, authorized live smoke |
| RocketShipIt Cloud | Optional aggregator | Authentication, address, rates, transit, labels, void, tracking, pickup, manifest, documents | Active RocketShipIt account, carrier-account verification, sandbox/test contracts, authorized live smoke |
| Mock | Test evidence only | Deterministic address, rates, transit, labels, void, tracking, reconciliation | Automated tests; never represented as a live carrier |

Unsupported capabilities stay visibly disabled. A provider transport compiling or returning fixture data does not establish production support.

### Provider environment boundaries

| Provider | Developer environment | Production environment |
| --- | --- | --- |
| UPS REST | CIE (`wwwcie.ups.com`) | UPS production (`onlinetools.ups.com`) |
| FedEx REST | Sandbox (`apis-sandbox.fedex.com`) | FedEx production (`apis.fedex.com`) |
| USPS REST | TEM (`apis-tem.usps.com`) | USPS production (`apis.usps.com`) |

Each organization configures a distinct credential record for each provider and environment. Environment hosts are adapter constants, not user configuration. Provider test credentials, account enrollment, permissions, test labels, and certification steps remain separate from production onboarding, and no access token or verified state crosses that boundary.

## RocketShipIt Transport Rules

The isolated Cloud transport:

- fixes the host to `https://api.rocketship.it/v1` and does not accept an operator-supplied endpoint;
- permits only reviewed carriers and documented actions;
- sends no credentials through browser APIs or business tables;
- uses a timeout below RocketShipIt's documented 30-second Cloud limit;
- bounds response size before parsing;
- rejects `debug` anywhere in a request because RocketShipIt debug responses may contain underlying carrier requests and responses;
- converts HTTP, RocketShipIt metadata, carrier, timeout, and network failures into stable error codes without logging request parameters, credentials, labels, addresses, or provider error bodies;
- treats RocketShipIt floating-point money fields as untrusted input that must be parsed into exact ClawPilot money before persistence;
- treats base64 labels and documents as sensitive document payloads and sends them to the document/print boundary rather than logs.

The transport is intentionally below the canonical `CarrierAdapter`. A later RocketShipIt adapter maps ClawPilot requests to `GetAllRates`, `SubmitShipment`, `AddressValidate`, `VoidShipment`, `TimeInTransit`, `Track`, `CreatePickup`, `CreateManifest`, and document actions as supported by each carrier.

## Side-Effect Safety

Rating and transit requests may use bounded retries when a provider definitively did not create a transaction. Label, void, pickup, manifest, and document actions use a durable command before the outbound request.

A label command records:

- organization, provider account, package Global ID and version;
- carrier/service, request hash, provider key/reference, and idempotency key;
- attempt number, start/end time, timeout/circuit state, and outcome;
- `succeeded`, `failed`, or `unknown` status;
- resulting label/document references, tracking number, charge, and sanitized response snapshot.

An ambiguous timeout is `unknown`, not failed. ClawPilot reconciles using the original provider key or approved carrier reference before it retries. A new command key cannot be used to bypass reconciliation. At most one active label may exist for a package version and carrier account.

## Rating And Selection

Eligible carrier adapters are called with controlled parallelism and provider-specific deadlines. Results are normalized into one immutable rate snapshot containing:

- provider/account, carrier/service, negotiated or published source;
- package dimensions, actual weight, billing weight, zone, surcharges, taxes, currency, and total cost;
- transit days, delivery estimate, guarantee, Saturday/residential indicators, and restrictions;
- request time, expiration, provider response reference, and adapter version.

Selection occurs in the domain service after normalization. It chooses the lowest approved cost that meets the customer promise unless a versioned customer, contract, warehouse, or carrier rule requires another promise-safe option. Provider order never determines the winner.

## Secrets And Account Ownership

Carrier credentials are organization-scoped and stored through ClawPilot's secret-management boundary. Each customer organization supplies and verifies credentials separately for every carrier and environment it enables. Business tables retain only a credential reference and non-secret configuration. Integration accounts distinguish customer-owned from operator-owned carrier accounts and bind allowed warehouses, services, billing terms, and environments.

ClawPilot never falls back to another organization's credentials or to a platform-wide carrier account. A carrier capability stays unavailable until the active organization has an active, verified account for that carrier and environment. Operator-owned credentials may be selected only when the organization has an explicit, auditable authorization and billing rule for that account.

OAuth access tokens remain server-side, short-lived, and cached by provider/account/environment. Rotation creates auditable credential metadata without exposing the credential value. Test credentials cannot be selected by a production shipment command.

### Implemented Credential, Sandbox Rating, And Diagnostic Label Boundary

Migration `0087_operations_carrier_credentials.sql` adds the organization-scoped encrypted companion record for direct UPS REST, FedEx REST, and USPS REST integration accounts. **Settings > Integrations > Shipping** verifies a candidate through the provider's fixed OAuth endpoint before writing AES-256-GCM ciphertext. Authenticated encryption includes organization, provider, and environment; API responses expose only masked suffixes, verification state, credential version, safe error code, and timestamps. Enabling an account re-verifies it, while disconnect removes ciphertext and disables the non-secret integration record. Access tokens are intentionally discarded after verification.

Migration `0088_operations_sandbox_rating_and_mock_retirement.sql` adds an append-only `grq` sandbox-rate evidence record. An organization manager may run one UPS CIE or FedEx Sandbox rate request from **Settings > Integrations > Shipping** only when that provider's sandbox credential and selected billing account are active and verified. The selected account's sender identity and registered address are the origin, the operator may edit a validated U.S. destination, and one fixed `Test Product` parcel measures `12 x 10 x 6 in` and weighs `5 lb`. Rating is sender-billed in this bounded flow. The browser receives normalized quotes and the evidence Global ID; durable evidence binds the exact request while omitting credentials, access tokens, account numbers, raw provider bodies, and full address PII.

Rating and shipping remain separate provider commands. A successful rate contains no label document or tracking number. An authorized operator may explicitly select one evidenced service and call the provider sandbox Ship API through a durable prepare/call/finalize command. The returned label is decoded, format-validated, checksummed over printable bytes, and stored before any printer route is attempted. The associated void resolves the exact persisted account, and an ambiguous create or void result blocks a fresh attempt until reconciliation.

Printing is a third command over the stored label artifact. Test-print, retry, and controlled reprint do not call the carrier. The boundary refuses production credentials and cannot create an operational shipment, pickup, manifest, tracking observation, commerce export, packing slip, or inventory mutation. A successful sandbox rate or label remains diagnostic evidence, not certification for production shipping.

## Health And Reconciliation

Adapter health reports capability, environment, circuit state, last successful authentication, last rate/label/tracking result, quota/rate-limit state when available, and reconciliation cursor. Health output never includes account numbers, credentials, addresses, labels, or raw provider bodies.

Scheduled reconciliation covers:

- label commands with unknown outcomes;
- active labels versus carrier shipment state;
- void acknowledgements;
- manifests and pickups;
- tracking gaps and terminal status;
- carrier charges versus stored estimate/final cost;
- commerce fulfillment/tracking export acknowledgements.

## Source Documentation Reviewed

- [RocketShipIt Cloud API](https://docs.rocketshipit.com/rs/docs/cloud-api.html)
- [RocketShipIt request and response format](https://docs.rocketshipit.com/rs/docs/req-resp-format.html)
- [RocketShipIt rating guide](https://docs.rocketshipit.com/rs/docs/rating.html)
- [UPS Developer Portal](https://developer.ups.com/)
- [UPS API catalog](https://developer.ups.com/catalog?loc=en_US)
- [FedEx rates and transit times API](https://developer.fedex.com/api/en-us/catalog/rate/docs.html)
- [FedEx OAuth API](https://developer.fedex.com/api/en-as/catalog/authorization/docs.html)
- [FedEx ship API](https://developer.fedex.com/api/en-pr/catalog/ship/docs.html)
- [USPS APIs getting started](https://developers.usps.com/getting-started)
- [USPS Domestic Labels 3.0](https://developers.usps.com/domesticlabelsv3)

## Release Gate

No live shipment or label purchase is enabled until the adapter has:

1. tenant and account isolation tests;
2. capability and schema contract tests against the provider sandbox/test environment;
3. timeout, rate-limit, invalid-address, invalid-package, carrier-error, unknown-outcome, retry, void, and reconciliation tests;
4. credential rotation and environment-separation tests;
5. sanitized observability review;
6. an authorized live smoke test and recorded provider/account verification;
7. rollback and carrier-outage procedures in the operations runbook.
