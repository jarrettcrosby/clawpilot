# ClawPilot architecture and workflow diagrams

This is the single Diagram Design replacement for the former LikeC4 viewer.
It is a hand-maintained, source-reviewed map, not a runtime scanner, deployment
manifest, or health check. Read the scope, evidence, and topology cut ledger in
[ClawPilot Diagrams](../../docs/architecture/clawpilot-diagrams.md) before
changing a relationship or status label.

Diagram Design's HTML/SVG grammar is adapted from pinned upstream commit
`f4547ee95f88e5b28a52517feff6b6c11cc657f9` (`2.6.68`); see
[NOTICE.md](NOTICE.md) and [LICENSE.diagram-design](LICENSE.diagram-design).
No upstream executable, plugin, separate gallery runtime, or AI adapter is
installed. The generator has zero tool dependencies and uses Node.js built-ins.

## Source Files

- `catalog.json`: seven view IDs (`index`, `orders`, `accounting`, `email`,
  `meetings`, `access`, `domains`), titles, source references, caveats, and
  October 8, 2026 source-review dates.
- `layouts.mjs`: deterministic SVG geometry and connector/message routing.
- `renderer.mjs`: catalog/source checks, geometry/readability budgets, and HTML/SVG rendering.
- `viewer.html`: self-contained light/dark shell using ClawPilot's palette and local font fallbacks.
- `viewer.js`: offline view and theme selection; no fetch, analytics, storage, or parent messaging.

Geometry validation caps each view at nine nodes and twelve connectors/messages
and checks grid alignment, non-overlapping nodes, safe node/connector margins,
label widths, orthogonal edge routing, node-edge attachment, unrelated-node
crossings, label-mask collisions, and ordered/unobscured sequence messages.
SVG text alternatives describe connections and ordered sequence steps.
Source checks confirm referenced files and literal symbols exist; maintainers
must independently review the behavior and claims.

## Generate and Verify

From the repository root with Node.js 24 (see `.nvmrc`):

```bash
node scripts/build-architecture-viewer.mjs
npm run test:architecture-viewer
npm run verify:docs
```

The normal application build invokes the same generator. It reads only static
checked-in sources, requires no credentials, installs no packages, and makes
no external network calls. A local disk preflight runs before rebuilding. The
source hash permits reuse only when the artifact's integrity hash also matches;
use `node scripts/build-architecture-viewer.mjs --force` for a reviewed forced
regeneration. Do not edit generated files.

Only a self-contained HTML file and integrity manifest are written to ignored
`app_src/server-assets/architecture/`. They are traced as private Next.js server
assets, never copied to `public` or `_next/static`, and never imported into
application JavaScript. Settings → Architecture is available only to the active
configured root app owner outside impersonation, with server checks on both
metadata and viewer requests. The HTML runs in a sandboxed iframe and CSP blocks
network connections and external resources: zero external viewer requests, no
provider credentials, no new service or database.

Update the catalog, geometry, source notes, and owning contract together. The
orders diagram ends at canonical intake/planning handoff, not full fulfillment.
Dated domain/environment labels require separate current operational
verification. Passing local checks does not prove a deployment or provider
write enablement.
