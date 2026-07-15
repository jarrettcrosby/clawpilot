---
title: Projects and Tenancy
status: active
kind: module-contract
tags: [projects, boards, tasks, sharing]
app_visible: true
---

# Projects and Tenancy

## Purpose

Give every user a private project board while allowing deliberate collaboration.

## Current Contract

- Every active user receives a default board owned by that user.
- A board owner can share view or edit access with another active ClawPilot user.
- The selected board is explicit and persisted independently of another user's selection.
- Task reads and writes resolve through board access before touching durable task data.
- Comments use the signed-in user as the actor. Agent assignment and task-thread routing retain that attribution.
- Archived and deleted work is excluded from the current board but retained according to the task lifecycle policy.
- A board named `CRM Board` is a managed projection of its owner's default pipeline. ClawPilot creates exactly one durable card for every CRM Organization and Contact, initially in Backlog, while preserving normal status moves, assignments, comments, checklists, and agent conversations afterward.
- Managed CRM cards cannot be created, renamed, archived, or permanently deleted from Projects. Their identity and lifecycle follow the CRM record; access requires the intersection of the user's board and pipeline permissions.
- CRM card descriptions are versioned, transactional write-through fields. A valid edit updates the Postgres CRM projection, SuiteCRM outbox, task projection, and audit trail together; a stale edit is rejected instead of overwriting newer CRM data.

## Durable Data

- `project_boards`
- `project_board_members`
- `tasks`
- `crm_board_projections`
- `crm_board_cards`
- task comments, activity, checklist, and assignment tables

## Next Boundary

Global application roles and board membership are separate concepts. Ordinary boards use board ownership and sharing as their authorization boundary. Managed CRM boards additionally require access to the bound pipeline.
