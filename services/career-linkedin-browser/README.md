# Career LinkedIn browser worker

This service is the isolated browser boundary for Career Desk's owner-controlled
LinkedIn connection. It does two things only:

1. presents an interactive LinkedIn browser so the owner can complete login,
   MFA, or an account checkpoint; and
2. performs bounded, read-only LinkedIn **Jobs** scans after an authenticated
   session is available.

It cannot post, comment, message, save a job, apply, follow, or solve a CAPTCHA.
There is no endpoint or browser code for those actions. A LinkedIn restriction
is a terminal, user-visible stop.

## Runtime design

- Playwright Core controls system Chromium in a non-persistent browser context.
- Xvfb supplies a private display. `x11vnc` listens on loopback only and has no
  public port. The Node process is the only WebSocket-to-VNC bridge.
- noVNC supplies the self-hosted phone/desktop live browser. The page includes a
  mobile keyboard control, reconnect control, and an unconditional Career Desk
  return link.
- One process owns one browser and at most one live viewer. Starting any command
  closes the previous viewer; every auth terminal/failure path closes it again.
  A completed auth cookie remains valid only for polling its final outcome and
  can no longer authorize the VNC WebSocket.
- The worker polls ClawPilot. ClawPilot never has to make a public command call
  into the worker.
- Only `/healthz`, `/live`, redemption/outcome routes, static live assets, and
  the authenticated noVNC WebSocket are exposed. `/internal/status` requires
  both the worker bearer token and the HMAC contract.

Playwright documents storage-state reuse for authenticated browser contexts,
and noVNC documents its RFB client over a WebSocket proxy. The worker exports
Playwright state with `indexedDB: true`; it never writes a user-data directory.

## Authentication handoff

ClawPilot creates the random authentication-token preimage and stores only its
SHA-256 digest. It returns this URL to Career Desk:

```text
https://<worker-host>/live#token=<one-time-preimage>
```

URL fragments do not reach the HTTP server. Page JavaScript immediately removes
the fragment with `history.replaceState`, retains the preimage only in page
memory, and posts it to `/v1/live/redeem`. A not-yet-claimed handoff is retried
within the bounded 15-minute attempt window; an explicitly rejected duplicate
is not retried. The visible Reconnect control remains disabled throughout this
wait so a reload cannot discard the only preimage. An accepted redemption
receives a short-lived `Secure`, `HttpOnly`,
`SameSite=Strict`, `__Host-` cookie. Before the cookie is issued, the worker
reports a `live_token_redeemed` evidence event; ClawPilot atomically accepts it
only when the attempt has not already been redeemed. The cookie is independently
HMAC-signed with `CAREER_LINKEDIN_BROWSER_COOKIE_SECRET`, contains no owner
identity, and survives a worker restart/reclaim while the attempt remains live.
If the first successful HTTP response is lost, the worker can replay that exact
same issued cookie for 30 seconds in the same active attempt. This recovery state
is memory-only and is erased on terminal outcome, expiry, or a new command.

Every connect and reauthenticate command activates this handoff before it
inspects or navigates the restored LinkedIn page. Even when the restored session
is already authenticated, the command cannot report success until ClawPilot has
atomically accepted the one-time redemption. Login, MFA, and checkpoint states
remain visible in the same live surface until the 15-minute auth attempt expires.
As soon as an authenticated page and accepted redemption are both known, the
worker synchronously revokes VNC/input before awaiting any report retry or
exporting session state. The signed cookie remains outcome-polling only.

The live page is `no-store`, sends no referrer, cannot be framed, denies
camera/microphone/geolocation, and restricts script, style, and WebSocket
connections to its own origin. Request URLs, bodies, cookies, screenshots, and
LinkedIn page text are never logged.

## ClawPilot polling contract

The worker uses exactly these routes:

```text
POST /api/internal/career-site/linkedin/worker/claim
POST /api/internal/career-site/linkedin/worker/report
```

The claim body is exactly:

```json
{
  "workerId": "career-linkedin-browser-production",
  "capabilities": ["interactive_auth", "jobs_read"]
}
```

ClawPilot responds with `{ "ok": true, "claim": null }` or a flat claim with
only these fields:

