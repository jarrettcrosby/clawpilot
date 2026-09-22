---
id: cp-architecture-likec4
title: ClawPilot Architecture Model
summary: Local-only LikeC4 views of current production, suspended development, provider data flows, and pending BPO domains.
status: active
kind: architecture
area: architecture
tags: [clawpilot, likec4, architecture, railway, data-flow]
app_visible: false
---

# ClawPilot Architecture Model

The [LikeC4 model](../../tools/architecture/model.c4) is a hand-reviewed map,
not an automated inventory or deployment manifest. Its static viewer is built
locally from the separate [tool package](../../tools/architecture/README.md).
Generated `dist/` files and dependencies are ignored; no architecture service
or public site is deployed.

The model has four views: system context; production runtime and durable data;
commerce, POS, CRM, and accounting connections; and current domain/environment
state. The domain view labels the additional BPO Railway hostnames as registered
but awaiting DNS/TLS acceptance, the BPO website short-link route as planned,
and Railway development as suspended. A diagram edge is a documented
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
