---
id: cp-module-pipeline-sync
title: Pipeline and Synchronization
summary: Personal and shared pipelines, managed Google Sheets, projections, outboxes, permissions, and synchronization lifecycle.
status: active
kind: module-contract
area: pipeline
tags: [pipeline, google-drive, google-sheets, outbox, provisioning, projections, crm]
app_visible: true
---

# Pipeline and Synchronization

## Purpose

Provide a user-owned pipeline workspace while preserving the Opportunities Sheet as the writable operator table and SuiteCRM as the CRM authority.

## Current Contract

- Every active user receives a default pipeline space.
- Every new default or additional pipeline receives the generic base workflow once: stages, priorities, lifecycle statuses, sources, and loss reasons are seeded in `pipeline_dropdown_catalogs`; products remain empty until that organization adds or imports its own catalog. Existing customized catalogs are preserved, while wholly empty legacy workflow catalogs receive the base choices without replacing their products.
- A pipeline owner can share view or edit access with another active user.
- Railway Postgres stores ClawPilot-owned pipeline definitions, normalized rows, projections, sync outbox entries, and audit events.
- Pipeline editors can create an opportunity from the Pipeline surface by selecting an existing customer organization or creating that customer organization inline. Products are selected from active, tenant-scoped CRM Product records and are stored as durable relationships rather than inferred only from a display string. Legacy opportunity names remain readable during migration, while unambiguous existing product names are attached to their new Product records. The opportunity is immediately written to the tenant-scoped CRM tables in Postgres and queued for SuiteCRM synchronization.
- The Pipeline setup surface owns three scoped catalogs: People, Products, and Workflow. People includes active ClawPilot members from the selected organization plus explicitly marked CRM-only team Contacts. A CRM-only person can own pipeline work but receives no application login, invitation, role, session, or implicit data access.
- Product records carry permanent `gp` references, SKU, type, category, status, price, cost, currency, description, and active state. Product and CRM-only-person intake supports individual editing and CSV import. Imports are idempotent inside the selected tenant and report rejected rows without granting access.
- Stage, priority, status, source, and loss-reason choices are editable per pipeline. App-managed pipelines persist the catalog in Postgres. Sheet-backed pipelines send field-scoped patches through the durable outbox: workflow edits update only workflow columns, while active product and owner projections update only their owned columns after merging against a fresh Sheet snapshot. Desired and applied product-catalog revisions remain separate so failed or dead deliveries are retried instead of being reported as synchronized.
- Status is authoritative for lifecycle calculations: `Open` and `On Hold` are active; `Won` and the historical `Closed` alias are won; `Lost` and `Abandoned` are losses. Stage controls board position. Active value excludes terminal statuses, weighted active value is `value × probability`, and win rate is won divided by decided outcomes. Stage/status conflicts, overdue expected-close dates, missing expected-close dates, and invalid probability values are surfaced in Pipeline Insights instead of silently changing totals.
- Mobile portrait and compact-landscape boards use one selected stage at a time with native vertical scrolling. Desktop retains the multi-column board, and every viewport can switch to list or Insights views.
- CRM date-only fields are serialized as `YYYY-MM-DD` whether PostgreSQL returns a string or JavaScript `Date`, so expected-close and campaign dates survive the Postgres, API, and browser-form round trip without timezone conversion.
- ClawPilot opportunity creation and editing require caller-stable idempotency keys. Creates return the existing record without overwriting later edits, and edits use an atomic version check plus a durable replay receipt so concurrent writers cannot silently replace one another.
- Opportunity edits and comments update the CRM record by its Postgres UUID. They never infer or increment a Google Sheet row number.
- Only `Opportunities!B5:M` remains an operator-facing writable workbook table. CRM and reporting tabs are generated projections.
- SuiteCRM/Postgres is the entity authority for app-created opportunities. Google Sheets remains an operator-editable input and reporting surface; synchronization projects changes in both directions through durable outboxes rather than competing direct writes.
- Pull synchronization updates durable normalized rows and a read projection.
- Push synchronization uses an outbox and worker heartbeat; the UI reports sync state instead of assuming a write succeeded.
- New pipeline spaces are app-owned until their owner explicitly confirms the `provision-pipeline` workspace action.
- The configured owner's historical environment Sheet may belong to only one pipeline. Default-resource creation starts new pipelines without a Sheet binding and claims that historical Sheet only when no other pipeline owns it; a second root therefore remains app-owned until its own managed workbook is provisioned, and loading that root cannot overwrite or duplicate the first root's Sheet binding.
- Managed pipelines use one platform Google Workspace integration per environment database. The owner-only settings API stores a standard Google API key and service-account credential separately with AES-256-GCM encryption under `AGENT_CREDENTIAL_ENCRYPTION_KEY`.
- API-key and service-account rotations validate candidates before one atomic persistence update. A failed candidate leaves the current encrypted credential and Shared Drive selection unchanged.
- The integration is ready only when the API key, validated service account, and a selected writable Shared Drive are present. Shared Drive selection verifies that the root can add children and share content.
- Private Drive and Sheets requests use service-account OAuth. The stored API key is also attached for Google project and quota attribution.
- At queue time ClawPilot binds the service-account email and selected Shared Drive ID to the pipeline. Key rotation for that same service account is supported; changing the service-account identity fails closed while managed pipelines remain bound.
- Raw credentials, Sheet IDs, folder IDs, Shared Drive IDs, and internal short-link IDs are not returned in workspace payloads. The owner settings endpoint may return Shared Drive IDs only in the authorized selection list.
- Loading Pipeline setup is read-only for viewers. Catalog bootstrap, CRM projection, and Sheet synchronization run only for pipeline editors or system workers.

