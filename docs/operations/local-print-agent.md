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

The durable model supports:

- thermal carrier labels in ZPL, PDF, or PNG on 4 x 6 or 4 x 8 label media only when the enrolled agent explicitly declares that exact format/media/document combination;
- thermal product and location barcode labels in ZPL on 2 x 1, 3 x 1,
  4 x 2, 4 x 6, or 4 x 8 media when the enrolled agent and printer both
  declare the exact document type and media;
- nonthermal packing slips in PDF or PNG on US Letter or A4 media only when the enrolled agent explicitly declares that exact format/media/document combination;
- warehouse-scoped agent credentials stored only as SHA-256 verifiers;
- leased claims with a fenced claim token;
- append-only acknowledgement and failure attempts;
- bounded retries on the same job;
- an explicit compatible fallback printer;
- reason-gated, permission-checked reprints that create a new job from the same artifact.

`delivered` or **Acknowledged** means the local agent handed the artifact to its configured device. It does not prove that paper exited the printer. Browser downloads and print dialogs never create durable delivery evidence.

Authorized operators may download the exact immutable bytes from a print-job
detail or a stored diagnostic label after its print artifact exists. The
active-organization artifact route supports ZPL, PDF, and PNG; it derives a
safe MIME type and extension from the recorded format, validates the stored
length and SHA-256 before streaming, and emits a strong SHA-256 ETag. The
browser must revalidate every cached response through the signed-in,
active-organization authorization boundary; label bytes are never fresh for
offline or year-long cache reuse. The binary response is never placed in
print-job JSON, audit payloads, or logs.
Downloading is inspection or manual-delivery assistance only and does not
acknowledge a print job, prove physical output, call a carrier, or create a
reprint.

### Does the workstation need an installed application?

Not for download-only use. An authorized operator may download the stored ZPL,
PDF, or PNG and print it manually without installing the ClawPilot agent.

Automatic cloud-to-local printing does require a trusted process on a computer
or print server that can reach the printer. A browser cannot be treated as a
durable, silent bridge to a USB device, an operating-system queue, or arbitrary
raw port 9100 endpoints. The supported first-party path is the ClawPilot local
print agent:

- a network Zebra that accepts native ZPL can receive the exact stored command
  stream over raw TCP without an operating-system printer driver;
- a USB printer, or a PDF/PNG route, requires an explicitly configured
  operating-system/vendor queue and a local-agent backend that declares those
  capabilities; the bundled raw-ZPL worker does not claim them;
- a dedicated always-on workstation or print server is preferable to relying on
  an operator's browser tab.

Do not vendor an indiscriminate collection of GitHub printer drivers into the
agent. Prefer carrier-native output, driverless IPP/CUPS where the device
supports it, signed vendor software, or a maintained printing bridge with a
bounded capability adapter. Any added backend must be version-pinned, licensed,
security-reviewed, and tested against the exact format, DPI, media, copy count,
and printer model before it may advertise compatibility.

## Configure Printing

Open **Operations > Printing**.

1. In **Agents**, enroll one agent for the warehouse and declare only the formats, media, and document types its installed runtime can actually deliver.
2. Retain the one-time credential in the local agent configuration. ClawPilot stores only its verifier.
3. In **Printers**, configure the device capabilities and bind it to an enrolled agent whose declared capabilities contain the entire printer profile.
4. Keep an unbound local-agent printer offline.
5. For thermal devices, select only the physical label sizes loaded and
   calibrated on that Zebra. The bundled agent supports 2 x 1, 3 x 1, 4 x 2,
   4 x 6, and 4 x 8 ZPL barcode labels; carrier labels remain limited to
   4 x 6 or 4 x 8.
6. For nonthermal devices, select PDF or PNG and Letter or A4 media.
7. Optionally select one same-warehouse fallback that supports every configured document, format, and medium on the primary.
8. Mark the profile online only after the real device path is ready. ClawPilot rejects an assignment whose printer capabilities exceed the agent, and the worker repeats its runtime capabilities on every claim so a credential/runtime mismatch fails closed before payload delivery.

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

The repository includes a raw-ZPL Mac runtime for a networked Zebra printer.
Its fixed capability profile is **raw ZPL carrier and warehouse barcode
labels**. It accepts carrier labels on 4 x 6 or 4 x 8 media and product or
location barcode labels on 2 x 1, 3 x 1, 4 x 2, 4 x 6, or 4 x 8 media. It does
not advertise or accept PDF, PNG, Letter, A4, packing slips, return labels, or
office documents:

```bash
CLAWPILOT_PRINT_AGENT_URL=https://dev.aiapp.eigenracing.com \
CLAWPILOT_PRINT_AGENT_CREDENTIAL='cpprint.v1.<agent-uuid>.<secret>' \
CLAWPILOT_PRINTER_HOST='printer-hostname-or-static-ip' \
npm run print-agent:run
```

