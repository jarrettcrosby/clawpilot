---
id: cp-ops-public-demo
title: Public Demo Environment
summary: Isolated synthetic ClawPilot environment, rolling-date dataset, reset controls, provider boundaries, and acceptance checks.
status: active
kind: operations-contract
area: operations
tags: [demo, railway, synthetic-data, security, quickbooks]
app_visible: true
---

# Public Demo Environment

## Purpose

The public demo shows a complete ClawPilot workspace without copying production or development data. It uses a dedicated Railway `demo` environment, app instance, and Postgres database at `https://demo.aiapp.eigenracing.com`. It does not share application rows, sessions, provider credentials, databases, or backups with development or production.

## Synthetic Data Contract

- The demo generator creates a fictional parent company, customer accounts, contacts, products, opportunities, interactions, project work, documents, and accounting records. Names, emails, phone numbers, provider IDs, and record IDs are synthetic.
- Production and development are pattern references only. No literal EPISCS, Suburbia Sandwich Co, user, customer, timestamp, invoice, interaction, or provider payload is copied or redacted into the demo.
- One anchor date drives every generated date. By default it is the current UTC date; `DEMO_ANCHOR_DATE=YYYY-MM-DD` creates a deterministic acceptance snapshot.
- CRM interactions and invoices preserve realistic relative sequence across `0-30`, `31-60`, and `61-90` day cohorts. Opportunities include current, future, recently won, and recently lost outcomes. Accounting deposits and report periods extend the same model through a rolling twelve-month view.
- `demo_dataset_metadata` records the anchor, generator version, window sizes, generation time, and record counts. `npm run demo:verify` rejects an incomplete or externally connected dataset.

## Isolation And Mutation Boundary

- `CLAWPILOT_DEMO_MODE=1` is accepted only when `RAILWAY_ENVIRONMENT_NAME=demo`.
- Demo sign-in creates a normal, attributable browser session for `demo@clawpilot.example`; no email code or external identity provider is required.
- Local CRM, pipeline, accounting, document, and project exploration remains available. User access administration, invitations, impersonation, provider integration changes, credential changes, backups, and agent authorization are disabled.
- QuickBooks data is a durable synthetic projection with connection ID `demo-synthetic-no-provider`. Its provider write mode is `disabled`, automatic provider catalog sync is off, and no Maton, Google, Toast, SuiteCRM, OpenAI, Intuit, or Gmail credential is installed.
- Demo startup still requires strong internal session, worker, encryption, and short-link secrets. These secrets are unique to demo and are never copied from another environment.

## Seed And Reset

Railway predeploy applies all migrations, runs `npm run demo:seed`, and verifies the result before the app starts. The runtime refresh loop regenerates the dataset every 24 hours by default. A reset is transactional, but it invalidates existing public demo sessions; the visitor can immediately re-enter through **Explore the live demo**.

Manual operations:

```bash
npm run demo:seed
npm run demo:verify
```

The seeder refuses to run unless demo mode and environment guards pass. A local operator must additionally set `CLAWPILOT_ALLOW_LOCAL_DEMO_SEED=1`. Never point these commands at development or production.

## Acceptance

1. Run `npm run test:demo` to verify synthetic identities, rolling date cohorts, migration controls, and provider restrictions.
2. Run `railway run --environment development --service Postgres npm run demo:verify-postgres`. This creates a temporary database, applies every migration, seeds and verifies it, then drops only that generated database.
3. Verify `https://demo.aiapp.eigenracing.com/api/health` reports current migrations and worker heartbeats.
4. Use **Explore the live demo** in desktop and mobile layouts. Confirm CRM, pipeline, QuickBooks invoices and line items, projects, and documents render with current relative dates.
5. Confirm restricted settings return `403` and no external provider request or accounting write is possible.

See [ClawPilot Environments and Deployment](clawpilot-environments.md), [QuickBooks Accounting Connector](../modules/quickbooks-accounting.md), and [Organization-rooted Tenancy](../decisions/0002-organization-rooted-tenancy.md).
