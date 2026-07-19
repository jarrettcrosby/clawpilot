---
id: cp-module-quickbooks-accounting
title: QuickBooks Accounting Connector
summary: Organization-bound QuickBooks access, authoritative financial reports, reconstructed invoice and receipt evidence, explicit CRM product import, and controlled accounting mappings.
status: active
kind: module-contract
area: integrations
tags: [quickbooks, accounting, maton, products, toast, tenancy]
app_visible: true
---

# QuickBooks Accounting Connector

## Purpose

Bind one QuickBooks Online company to the active ClawPilot organization without confusing a user's personal provider authorization with organization data ownership. The connector projects company metadata, accounts, products and services, customers, vendors, transaction forms, attachments, and formal reports into an organization-scoped accounting workspace. The product direction is a complete QuickBooks operating console; provider writes remain locked until sandbox behavior, reconciliation, approval, and recovery controls are accepted.

## Connection And Tenancy Contract

- A user first authorizes QuickBooks through their own Maton account and selects one `ACTIVE` QuickBooks connection.
- An organization owner or administrator with access-management permission explicitly binds that selected connection to the active organization.
- The encrypted Maton API key remains user-owned. The organization stores only the credential owner, selected connection pointer, verified company name, status, and sync metadata.
- One Maton QuickBooks connection cannot be bound to two ClawPilot organizations. A user with multiple businesses switches workspace and binds each business to its own QuickBooks company.
- Every API read, cached record, worker job, Toast mapping, CRM import, and audit event is scoped by `organization_id`.
- Rebinding or disconnecting clears cached account and item rows and invalidates old account mappings. It never falls back to another organization or platform credential.

## Read-Only Accounting Flow

```mermaid
flowchart LR
  User[User Maton authorization] --> Binding[Organization connection binding]
  Binding --> Worker[Leased catalog worker]
  Worker --> QBO[QuickBooks read-only APIs]
  QBO --> Accounts[(Account and product projections)]
  QBO --> Financial[(Customer, vendor, transaction, attachment projections)]
  QBO --> Reports[(Authoritative report snapshots)]
  Financial --> Explorer[Accounting explorer]
  Reports --> Explorer
  QBO --> Items[(Product and service projection)]
  Items --> Selection[Explicit manager selection]
  Selection --> CRM[(CRM product catalog)]
  CRM --> Pipeline[Pipeline product dropdown]
```

- The shared Railway poller claims snapshot jobs with a lease and bounded retries.
- Entity pages are fetched serially with provider pacing. Rate limits and temporary provider failures honor `Retry-After` plus capped exponential backoff; a failed refresh leaves the last complete snapshot intact.
- Automatic refresh runs no more often than once every 24 hours for enabled active bindings. A manager can queue a refresh from Settings.
- Provider responses are size-bounded and parsed into sanitized projections before Postgres persistence.
- The Accounting workspace supports an overview, invoices, receipts, all transaction types, products and services, the chart of accounts, customers, vendors, attachment evidence, and formal financial statements. Lists are paginated and searched server-side.
- Profit & Loss and Cash Flow are cached for month-to-date, quarter-to-date, year-to-date, and six-month periods. Balance Sheet, A/R Aging, and A/P Aging are cached as-of snapshots. These views preserve the report basis and nested totals returned by the QuickBooks Reports API.
- Overview totals remain operational views of synced transaction forms. They are intentionally separated from authoritative QuickBooks statements.
- Selecting an invoice reconstructs a document view from its durable source payload, including customer and company addresses, dates, terms, item descriptions, quantities, rates, subtotal, tax, total, balance, and linked attachments.
- Receipt and invoice attachments remain organization scoped. ClawPilot validates the signed-in user's accounting permission, resolves the organization binding on the server, and requests a short-lived QuickBooks download URL. Because Maton may reject QuickBooks' dedicated download resource, ClawPilot first refreshes the exact Attachable metadata and uses its temporary Intuit URL, retaining the documented download resource as a fallback. Provider credentials and durable download URLs are never returned by ClawPilot APIs.
- Organization owners can view accounting data. Administrators can grant the `viewAccounting` permission to selected organization members. Connector management remains restricted to owners and access administrators.
- Categories, inactive items, and ambiguous duplicate names are not imported as pipeline products.
- Product import is explicit and limited to 100 selected active products or services per request. It stages durable CRM product records, queues SuiteCRM projection, and refreshes the selected pipeline's product catalog.
- Read access does not create invoices, receipts, payments, journal entries, customers, or provider-side items.

## Toast Mapping Contract

Each selected Toast location can map sales, discounts, voids, refunds, taxes, tips, service charges, gift cards, tenders, payouts, fees, and over/short to active accounts from the organization-bound QuickBooks company. Unmapped values remain valid configuration choices and keep accounting drafts in `needs_mapping`.

Refreshing the chart of accounts clears any mapping whose provider account no longer exists or is inactive. Disconnecting QuickBooks clears every account pointer and returns unposted drafts to mapping review. Posted evidence is retained.

## Posting Boundary

The current release is read-only. QuickBooks posting will require a separate accepted slice with all of the following:

1. Intuit sandbox verification for invoices, receipts, journal entries, products, customers, and idempotent retries.
2. Explicit organization approval roles and immutable approval evidence.
3. Balanced Toast draft reconciliation and account-mapping validation.
4. Provider transaction references, reversal behavior, retry safety, and a tested recovery procedure.
5. Agent isolation: agents may summarize normalized records but cannot retrieve credentials, change mappings, approve drafts, or post transactions.

## Durable Data

- `organization_quickbooks_connections`
- `quickbooks_accounts`
- `quickbooks_items`
- `quickbooks_customers`
- `quickbooks_vendors`
- `quickbooks_transactions`
- `quickbooks_attachments`
- `quickbooks_financial_reports`
- `quickbooks_sync_outbox`
- `toast_accounting_mappings`
- `toast_accounting_export_drafts`
- `audit_events`

## Verification

1. Run `npm run test:quickbooks` and `npm run test:toast`.
2. Select an active Maton QuickBooks connection, switch to the intended workspace, and bind it in **Settings > Integrations > QuickBooks**.
3. Confirm the company name matches the active organization before importing or mapping anything.
4. Refresh the catalog and confirm `/api/health` reports migration `0063` plus a current QuickBooks worker heartbeat.
5. Open each Financial reports tab and verify its period, basis, nested rows, totals, and latest-sync state against QuickBooks Online.
6. Open an invoice and verify its item lines, quantity, rate, tax, total, balance, and customer addresses. Open one linked receipt image or PDF and confirm another organization cannot retrieve it.
7. Import a small selected item set and verify CRM, SuiteCRM outbox, and pipeline product dropdown results.
8. Save one Toast location mapping and confirm another organization cannot read or mutate it.
9. Confirm no QuickBooks mutation endpoint or automatic posting path exists in this release.

QuickBooks report and attachment behavior follows Intuit's official [Reports API workflow](https://developer.intuit.com/app/developer/qbo/docs/workflows/run-reports) and [attachment workflow](https://developer.intuit.com/app/developer/qbo/docs/workflows/attach-images-and-notes).

See [User Integrations and Credentials](user-integrations.md), [Toast Sales and Accounting](toast-and-accounting.md), and [Platform and Data Map](../maps/platform-data-map.md).