The runtime declares that fixed capability profile on every claim and accepts
only immutable inline UTF-8 ZPL artifacts. It verifies the
artifact SHA-256 and byte length, writes a claim ledger under
`~/.clawpilot/`, and connects to the printer's raw port `9100`. The credential
may instead be read from macOS Keychain with
`CLAWPILOT_PRINT_AGENT_KEYCHAIN_SERVICE` and
`CLAWPILOT_PRINT_AGENT_KEYCHAIN_ACCOUNT`; do not put the credential in a
LaunchAgent property list.

An agent enrolled before bundled barcode printing was added retains the exact
legacy **ZPL + 4 x 6 + shipping label** capability boundary. The current
runtime detects that boundary once at startup and falls back to shipping-only
claims, so upgrading the workstation does not interrupt existing carrier-label
delivery. In **Operations > Printing > Agents**, use **Enable bundled barcode
printing** on that exact legacy profile, then reinstall or restart the bundled
runtime. Rerun the macOS installer when the runtime was copied into a
LaunchAgent; a repository-run worker only needs a restart. ClawPilot expands
only the known legacy first-party profile; it never
overwrites a custom agent capability declaration.

Use `--probe` to test raw network reachability without claiming work. A
separate guarded command can print a static label marked
`VOID - NO POSTAGE`; it never invokes a carrier or creates a shipment:

```bash
CLAWPILOT_PRINTER_HOST='printer-hostname-or-static-ip' \
npm run print-agent:test-label
```

### Zebra media calibration

Media calibration is device maintenance, not a print job. It does not create,
claim, retry, reprint, or acknowledge a ClawPilot artifact. The inspection
command is read-only and reports the printer's media mode, sensor, configured
label length, tear-off position, label offsets, and the difference between the
calibrated stock and an expected 4 x 6 label:

```bash
CLAWPILOT_PRINTER_HOST='192.0.2.10' \
npm run print-agent:calibrate-zebra -- --expected-media label_4x6
```

For 203 dpi stock, a configured label length materially above approximately
1,218 dots means the sensor is consistently finding a gap beyond six inches.
Calibration cannot turn physically longer stock into 4 x 6 stock. Load actual
4 x 6 die-cut gap labels before calibrating or select a carrier stock size that
matches the loaded media.

The first-line corrective action for skipped labels is Zebra's standard auto
media calibration (`~JC`). Pause the exact local print-agent service first so
no print job can overlap calibration, load 4 x 6 gap media, close the cover,
and run:

```bash
CLAWPILOT_PRINTER_HOST='192.0.2.10' \
npm run print-agent:calibrate-zebra -- \
  --expected-media label_4x6 \
  --confirm-agent-paused \
  --confirm-auto-calibration
```

The command refuses to mutate a printer that is not `READY` or does not report
`GAP/NOTCH` media with the `WEB` sensor. Zebra documents that `~JC`
intentionally feeds one to four labels while measuring label length and
calibrating the media sensor. Those blank feeds are calibration activity, not
duplicate ClawPilot jobs. After calibration, press the physical Feed button
once: exactly one blank label should advance and stop at the tear position.
Then restart the exact paused local print-agent service.

The calibration command exits nonzero and reports `calibrationVerified: false`
when the post-`~JC` label pitch still differs materially from the selected
stock. That result means the printer accepted the maintenance command but did
not become safe for 4 x 6 delivery. Measure the physical gap-to-gap pitch,
reload actual 4 x 6 stock, and inspect or clean the WEB sensor before trying
again; do not treat command delivery alone as successful calibration.

The printer's tear-off setting controls only where the gap rests over the tear
bar. It cannot correct a whole-label skip. Do not change `^TA`, label-top, or
left-position values to compensate for an incorrect media length. If standard
auto calibration still does not make one Feed press advance one label, inspect
media loading and the transmissive sensor, then use the GK420d seven-flash
manual calibration procedure. Manual calibration prints a sensor profile and
disables automatic calibration until printer defaults are restored, so it is
an escalation rather than the default application command.

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

PDF and PNG are not converted to ZPL. To deliver either format, enroll a
separate agent/runtime that natively supports that exact format and media, then
bind the printer profile to it. Until such an agent exists, the format remains
visible as unsupported instead of entering a queue that the Zebra runtime
cannot complete.

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

- **Download ZPL/PDF/PNG** streams the exact stored artifact through the
  signed-in active-organization boundary. It does not convert, resize, rerender,
  queue, acknowledge, or alter the document.
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
- `GET /api/operations/artifacts/{artifactGlobalId}` for an authenticated,
  tenant-scoped exact-byte download

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
- Artifact downloads require an authenticated operator with Operations view
  access in the artifact's organization. Cross-organization and malformed
  Global IDs return no artifact bytes.
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
