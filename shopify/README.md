# Shopify checkout test-rate isolation

This package contains the Shopify-hosted customer-rate policy guard. In
Shadow, the default is to hide ClawPilot rates and selected authenticated
customers receive an explicit policy. In Active, the default is to show
ClawPilot rates to every eligible cart, including guests, while optional
per-customer policies can filter the available ClawPilot services.

The CarrierService callback cannot provide strict customer isolation by itself.
Shopify doesn't guarantee customer identity in the callback request, and its
successful CarrierService response cache does not vary by customer. The
Delivery Customization Function therefore performs the customer visibility
check after Shopify has assembled the checkout delivery options.

## Security boundary

The two controls are complementary:

1. The ClawPilot CarrierService callback returns a customer-neutral superset of
   eligible services. The bounded Shadow proof additionally rates only exact,
   tenant-configured test variants.
2. This Function recognizes ClawPilot options by their stable
   `clawpilot:<carrier>:<service>` code and applies the policy stored on the
   authenticated Shopify Customer resource after Shopify assembles checkout
   delivery options.

Never use an email address, cookie, browser session, or checkout URL as the
authorization key. The administrator may search by email in ClawPilot, but the
saved assignment must target the resolved
`gid://shopify/Customer/<numeric-id>` resource.

Customer assignments are not stored in one capped cohort array. Each Shopify
Customer owns one app-reserved `customer-rate-policy` metafield, so ClawPilot
does not impose a limit on how many customers can receive a policy. A single
customer policy is bounded to the 50 services that the CarrierService response
itself supports.

ClawPilot continues returning customer-facing titles in this format:

```text
<store entity name> · <carrier name> · <service name>
```

The store entity name is tenant configuration. It is not used as the security
identifier, so an administrator can rename it without breaking customer-rate
policy enforcement.

The global Function configuration has two modes:

- `hide_all`: Shadow default. Guests and customers without a valid explicit
  policy do not see ClawPilot rates.
- `show_all`: Active default. Every eligible cart sees the customer-neutral
  ClawPilot service set, whether the buyer is authenticated or a guest.

An authenticated customer policy can use `show_all`, `hide_all`,
`include_only`, or `exclude`. An anonymous checkout always receives the global
default because Shopify has no durable customer identity to personalize.

## Required eligibility and scopes

Before linking or releasing the extension, verify both conditions:

- The app has `read_delivery_customizations` and
  `write_delivery_customizations`.
- The distribution/plan combination is eligible. Shopify documents that a
  custom app can activate Shopify Functions only on Shopify Plus. Stores on
  other plans can use Functions delivered by public App Store apps.

If the existing API-only app is custom distributed and the store isn't on
Shopify Plus, `deliveryCustomizationCreate` will fail with
`DELIVERY_CUSTOMIZATION_FUNCTION_NOT_ELIGIBLE`. In that state, do not enable
variant-only CarrierService fallback. The safe behavior is the existing
customer-plus-variant fail-closed response.

**Current release blocker:** Pro Bakery Bites is on Shopify Advanced, not
Shopify Plus. The existing custom app therefore cannot activate this Function
on that store. Keep the extension unreleased for this store and keep
variant-only callback fallback disabled. Activation requires either upgrading
the store to Plus or distributing the Function through an eligible public App
Store app; neither is a code-side bypass.

## Link and stage the existing app

This repository deliberately does not contain a fabricated `shopify.app.toml`.
Link the package to the existing EPISHIP app so Shopify CLI writes the actual
app configuration and extension identity:

```bash
cd /Users/agentsuburbiasandwich/Desktop/clawpilot/shopify
npm install
npm run config:link
npm test
npm run build
npm run deploy:staged
```

During `config:link`, select the existing EPISHIP app. Confirm the generated
configuration has the intended client ID, store URL, and the two delivery
customization scopes before continuing. `deploy:staged` creates an unreleased
app version. Review that version in the Shopify Dev Dashboard before releasing
it with Shopify CLI or the dashboard.

No app secret, access token, customer email, or live Customer GID belongs in
Git.

## Activate with app-owned configuration

