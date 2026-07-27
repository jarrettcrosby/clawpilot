---
id: cp-ops-codex-task-continuity
title: Codex Task Continuity
summary: Procedure for continuing ClawPilot development across desktop, phone, task compaction, and fresh Codex tasks without depending on chat history.
status: active
kind: operations-contract
area: engineering
tags: [codex, development, continuity, mobile, handoff]
app_visible: false
---

# Codex Task Continuity

## Source Of Truth

Conversation history is supporting context, not the durable engineering record. A ClawPilot task resumes from:

1. The canonical repository at `/Users/agentsuburbiasandwich/Desktop/clawpilot`.
2. `AGENTS.md` and the `dev` branch policy.
3. The owning active module or operations contract under `docs/`.
4. Append-only migrations, focused tests, Git history, and deployed health evidence.
5. Runtime records in the environment-specific Postgres database.

Do not reconstruct current behavior from screenshots or a long prior conversation when the repository and active contracts can answer the question directly.

## Task Size

Use one Codex task for one coherent implementation slice. Keep long-running module work connected through the owning contract rather than extending one conversation indefinitely. A large task may compact or time out on a phone while the repository, database, and deployment remain intact.

Before ending a substantial slice:

1. Update the owning active contract with implemented behavior, limitations, and the next boundary.
2. Add or update focused tests that prove the behavior.
3. Run the required validation gate.
4. Commit and deploy only the reviewed scope.
5. Record deployment evidence when the slice reaches a hosted environment.

## Starting From Desktop Or Phone

If the existing task loads reliably, continue it. If it times out, start a fresh task and send:

```text
ClawPilot continuation. Use /Users/agentsuburbiasandwich/Desktop/clawpilot on dev.
Read AGENTS.md and the relevant active contract under docs/ before editing.
Inspect git status and the latest dev deployment. Preserve unrelated changes.
Continue this slice: <specific outcome>.
Update the owning contract and run the required validation before stopping.
```

Name the concrete outcome instead of asking the new task to reread the full historical conversation. Examples include:

- Add carrier-account sender identity to rate and label requests.
- Continue warehouse receiving and directed-putaway execution.
- Repair the pipeline outbox projection and prove it in development.

The Mac must be awake, unlocked when local UI control is required, connected to the network, and running Codex for phone-driven local work. Repository-only work does not require a browser or unlocked UI. A phone task cannot control a sleeping or disconnected Mac.

## Recovery Checklist

At the start of every continuation:

1. Confirm the repository path and current branch.
2. Read `git status` before changing files.
3. Read the active contract for the named module.
4. Inspect the latest relevant migration and focused tests.
5. Verify whether the prior task changed only code, changed development data, or deployed.
6. Treat uncommitted unrelated files as operator work and preserve them.
7. Use `./scripts/dev-start.sh` for local browser validation.

When prior evidence is uncertain, rerun the smallest deterministic test. Do not claim a production or provider result from conversation memory alone.

## Current Distributed Operations Handoff

The current Operations authority and remaining phases are maintained in:

- [Distributed Operations](../modules/distributed-operations.md)
- [Distributed Operations Runbook](distributed-operations-runbook.md)
- [Local Print Agent](local-print-agent.md)
- [Small Parcel Carrier Adapters](../architecture/small-parcel-carrier-adapters.md)
- [Distributed Operations Delivery Plan](../architecture/distributed-operations-delivery-plan.md)

These documents, migrations, tests, and hosted health checks supersede conversational summaries.
