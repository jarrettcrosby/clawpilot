# Checkout rate warmer deployment contract

The saved-address checkout rate warmer is a staged Shopify theme app extension.
It is not active merely because the ClawPilot application route is deployed.
Do not release the extension or enable its tenant policy until the store's
customer-isolation readiness is active.

## Exact app-proxy mapping

Shopify allows one app-proxy root and appends child paths under that root to the
configured application URL. ClawPilot uses this mapping:

| Surface | Path |
| --- | --- |
| Storefront proxy root | `/apps/clawpilot` |
| ClawPilot development proxy root | `https://dev.aiapp.eigenracing.com/api/integrations/commerce/shopify/rate-warm` |
| Theme embed request | `/apps/clawpilot/checkout-rate-warmer` |
| Resolved ClawPilot route | `/api/integrations/commerce/shopify/rate-warm/checkout-rate-warmer` |

The child route is a narrow alias of the verified parent handler. It does not
bypass Shopify app-proxy signature verification or account-scoped policy
loading.

Merge
`contracts/checkout-rate-warmer-app-proxy.toml.example` into the configuration
linked to the existing EPISHIP app. Preserve all other required scopes. The
rate warmer specifically requires `read_customers` to derive saved rate zones
and `write_app_proxy` to configure the proxy.

The example deliberately uses an absolute ClawPilot development URL. The
EPISHIP API-only app can keep Shopify's default app-home URL while its app proxy
targets the ClawPilot server. A production Shopify app version must use
`https://aiapp.eigenracing.com/api/integrations/commerce/shopify/rate-warm`
instead. Never release a version whose proxy destination points at the wrong
ClawPilot environment.

The storefront `prefix` or `subpath` can be customized by a merchant after
installation. If that happens, update the theme block's **ClawPilot app proxy
path** setting to the installed storefront path. The ClawPilot destination root
does not change.

## Staged verification

From the repository root:

```bash
npm run test:shopify-rate-warmer-extension
```

That root gate verifies the path contract, runs every Shopify extension test,
and builds the theme rate-warmer asset. It runs as part of
`test:shopify-carrier-service`, so the normal commerce gate cannot omit it.

Only after the linked Shopify configuration has been reviewed:

```bash
cd shopify
npm run config:link
npm run deploy:staged
```

`deploy:staged` creates an unreleased version. Releasing the Shopify app version,
adding the theme app embed, or enabling the tenant warm-up policy are separate
operator actions and are intentionally outside this code-side validation.

Official behavior:

- <https://shopify.dev/docs/apps/build/online-store/app-proxies>
- <https://shopify.dev/docs/apps/build/online-store/app-proxies/authenticate-app-proxies>
