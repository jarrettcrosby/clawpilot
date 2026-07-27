---
id: cp-ops-local-print-agent
title: Local Print Agent
summary: Enrollment, claim leases, delivery acknowledgement, failure, fallback, retry, and reprint controls for warehouse printing.
status: active
kind: operations-guide
area: distributed-operations
tags: [clawpilot, printing, warehouse, labels, packing-slips]
app_visible: true
---

# Local Print Agent

## Scope

The local print agent transports an existing immutable print artifact to an approved warehouse printer. It cannot rate a shipment, purchase or void a carrier label, change a package, or create a reprint.

The durable path supports:

- thermal carrier labels in ZPL, PDF, or PNG on 4 x 6 or 4 x 8 label media;
- nonthermal packing slips in PDF or PNG on US Letter or A4 media;
- warehouse-scoped agent credentials stored only as SHA-256 verifiers;
- leased claims with a fenced claim token;
- append-only acknowledgement and failure attempts;
- bounded retries on the same job;
- an explicit compatible fallback printer;
- reason-gated, permission-checked reprints that create a new job from the same artifact.

`delivered` or **Acknowledged** means the local agent handed the artifact to its configured device. It does not prove that paper exited the printer. Browser downloads and print dialogs never create durable delivery evidence.

## Configure Printing

Open **Operations > Printing**.

1. In **Agents**, enroll one agent for the warehouse.
2. Retain the one-time credential in the local agent configuration. ClawPilot stores only its verifier.
3. In **Printers**, configure the device capabilities and bind it to the enrolled agent.
4. Keep an unbound local-agent printer offline.
5. For thermal devices, select only 4 x 6 or 4 x 8 label media.
6. For nonthermal devices, select PDF or PNG and Letter or A4 media.
7. Optionally select one same-warehouse fallback that supports every configured document, format, and medium on the primary.
8. Mark the profile online only after the real device path is ready.

Rotating an agent credential invalidates the prior credential immediately. Revoking an agent is terminal, unbinds its printer profiles, and sets those local-agent printers offline.

`nonthermal` is the canonical printer kind for office printers. `office` remains
the station type and is not a printer kind. Migration `0094` normalizes legacy
`office` printer-kind rows and removes invalid thermal capabilities from them.

## Agent API

The canonical agent endpoint is:

`POST /api/operations/print-agent/jobs`

Send the one-time credential as:

`Authorization: Bearer <credential>`

New enrollment and rotation credentials use the versioned shape:

`cpprint.v1.<agent-uuid>.<secret>`

## Mac Runtime

The repository includes a raw-ZPL Mac runtime for a networked Zebra printer:

```bash
CLAWPILOT_PRINT_AGENT_URL=https://dev.aiapp.eigenracing.com \
CLAWPILOT_PRINT_AGENT_CREDENTIAL='cpprint.v1.<agent-uuid>.<secret>' \
CLAWPILOT_PRINTER_HOST='printer-hostname-or-static-ip' \
npm run print-agent:run
```

The runtime accepts only immutable inline UTF-8 ZPL artifacts. It verifies the
artifact SHA-256 and byte length, writes a claim ledger under
`~/.clawpilot/`, and connects to the printer's raw port `9100`. The credential
may instead be read from macOS Keychain with
`CLAWPILOT_PRINT_AGENT_KEYCHAIN_SERVICE` and
`CLAWPILOT_PRINT_AGENT_KEYCHAIN_ACCOUNT`; do not put the credential in a
LaunchAgent property list.

Use `--probe` to test raw network reachability without claiming work. A
separate guarded command can print a static label marked
`VOID - NO POSTAGE`; it never invokes a carrier or creates a shipment:

```bash
CLAWPILOT_PRINTER_HOST='printer-hostname-or-static-ip' \
npm run print-agent:test-label
```

For an always-on macOS workstation, store the enrolled credential in Keychain
and install a user-scoped LaunchAgent:

```bash
security add-generic-password -U \
  -s 'com.clawpilot.print-agent.dev' \
  -a 'FHMXLAB35' \
  -w 'cpprint.v1.<agent-uuid>.<secret>'

npm run print-agent:install:macos -- \
  --name 'FHMXLAB35 Zebra' \
  --base-url 'https://dev.aiapp.eigenracing.com' \
  --printer-host 'FHMXLAB35.local' \
  --keychain-service 'com.clawpilot.print-agent.dev' \
  --keychain-account 'FHMXLAB35'
```

The installer copies the minimal runtime into the user's Application Support
directory, writes a credential-free property list under
`~/Library/LaunchAgents`, and creates separate standard-output, error, and
duplicate-fence paths. It refuses to install if the referenced Keychain item
does not exist. Use the same arguments with `--uninstall` to stop and remove
the LaunchAgent; the Keychain item and delivery ledger remain for an explicit
operator cleanup.

If the runtime restarts after bytes may have reached the printer but before an
acknowledgement is recorded, it reports `PRINT_OUTCOME_UNCERTAIN` and fences
automatic resend. An operator must inspect the device and use the controlled
retry or reprint workflow.

The route does not use a browser session. Every claim, acknowledgement, and failure requires a caller-stable `Idempotency-Key` header containing 8 to 200 letters, numbers, periods, underscores, colons, or hyphens.