## Historical Default Pipeline Catalog

The configured owner's imported workbook uses 13 real products: `AAR`, `LDS`, `CAO`, `CAC`, `GLC`, `TIA`, `POD`, `DTS`, `CPR`, `PTP`, `Merchant y140`, `Merchant y140 & y182`, and `Merchant y182`. The legacy Dropdowns tab expanded those products into 515 comma-separated combinations because Google Sheets could not provide the required multi-select behavior. Those combinations are transport values for opportunity rows, not Product records. ClawPilot and SuiteCRM store only the 13 atomic products and the Pipeline opportunity editor supplies the multi-select interface.

The same historical catalog defines:

- Sources: `Linkedin`, `Email`, `Phone Outreach`, `Networking`, `Website`, `Account Transition`, `Trade Show`.
- Stages: `Identified Lead`, `Qualified Lead`, `Needs Analysis`, `Demo`, `Proposal`, `Negotiation`, `Closed`, `Closed Delayed`, `Loss`.
- Priorities: `A+`, `A`, `B`, `C`, `D`.
- Statuses: `Open`, `Closed`, `Lost`, `Abandoned`, `On Hold`.
- Loss reasons: `Price`, `Functionality`, `Competitor`, `Complaint`, `Other`.

This imported taxonomy is specific to that pipeline. New organizations receive their own tenant-scoped catalog and can edit or import products and workflow values without inheriting another organization's choices. Owner choices are always projected from active ClawPilot users and explicitly added CRM-only people for the selected organization; the legacy static account-manager column is not authoritative.

## Managed Google Resources

- Service accounts cannot own files for this workflow, so provisioning requires the bound Shared Drive and never falls back to My Drive or Maton.
- The provisioning worker creates or recovers resources by Drive `appProperties` under `ClawPilot Data/<Production|Development>/Organizations/<ga code + organization name>/Contacts/<gc code + user name>/Pipelines/<gc code + pipeline name>/` in that Shared Drive.
- `ga` belongs to the workspace organization and `gc` belongs to the app user. They are canonical across owned pipelines; pipeline CRM rows and Drive folders reuse them.
- Existing bound folders and Sheets are moved and renamed by Google resource ID. ClawPilot verifies the exact new parent and name before it removes an empty managed legacy folder.
- Provisioning is resumable. `drive_folder_id` and `provisioning_sheet_id` are stored as soon as each external resource verifies, while public `sheet_id` and `sync_enabled` are set only after all checks pass.
- A managed Sheet requires `Start Here`, `Organizations`, `Contacts`, `Opportunities`, `Interactions`, `Calculations`, `Dashboard`, and `Dropdowns`; headers begin on row 4.
- `Start Here` is the workbook tutorial and explains the same status, stage, probability, expected-close, product, and writable-tab rules as the application. This tutorial is generic and applies to every managed pipeline.
- Every managed tab uses the ClawPilot workbook design system: an organization-branded shell header, a stable `CP` or organization-initial mark, fixed column widths, hidden gridlines, restrained tab colors, Arial typography, and light report surfaces that mirror the application without relying on externally approved `IMAGE` formulas. Reprojection rebuilds this formatting deterministically instead of inheriting prior manual or Google-default styling.
- `Calculations` and `Dashboard` are deterministic generated reports. The Dashboard presents active value, weighted value, won value, and win rate as KPI cards plus managed lifecycle, value, CRM-record, and interaction charts. Its source formulas live in hidden helper columns and each chart explicitly includes hidden dimensions. Managed workbooks are pinned to `Etc/UTC`, so projected interaction timestamps and Sheet calendar-month buckets use one deterministic UTC contract; the app's shared data can still be viewed through a signed-in user's selected reporting timezone. Provisioning clears generated Start Here and reporting ranges, removes every Sheets-API-visible embedded object from managed tabs, rebuilds the managed Dashboard chart set, and never clears the operator-owned Opportunities table or an established Dropdown catalog.
- Opportunity value and expected-close cells receive currency and date formats. Probability is stored as a number from 0 through 100 with up to two decimal places and displayed with two decimal places plus a literal percent suffix; formulas divide it by 100 exactly once. Every managed table range first has legacy data validation removed; Stage, priority, status, source, owner, probability, and date then receive only the current opportunity rules. This prevents old organization or agent dropdown rules from rejecting valid generated CRM values.
- Workbook provisioning seeds Dropdown headers and default values only when it first creates the `Dropdowns` tab. After that, the dropdown synchronizer owns both its headers and values; later CRM projections refresh generated CRM and reporting content without relabeling or replacing the pipeline's configured product or workflow catalogs.
- Column A contains protected record identity. Google protected ranges allow user edits only in `Opportunities!B5:M`.
- Opportunity pulls stage SuiteCRM records through the CRM outbox. Organizations, Contacts, Interactions, Calculations, and Dashboard are regenerated from the CRM projection.
- A ClawPilot short link points to the private Sheet. Creating the link does not change Google permissions.
- The Pipeline header always presents the Sheet state: `Open Sheet` for a ready link, `Create Sheet` for an app-only owner pipeline, a stable in-progress state during provisioning, or a retry/repair command after failure or missing-link recovery.
- The managed folder grants direct user access to the pipeline owner and active app members: `editor` maps to `writer`, and `viewer` maps to `reader`. The reconciler never creates `anyone`, domain, group, or public permissions and only mutates exact users or permissions tracked by ClawPilot.
- Shared Drive governing and inherited permissions are preserved. Direct broad permissions are rejected for operator review; selecting a Shared Drive therefore carries the visibility implied by that drive's governing membership.
- Hierarchy provisioning is serialized per environment to prevent concurrent pipelines from creating duplicate organization or contact folders. Permission reconciliation remains pipeline-scoped. Both use idempotent Google Workspace outbox operations; versioned hierarchy migrations use a versioned target that an outgoing worker cannot claim during a rolling deployment.
- Credential testing and every provisioning attempt preflight both the Google Sheets API service and the API key restriction. A missing or blocked Sheets API fails before ClawPilot creates new Drive resources.

