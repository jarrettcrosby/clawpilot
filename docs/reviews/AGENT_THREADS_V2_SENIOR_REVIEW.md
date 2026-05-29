# Agent Threads v2 — Senior Acceptance Gate Review

Date: 2026-03-05
Reviewer: senior subagent
Scope: acceptance criteria + lifecycle expectations + 50-write integrity + UI non-regression + context usefulness + go/no-go decision template

## 1) Acceptance Criteria (package-level)

### A. Lifecycle behavior (required)
1. Thread lifecycle states are implemented and persisted (at minimum aligned to package checklist intent): `queued -> running -> replied | failed`.
2. Illegal transitions are rejected and logged.
3. Crash-safe recovery is defined (in-flight state resolves to deterministic terminal/retryable state).
4. API response envelope returns lifecycle metadata per turn (state + timestamps + error when failed).

### B. Write integrity (required)
1. Concurrent write burst of **50 writes** to same thread has zero loss/duplication/corruption.
2. Atomic write semantics (`tmp + rename`) and lock semantics are enforced.
3. Integrity check is automated in project test script(s), not only ad-hoc.

### C. UI non-regression (required)
1. Agents UI remains functional (agent list, open thread, send message, task->thread navigation).
2. Build + restart + smoke checks pass (`safe-restart.sh`, `regression-smoke.sh` flow or CI equivalent).
3. Thread status rendering does not regress existing views.

### D. Context usefulness (required)
1. `buildContext(taskId, agentId)` (or equivalent) exists and is used in responder input assembly.
2. Context includes compact, high-signal metadata (task title/id, recent thread tail, basic counters/summary hints).
3. Context source-of-truth is persisted thread history, not transient UI state.

---

## 2) Verification against current codebase

### Observed evidence
- Thread persistence API/store exists:
  - `app_src/app/api/agents/threads/route.ts`
  - `app_src/lib/agents/threadStore.mjs`
- Atomic + lock + in-process queue are implemented in store.
- Docs define richer v2 model/lifecycle/context:
  - `docs/architecture/AGENT_THREADS_V2.md`
- File format doc exists for current v1-ish runtime model:
  - `docs/architecture/AGENT_THREADS_FILE_FORMAT.md`
- Existing automated test script passes:
  - `npm run -s test:threads` => PASS
- Ad-hoc 50-write integrity check executed in review:
  - result: `count=50`, `missing=[]` (PASS)

### Gaps found
1. **Lifecycle behavior gap (major)**
   - Runtime API/store do not implement `queued/running/replied/failed` flow.
   - POST writes user + agent messages immediately; no explicit state machine or crash-recovery envelope.
2. **Context usefulness gap (major)**
   - No `buildContext(taskId, agentId)` implementation found in runtime paths.
   - No context assembly step wired into responder (stub responder only echoes text).
3. **Write integrity automation gap (minor/moderate)**
   - Automated script currently stress-tests 40 writes, not 50.
4. **UI non-regression evidence gap (moderate)**
   - Guard scripts exist, but this review did not execute full restart/smoke sequence.

---

## 3) Decision Criteria (go / no-go)

### Go only if all are true
- Lifecycle state machine implemented and enforced in runtime code.
- 50-write integrity check is automated in repository tests.
- Context builder implemented + responder path consumes it.
- UI smoke/build regression checks pass in validation run.

### No-go triggers
- Missing lifecycle state transitions in runtime path.
- Missing context assembly wiring.
- Integrity requirement met only manually, not in test gate.

---

## 4) Current Verdict

**Verdict: NO-GO (for v2 package acceptance gate)**

Reason summary:
- Core v2 lifecycle and context expectations are documented but not implemented in active runtime path.
- Integrity is strong in implementation and manually validated at 50, but automated gate still at 40.
- UI regression protections exist as scripts, but no completed execution evidence attached in this review.

---

## 5) Go/No-Go Review Template (reusable)

```md
# Agent Threads v2 Gate Review
Date:
Reviewer:
Commit/Branch:

## Checklist
- [ ] Lifecycle: queued/running/replied/failed implemented
- [ ] Lifecycle transitions validated + illegal transition tests
- [ ] Crash safety behavior verified
- [ ] API envelope includes lifecycle metadata
- [ ] 50-write concurrent integrity automated test passing
- [ ] Atomic write + lock behavior confirmed
- [ ] UI non-regression smoke/build passing
- [ ] Context builder implemented and wired to responder
- [ ] Context derived from persisted history

## Evidence
- Tests run:
- Logs/artifacts:
- Key files changed:

## Decision
- Result: GO / NO-GO
- Blocking issues:
- Follow-ups (owner + due date):
```

## 6) Minimum unblock actions
1. Implement lifecycle state transitions in API/store path with explicit transition validation.
2. Add/buildContext wiring in responder flow with compact metadata.
3. Update `scripts/test-agent-thread-store.mjs` burst from 40 -> 50 and keep as required gate.
4. Attach successful `safe-restart.sh` + `regression-smoke.sh` outputs to acceptance evidence.
