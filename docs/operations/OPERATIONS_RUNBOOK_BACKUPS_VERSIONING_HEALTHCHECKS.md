# ClawApp Operations Runbook — Backups, Versioning, Health Checks

Status: Active runbook draft
Owner: Engineering / Ops
Last Updated: 2026-03-05

## 1) Purpose
Define repeatable operational procedures to keep ClawApp recoverable, auditable, and healthy across local/shared-drive deployment workflows.

## 2) Scope
Covers:
- Data/config backup routines
- Versioning + release checkpoints
- Health checks (service + UI smoke)
- Incident rollback flow

## 3) Backup Runbook
### 3.1 What to back up
- `data/` (tasks, pipeline normalized data, agents, auth state)
- `integrations/` mappings and sync metadata
- critical docs under `docs/` (architecture, schema, runbooks)
- release artifacts/config scripts (`scripts/safe-restart.sh`, smoke scripts)

### 3.2 Frequency
- Pre-release: mandatory snapshot
- Daily: end-of-day incremental
- Weekly: full snapshot retained for 4 weeks

### 3.3 Procedure (manual/scripted)
1. Freeze writes where possible (brief maintenance window).
2. Export timestamped archive: `clawapp-backup-YYYYMMDD-HHMM.tar.gz`.
3. Validate archive integrity (list + checksum).
4. Store in at least 2 locations (local + shared/remote).
5. Record backup metadata (time, size, checksum, operator).

### 3.4 Restore drill (monthly)
- Restore into non-prod path
- Run app boot + smoke test
- Verify core datasets load and API responds

## 4) Versioning & Release Discipline
### 4.1 Version pattern
Use semantic build labels (e.g., `v0.4.0-local.3`) with checkpoint commit groups:
- `feat/*`
- `fix/*`
- `docs/*`
- `ops/*`

### 4.2 Pre-release checklist
1. Working tree reviewed and grouped by feature.
2. Regression smoke script passes.
3. Backup snapshot completed and logged.
4. Release note added under `docs/` (delta, risks, rollback trigger).

### 4.3 Post-release checklist
1. Restart sequence completes cleanly.
2. Health checks pass (API + UI).
3. Error logs reviewed for first 15 minutes.
4. Deployment status recorded in release audit note.

## 5) Health Checks
### 5.1 Service-level checks
- App process is running
- API endpoints return expected statuses:
  - `/api/health` (if available)
  - `/api/agents`
  - `/api/pipeline/dropdowns`
- No crash loops/restart storms

### 5.2 Functional smoke checks
- Login/auth guard behavior (expected fail-open posture if configured)
- Pipeline list loads and dropdowns populate
- Agents section loads without spinner lock
- Calendar shell (once enabled) renders baseline view

### 5.3 Performance sanity
- Initial app load within acceptable bounds on test device
- No critical memory/error spikes from baseline

## 6) Incident Levels
- **SEV-1**: App unavailable / data corruption risk
- **SEV-2**: Core workflow degraded (pipeline/agents/calendar write path)
- **SEV-3**: Minor functional/UI issues

## 7) Rollback Procedure
Trigger rollback when:
- smoke test fails post-release,
- core route unavailable,
- data integrity mismatch detected,
- user-facing blocker persists >15 minutes without mitigation.

Steps:
1. Announce rollback event and freeze new writes.
2. Revert to previous known-good code checkpoint.
3. Restore latest pre-release data snapshot if integrity is impacted.
4. Restart app with safe restart script.
5. Re-run smoke + health checks.
6. Publish rollback summary with root-cause hypothesis.

## 8) Acceptance Criteria
1. Every release has a linked pre-release backup ID and checksum.
2. Recovery drill can restore backup in non-prod and pass smoke checks.
3. Versioned checkpoints are grouped and traceable to docs/audit notes.
4. Health checks are executable in <10 minutes with clear pass/fail output.
5. Rollback can be completed and validated within 30 minutes.

## 9) Rollback Notes (for this runbook itself)
If this runbook conflicts with actual deployment constraints:
- Mark the incompatible step with `TEMP_EXCEPTION` in release notes.
- Keep minimum guarantees: pre-release backup + rollback checkpoint + smoke test.
- Update this runbook within one business day to match validated practice.
