# ClawPilot fulfillment optimizer

This isolated Python service supplies Google OR-Tools CP-SAT implementations
behind ClawPilot's transport-neutral optimizer boundary. It has no database,
provider credential, browser session, or write authority.

The service exposes two authenticated, bounded operations:

- `POST /v1/optimize` performs exact integer unit allocation, inventory
  selection, three-dimensional carton placement with allowed rotations, and
  lexicographic warehouse/carton/cost/waste selection.
- `POST /v1/assortments/optimize` selects a bounded packaging-material
  assortment from operator-supplied historical demand frequencies and
  precomputed feasible landed costs.

Both requests carry immutable schema-version-1 input plus its canonical SHA-256
hash. Both results echo that hash. The service never calls a carrier, infers a
carton, invents inventory, or reads current runtime state.

## Required runtime configuration

- `CLAWPILOT_FULFILLMENT_OPTIMIZER_SECRET`: a random bearer secret of at least
  32 UTF-8 bytes.
- `PORT`: optional HTTP port; defaults to `8080`.
- `TRUSTED_PROXY_IPS`: optional Uvicorn proxy allowlist; defaults to
  `127.0.0.1`.

The health endpoint returns `503` until the secret is configured. The ClawPilot
application adapter additionally requires:

- `CLAWPILOT_FULFILLMENT_OPTIMIZER_ENABLED=1`;
- `CLAWPILOT_FULFILLMENT_OPTIMIZER_URL`, using HTTPS or the exact Railway
  private endpoint `http://fulfillment-optimizer.railway.internal` with an
  optional valid port such as `:8080`;
- the same `CLAWPILOT_FULFILLMENT_OPTIMIZER_SECRET`; and
- an optional `CLAWPILOT_FULFILLMENT_OPTIMIZER_TIMEOUT_MS` from 100 through
  30,000 milliseconds.

Other HTTP hosts, private HTTPS hosts, URL userinfo, query strings, fragments,
and invalid ports fail closed. ClawPilot `/api/health` reports whether this
configuration is disabled, ready, or invalid without making an optimizer
network call. An enabled but invalid configuration makes application health
fail, and a disabled optimizer makes Railway application health fail so an
environment cannot silently lose the capability. `connectivity: not-probed`
is intentional; verify the optimizer's own health endpoint separately after
each environment deployment.

## Bounded model

The v1 per-order solver caps expanded units, warehouses, positions, carton
types, carton slots, assignment variables, pairwise 3D disjunctions, request
bytes, response bytes, wall-clock deadline, and returned candidates. Oversized
orders fail closed for partitioning or manual review.

The assortment solver caps materials, demand samples, and supplied feasible
landed-cost edges. Hard coverage is the default policy. A lower coverage
threshold must be explicit in the immutable policy.

## Local verification

```bash
python3.13 -m venv .venv
.venv/bin/pip install -r requirements-test.txt
CLAWPILOT_FULFILLMENT_OPTIMIZER_SECRET=0123456789abcdef0123456789abcdef \
  .venv/bin/python -m unittest discover -s tests -v
```

The Docker image pins the Python base-image digest and all Python dependencies.
OR-Tools is pinned to `9.15.6755`.
