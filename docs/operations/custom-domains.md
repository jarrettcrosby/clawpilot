# ClawPilot Custom Domains

## Runtime Map

| Lane | Branch | Railway environment | Domain | Database |
|---|---|---|---|---|
| Production | `main` | `production` | `aiapp.eigenracing.com` | Production `Postgres` volume |
| Development | `dev` | `development` | `dev.aiapp.eigenracing.com` | Isolated development `Postgres` volume |

Both named runtimes are hosted on Railway so the Next.js app and pipeline outbox worker run together. Vercel remains a protected preview/build check and is not the durable runtime behind either custom domain.

The persistent `development` Railway environment was created from production configuration, rebound to the `dev` branch, and given its own empty Postgres instance. It is seeded from canonical `data-dev` task/thread state and uses the isolated development pipeline workbook. Secrets for sessions, the outbox worker, and Postgres are distinct from production.

The domain names are routing configuration only. ClawPilot must not inherit Eigen Racing application data, business rules, deployment ports, or project assumptions.

## DNS

The `eigenracing.com` zone is registered and DNS-hosted through Squarespace Domains. Railway custom domains require the exact CNAME and ownership-verification TXT records returned when each hostname is attached to its service.

Do not reuse the production CNAME or verification token for development. Each Railway environment receives its own domain target and verification token.

References:

- https://docs.railway.com/networking/domains/working-with-domains
- https://support.squarespace.com/hc/en-us/articles/360002101888-Edit-your-domain-s-DNS-records

## Validation

For each hostname:

1. Verify the CNAME and TXT records with `dig`.
2. Wait for Railway to report the custom domain as valid.
3. Verify TLS and an unauthenticated redirect to `/login`.
4. Run the authenticated deployed smoke gate.
5. Confirm production reports `main` and development reports `dev` through `/api/runtime` or deployment metadata.

The primary login path emails a short-lived code to the approved `APP_LOGIN_EMAIL`. The emergency operator password is stored in macOS Keychain under service `clawpilot-login` and account `jarrett`:

```bash
security find-generic-password -a jarrett -s clawpilot-login -w
```