## Lifecycle

`pipeline_spaces.provisioning_status` is one of `not_requested`, `queued`, `provisioning`, `ready`, or `failed`. Sanitized failures and request, attempt, start, and completion timestamps remain durable so retries can continue from partial external state without duplicating resources.

Migration `0022_pipeline_sheet_access_links.sql` backfills an active short link for every ready Sheet-backed pipeline and fails closed if any ready pipeline remains inaccessible. Migration `0023_crm_modules_references_and_integrations.sql` allocates canonical CRM references. Migration `0024_versioned_drive_hierarchy_reconciliation.sql` requeues existing managed resources into the organization/contact hierarchy without allowing the outgoing worker to acknowledge the legacy layout. Migration `0025_profile_crm_projection_backfill.sql` adds each historical pipeline owner to that pipeline's CRM organization and contact projections. Migrations `0026_legacy_drive_hierarchy_cleanup.sql` through `0029_verified_drive_trash_reconciliation.sql` remove only empty managed `Users/<email>/Pipelines` chains after the move. The reconciler verifies every parent-child response and moves legacy Shared Drive folders to the immediately verifiable trash state without touching canonical resources. Runtime provisioning performs the same repair for a ready pipeline whose link was removed or never attached.

The configured owner's historical default pipeline remains on the environment Sheet and global Maton/environment credential during migration. Managed pipelines resolve their validated pipeline, Sheet, service-account, and Shared Drive binding and never fall back to that credential or accept caller-provided Google resource IDs.

## Durable Data

- `pipeline_spaces`
- `pipeline_space_members`
- `google_workspace_integration`
- `pipeline_google_permissions`
- `pipeline_sheet_rows`
- `pipeline_source_state`
- `pipeline_dropdown_catalogs`
- `sync_outbox`
- `audit_events`
- `crm_organizations`, `crm_contacts`, `crm_products`, `crm_leads`, `crm_opportunities`, `crm_opportunity_products`, `crm_meetings`, `crm_interactions`, `crm_campaigns`
- `crm_integration_actions`, `crm_integration_action_attempts`, `crm_inbound_messages`
- `crm_sync_runs`

## Operational Check

Use `/api/pipeline/sync-status` and the Railway health endpoint to verify the active projection and worker heartbeat after deployment. The sync-status response includes pending and failed CRM record counts so the application cannot report an app-created opportunity as synchronized before the SuiteCRM outbox succeeds.

See [CRM and workbook reporting](crm-and-reporting.md) for CRM authority, entity mapping, migration, and workbook projection rules.
