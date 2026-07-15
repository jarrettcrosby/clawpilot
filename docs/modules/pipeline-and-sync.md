---
title: Pipeline and Synchronization
status: active
kind: module-contract
tags: [pipeline, google-drive, google-sheets, outbox, provisioning, projections, crm]
app_visible: true
---

# Pipeline and Synchronization

## Purpose

Provide a user-owned pipeline workspace while preserving the Opportunities Sheet as the writable operator table and SuiteCRM as the CRM authority.

## Current Contract

- Every active user receives a default pipeline space.
- A pipeline owner can share view or edit access with another active user.
- Railway Postgres stores ClawPilot-owned pipeline definitions, normalized rows, projections, sync outbox entries, and audit events.
- Only `Opportunities!B5:M` remains an operator-facing writable workbook table. CRM and reporting tabs are generated projections.
- Pull synchronization updates durable normalized rows and a read projection.
- Push synchronization uses an outbox and worker heartbeat; the UI reports sync state instead of assuming a write succeeded.
- New pipeline spaces are app-owned until their owner explicitly confirms the `provision-pipeline` workspace action.
- Managed pipelines use one platform Google Workspace integration per environment database. The owner-only settings API stores a standard Google API key and service-account credential separately with AES-256-GCM encryption under `AGENT_CREDENTIAL_ENCRYPTION_KEY`.
- API-key and service-account rotations validate candidates before one atomic persistence update. A failed candidate leaves the current encrypted credential and Shared Drive selection unchanged.
- The integration is ready only when the API key, validated service account, and a selected writable Shared Drive are present. Shared Drive selection verifies that the root can add children and share content.
- Private Drive and Sheets requests use service-account OAuth. The stored API key is also attached for Google project and quota attribution.
- At queue time ClawPilot binds the service-account email and selected Shared Drive ID to the pipeline. Key rotation for that same service account is supported; changing the service-account identity fails closed while managed pipelines remain bound.
- Raw credentials, Sheet IDs, folder IDs, Shared Drive IDs, and internal short-link IDs are not returned in workspace payloads. The owner settings endpoint may return Shared Drive IDs only in the authorized selection list.

## Managed Google Resources

- Service accounts cannot own files for this workflow, so provisioning requires the bound Shared Drive and never falls back to My Drive or Maton.
- The provisioning worker creates or recovers resources by Drive `appProperties` under `ClawPilot Data/<Production|Development>/Organizations/<ga code + organization name>/Contacts/<gc code + user name>/Pipelines/<gc code + pipeline name>/` in that Shared Drive.
- `ga` belongs to the workspace organization and `gc` belongs to the app user. They are canonical across owned pipelines; pipeline CRM rows and Drive folders reuse them.
- Existing bound folders and Sheets are moved and renamed by Google resource ID. ClawPilot verifies the exact new parent and name before it removes an empty managed legacy folder.
- Provisioning is resumable. `drive_folder_id` and `provisioning_sheet_id` are stored as soon as each external resource verifies, while public `sheet_id` and `sync_enabled` are set only after all checks pass.
- A managed Sheet requires `Start Here`, `Organizations`, `Contacts`, `Opportunities`, `Interactions`, `Calculations`, `Dashboard`, and `Dropdowns`; headers begin on row 4.
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

Migration `0022_pipeline_sheet_access_links.sql` backfills an active short link for every ready Sheet-backed pipeline and fails closed if any ready pipeline remains inaccessible. Migration `0023_crm_modules_references_and_integrations.sql` allocates canonical CRM references. Migration `0024_versioned_drive_hierarchy_reconciliation.sql` requeues existing managed resources into the organization/contact hierarchy without allowing the outgoing worker to acknowledge the legacy layout. Migration `0025_profile_crm_projection_backfill.sql` adds each historical pipeline owner to that pipeline's CRM organization and contact projections. Migrations `0026_legacy_drive_hierarchy_cleanup.sql`, `0027_verified_legacy_drive_cleanup.sql`, and `0028_eventual_drive_cleanup_reconciliation.sql` remove only empty managed `Users/<email>/Pipelines` chains after the move, every parent-child response, and each eventually consistent Drive deletion verify. Runtime provisioning performs the same repair for a ready pipeline whose link was removed or never attached.

The configured owner's historical default pipeline remains on the environment Sheet and global Maton/environment credential during migration. Managed pipelines resolve their validated pipeline, Sheet, service-account, and Shared Drive binding and never fall back to that credential or accept caller-provided Google resource IDs.

## Durable Data

- `pipeline_spaces`
- `pipeline_space_members`
- `google_workspace_integration`
- `pipeline_google_permissions`
- `pipeline_sheet_rows`
- `pipeline_source_state`
- `sync_outbox`
- `audit_events`
- `crm_organizations`, `crm_contacts`, `crm_leads`, `crm_opportunities`, `crm_meetings`, `crm_interactions`, `crm_campaigns`
- `crm_integration_actions`, `crm_integration_action_attempts`, `crm_inbound_messages`
- `crm_sync_runs`

## Operational Check

Use `/api/pipeline/sync-status` and the Railway health endpoint to verify the active projection and worker heartbeat after deployment.

See [CRM and workbook reporting](crm-and-reporting.md) for CRM authority, entity mapping, migration, and workbook projection rules.
