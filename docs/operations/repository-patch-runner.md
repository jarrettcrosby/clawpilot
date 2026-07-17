---
id: cp-ops-repository-patch-runner
title: Repository Patch Runner
summary: Patch-only GitHub Actions execution boundary, credentials, lifecycle, and operator review contract.
status: active
kind: operations-runbook
area: operations
tags: [agents, codex, github, repository, security]
app_visible: false
---

# Repository Patch Runner

## Boundary

The repository runner is an optional patch-generation lane for assigned ClawPilot tasks. It checks out one recorded commit from `dev`, lets Codex edit that isolated workspace, enforces a path and size policy, applies the patch to a second clean checkout, and runs `npm run check`.

The first release is intentionally patch-only. It cannot push, create a branch or pull request, merge, deploy, read ClawPilot customer data, or use a human browser session. A successful run stores an artifact URL, digest, changed paths, validation evidence, and concise summary. The task moves to review but does not complete.

## Credentials

The Railway application uses a dedicated GitHub App installation token scoped to the ClawPilot repository with `Actions: write`, `Contents: read`, and `Metadata: read`. The private key is server-only and is never sent to the workflow.

GitHub Actions uses a separate `OPENAI_API_KEY` repository secret for `openai/codex-action`. It must not reuse or receive any user's ChatGPT/Codex device authorization. The application and workflow share only a random HMAC report secret used to authenticate status callbacks.

## Application Environment

```bash
CLAWPILOT_REPOSITORY_RUNNER_ENABLED=1
CLAWPILOT_GITHUB_APP_ID=<positive-integer>
CLAWPILOT_GITHUB_APP_BOT_USER=<exact-app-slug-or-bot-username>
CLAWPILOT_GITHUB_APP_PRIVATE_KEY_BASE64=<base64-pem>
CLAWPILOT_GITHUB_INSTALLATION_ID=<positive-integer>
CLAWPILOT_GITHUB_REPOSITORY_ID=<positive-integer>
CLAWPILOT_GITHUB_REPOSITORY=jarrettcrosby/clawpilot
CLAWPILOT_GITHUB_BASE_BRANCH=dev
CLAWPILOT_GITHUB_WORKFLOW_FILE=clawpilot-repository-runner.yml
CLAWPILOT_REPOSITORY_RUNNER_REPORT_SECRET=<at-least-32-random-characters>
```

GitHub Actions requires repository secrets named `OPENAI_API_KEY` and `CLAWPILOT_REPOSITORY_RUNNER_REPORT_SECRET`. The latter must exactly match the application environment.

`CLAWPILOT_GITHUB_APP_BOT_USER` is passed to the Codex Action's explicit bot allowlist. Configure only the dedicated repository-runner app; never use a wildcard bot allowance.

## Lifecycle

1. An editor selects an assigned task and explicitly chooses **Generate patch**.
2. ClawPilot commits a repository run and outbox row in Postgres.
3. The Railway worker mints a short-lived GitHub App token, resolves the exact `dev` SHA, and dispatches the fixed workflow on the default branch.
4. The workflow signs `running` and final status callbacks with the report secret.
5. `patch_ready` records review evidence. `policy_rejected` and `failed` retain actionable errors and remain retryable through a new explicit request.

No ordinary agent assignment or card comment silently starts repository execution.