After the extension version is released, use the app's authenticated Admin
GraphQL client to run:

- `admin-graphql/create-test-rate-isolation.graphql`
- `admin-graphql/create-test-rate-isolation.variables.example.json`
- `admin-graphql/set-customer-rate-policy.graphql`
- `admin-graphql/set-customer-rate-policy.variables.example.json`, after
  replacing the placeholder with the exact resolved Customer GID

The first mutation creates the customization and its default policy together.
The second assigns a policy to one Customer resource. Both namespaces are
app-owned, so another app can't silently rewrite the policy. Repeat the
customer-policy mutation for any number of customers; there is no central
cohort-size limit.

Then run `admin-graphql/verify-test-rate-isolation.graphql` with the returned
DeliveryCustomization GID. Persist the verified result using
`contracts/shopify-test-rate-isolation-readiness.schema.json`.

Variant-only callback fallback is permitted only while that durable readiness
record is active, unexpired, and still matches all of the following:

- shop domain and ClawPilot tenant/account;
- enabled DeliveryCustomization GID;
- Function handle and target;
- global default policy and stable `clawpilot:` rate-code prefix;
- app-owned customer-policy namespace and key;
- exact allowed variant GID set;
- digest of the app-owned Function configuration.

An environment flag alone is not authority to weaken the callback.

## Configuration failure behavior

Missing or malformed Function configuration hides every option positively
identified by the stable `clawpilot:` service-code prefix. Native carrier and
merchant rates remain untouched. A malformed customer policy falls back to the
valid global default.

That behavior is not proof of isolation. Activation and provider verification
must therefore fail closed: an invalid or absent app-owned configuration can
never produce a current readiness record, and variant-only callback fallback
must remain disabled. The activation mutation creates the customization and
configuration together. On any later configuration change, first invalidate
the durable readiness record, then write and re-verify the provider resource.

## Acceptance

Test all cases from fresh checkouts, not by repeatedly refreshing one cached
checkout:

1. Shadow `hide_all` + authenticated `show_all` customer policy + allowed
   variant: ClawPilot rates appear.
2. Shadow `hide_all` + authenticated customer without a policy: ClawPilot rates
   do not appear.
3. Shadow `hide_all` + guest checkout: ClawPilot rates do not appear.
4. Active `show_all` + guest or authenticated customer without a policy:
   ClawPilot rates appear.
5. Active `show_all` + `include_only` or `exclude` customer policy: only the
   configured stable service codes remain.
6. Allowed customer + non-allowed Shadow variant: callback returns no
   ClawPilot rates.
7. A non-ClawPilot UPS/USPS option remains visible for every policy.
8. Five concurrent authenticated sessions for one Customer GID produce the
   same policy result.
9. Multiple delivery groups are all filtered.
10. After durable readiness expires, callback fallback closes until a new
   provider verification succeeds.

Official references:

- <https://shopify.dev/docs/api/functions/unstable/delivery-customization>
- <https://shopify.dev/docs/apps/build/checkout/delivery-shipping/delivery-options/build-function>
- <https://shopify.dev/docs/apps/build/checkout/delivery-shipping/delivery-options/build-ui>
- <https://shopify.dev/docs/api/admin-graphql/latest/mutations/deliverycustomizationcreate>
- <https://shopify.dev/docs/apps/build/functions/index>
- <https://shopify.dev/docs/apps/launch/distribution/select-distribution-method>
- <https://shopify.dev/docs/apps/build/cli-for-apps/manage-app-config-files>
- <https://shopify.dev/docs/apps/launch/deployment/deploy-app-versions>

## Saved-address checkout rate warmer

The theme app extension in
`extensions/clawpilot-checkout-rate-warmer` can warm Shopify Ajax shipping-rate
requests for the normalized saved-address rate zones returned by ClawPilot.
It is disabled by default and is a separate surface from the Delivery
Customization Function above.

Its exact app-proxy path, required scopes, staging boundary, and root validation
gate are documented in
`contracts/checkout-rate-warmer-deployment.md`. Do not release the extension or
enable a tenant warm-up policy solely because the extension asset builds.