### Claim

```json
{
  "action": "claim",
  "limit": 1,
  "leaseSeconds": 120
}
```

A claim returns only jobs for online printers assigned to the authenticated agent in its warehouse. Claims use `FOR UPDATE SKIP LOCKED`, expire after a 30-to-300-second lease, and return a job-specific `claimToken`. Repeating the same claim request with the same idempotency key returns the original claims rather than taking more work.

The document object contains its immutable SHA-256 digest, byte length, format, media, and storage reference. An active carrier label may also include its payload inline. The agent must verify the digest and byte length before submitting the document to the device.

Persist each `claimToken` in the agent's local work ledger before sending output to a printer, and never submit the same token twice. Claim responses are replayable so a lost HTTP response cannot lease additional work.

### Acknowledge

```json
{
  "action": "acknowledge",
  "jobGlobalId": "gpj1234567",
  "claimToken": "00000000-0000-4000-8000-000000000000",
  "deviceJobReference": "optional-device-reference"
}
```

Only the agent that owns the current unexpired claim may acknowledge it. Replaying the same request and idempotency key returns the first result. A different payload with the same key returns a conflict.

### Fail

```json
{
  "action": "fail",
  "jobGlobalId": "gpj1234567",
  "claimToken": "00000000-0000-4000-8000-000000000000",
  "errorCode": "PRINTER_OFFLINE",
  "errorMessage": "Configured device did not accept the job",
  "retryable": true,
  "printerUnavailable": true,
  "retryAfterSeconds": 0
}
```

A retryable failure remains on the same print job and artifact. When the requested printer fails, ClawPilot prefers its explicit compatible online fallback. Otherwise it may retry the same approved route while attempts remain. A retry never invokes carrier code and cannot create another label.

Expired claims become append-only failures before a later bounded attempt is queued. Stale claim tokens cannot acknowledge or fail the new attempt.

Before every claim, ClawPilot checks queued routes again. If the selected
printer is offline, unbound, or attached to a revoked agent, the job is
rerouted only to its explicit compatible online fallback. The attempt history
records `rerouted` and the new `queued` state. If no approved route remains,
the job becomes visibly failed with `PRINT_ROUTE_UNAVAILABLE`; it is never
silently left queued.

## Operator Controls

The **Jobs** view shows current target, document type, media, format, attempts, lease expiry, failure, and reprint lineage.

- **Retry** is available only for a failed job below its maximum attempt count and requires a reason.
- **Cancel** is available for queued or claimed jobs and requires a reason. Cancelling fences later acknowledgement, but a device may already have accepted a claimed document.
- **Reprint** is available only after an acknowledged durable delivery, requires both printer-management and warehouse-execution access, and requires a reason.
- A reprint creates a new job with `reprint_of_job_id`, authorization actor, and immutable reason. It reuses the existing artifact and label reference.

Ordinary label enqueue permits one original print job for each immutable
carrier label. Repeating the same request with the same idempotency key returns
the original job. A different ordinary enqueue for that label is rejected,
regardless of whether the original job is queued, delivered, cancelled, or
failed. Retry the existing job when eligible, use the controlled reprint action
after acknowledged delivery, or generate a new carrier label after voiding the
old label.

The signed-in operator APIs are:

- `GET/POST /api/operations/print-agents`
- `GET/POST /api/operations/print-jobs`
- `GET/POST /api/operations/printers`

Queue commands accept an existing active carrier label or immutable packing-slip artifact metadata. They route only to a capability-compatible online local-agent profile.

Packing-slip enqueue may include the source order and shipment Global IDs. A
shipment reference is validated against both its order and selected warehouse.
The job projection and enqueue, claim, delivery, failure, cancellation,
reroute, and reprint audit events retain the resolved order, shipment, and
tracking linkage. Delivery attempts remain append-only and expose the printer,
agent, actor, failure code, device reference, and occurrence time without
putting document contents into audit payloads.

## Security Rules

- Credentials are random 256-bit secrets and are never persisted in plaintext.
- Agents are scoped to one organization and warehouse.
- A claim is limited to printers explicitly bound to that agent.
- Claim tokens fence every acknowledgement and failure.
- Artifact payloads and storage references are never written to audit events.
- Caller-provided artifact references must use `https`, `s3`, or a ClawPilot document reference and cannot contain credentials, query strings, or fragments.
- Carrier label status is checked before claim; voided or inactive labels are not delivered.
- A carrier-label reprint is rejected when the source label is no longer active.
- Fallbacks must be explicit, same-warehouse, non-disabled, and compatible with the exact document, format, and media.
- Delivery attempts, reprints, credential rotation, and revocation retain audit evidence.

## Focused Validation

```bash
node scripts/test-operation-printing.mjs
node scripts/test-operation-print-agent-runtime.mjs
node scripts/test-macos-print-agent-installer.mjs
node scripts/test-operations-print-delivery.mjs
npm run lint
```

The PostgreSQL tests use disposable databases and verify the full migration
chain, immutable artifacts, warehouse scoping, capability constraints,
ordinary-label uniqueness, order and shipment linkage, offline rerouting,
revoked-agent failure, claim fencing, append-only attempts, acknowledgement
projection, credential rotation, and audited reprints.
