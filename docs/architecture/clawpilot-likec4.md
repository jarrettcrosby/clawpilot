---
id: cp-architecture-likec4
title: ClawPilot Architecture Model
summary: Private platform-owner LikeC4 views of production, suspended development, provider data flows, verified BPO app hosts, and the staged short-link bridge.
status: active
kind: architecture
area: architecture
tags: [clawpilot, likec4, architecture, railway, data-flow]
app_visible: false
---

# ClawPilot Architecture Model

The [LikeC4 model](../../tools/architecture/model.c4) is a hand-reviewed map,
not an automated inventory or deployment manifest. Its static viewer is built
from the separate [tool package](../../tools/architecture/README.md) during the
application build. Settings → Architecture loads the real LikeC4 views on
demand, only for the configured platform owner outside impersonation; ordinary
organization owners/admins do not receive the global topology. Both metadata
and HTML are independently authenticated, private/no-store responses. The
single-file artifact stays outside `public` and `_next/static`, runs in a
sandboxed iframe with network connections blocked, and needs no separate
service or AI runtime. Generated artifacts and tool dependencies remain ignored.

The model has four views: system context; production runtime and durable data;
commerce, POS, CRM, and accounting connections; and current domain/environment
state. The September 21, 2026 domain view reflects verified DNS/TLS for both
BPO app hostnames and a real production magic-code login without an Eigen
redirect. The BPO website short-link bridge is staged and protected, not yet
promoted to its public domain; production end-to-end acceptance and activation
remain open. Google browser sign-in requires separate acceptance. Railway
development is retained but suspended, not a live login path. A diagram edge is a documented
integration boundary, not proof that every provider action is currently enabled.

Sources for the relationships and authority boundaries:

- [Platform and Data Map](../maps/platform-data-map.md)
- [CRM and Workbook Reporting](../modules/crm-and-reporting.md)
- [User Integrations and Credentials](../modules/user-integrations.md)
- [Toast POS and Accounting](../modules/toast-and-accounting.md)
- [QuickBooks Accounting Connector](../modules/quickbooks-accounting.md)
- [Infrastructure and Cost Control Register](../operations/infrastructure-and-cost-control-register.md)
- [BPO Public Domains](../operations/bpo-public-domains.md)

Review the [environment contract](../operations/clawpilot-environments.md) and
live provider status before treating a dated diagram label as current. Update
the model, this note, and the underlying contract together when topology
changes. Do not infer secrets, customer data, active deployment state, or
provider-write authorization from the diagram.
