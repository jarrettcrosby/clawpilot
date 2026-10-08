---
id: cp-architecture-diagrams
title: ClawPilot Architecture and Workflow Diagrams
summary: Private root-owner Diagram Design views of source-reviewed platform boundaries and workflows, with explicit simplifications and no live-status claims.
status: active
kind: architecture
area: architecture
tags: [clawpilot, diagram-design, architecture, workflows, source-evidence]
app_visible: false
---

# ClawPilot Architecture and Workflow Diagrams

Settings → Architecture contains seven hand-reviewed static diagrams. The
viewer is restricted to the active configured root app owner outside
impersonation; organization-owner or administrator roles do not grant access.
Metadata and HTML requests independently enforce this boundary before reading
the private artifact. This is source-reviewed documentation, not a deployment
inventory, live health check, or proof that a provider-write path is enabled.

The content was reviewed against repository source on October 8, 2026. Dates
inside a view describe its evidence, not the current state of a host, service,
DNS record, or external account. The domains view retains September 21, 2026
contract observations; it does not refresh those observations automatically.
No deployment or current-host verification is claimed by this documentation.

## Views and Scope

| View | Purpose | Boundary |
| --- | --- | --- |
| `index` — ClawPilot platform | App, durable data, operator tables, projections, and provider ownership | A deliberately compact context map, not every service or dependency. |
| `orders` — Commerce order intake | Provider evidence, staging, resolution, blockers, and canonical promotion | Intake only, ending at the imported-order planning handoff; not a full warehouse-fulfillment diagram. |
| `accounting` — Toast to QuickBooks | Read-only source evidence, mappings, draft readiness, approved posting, and external acknowledgment | Preparation does not post; write enablement and exact external-document parity are separate gates. |
| `email` — CRM email lifecycle | Reviewed sender identity, selected-mailbox polling, durable CRM associations, and projections | Authentication notices are excluded; ambiguous associations remain unlinked. |
| `meetings` — Meetings and Calendar | Canonical meetings, reviewed Calendar identity, delivery, and reconciliation | An unsent local meeting is not a delivered invitation; reverse sync does not infer cancellation from an inaccessible event. |
| `access` — Workspace and module access | Membership, scoped permissions, shell visibility, and server checks | Hidden navigation is not authorization; architecture has a stricter root-owner boundary. |
| `domains` — Domains and retained environments | Documented origin, cookie, callback, and retained-development boundaries | Dated contracts, not live DNS, TLS, login, deployment, or activation verification. |

The orders view does not replace the [Distributed Operations contract](../modules/distributed-operations.md)
or its [delivery plan](distributed-operations-delivery-plan.md). Warehouse
release, picking, packing, label evidence, shipment confirmation, and provider
fulfillment export remain separate implementation gates. Local shipment is not
provider acknowledgment, and universal live carrier-dispatch success
materialization still has an explicit implementation gap. The accounting view
likewise does not establish a verified bank deposit from calculated settlement.

## Renderer, Artifacts, and Isolation

The single active renderer adapts Diagram Design's editorial HTML structure,
SVG primitives, and connector grammar from upstream commit
`f4547ee95f88e5b28a52517feff6b6c11cc657f9`, version `2.6.68`. See the
[provenance notice](../../tools/architecture/NOTICE.md) and retained
[license](../../tools/architecture/LICENSE.diagram-design). LikeC4 is
superseded, not a second active engine; its [old note](clawpilot-likec4.md)
remains only to preserve historical links.

The [offline generator](../../scripts/build-architecture-viewer.mjs) uses
Node.js built-ins and checked-in source under
[tools/architecture](../../tools/architecture/README.md). It installs no tool
dependencies, starts no service or AI runtime, and needs no provider
credentials. It reads static repository files, not application environment
files, customer data, or external accounts. Generated HTML and its integrity
manifest stay in ignored `app_src/server-assets/architecture/`, outside
`public` and `_next/static`; Next.js traces them as private server assets.

The same-origin authenticated routes return private/no-store responses. HTML
runs on demand in a sandboxed iframe with scripts allowed but no same-origin
privilege. CSP blocks network connections, workers, forms, external scripts,
and external fonts/resources. The rendered viewer makes zero external network
requests and has no analytics, provider calls, credential adapters, or browser
storage. Source and HTML hashes detect stale or changed artifacts; hashes do
not certify deployment status or semantic correctness.

## Readability and Source Verification

[catalog.json](../../tools/architecture/catalog.json) owns titles, scope notes,
review dates, and source file/symbol references.
[layouts.mjs](../../tools/architecture/layouts.mjs) owns explicit geometry.
[renderer.mjs](../../tools/architecture/renderer.mjs) validates and renders
them with the checked-in HTML and JavaScript shell.

Validation limits each view to nine nodes and twelve connectors/messages. It
checks a four-pixel node grid, non-overlapping nodes, safe canvas and connector
margins, label-width budgets, orthogonal connectors, node-edge attachment,
unrelated-node crossings, label-mask collisions, ordered and unobscured sequence
messages, and matching catalog/layout identities. Each SVG includes a textual
description of its connections and ordered sequence steps. Source verification
checks that referenced repository files and literal symbols exist; this is not
a substitute for reviewing what those functions actually do. Browser checks
must also verify light/dark readability, view selection, compact-screen
behavior, and the private access boundary.

Update content, geometry, caveats, review dates, and the owning contract
together. Run `npm run test:architecture-viewer` and `npm run verify:docs` from
the repository root before completing a change. The viewer gate builds the
artifact and runs the architecture contract and UI checks; a successful local
gate alone does not prove deployment or provider health.

## Topology Cut Ledger

The replacement deliberately reduces the former LikeC4 topology. These cuts
are editorial simplifications, not evidence that a system was deleted or an
integration was enabled.

| Former detail | Replacement treatment | What must not be inferred |
| --- | --- | --- |
| Separate fulfillment optimizer | Omitted from the compact platform overview | Removal, decommissioning, or completed optimization. |
| Separate MariaDB node | Grouped into the SuiteCRM projection node, which identifies its separate store | That CRM projections are app-owned Postgres records or share its database. |
| Individual provider groups | Collapsed into Commerce + POS and Google account groups, with workflow-specific detail in other views | That provider credentials, authority, delivery, or write policies are interchangeable. |
| Full commerce/warehouse lifecycle | Orders view covers intake and canonical promotion only | Completed picking, packing, live postage purchase, shipment, or provider fulfillment acknowledgment. |

## Owning Evidence and Contracts

Use each view's source references for implementation detail and these contracts
for maintained authority boundaries:

- [Platform and Data Map](../maps/platform-data-map.md)
- [Application Shell and Access](../modules/application-shell-and-access.md)
- [CRM and Workbook Reporting](../modules/crm-and-reporting.md)
- [User Integrations and Credentials](../modules/user-integrations.md)
- [Toast POS and Accounting](../modules/toast-and-accounting.md)
- [QuickBooks Accounting Connector](../modules/quickbooks-accounting.md)
- [Infrastructure and Cost Control Register](../operations/infrastructure-and-cost-control-register.md)
- [BPO Public Domains](../operations/bpo-public-domains.md)
- [Environment and release contract](../operations/clawpilot-environments.md)

Check current authorized operational evidence before treating a dated topology
label as current. Diagrams do not authorize production mutations or expose
secrets, customer records, runtime logs, or credential material.
