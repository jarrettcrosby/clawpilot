# EPISCS Second-Brain Structure Decisions (ClawApp)

Status: Decision record (living)
Umbrella: EPISCS
Last Updated: 2026-03-05

## Purpose
Capture how ClawApp organizes operational knowledge under the EPISCS umbrella so agents/humans can find, trust, and evolve documentation consistently.

## Decision Summary
1. **EPISCS is the top-level context umbrella** for CRM/workflow knowledge tied to Express Parcel International (EPI).
2. **Docs are split by intent**: architecture, operations, integrations, data, and delivery audits.
3. **Decision records are explicit** (this file) instead of implicit in chat logs.
4. **Operational truth is versioned** through release-linked docs and audit notes.

## Information Architecture
Recommended docs tree (incremental):
- `docs/architecture/` -> system/module design specs
- `docs/operations/` -> runbooks, incident and rollback playbooks
- `docs/integrations/` -> external system audits and adapters
- `docs/data/` -> schema plans and normalization rules
- `docs/` root -> dated delivery/release audit snapshots

## Naming & Lifecycle Decisions
- Specs: `*_SPEC.md`
- Architecture deep-dives: `*_ARCHITECTURE.md`
- Runbooks: `OPERATIONS_RUNBOOK_*.md`
- Audits: `DELIVERY_AUDIT_YYYY-MM-DD.md`
- Decision records: `*_DECISIONS.md`

Lifecycle states:
- `Draft` -> `Active` -> `Superseded`

## EPISCS Alignment Rules
- EPISCS-linked entities (organizations, contacts, opportunities, interactions) must be documented where schema or workflow changes occur.
- If product behavior changes EPISCS process, update both:
  1) module spec/architecture doc, and
  2) delivery audit for that date.

## Acceptance Criteria
1. New module docs map to one EPISCS knowledge domain (architecture/ops/integration/data).
2. Any EPISCS workflow change references at least one decision or audit doc.
3. Teams can locate module spec + rollback guidance in under 2 minutes.
4. Superseded decisions include pointer to replacement doc.

## Rollback Notes
If this structure proves too rigid:
1. Keep existing files; do not delete history.
2. Add redirect notes at top of moved docs (`Moved to: ...`).
3. Preserve EPISCS umbrella tag in replacement docs.
4. Update this decision record with a superseding structure map.

## Next Maintenance Actions
- Add doc index page linking all active module specs and runbooks.
- Add `Status` headers to older docs for consistency.
- Introduce monthly architecture/doc hygiene review.
