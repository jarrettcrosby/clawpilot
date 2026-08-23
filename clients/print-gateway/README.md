# ClawPilot Print Agent

This package is the customer desktop installer and local background delivery
plane for ClawPilot web-managed LAN printing. It produces a genuine macOS
application in a universal DMG and a Windows x64 application in an NSIS
installer. It is not the browser/manual-print path.

The desktop shell bundles the exact repository worker and its immutable-artifact
verification, claim ledger, lost-acknowledgement fence, opaque device reference,
and raw ZPL delivery helper. Closing the setup window leaves the tray process and
workers running. The app registers at user sign-in; the computer must remain on,
awake, signed in, and connected to the printer LAN.

## Pairing and local privacy

The operator supplies these values in the desktop app:

- an exact trusted Production or Development ClawPilot deployment;
- an optional local nickname (the server agent identity remains authoritative);
- the short-lived `cppair.v1` code shown by the web app;
- the Zebra's literal private LAN IPv4 address;
- raw TCP port, normally `9100`.

The agent opens and closes TCP 9100 without sending bytes before it redeems the
one-time pairing code. Before the first request it durably encrypts an X25519
recovery key, installation identity, and idempotency key. Redemption sends that
public recovery identity and the pairing code only to the selected trusted
deployment. A lost response replays the same request; the server returns the
same sealed enrollment to that client key. The app validates and decrypts the
authoritative agent and warehouse identity, then atomically replaces pending
recovery with the enrolled instance. The resulting `cpprint.v1` credential and
execution configuration are encrypted with Electron `safeStorage` (macOS
Keychain or Windows DPAPI), then the credential is passed to the worker through
an inherited pipe. It is not placed in argv, the worker environment, logs, or a
plaintext file.

A `clawpilot-print-gateway://pair` link may carry display-only `organization`,
`warehouse`, and `context` values. It must not carry a printer endpoint, pairing
code, runtime credential, or authoritative ClawPilot URL. The operator confirms
the URL in the native app.

Every organization/workspace uses a unique local instance and an independent,
organization-scoped credential, claim ledger, and device key. Multiple
instances may intentionally target the same physical Zebra: pair each workspace
or organization separately, reusing the same printer IP and port. There is no
local printer-endpoint uniqueness requirement. The workers poll and acknowledge
only through their own credentials, while raw delivery is serialized at the
shared physical endpoint. Removing one local instance never removes another
instance's protected state. macOS serializes the endpoint with `lockf` at the
exact legacy shared root
`~/Library/Application Support/ClawPilot/print-agent/device-locks`; Windows uses
a stable per-user ClawPilot root plus an operating-system named mutex
whose abandoned-lock behavior is released by the kernel if a delivery process
dies.

On macOS the app hard-blocks pairing, worker start, and enabling start-at-login
while either legacy family is present:

- For a `com.clawpilot.print-agent.*` LaunchAgent, drain and verify no
  pending/in-flight work, then use the old command manager's
  `3. Stop and uninstall an instance` action. It retains that instance's
  Keychain credential, device key, and ledger for rollback.
- For the older Tauri `Print Agent.app`, the exact
  `~/Library/LaunchAgents/com.printagent.app.plist` or a running executable whose
  exact app-bundle identity ends in
  `/Print Agent.app/Contents/MacOS/print-agent` is enough to block. The process
  check uses the full `ps` command only to nominate PIDs, then uses `lsof` to
  verify the executable identity rather than trusting shell/grep command text.
  It therefore also covers an app launched from `/Applications`,
  `~/Applications`, a mounted DMG, or macOS App Translocation without treating
  helper commands as the app.
  In that old tray app, turn off auto-start and then Quit. Preserve the installed
  app and `~/Library/Application Support/print-agent` configuration for rollback;
  do not manually delete its LaunchAgent or configuration.

