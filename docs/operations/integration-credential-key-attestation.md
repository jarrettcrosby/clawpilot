---
id: cp-operations-integration-credential-key-attestation
title: Integration credential key attestation
summary: Bind the configured integration-credential key to one database identity before provider migration or activation.
status: active
kind: operations-runbook
area: operations
tags: [operations, integrations, credentials, migration, production, railway]
app_visible: false
---

# Integration credential key attestation

ClawPilot binds the integration-credential encryption key to one durable
database identity before production provider credentials are written or read.
The attestation stores an AES-256-GCM ciphertext, a random IV and tag, and
non-secret creation metadata. It never stores raw key material, a direct key
hash, or the plaintext random challenge.

## Required configuration

- `DATABASE_URL`: the exact database being attested.
- `INTEGRATION_CREDENTIAL_ENCRYPTION_KEY`: required in Railway, the sole
  production runtime, and in any other runtime configured with
  `CLAWPILOT_STORAGE=postgres` and a non-empty `DATABASE_URL`. Normal
  production bootstrap and verification never fall back to
  `AGENT_CREDENTIAL_ENCRYPTION_KEY` or `APP_SESSION_SECRET`.
- `INTEGRATION_CREDENTIAL_ENCRYPTION_KEY_ID`: a non-secret rotation label such
  as `prod-integrations-2026-09`. It is not derived from the key.
- `--expected-database-identity`: the exact UUID stored at
  `app_settings['deployment.database.identity'].id`.
- `--actor`: an active `app_users.email` whose application role is `owner` or
  `admin` for bootstrap or adoption.

Never pass key material as a command-line argument or write it into a plan.

## Runtime enforcement and platform boundary

Railway is the required only production application runtime after cutover. Its
startup script reads and authenticates the durable sentinel before Next.js
starts. Accepted post-retirement Vercel previews are compile/UI-only and receive
no production database URL, integration key, or provider secrets; bare
`VERCEL=1` therefore does not by itself activate the production attestation
gate. The September 5, 2026 audit found the transitional Vercel application
project still has a production-scoped `DATABASE_URL` but no
`INTEGRATION_CREDENTIAL_*` variables. Under the current runtime detector that
combination activates enforcement and fails closed; it is a cutover blocker,
not a supported preview configuration. Remove the legacy database assignment
only after Railway exact-commit acceptance, then re-audit before preview use. If
any other runtime is intentionally configured with the Postgres contract above,
it becomes an enforced runtime and must pass the same gate.

Strict mode is the default. It requires the immutable sentinel and issues a
key-signed, database-URL-bound, deployment-bound process proof with a maximum
15-minute lifetime. Long-lived processes attempt a direct database refresh
every minute, health checks also refresh the proof, and any refresh failure
deletes the current proof. Provider entry points synchronously verify the
proof before the first provider call or mutation of key-backed integration
state. Credential encryption, decryption, and keyed callback fingerprints use
the same boundary before key bytes are released.

`INTEGRATION_CREDENTIAL_ATTESTATION_MODE=adoption` is an explicit maintenance
state, not normal readiness. It requires a future
`INTEGRATION_CREDENTIAL_ATTESTATION_ADOPTION_DEADLINE` no more than two hours
away. A missing sentinel may keep HTTP health available as `maintenance`, but
provider I/O and integration credential reads and writes remain disabled. The
Railway launcher also suppresses the entire pipeline outbox poller during
adoption so no commerce, fulfillment, image, catalog, or CRM job can claim
work before the strict provider boundary is restored.
After reviewed adoption creates the sentinel, switch immediately to strict
mode; adoption mode deliberately rejects a populated sentinel.

The proof is not a same-transaction database attestation for every provider
write. The trusted infrastructure boundary therefore includes the stable
`DATABASE_URL` routing, its database owner/runtime role, and the database
identity during the proof's bounded lifetime. A routing or owner compromise
inside that window is outside the application-layer proof. Health and the
periodic refresh bound that exposure; a future per-operation transaction-bound
attestation or separate least-privilege runtime role would narrow it further.

## Empty database bootstrap

Only use this when every known store encrypted by the legacy integration key is
empty. Both the CLI and migration trigger reject empty bootstrap when any such
record exists.

