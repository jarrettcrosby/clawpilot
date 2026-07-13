---
title: Application Shell and Access
status: active
kind: module-contract
tags: [shell, authentication, invitations, users]
app_visible: true
---

# Application Shell and Access

## Purpose

Provide a responsive, authenticated ClawPilot workspace with clear user identity, role controls, and private per-user credentials.

## Current Contract

- Desktop navigation is a sibling layout track and can collapse without covering page content.
- Mobile navigation uses a temporary drawer plus compact bottom navigation; Versions remains reachable through More.
- Existing active users sign in with a six-digit one-time code.
- New users receive a branded welcome link first. That invitation must be valid before an invitation-purpose sign-in code can activate the account.
- The configured owner can invite users, assign global application roles, and grant explicit privileges.
- Each user manages name, job title, timezone, and locale in Settings.
- ChatGPT/Codex authorization is stored per ClawPilot user. One user's credential cannot authorize another user's agent execution.

## Durable Data

- `app_users`
- `app_user_invitations`
- `auth_magic_codes`
- separate encrypted agent credential database

## Security Boundary

An invited account is not a normal active account. Ordinary sign-in rejects invited, disabled, expired, or revoked access. Invitation activation consumes the code and invitation in one database transaction.