The Electron app only reads this legacy state; it does not stop, delete,
uninstall, or revoke either older runtime. It checks at startup, while running,
and when brought to the foreground. If legacy printing appears after Electron
workers start, they finish any current raw delivery and acknowledgement through
the existing graceful shutdown path, then all stop before another claim. The
block remains latched until this app is reopened. A previously enabled Electron
start-at-login setting remains available only so the operator can turn it off.
Once the old auto-start entries are disabled and processes have quit, reopen
this app, pair the same private Zebra IP and port, run the no-print probe, send
exactly one controlled UPS sandbox label, and verify its acknowledgement. Only
then revoke the old server enrollment. Roll back before permitting a new
Electron claim if that proof fails.

## Local validation

Local CI builds are deliberately unpacked and unsigned. They are never uploaded
as customer downloads.

```bash
npm --prefix clients/print-gateway ci
npm --prefix clients/print-gateway test
npm --prefix clients/print-gateway run build:dir
```

## Customer release gate

`.github/workflows/print-gateway-release.yml` is manual-only and requires the
exact `SIGN_AND_PUBLISH` confirmation plus approval of the protected
`print-gateway-customer-release` GitHub environment. It publishes nothing unless
every selected platform job finishes and the publish job proves all of the
following:

- macOS app and DMG use a `Developer ID Application` identity for the expected
  Apple team;
- hardened-runtime verification succeeds;
- Apple notary service returns `Accepted` for the app and DMG;
- notarization tickets are stapled and validated;
- Gatekeeper accepts the mounted app and DMG;
- when Windows is selected, its app executable and NSIS installer have a `Valid` Authenticode chain
  for the expected subject and a trusted timestamp;
- every selected artifact matches its SHA-256/byte-length manifest and contains no
  concrete `cppair.v1` or `cpprint.v1` value;
- the release index contains exactly the selected release-ready platforms;
- per-artifact manifests, per-artifact checksums, the aggregate release index,
  and `SHA256SUMS.txt` receive verified GitHub OIDC Sigstore bundles.

Redacted diagnostics deliberately omit the endpoint and any unkeyed endpoint
hash; private IPv4 addresses are enumerable and are not anonymized by a short
plain SHA-256 fingerprint.

The release is created as a draft and becomes visible only after every file and
signature bundle uploads. Existing release tags are immutable and are never
replaced.

### Required protected secrets

macOS:

- `PRINT_GATEWAY_MACOS_CERTIFICATE_P12_BASE64`
- `PRINT_GATEWAY_MACOS_CERTIFICATE_PASSWORD`
- `PRINT_GATEWAY_MACOS_DEVELOPER_ID_APPLICATION` (must start with
  `Developer ID Application:`; an Apple Development identity is insufficient)
- `PRINT_GATEWAY_APPLE_TEAM_ID`
- `PRINT_GATEWAY_APPLE_API_KEY_P8_BASE64`
- `PRINT_GATEWAY_APPLE_API_KEY_ID`
- `PRINT_GATEWAY_APPLE_API_ISSUER`

Windows (required only when `macos-and-windows` is selected):

- `PRINT_GATEWAY_WINDOWS_CERTIFICATE_PFX_BASE64`
- `PRINT_GATEWAY_WINDOWS_CERTIFICATE_PASSWORD`
- `PRINT_GATEWAY_WINDOWS_SIGNING_SUBJECT`
- `PRINT_GATEWAY_WINDOWS_SIGNING_THUMBPRINT` (the exact 40-hex signer certificate thumbprint)

The Windows PFX must chain to a publicly trusted code-signing certificate usable
by electron-builder/sign-tool. The resulting installer must carry a valid RFC
3161 timestamp. No signing key, certificate, App Store Connect credential, or
notarization upload is created or performed by local source validation.

Until the selected platform secrets and the protected environment are configured,
there is no customer-release artifact. This package does not publish or relabel an unsigned
`.command`/Node ZIP as a customer download.