```sh
npm run integration-key:attest -- bootstrap-empty \
  --expected-database-identity 00000000-0000-4000-8000-000000000000 \
  --actor operator@example.com
```

The operation uses a serializable transaction, a database advisory lock, and
`SHARE` locks on every known key-backed table. Those table locks conflict with
normal inserts, updates, and deletes, so a credential or protected address
cannot appear between the empty-store check and singleton creation. It is
idempotent only when an existing row authenticates with the same key ID, key
material, and database identity.

## Reviewed legacy adoption

Adoption is deliberately two-step. Planning decrypt-authenticates every row in
every known integration-key-backed store with the configured key and the exact
tenant, account, provider, order, event, or cursor identity used as its AES-GCM
authenticated data. It also records counts and ciphertext digests without
exporting ciphertext or plaintext. The footprint includes commerce and carrier
credentials, carrier accounts, pending Faire OAuth credentials, provider
webhook/read/cursor evidence, protected order candidate snapshots,
imported-order workbench shipment-address drafts, and canonical-order
shipment-address working copies. A row that uses a different key or whose
authenticated identity was changed makes adoption fail closed.

```sh
npm run integration-key:attest -- adopt-plan \
  --expected-database-identity 00000000-0000-4000-8000-000000000000 \
  --actor operator@example.com \
  --out /private/path/integration-key-adoption-plan.json
```

The new plan is written with mode `0600` and expires after 30 minutes. Review
the database identity, key ID, actor, per-store counts/digests, and final plan
digest. Apply requires re-entering that exact digest:

```sh
npm run integration-key:attest -- adopt-apply \
  --expected-database-identity 00000000-0000-4000-8000-000000000000 \
  --actor operator@example.com \
  --plan /private/path/integration-key-adoption-plan.json \
  --reviewed-plan-digest 0000000000000000000000000000000000000000000000000000000000000000
```

Apply rechecks the database identity, key ID, actor, plan age, complete
key-backed footprint, and decrypt-authenticates every key-backed row inside the
same serialized transaction and the same write-conflicting table locks before
inserting the immutable singleton. The integration-account and canonical-order
tables that supply authenticated-data identities are locked as well, so an
account global ID or provider-order identity cannot drift during proof. The CLI
also installs a transaction-local context bound
to the reviewed plan digest, actor, database/key metadata, and the newly
generated sentinel ciphertext. The database trigger rejects a raw or stale
reviewed-adoption insert without that exact context. Any footprint change
requires a new plan and review.

### One-time hosted legacy agent-key adoption

A legacy hosted database may contain records encrypted before the dedicated
integration key variable existed. Only `adopt-plan` and `adopt-apply` may
explicitly use the historical `AGENT_CREDENTIAL_ENCRYPTION_KEY` fallback, and
only when each command includes:

```sh
--allow-hosted-legacy-agent-key true
```

Use the flag only when the dedicated integration key is absent and the
reviewed legacy key-backed rows authenticate with the agent key. Both plan
and apply must use it. After adoption, configure
`INTEGRATION_CREDENTIAL_ENCRYPTION_KEY` with the same key material and run the
normal `verify` command without the flag. The flag is rejected for `verify`
and `bootstrap-empty`; it is not a normal hosted runtime fallback.

## Verification

Verification is read-only and emits only the status, key ID, attestation-record
digest, and database identity:

```sh
npm run integration-key:attest -- verify \
  --expected-database-identity 00000000-0000-4000-8000-000000000000
```

Missing, malformed, mismatched, or tampered attestations all fail with the safe
code `INTEGRATION_CREDENTIAL_KEY_ATTESTATION_VERIFICATION_FAILED`. The error
does not include key material, plaintext, ciphertext, or low-level crypto
details.

Key rotation cannot mutate this singleton. It requires an explicitly reviewed
future schema/version transition so the old proof remains durable evidence.

The table is immutable by trigger. Ambient `PUBLIC` table access and direct
execution of its trigger functions are revoked. Railway currently runs the
migration and application with the same `DATABASE_URL`, so that database role
may own the table and remains part of the trusted migration/operator boundary.
The transaction-local reviewed-adoption context prevents accidental generic
runtime or operator inserts; it is not a security boundary against a malicious
or compromised table owner or superuser, which can alter or disable database
objects. A future split between a schema-owner migration role and a
least-privilege runtime role would provide that stronger infrastructure
boundary.
