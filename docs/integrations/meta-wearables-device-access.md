---
id: cp-integration-meta-wearables-device-access
title: Meta Wearables Device Access
summary: ClawPilot Phase 1 Meta camera and Apple build configuration boundary.
status: draft
kind: integration-contract
area: distributed-operations
tags: [clawpilot, meta, ios, camera, barcode]
app_visible: false
---

# Meta Wearables Device Access

The iPhone target pins the official `facebook/meta-wearables-dat-ios` package
to version 0.9.0 and links `MWDATCore` plus `MWDATCamera`. Registration and
camera permission are explicit operator actions. A scan starts only when
exactly one connected compatible device is available, consumes public
`VideoFrame.sampleBuffer` values synchronously with Apple Vision, and stops
after the first unambiguous barcode. The iPhone camera remains available when
Meta setup or streaming fails.

The source-controlled build pins the development ClawPilot origin and universal
link/associated domain, Apple team, and phone/watch bundle IDs. The
Meta app ID/client token live only in ignored `Config/Local.xcconfig`.
`project.yml` opts out of SDK analytics/crash capture and declares Meta's
required external-accessory, Bluetooth, local-network, Hotspot Configuration,
Wi-Fi information, and associated-domain settings.

No source gate can establish physical frame accuracy, SDK distribution
eligibility, Meta AI callback behavior, audio routing, battery performance, or
warehouse comfort/privacy. Those are signed pilot admission checks.
