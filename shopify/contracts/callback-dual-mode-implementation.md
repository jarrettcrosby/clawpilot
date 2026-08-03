# CarrierService shadow callback dual-mode implementation

This is the bounded application patch required to consume
`shopify-test-rate-isolation-readiness.schema.json`. It intentionally does not
use process environment variables as customer or variant authorization.

## Durable account-scoped record

Add migration
`db/migrations/0172_operations_shopify_shadow_rate_guards.sql` with one row per
Shopify integration account and CarrierService configuration. The table must
be protected by the same organization isolation and audit conventions as the
existing Operations Shopify tables.

Required columns:

- `organization_id`, `integration_account_id`, and
  `carrier_service_config_id`, with a unique constraint across the account and
  config;
- exact numeric `allowed_customer_ids` and `allowed_variant_ids`;
- `customer_label` and exact `rate_title_prefixes`;
- `delivery_customization_gid`, provider `function_id`, fixed Function handle
  and fixed target;
- canonical `configuration_sha256` and released Shopify app version;
- provider status, provider verification request ID, `verified_at`, and
  `verification_expires_at`;
- `row_version`, audit actor/timestamps, and the last provider error code.

The row can exist in `unverified`, `verified`, `error`, or `disabled` state.
Customer/variant identifiers belong in this protected table, not the existing
customer-neutral checkout policy snapshot.

Any allowlist, title-prefix, Function configuration, app-version, account, or
CarrierService config change must synchronously invalidate provider readiness
before the change is saved.

## Provider activation and verification

Add an account-admin-only application service that:

1. Loads the Shopify credential and the account/config-scoped shadow guard in
   one organization scope.
2. Rejects non-shadow accounts and accounts without the two delivery
   customization scopes.
3. Creates or updates the DeliveryCustomization with the app-owned
   configuration and the released Function handle.
4. Reads the provider resource back with
   `admin-graphql/verify-test-rate-isolation.graphql`.
5. Requires `enabled: true`, the expected provider Function ID, exact
   configuration JSON, and a released app-version binding.
6. Canonicalizes and hashes the verified JSON.
7. Finalizes the durable row as `verified` only if the provider response and
   original row version still match. Persist the Shopify request ID and an
   explicit short verification expiry.
8. Records the provider mutation/read as an external effect and audit event.

`CUSTOM_APP_FUNCTION_NOT_ELIGIBLE` and
`DELIVERY_CUSTOMIZATION_FUNCTION_NOT_ELIGIBLE` are terminal readiness failures,
not signals to weaken the callback.

Before an update or disable operation, mark readiness `unverified` in Postgres.
Only then mutate Shopify. A successful provider re-read can restore
`verified`.

## Callback decision

Replace the environment readers in
`app_src/lib/integrations/shopifyCarrierServiceCallback.ts` with a Postgres read
that is scoped by all three identifiers:

- `organization_id = account.organizationId`;
- `integration_account_id = account.integrationAccountId`;
- `carrier_service_config_id = account.configGlobalId` (resolve the internal FK
  in the persistence adapter).

The returned object must include the shadow-guard row version and canonical
readiness digest.

Apply this exact decision order:

1. Non-shadow account: keep the existing active-account behavior.
2. Missing, disabled, malformed, or wrong-account guard: return zero rates.
3. Any shippable variant outside the durable allowed-variant set: return zero
   rates.
4. Customer ID present in the CarrierService request: require an exact match in
   the durable allowed-customer set. A known but disallowed customer never
   falls through to variant-only mode.
5. Customer ID absent: allow variant-only mode only when provider readiness is
   `verified`, unexpired, and its account/config, Function handle/target,
   customer set, variant set, title-prefix set, app version, and configuration
   digest all match the current durable guard.
6. Otherwise return zero rates.

Return `customer_label` from the durable row for checkout evidence. Do not read
it from an environment variable.

Include the guard row version and readiness digest in
`checkoutExecutionFenceHash` and the receipt idempotency fence. That prevents a
receipt created under one authorization boundary from being reused after a
policy or provider-verification transition.

## Concrete files and tests

Add:

- `app_src/lib/persistence/shopifyShadowRateGuard.ts` for strict row parsing,
  account-scoped reads, invalidation, and compare-and-swap finalization;
- `app_src/lib/integrations/shopifyDeliveryCustomization.ts` for normalized
  Admin GraphQL create/update/read operations and provider evidence hashing;
- an admin route under the existing Shopify CarrierService setup surface for
  configure, verify, disable, and status operations;
- a focused TypeScript guard module so the callback decision is unit-testable
  without Postgres.

Update:

- `shopifyCarrierServiceCallback.ts` to await the account-scoped guard read and
  remove all three `SHOPIFY_CHECKOUT_SHADOW_*` environment readers;
- `.env.example` to remove the allowlist/label variables;
- the setup panel to show Function eligibility, app-version release, provider
  verification time/expiry, and the exact customer/variant cohort;
- the Operations contract and runbook;
- `scripts/verify-predeploy.mjs` with the focused test commands.

Required tests:

- exact customer + exact variants succeeds without current Function readiness;
- missing customer + exact variants succeeds only with current matching
  provider readiness;
- stale, disabled, malformed, wrong-account, wrong-config, wrong-app-version,
  or digest-mismatched readiness returns zero rates;
- a known disallowed customer never gets variant-only fallback;
- any non-allowed variant returns zero rates in both modes;
- row-version transition changes the execution fence and prevents cache reuse;
- provider eligibility/scope errors never finalize readiness;
- provider configuration changes invalidate readiness before the write;
- every persistence read is organization/account/config scoped.
