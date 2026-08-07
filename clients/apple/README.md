# ClawPilot Apple Picking Client

This is the bounded Phase 1 worker companion for outbound pick confirmation.
Meta glasses and the iPhone camera are barcode observation sources; the iPhone
owns authentication, exact matching, task caching, voice readout, the durable
confirmation outbox, and all ClawPilot API calls. Apple Watch caches only the
current and next two display cards and has no mutation authority.

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

The source-controlled project pins the development server, HTTPS fallback
associated domain, Meta DAT callback scheme, Apple team, and phone/watch bundle
identifiers. For DAT 0.9, the Meta Wearables Developer Center iOS
**Universal link** field must exactly match the app's callback value
`clawpilot-meta://`; despite the portal label, this is the custom URL scheme
used by Meta AI to return to the app. Signed pilot builds keep these Meta
credentials in the ignored
`Config/Local.xcconfig` file:

- `CLAWPILOT_META_APP_ID`
- `CLAWPILOT_META_CLIENT_TOKEN`

The local file is optional for simulator compilation and must never be
committed. Physical validation must still prove Meta registration, camera
permission and frames, exact barcode accuracy, audio routing, paired-Watch
delivery, battery life, and warehouse privacy/comfort before operator use.
