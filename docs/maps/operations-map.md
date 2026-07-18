---
id: cp-map-operations
title: Operations Map
summary: Runtime topology, release gates, provider procedures, credentials, monitoring, backup, and recovery entry points.
status: active
kind: map-of-content
area: operations
tags: [clawpilot, moc, operations, deployment, recovery, runbooks]
app_visible: true
---

# Operations Map

## Runtime And Promotion

- [ClawPilot Environments and Deployment](../operations/clawpilot-environments.md) is the source for local, development, and production topology and promotion gates.
- [Release Documentation Contract](../releases/README.md) defines release copy and durable Versions records.
- Development runs from `dev`; production promotion is a reviewed `dev` to `main` pull request.

## Provider Runbooks

- [Google Workspace Integration](../operations/google-workspace-integration.md): service account, Shared Drive, managed folders, and credential rotation.
- [SuiteCRM Railway Runbook](../operations/suitecrm.md): service topology, Global ID fields, scheduler, upgrades, and rollback.
- [Sales Pipeline EPISCS Migration](../operations/sales-pipeline-episcs-migration.md): guarded ownership transfer for the established Sales CRM graph and workbook.
- [Railway Postgres Backups](../operations/railway-postgres-backups.md): provider backups, snapshots, logical exports, and restore drills.
- [ChatGPT Agent Authorization](../operations/chatgpt-agent-auth.md): per-user Codex device authorization and agent mapping.
- [Agent Security and Integration Isolation](../operations/agent-security-and-isolation.md): prompt trust zones, deterministic connector ingestion, action approvals, and worker scheduling.

## Operational Knowledge

- [Knowledge Vault Organization](../operations/knowledge-vault-organization.md): authoring, indexing, vectors, maps, and verification.
- [Application Shell and Access](../modules/application-shell-and-access.md): roles, permissions, login history, and security boundaries.
- [2026-03-20 Stable Build Integrity Outage](../incidents/2026-03-20-stable-build-integrity-outage.md): retained release-safety evidence.

## Standard Verification Path

1. Run focused tests for the changed boundary.
2. Run lint, build, test, and predeploy verification.
3. Verify Railway health and persistence in development.
4. Perform a real browser workflow in development.
5. Promote through a pull request.
6. Repeat hosted checks and the critical browser workflow in production.
7. Record the release in both environments.
