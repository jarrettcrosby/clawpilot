# Shopify checkout test-rate isolation

This package contains the Shopify-hosted guard that makes ClawPilot checkout
rates visible only to an exact, authenticated Shopify customer cohort.

The CarrierService callback cannot provide strict customer isolation by itself.
Shopify doesn't guarantee customer identity in the callback request, and its
successful CarrierService response cache does not vary by customer. The
Delivery Customization Function therefore performs the customer visibility
check after Shopify has assembled the checkout delivery options.

## Security boundary

The two controls are complementary:

1. The ClawPilot CarrierService callback only rates exact, tenant-configured test
   variants. If customer identity is present, it also requires the exact
   tenant-configured customer identity.
2. This Function hides every ClawPilot-prefixed rate unless
   `cart.buyerIdentity.isAuthenticated` is true and the exact Shopify Customer
   GID is in the Function's app-owned configuration.

Never use an email address as the authorization key. The configured value must
look like `gid://shopify/Customer/1234567890`.

The Function uses the checkout-visible rate title because the Delivery
Customization input does not expose the originating CarrierService ID or
CarrierService `service_code`. ClawPilot must continue returning titles in this
format:

```text
<store entity name> · <carrier name> · <service name>
```

For the current test store, the configured prefix should therefore be:

```text
Pro Bakery Bites ·
```

The store entity prefix is tenant configuration. It is not hard-coded into the
Function.

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
- `admin-graphql/create-test-rate-isolation.variables.example.json`, after
  replacing both placeholders with the exact values for this store

The mutation creates the customization and its configuration together. The
namespace is app-owned, so another app can't silently rewrite the authorization
cohort.

Then run `admin-graphql/verify-test-rate-isolation.graphql` with the returned
DeliveryCustomization GID. Persist the verified result using
`contracts/shopify-test-rate-isolation-readiness.schema.json`.

Variant-only callback fallback is permitted only while that durable readiness
record is active, unexpired, and still matches all of the following:

- shop domain and ClawPilot tenant/account;
- enabled DeliveryCustomization GID;
- Function handle and target;
- exact allowed Customer GID set;
- exact rate-title prefix set;
- exact allowed variant GID set;
- digest of the app-owned Function configuration.

An environment flag alone is not authority to weaken the callback.

## Configuration failure behavior

Missing or malformed Function configuration returns no customization
operations. This preserves native carrier options and avoids stranding every
customer's checkout when the Function can't safely identify the ClawPilot
option.

That behavior is not proof of isolation. Activation and provider verification
must therefore fail closed: an invalid or absent app-owned configuration can
never produce a current readiness record, and variant-only callback fallback
must remain disabled. The activation mutation creates the customization and
configuration together. On any later configuration change, first invalidate
the durable readiness record, then write and re-verify the provider resource.

## Acceptance

Test all cases from fresh checkouts, not by repeatedly refreshing one cached
checkout:

1. Authenticated allowed Customer GID + allowed variant: ClawPilot rates appear.
2. Authenticated different Customer GID + allowed variant: ClawPilot rates do
   not appear.
3. Guest checkout + allowed variant: ClawPilot rates do not appear.
4. Allowed customer + non-allowed variant: callback returns no ClawPilot rates.
5. A non-ClawPilot UPS/USPS option remains visible for denied customers.
6. Multiple delivery groups are all filtered.
7. After the durable readiness record expires, callback fallback closes until a
   new provider verification succeeds.

Official references:

- <https://shopify.dev/docs/api/functions/unstable/delivery-customization>
- <https://shopify.dev/docs/apps/build/checkout/delivery-shipping/delivery-options/build-function>
- <https://shopify.dev/docs/apps/build/checkout/delivery-shipping/delivery-options/build-ui>
- <https://shopify.dev/docs/api/admin-graphql/latest/mutations/deliverycustomizationcreate>
- <https://shopify.dev/docs/apps/build/functions/index>
- <https://shopify.dev/docs/apps/launch/distribution/select-distribution-method>
- <https://shopify.dev/docs/apps/build/cli-for-apps/manage-app-config-files>
- <https://shopify.dev/docs/apps/launch/deployment/deploy-app-versions>
