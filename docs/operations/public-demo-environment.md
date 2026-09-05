---
id: cp-ops-public-demo
title: Demo Account
summary: Permissioned synthetic ClawPilot account, rolling-date dataset, tenant boundary, read-only controls, and acceptance checks.
status: active
kind: operations-contract
area: operations
tags: [demo, synthetic-data, security, tenancy, quickbooks]
app_visible: true
---

# Demo Account

## Purpose

The demo is a protected account inside the sole Railway production deployment.
It is not a separate app instance, host, Railway environment, or public login
path. An authorized signed-in user opens the active-business control and
selects **Open demo account**. The current browser session switches to a
complete synthetic customer example and can switch back to any normal business
from the same control.

The obsolete Railway `demo` environment was retired on July 19, 2026. Do not
recreate a standalone demo service or restore `demo.aiapp.eigenracing.com`.
Railway production seeds the protected account into its own database; local
fixtures do not seed or connect to that production tenant. Post-retirement
Vercel previews must not connect either; the current application-project Vercel
database assignment is a cutover blocker, so no Vercel deployment is accepted
as demo isolation evidence until the gated credential removal and re-audit pass.

The login screen never advertises or opens the demo. An invitation starts with demo access off. An organization administrator must explicitly enable **Demo account access** for that user; owners retain access by default.

## Synthetic Data Contract

- The generator creates `ClawPilot Demo Company`, fictional customer accounts, contacts, products, opportunities, interactions, project work, documents, invoices, vendors, accounts, and reports.
- Every customer, contact, and vendor email uses the reserved `demo.clawpilot.example` domain. Names, phone numbers, provider IDs, and source payloads are synthetic.
- Production and retired-development records are not donor rows. No literal EPISCS, Suburbia Sandwich Co, user, customer, email, timestamp, invoice, interaction, or provider payload is copied, transformed, or anonymized into the demo account.
- One anchor date drives all generated dates. The default is the current UTC date; `DEMO_ANCHOR_DATE=YYYY-MM-DD` creates a deterministic acceptance snapshot.
- CRM interactions and invoices span `0-30`, `31-60`, and `61-90` day cohorts. Opportunities include future, active, won, and lost outcomes. Accounting deposits and reports extend the synthetic model through a rolling twelve-month view.
- `demo_dataset_metadata` records the anchor, generator version, windows, generation time, and counts. Verification rejects missing records, non-demo email domains, or a demo identity matching a live CRM identity.

## Tenant And Mutation Boundary

- The account has the fixed workspace ID `10000000-0000-4000-8000-000000000001`, one fixed board, and one fixed pipeline. Its workspace row is marked `is_demo=true`; a partial unique index allows only one demo account per database.
- Human access is a normal workspace membership created only after the signed-in user passes the `accessDemo` permission check. Human members receive viewer access to the fixed board and pipeline.
- Requests in a browser session whose active workspace is the demo account are read-only. Data mutations return `403`; switching business, session activity, and sign-out remain available.
- QuickBooks is a local synthetic projection with connection ID `demo-synthetic-no-provider`. Provider write mode is disabled, catalog polling is off, and no Maton, Google, Toast, SuiteCRM, OpenAI, Intuit, or Gmail credential is attached.
- Demo rows share the deployment database only as a separate tenant. Every seeded CRM, project, document, pipeline, and accounting object is scoped to the fixed demo workspace or its fixed resources.

## Seed And Refresh

Railway production predeploy applies migrations, runs `npm run demo:seed`, and
then runs `npm run demo:verify`. The seed transaction deletes and recreates only
data owned by the fixed demo workspace. It never truncates a shared table.
Fixed workspace, board, and pipeline IDs preserve navigation, while active
authorized memberships and browser sessions remain intact.

Manual operations:

```bash
npm run demo:seed
npm run demo:verify
```

These commands are safe only because their delete predicates use the fixed demo workspace ID. Any change to those predicates requires a temporary-database acceptance run before deployment.

## Acceptance

1. Run `npm run test:demo` to verify synthetic identities, rolling-date cohorts, permission defaults, in-app switching, and provider restrictions.
2. Run `npm run demo:verify-postgres` against an authorized Postgres server. It creates a temporary database, applies all migrations, seeds twice to prove idempotency, verifies it, and removes only that generated database.
3. After Railway production health succeeds, sign in as an owner. Use **Open demo account** and confirm CRM, Pipeline, QuickBooks, Projects, and Docs show only fictional data with current relative dates.
4. Confirm a normal data mutation in the demo returns `403`, then switch back to a real business and confirm the same workflow remains writable.
5. Invite a test member with demo access off and confirm the CTA is absent. Enable the permission and confirm it appears without exposing the demo on the login screen.
6. Repeat the authenticated workflow on desktop and mobile as production acceptance evidence before declaring the release complete.

See [ClawPilot Environments and Deployment](clawpilot-environments.md), [QuickBooks Accounting Connector](../modules/quickbooks-accounting.md), and [Organization-rooted Tenancy](../decisions/0002-organization-rooted-tenancy.md).