```text
leaseId, leaseToken, expiresAt, authExpiresAt, command, ownerId, attemptId, scanId,
authTokenDigest, authTokenRedeemedAt, authTokenAdoptionRequired, encryptedSessionEnvelope,
transientSessionDataKey, scan, returnUrl
```

`command` is `connect`, `reauthenticate`, `scan`, or `disconnect`. A scan is:

```json
{
  "scope": "jobs",
  "maximum": 10,
  "filters": {
    "keywords": ["operations"],
    "locations": ["New York", "New Jersey"],
    "minimumSalary": 180000
  }
}
```

The worker deterministically evaluates every one of at most ten bounded
keyword/location pairs. It applies a fair per-pair quota, then round-robins and
globally deduplicates the results, never returning more than 50 jobs. Discovery
prefers LinkedIn's search-result/card containers and uses a cautious non-
recommendation fallback only when no scoped result exists. A verified LinkedIn
empty state is a valid zero-result scan; an ambiguous empty DOM fails safely as
`extraction_incomplete`. `minimumSalary` is retained as a control-plane
refinement; the worker does not pretend LinkedIn applied a salary filter when
the listing lacks salary evidence.

Reports contain only:

```text
leaseId, leaseToken, status, authState, encryptedSessionEnvelope, jobs,
evidence, errorCode, errorMessage
```

Report transport is recoverable without changing this JSON. The worker retries
the exact serialized report body with a fresh HMAC nonce after network loss,
408/425/429, 5xx, or a malformed/truncated 2xx response. Retries use a bounded
exponential schedule; 400/401/403/409 remain authoritative. If every retry of a
possibly committed report is exhausted, the worker records a local
`confirming` outcome and returns the browser to Career Desk so the durable
attempt can be polled. It never converts that ambiguity into a `failed` report.

`authState` is `{kind: login|mfa|checkpoint|none, message: string|null}`.
Evidence is either a `live_token_redeemed` or `page_state` record with the exact
fields accepted by ClawPilot. Jobs use:

```text
externalId, url, title, company, location, description, salaryText, postedAt
```

Incomplete jobs (missing title/company or a description under 40 characters)
are omitted. IDs are 5-30 digits; descriptions are capped at 20,000 characters.
The scanner recognizes both `/jobs/view/<id>` and `currentJobId=<id>` URL forms.

A scan never opens the interactive authentication wait itself. If its supplied
session is missing or expired, it reports `awaiting_auth` and ends its lease so
ClawPilot can create a separate reauthentication attempt.

Long scans renew their lease with bounded `running` progress reports between
query pairs and after job work when 30 seconds have elapsed. They stop before a
lease-safety deadline or the configured overall scan deadline instead of
continuing under stale fencing.

`expiresAt` is the renewable five-minute lease/fencing expiry. Connect and
reauthenticate claims additionally require `authExpiresAt`; only that longer
attempt expiry controls the live token, cookie, and interactive authentication
deadline. Thirty-second `awaiting_auth` reports renew the underlying lease.

`authTokenAdoptionRequired` is present on every claim and is normally `false`.
For a recovered already-redeemed auth attempt whose prior redeeming fence no
longer matches, it is `true`. The worker then requires either the still-held raw
preimage or a valid existing signed cookie, reports `live_token_redeemed` under
the current lease, and issues or accepts the cookie only after ClawPilot
atomically adopts that fence. Transport and 5xx failures remain retryable;
ClawPilot's authoritative 409 is terminal for that stale handoff.

Connect and reauthenticate claims use this exact return form, with no extra or
duplicate query parameters:

```text
https://jarrett.suburbiasandwichco.com/career/linkedin/return?attemptId=<claim-attempt-id>&destination=<overview|agents|settings>
```

## Internal request authentication

Bearer and HMAC secrets are distinct. The exact HMAC payload is six newline-
separated fields:

```text
clawpilot-linkedin-worker-v1
METHOD
/pathname
unix_timestamp_seconds
lowercase-uuid-nonce
sha256hex(exact UTF-8 request body)
```

Headers are:

