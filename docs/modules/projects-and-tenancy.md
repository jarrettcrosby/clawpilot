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

## Durable Data

- `project_boards`
- `project_board_members`
- `tasks`
- task comments, activity, checklist, and assignment tables

## Next Boundary

Global application roles and board membership are separate concepts. A future organization layer may group multiple boards, but board ownership and sharing remain the enforced authorization boundary today.
