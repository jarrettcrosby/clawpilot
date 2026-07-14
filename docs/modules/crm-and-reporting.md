---
title: CRM and Workbook Reporting
status: active
kind: module-contract
tags: [crm, suitecrm, organizations, contacts, opportunities, reporting]
app_visible: true
---

# CRM and Workbook Reporting

## Purpose

Use ClawPilot as the customer-work interface, SuiteCRM as the canonical CRM, Railway Postgres as the durable ClawPilot projection and outbox store, and Google Sheets as the opportunity input and reporting workbook.

## Ownership Contract

- SuiteCRM owns Organizations, Contacts, Opportunities, Interactions, CRM relationships, and CRM record history.
- ClawPilot is the primary user interface for Organizations, Contacts, and Interactions.
- The selected pipeline's `Opportunities` Sheet table is the only writable workbook input. Sheet pulls stage those changes into the same CRM gateway used by ClawPilot writes.
- Railway Postgres stores tenant-scoped CRM projections, source identity, synchronization status, reconciliation runs, and outbox leases. It is not a second independent CRM authority.
- Development and production use separate SuiteCRM, MariaDB, Postgres, Google workbook, and user data.

## Entity Mapping

| ClawPilot | SuiteCRM | Workbook |
|---|---|---|
| Organization | Account | Generated `Organizations` projection |
| Contact | Contact | Generated `Contacts` projection |
| Opportunity | Opportunity | Writable `Opportunities` input and canonical projection |
| Interaction | Note initially | Generated `Interactions` projection |

Every migrated record preserves its source workbook payload, source row, stable source key, deterministic SuiteCRM identifier, last synchronization state, and error details. Imports are additive and idempotent; they do not delete the source workbook.

## Workbook Contract

The managed workbook requires `Start Here`, `Organizations`, `Contacts`, `Opportunities`, `Interactions`, `Calculations`, `Dashboard`, and `Dropdowns`. Headers begin on row 4. Column A carries a hidden, protected ClawPilot record identity for CRM entity tabs.

Google protected ranges permit user edits only in `Opportunities!B5:M`. All other tabs, the opportunity headers, and record identifiers are generated and protected. `Calculations` and `Dashboard` derive reporting values from the projected CRM data.

The pipeline and CRM surfaces expose the workbook through its ClawPilot short link. The Pipeline header also creates, retries, or repairs the managed Sheet when the current owner has no usable link. That link does not bypass Google access controls.

## Synchronization

1. A ClawPilot form write or an Opportunities Sheet pull stages a pipeline-scoped Postgres projection and a `suitecrm` outbox item atomically.
2. The SuiteCRM worker claims records with a lease, uses OAuth2 client credentials against the private Railway service, and records success or a retriable failure.
3. A successful SuiteCRM batch queues a `project_crm_workbook` Google outbox operation.
4. The Google worker regenerates the protected workbook projections and records a reconciliation run.

The active endpoints are `/api/crm`, `/api/crm/import`, `/api/crm/workbook`, and the authenticated worker endpoint `/api/crm/outbox/process`.

## Operations

Use the [SuiteCRM Railway runbook](../operations/suitecrm.md) for service variables, volume, worker, migration, and rollback checks. Use [Pipeline and synchronization](pipeline-and-sync.md) for Google provisioning and workbook access.
