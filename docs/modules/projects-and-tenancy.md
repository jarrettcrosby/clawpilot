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
- Project activity is promoted into the append-only audit stream with the owning board organization's event-time scope. The global Activity drawer reads all authorized boards rather than the board currently selected; the card drawer remains the resource-local history.
- Archived and deleted work is excluded from the current board but retained according to the task lifecycle policy.
- Ordinary project work follows one kanban lifecycle: Backlog, Todo, In Progress, Review, and Done. Creating, editing, moving, assigning, commenting, completing, archiving, and restoring all use explicit user actions.
- Reading a board never creates, retags, assigns, moves, hides, or archives work. A rejected move leaves the card unchanged and returns an actionable reason.
- New ordinary tasks require a meaningful title and auditable signed-user/source attribution. Automation is deny-by-default, and agents can propose work but cannot create tasks.
- A task has at most one product-agent assignment. The task remains the canonical source for status, owner, next action, blocker, checklist, activity, and agent-thread context.
- A global application administrator does not automatically receive every organization's board, CRM, pipeline, document, or short-link data. Those reads continue to require the relevant organization graph, pipeline membership, board membership, ownership, or explicit share.
- Every invited or active user assigned to an organization receives one private board named `CRM Board`. Users in the same organization share that organization's primary CRM pipeline, but their board comments, assignments, checklists, and agent conversations remain private unless the board is explicitly shared.
- Successful first sign-in also guarantees a separate default personal pipeline for that user and durably queues its managed Google Sheet, Drive hierarchy, and organization-scoped shortlink. The private CRM Board remains bound to the organization-primary pipeline, so shared account context does not replace the user's personal pipeline.
- A CRM Board projects the Account that represents the user's assigned workspace organization, every descendant Account in that organization graph, and Contacts attached to those Accounts. It never projects ancestors, siblings, or an unrelated tenant's records. Root administrators therefore see the root subtree while child-organization administrators see only their own subtree; ordinary members see only their assigned organization in the hierarchy surface.
- ClawPilot creates exactly one durable projection card for every visible CRM Organization and Contact, initially in Backlog. Projection is not an ordinary task-creation event: it must not create a second work task, assign a user, or assign an agent. A user may later add card-specific comments, checklists, status, or an explicit assignment.
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

Global application roles, organization roles, organization data scope, and board membership are separate concepts. A child-organization owner may also receive global application administration without being moved into the root organization or gaining unrelated tenant data. An invitation must assign the user to either the inviter's organization, an existing descendant organization, or a deliberately created descendant organization. It must not create a synthetic organization for each person. Ordinary boards use board ownership and sharing as their authorization boundary. Managed CRM boards additionally require access to the organization-primary pipeline and bind to the user's assigned organization.
