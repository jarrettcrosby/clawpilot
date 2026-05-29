# ClawApp ↔ Google Sheets Sync Architecture

## a) Goals + non-goals

### Goals
- Bidirectional sync of pipeline dropdown catalogs between ClawApp and Google Sheets.
- Preserve formatting parity and validation parity by copying from a template row/range in the target sheet.
- Keep sync idempotent and safe for repeated runs.
- Use stable IDs (`dropdown_key`, `field_key`) rather than display text as primary identity.
- Keep implementation local-first for development with clear path to stage/prod isolation.

### Non-goals
- Full real-time collaborative conflict UI in v1.
- Immediate webhook/event-driven sync (poll + explicit sync endpoints first).
- Cross-spreadsheet federation or multi-tenant sync in v1.

---

## b) Data model (dropdowns + fields + mappings)

### Dropdown option row model (canonical internal shape)
- `dropdown_key` (string, required, stable)
- `option_value` (string, required)
- `option_label` (string, optional, defaults to `option_value`)
- `active` (boolean, default true)
- `sort_order` (number, default incremental)
- `updated_at` (ISO string)
- `source` (`app` | `sheet`)
- `version` (number)
- `hash` (string, content hash for drift detection)

### Field mapping model
- `field_key` (stable app field id)
- `input_type` (`text` | `number` | `date` | `dropdown`)
- `dropdown_key` (nullable, required when `input_type=dropdown`)

### Sheet layout assumption (updated from Jarrett input)
`Dropdowns` is **column-per-dropdown**:
- Headers: row 4, columns B:K (expandable)
- Options: start row 5 downward, variable length per column
- App must ingest newly added sheet columns/options
- App-added dropdowns must append new columns on sheet

---

## c) Sync contract (what data is authoritative where)

### Dev default contract (until business rule confirmed)
- **Hybrid with conflict rule**:
  - If one side changed since last hash/version snapshot, apply that side.
  - If both changed inside conflict window, default to `last_write_wins` by `updated_at`.
- App keeps local cache at `data/pipeline/dropdowns/catalog.json`.
- Sheet remains human-editable source for operations users.

---

## d) Sync flows (App→Sheet, Sheet→App)

### Sheet → App
1. Read `Dropdowns` tab rows.
2. Normalize/validate rows into internal catalog.
3. Group options by `dropdown_key`.
4. Persist normalized snapshot to local cache file.
5. Return grouped catalog to API caller/UI.

### App → Sheet
1. Receive normalized catalog payload from app.
2. Convert to deterministic row set (sorted by dropdown key + sort order).
3. Build metadata (`updated_at`, `source=app`, `version`, `hash`).
4. Use one `batchUpdate` request to paste values and copy formatting+validation from template.
5. Verify by readback (optional in dev) and write local cache.

---

## e) Formatting/validation parity approach

- Never hand-style cell-by-cell for dropdown catalog writes.
- Copy formatting and validation from the first template dropdown column (B) across newly written dropdown columns using `copyPaste` in Sheets `batchUpdate`.
- Use `PASTE_FORMAT` and `PASTE_DATA_VALIDATION` for destination range.
- Maintain existing column widths by not issuing width mutations in sync job.

---

## f) Conflict handling + versioning strategy

- Compute content hash per option row and version per write cycle.
- Include `updated_at` + `source` + `version` in metadata columns.
- On dual-write conflict window:
  - v1 default: last write wins using `updated_at`.
  - record conflict in sync logs with both versions/hashes.
- Future: add manual review queue for conflicting `dropdown_key` values.

---

## g) Failure modes + retry policy + idempotency

### Failure modes
- Sheet API unavailable / transient errors.
- Invalid sheet layout or missing `Dropdowns` tab.
- Bad payload from app.
- Partial data drift if external edits happen mid-write.

### Retry policy
- Retry transient provider failures once with reduced complexity.
- Log retry outcome with run id.

### Idempotency
- Deterministic row sorting and stable hash generation.
- Re-running same payload should produce identical sheet rows.
- Clear/replace write approach avoids row duplication.

---

## h) Local dev setup

- Auth path: existing Maton key strategy (`credentials/maton_api_key.txt` or workspace credential path).
- Required env:
  - `MATON_BASE_URL` (optional)
  - sheet id (currently hardcoded in pipeline routes; should become env next)
- Test spreadsheet:
  - `Dropdowns` tab with header + template row.
- Local cache files:
  - `data/pipeline/dropdowns/catalog.json`
  - `data/logs/pipeline-events.jsonl`

---

## i) Staging/prod outline

- Separate project IDs / credentials / sheet IDs per env.
- Separate service account/OAuth app registrations per env.
- Environment-specific config file or env var matrix:
  - `PIPELINE_SHEET_ID_DEV`
  - `PIPELINE_SHEET_ID_STAGING`
  - `PIPELINE_SHEET_ID_PROD`

---

## j) Future enhancements

- Event-driven sync via webhooks (Apps Script or gateway hook).
- Audit table for per-run diffs.
- UI diff preview before applying App→Sheet writes.
- Conflict resolution UI for manual merges.
- Schema migration helper for Dropdowns tab evolution.
