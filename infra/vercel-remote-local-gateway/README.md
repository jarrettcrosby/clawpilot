# ClawPilot remote-local Vercel gateway

This directory is the root of a dedicated Vercel gateway project for
`dev.aiapp.eigenracing.com`. It is intentionally separate from the production
ClawPilot Vercel project so its catch-all external route cannot affect
`aiapp.eigenracing.com`.

The project requires two encrypted Vercel environment variables:

- `CLAWPILOT_REMOTE_LOCAL_ORIGIN`: the exact stable HTTPS origin printed by
  `tailscale funnel`, with no path, query, fragment, or trailing slash;
- `CLAWPILOT_REMOTE_LOCAL_INGRESS_SECRET`: a random base64url value containing
  at least 43 characters. The same value is supplied only to the Mac-side
  ingress manager.

The transform overwrites any caller-supplied ingress header before Vercel
proxies the request. The Mac-side Caddy ingress rejects a request unless that
header has the configured value, then independently requires HTTP Basic
authentication. The Funnel URL therefore cannot bypass the branded gateway by
itself. The route matches only the exact branded host, returns 404 on the
project's other aliases, and disables external-origin caching.

Basic authentication is defense in depth, not ClawPilot's user-session layer.
The Mac-side manager refuses to start unless the independently started app
redirects anonymous users to the exact branded `/login`, returns 401 for a
protected API, and reports the exact approved Postgres database fingerprint.
The expected UUID is supplied locally as
`CLAWPILOT_REMOTE_LOCAL_DATABASE_FINGERPRINT`; it is not a Vercel variable.
The manager never starts the authentication-disabled file fixture from
`scripts/dev-start.sh`.

Do not put either value in Git, a `NEXT_PUBLIC_*` variable, a browser bundle, or
a shell command argument. Domain assignment, environment-variable changes,
deployment, and Funnel enablement are separate infrastructure actions and are
not performed by this directory.
