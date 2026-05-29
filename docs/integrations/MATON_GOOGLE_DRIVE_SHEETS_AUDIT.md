# Maton API Audit — Google Sheets + Google Drive

Date: 2026-03-04 01:33 EST

## What was tested
Using workspace Maton client against:
- Control API: `https://ctrl.maton.ai`
- Gateway API: `https://gateway.maton.ai`

## Connection status
Active connections include:
- `google-sheets` ✅
- `google-drive` ✅
- `google-mail` ✅
- `google-calendar` ✅
- others (analytics, quickbooks)

## Google Sheets access checks
All three provided sheets are reachable through Maton Sheets gateway.

### 1) Pipeline source
Sheet ID: `1sp-eLYEEGera1acBoze_GvR4263dunlmaOUyBej-iqY`
Title: `gacdb6c69 -- Express Parcel International, LTD dba EPISCS customer-relationship-management`
Tabs detected:
- Start Here (`1259528031`)
- Organizations
- Contacts
- Opportunities
- Interactions
- Calculations
- Dashboard
- Dropdowns

### 2) App schema source
Sheet ID: `1S82yOa9TfdPOb8g5Tm1pBKJawIhxCuOYi_PIO1ghVxE`
Title: `ClawPilot — App Data Schema & CRM`
Tabs detected:
- Tasks (`0`)
- Activity Log
- Docs
- Users
- Pipeline (CRM)
- Versions
- Schema Reference

### 3) Credentials/users source
Sheet ID: `1znHwQiYTQM1ebZrObxD-RG9uJ3p1vDl0G25lAHXdeQI`
Title: `2026-03-02 ClawPilot — User Credentials`
Tabs detected:
- Users
- README

## Google Drive checks
Drive gateway path that works: `/google-drive/drive/v3/...`

Results:
- Can access file metadata for: `1S82yOa9TfdPOb8g5Tm1pBKJawIhxCuOYi_PIO1ghVxE`
- `404 notFound` for:
  - `1sp-eLYEEGera1acBoze_GvR4263dunlmaOUyBej-iqY`
  - `1znHwQiYTQM1ebZrObxD-RG9uJ3p1vDl0G25lAHXdeQI`

Interpretation:
- Maton Sheets scope/access appears broader than current Drive file metadata scope for this connected account.
- Pipeline ingest can proceed via Sheets API now.
- Drive file ops may need permission/share update or connection re-auth for those IDs.

## Practical decision
Proceed with Sheets-first ingestion for pipeline + schema mapping immediately.
Use Drive integration for archival once permission parity is fixed.

## Next implementation steps
1. Add `integrations/sheets/mappings.json` from active tabs (Organizations/Contacts/Opportunities + Pipeline (CRM)).
2. Build `scripts/sync-pipeline.ts` to pull and normalize into `data/pipeline/normalized/current.json`.
3. Build Pipeline UI against normalized dataset.
4. Add sync status panel in app (last sync time, row counts, error counts).
5. Revisit Drive permissions for missing file IDs.