```text
Authorization: Bearer <CAREER_LINKEDIN_BROWSER_WORKER_TOKEN>
x-clawpilot-linkedin-worker-id: <worker id>
x-clawpilot-linkedin-timestamp: <10 digit unix seconds>
x-clawpilot-linkedin-nonce: <lowercase UUID v4>
x-clawpilot-linkedin-signature: <64 lowercase hex HMAC-SHA256>
```

The server-side verifier enforces a five-minute window and single-use nonce.
The frozen cross-service fixture is covered by `test/internal-auth.test.mjs`.

## Session envelope

ClawPilot supplies a transient 32-byte base64url data key for each leased
command. The worker holds it in memory, clears its Buffer on close, and never
receives or persists ClawPilot's master key. Playwright storage state is capped
at 2 MiB and encrypted with AES-256-GCM. The exact AAD is:

```text
clawpilot\0career-site-linkedin-worker-envelope\0v1\0<leaseId>\0<ownerId>
```

On every terminal outcome and disconnect, the browser context is closed and
transient key material is cleared. The encrypted envelope is the only session
artifact returned to ClawPilot.

## Required environment

Copy the names from `.env.example`. The three secrets must each be at least 32
characters and must all be different:

- `CAREER_LINKEDIN_BROWSER_WORKER_TOKEN`
- `CAREER_LINKEDIN_BROWSER_WORKER_HMAC_SECRET`
- `CAREER_LINKEDIN_BROWSER_COOKIE_SECRET`

`CAREER_LINKEDIN_BROWSER_CONTROL_PLANE_URL` must be HTTPS or an exact
`http://*.railway.internal` address. `CAREER_LINKEDIN_BROWSER_PUBLIC_URL` must
be HTTPS. `CAREER_LINKEDIN_BROWSER_OWNER_ID` locks the service to one owner.

## Railway setup

Create a separate Railway service whose root directory is
`services/career-linkedin-browser`. Railway will use `railway.json` and the
Dockerfile in this directory. Give the service a public HTTPS domain for the
live handoff and keep port 5900 unexposed. Configure the control-plane URL to
the private Railway hostname when both services share the project.

Run this service with **exactly one replica**. The active browser, viewer, and
live-token capability state are deliberately process-local; multiple replicas
would break one-time redemption and viewer isolation. `/healthz` discloses no
session or auth state. Startup configuration verifies the Chromium executable,
and each health request makes a short loopback TCP connection to x11vnc so a
Node-only process cannot report ready.

The checked-in Railway configuration pins one `us-east4-eqdc4a` replica and
sets deployment overlap to zero. Before any worker release, confirm that no
interactive authentication attempt is active, then verify the deployed service
manifest still shows exactly that single replica. Expose only the Node service
on port 8080; never create a TCP proxy or public domain for VNC port 5900.

No deployment is performed by this directory or its tests.

## Verification

```bash
npm ci
npm test
docker build -t career-linkedin-browser .
```

Runtime smoke the built image with distinct throwaway secrets and a non-routable
control-plane URL, then verify the real Xvfb/x11vnc/Node stack:

```bash
docker run --rm --name career-linkedin-browser-smoke -p 18080:8080 \
  -e CAREER_LINKEDIN_BROWSER_WORKER_ID=smoke-worker \
  -e CAREER_LINKEDIN_BROWSER_OWNER_ID=smoke-owner \
  -e CAREER_LINKEDIN_BROWSER_CONTROL_PLANE_URL=https://control.invalid \
  -e CAREER_LINKEDIN_BROWSER_PUBLIC_URL=https://worker.invalid \
  -e CAREER_LINKEDIN_BROWSER_WORKER_TOKEN=worker-token-0123456789abcdef-123456 \
  -e CAREER_LINKEDIN_BROWSER_WORKER_HMAC_SECRET=hmac-secret-0123456789abcdef-12345678 \
  -e CAREER_LINKEDIN_BROWSER_COOKIE_SECRET=cookie-secret-0123456789abcdef-123456 \
  career-linkedin-browser

curl --fail --silent --show-error http://127.0.0.1:18080/healthz
```

The pure contract tests do not launch Chromium or require LinkedIn credentials.
Production verification still requires the owner to open one live handoff on a
touch viewport and prove username/password/MFA entry through the mobile keyboard;
tests intentionally do not record that screen or its contents.
