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
- Every invited or active user assigned to an organization receives one private board named `CRM Board`. Users in the same organization share that organization's primary CRM pipeline, but their board comments, assignments, checklists, and agent conversations remain private unless the board is explicitly shared.
- A CRM Board projects the Account that represents the user's assigned workspace organization, every descendant Account in that organization graph, and Contacts attached to those Accounts. It never projects ancestors, siblings, or an unrelated tenant's records. Root administrators therefore see the root subtree while child-organization administrators see only their own subtree; ordinary members see only their assigned organization in the hierarchy surface.
- ClawPilot creates exactly one durable card for every visible CRM Organization and Contact, initially in Backlog, while preserving normal status moves, assignments, comments, checklists, and agent conversations afterward.
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

Global application roles and board membership are separate concepts. An invitation must assign the user to either the inviter's organization, an existing descendant organization, or a newly created descendant organization. It must not create a synthetic organization for each person. Ordinary boards use board ownership and sharing as their authorization boundary. Managed CRM boards additionally require access to the organization-primary pipeline and bind to the user's assigned organization.
