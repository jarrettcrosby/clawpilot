---
id: cp-ops-google-workspace
title: Google Workspace Integration
summary: Google service-account ownership, Shared Drive setup, managed folder conventions, application configuration, and rotation.
status: active
kind: operations-runbook
area: operations
tags: [google-workspace, drive, sheets, service-account, credentials]
app_visible: false
---

# Google Workspace Integration

## Ownership Model

ClawPilot uses one owner-managed Google Cloud integration per environment. It does not store a human Google password.

- The standard API key identifies the Google Cloud project for eligible API requests and quota attribution.
- The service-account JSON authenticates server-side Drive and Sheets operations with short-lived OAuth access tokens.
- A Shared Drive owns managed pipeline files. The service account cannot use personal My Drive storage as the owner of these files.
- ClawPilot users receive reader or writer access at their signed-in email address. They use their own Google account when opening a Sheet.

Google references:

- [Create Google Workspace credentials](https://developers.google.com/workspace/guides/create-credentials)
- [Manage Google API keys](https://cloud.google.com/docs/authentication/api-keys)
- [Shared Drive support](https://developers.google.com/workspace/drive/api/guides/enable-shareddrives)
- [Service-account storage boundary](https://developers.google.com/workspace/drive/api/guides/handle-errors#storageQuotaExceeded)

## Google Cloud Preparation

1. In the ClawPilot Google Cloud project, enable the Google Drive API and Google Sheets API.
2. Restrict the ClawPilot API key to those APIs and retain the key value for the owner Settings screen.
3. Open service account `clawpilot-drive@logical-bird-344400.iam.gserviceaccount.com`.
4. Under **Keys**, create a new JSON key if no current JSON key is available. Google does not allow an existing private key to be downloaded again.
5. Store the downloaded JSON only long enough to upload it to both ClawPilot environments. Never commit it or place it in the Obsidian vault.

## Shared Drive Preparation

1. Create or choose a Google Shared Drive dedicated to ClawPilot data.
2. Add `clawpilot-drive@logical-bird-344400.iam.gserviceaccount.com` with a role that can create and share content. **Manager** is the predictable choice.
3. Keep Shared Drive membership limited to the service account and required platform administrators. Shared Drive members can inherit visibility across managed content.
4. Confirm the Shared Drive permits direct sharing to the external user emails that will receive pipeline access.
5. Keep broad organization, domain, group, and anyone permissions off the managed folders.

## ClawPilot Configuration

Repeat these steps in `https://dev.aiapp.eigenracing.com` and `https://aiapp.eigenracing.com`; their Postgres credentials are intentionally separate.

1. Sign in as the ClawPilot owner and open **Settings > Integrations > Google Workspace**.
2. Save or rotate the standard Google API key.
3. Upload the service-account JSON and connect it.
4. Refresh Shared Drives, select the dedicated drive, and test the connection.
5. Confirm the status is **Ready** before creating a managed pipeline Sheet.

The API never returns either secret. The UI shows only masked key metadata, the service-account email and project, connection status, and the selected Shared Drive name.

## Managed Folder Contract

The expected path is:

`ClawPilot Data/<Production|Development>/Organizations/<ga code + organization name>/Contacts/<gc code + user name>/Pipelines/<gc code + pipeline name>/`

The workbook has the same `gc code + pipeline name`. Profile or organization-name changes enqueue reconciliation. Existing managed folders are identified by Google resource ID and ClawPilot `appProperties`, moved in place, and verified before empty legacy folders are removed. Do not manually duplicate a managed folder to correct its name; use profile save, pipeline retry, or the provisioning worker.

After a hierarchy migration, verify the Pipeline **Open Sheet** link, the exact Google parent path, and the direct user permission before considering reconciliation complete.

## Rotation

Rotate the API key and service-account private key independently through Settings. A service-account key rotation is safe when the service-account email remains unchanged. ClawPilot refuses to replace or disconnect a service account while managed pipelines remain bound to a different or missing account.

After rotation:

1. Test the Google Workspace connection.
2. Pull one managed pipeline from Sheets.
3. Queue and verify one app-to-Sheet update.
4. Confirm pipeline sharing still matches ClawPilot membership.
