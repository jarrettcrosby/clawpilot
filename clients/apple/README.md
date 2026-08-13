# ClawPilot Apple Picking Client

This is the bounded Phase 1 worker companion for outbound pick confirmation.
Meta glasses and the iPhone camera are barcode observation sources; the iPhone
owns authentication, exact matching, task caching, voice readout, the durable
confirmation outbox, and all ClawPilot API calls. Apple Watch caches only the
current and next two display cards and has no mutation authority.

The iPhone app uses the ClawPilot dark palette and mark, includes a native app
icon, and gates every workflow behind the same session as the web app. After
sign-in, capability-aware **Picker** and **Manager** entry points keep worker
execution separate from management. Manager Operations can review orders,
release a warehouse wave and assign its ready picks to an eligible worker using
the audited Operations command boundary. Managers can open **People** to invite
a worker and grant the bounded **Picker access** permission; picker accounts need
Operations view and warehouse execution, not Operations management. Both roles
see assignment-to-audited-confirmation UPH backed by pick-task assignment and
completion timestamps. The one-time-code keyboard can be
dismissed with its **Done** control or by dragging the screen, while iOS AutoFill
remains enabled for codes received by email.

The picker screen explains the deliberate operating loop. When one registered
device is connected, **Start Meta scan** opens a live glasses camera stream and
reads barcodes locally without saving photos. A verified location pauses the
workflow at **Scan product**; the picker explicitly advances from the iPhone or
Watch while the existing Meta camera session stays alive. A multi-unit product
scan opens a focused count popup on both devices. The picker punches in the
physical count, and only an exact match advances the item; a short or excess
count stays open with voice and haptic feedback. Unit-one products retain the
existing immediate scan path. Location, product, awaiting-count, and exact-count
progress is durably cached behind the complete queue/order identity fence so an
app restart cannot silently skip or transfer a step.

Returning from Meta AI starts
a bounded reconnection poll; **Reconnect glasses** retries it without requiring
the worker to leave ClawPilot. The iPhone camera remains an explicit fallback.
The Watch delegates a read request to the iPhone only when the enhanced voice
pack is ready and exactly one current Meta glasses session is connected. The
iPhone rechecks both conditions for every request and plays only after iOS has
selected a Bluetooth output. If the glasses disconnect, the route is not
Bluetooth, the phone is unreachable, or enhanced playback fails, the Watch
reads its cached instruction locally through Apple speech instead.

Instruction audio can use the optional Supertonic-3 FP16 voice pack through
SpeechSwift 0.0.23. The pack is installed explicitly from the Picker audio card,
validated by exact asset sizes, stored in the app's model cache, and runs locally
through CoreML after download. English and Spanish instructions use separately
validated voice profiles; Apple speech remains the safe fallback while the pack is
absent, downloading, invalid, or unavailable. The approximately 332 MB model is
derived from Supertone's Supertonic-3 under the OpenRAIL-M license. Supertonic
requires iOS 18 while the Watch target remains watchOS 10.2.
The model is installed only on iPhone; the Watch cannot install or run this iOS
CoreML package. Consistent enhanced speech therefore uses the reachable iPhone,
while Watch-only playback remains Apple speech.
The Picker audio card also maintains a device-local pronunciation dictionary;
operators can add, preview, replace, and remove written-term to spoken-term
corrections, which apply to both the enhanced voice and Apple fallback speech.

The client reads the signed worker queue from `GET /api/operations/picks` and
submits the existing `confirm-picks` command to `POST /api/operations` with the
order's `expectedRowVersion` and a durable `Idempotency-Key`. A timeout or other
ambiguous result blocks new work and replays the same command and key.

## Validation

From the repository root:

```sh
npm run test:wearable-phase1
npm run build:apple-picking-simulators
npm run pilot:apple-wearable-readiness
```

The simulator build pins `facebook/meta-wearables-dat-ios` exactly to 0.9.0 and
compiles the iPhone and Watch targets unsigned, then asserts that the phone app
contains the Watch companion. The readiness command prints only whether each
build-owned setting is present; it never prints configured values or
credentials.

The source-controlled project produces two fixed environments from the same
source revision. `ClawPilotPickingPhoneDev` builds **ClawPilot Dev** with the
`.dev` phone/Watch identifiers and `https://dev.aiapp.eigenracing.com`.
`ClawPilotPickingPhone` builds **ClawPilot** with the existing production
identifiers and `https://aiapp.eigenracing.com`. The environment is selected by
the signed Xcode scheme, never by a picker on the login screen.

The development scheme runs the `Development` debug configuration locally but
profiles and archives with the release-optimized `DevelopmentRelease`
configuration. Both configurations use `Development.xcconfig`, so a dev
TestFlight build retains the dev identifiers and origin without compiling
debug-only behavior. The iPhone and Watch targets each bundle their own
`PrivacyInfo.xcprivacy`; the phone declares its app-container file metadata and
app-local user-defaults access, while the Watch declares only its app-local
user-defaults access.

For DAT 0.9, each Meta Wearables Developer Center project must use the callback
from its matching configuration: `clawpilot-meta-dev://` for development and
`clawpilot-meta://` for production. Despite the portal label **Universal link**,
these are the custom URL schemes Meta AI uses to return to the matching app.
Signed builds keep environment-specific credentials in the ignored
`Config/Local.xcconfig` file:

- `CLAWPILOT_META_DEV_APP_ID`
- `CLAWPILOT_META_DEV_CLIENT_TOKEN`
- `CLAWPILOT_META_PRODUCTION_APP_ID`
- `CLAWPILOT_META_PRODUCTION_CLIENT_TOKEN`
- `CLAWPILOT_GOOGLE_DEV_IOS_CLIENT_ID`
- `CLAWPILOT_GOOGLE_DEV_REVERSED_CLIENT_ID`
- `CLAWPILOT_GOOGLE_PRODUCTION_IOS_CLIENT_ID`
- `CLAWPILOT_GOOGLE_PRODUCTION_REVERSED_CLIENT_ID`
- `CLAWPILOT_GOOGLE_SERVER_CLIENT_ID_SHARED`

Google sign-in is additive to magic codes and is linked separately by each
existing user from the iPhone Session Security card or web Security settings.
The server verifies the token against `GOOGLE_SSO_SERVER_CLIENT_ID` and requires
both the stored Google subject and its verified email to match that exact active
ClawPilot user. The linked user can switch among all of their direct active
organization memberships; legacy organization Google-policy flags do not limit
that user-scoped link. Root or parent relationships do not grant implicit
membership access. One user's link cannot authenticate another user, and Google
never creates a user, membership, or organization role. A Google-authenticated
session also cannot create a new business membership. Face ID is a device-local
unlock for an already authenticated ClawPilot session and cannot replace server
login.

The local file is optional for simulator compilation and must never be
committed. Physical validation must still prove Meta registration, camera
permission and frames, exact barcode accuracy, audio routing, paired-Watch
delivery, battery life, and warehouse privacy/comfort before operator use.
