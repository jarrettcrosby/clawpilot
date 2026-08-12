---
id: cp-module-shipping
title: Shipping
summary: Standalone shipment creation, shipment records, and pickup readiness separated into Parcel and LTL workflows.
status: active
kind: module-contract
area: shipping
tags: [clawpilot, shipping, parcel, ltl, pickup, freight-class]
app_visible: true
---

# Shipping

## Purpose

Shipping is the operator-facing module for creating shipment plans, reviewing
shipment records, and scheduling pickups. Operations remains the durable order,
inventory, fulfillment, authorization, and audit authority.

The module deliberately keeps **Parcel** and **LTL** separate:

- Parcel uses loose cartons and poly bags. The current executable one-off flow
  compares direct UPS and FedEx rates, creates a planned Operations order, and
  defers postage purchase to the audited whole-shipment execution step.
- LTL assumes cartons are palletized into outbound handling units. The current
  surface prepares advisory density-class evidence only. Worldwide Express and
  R+L rating, bill of lading/tender, and pickup orchestration are not connected
  to Create Shipment yet.

## Submodules

- **Create Shipment** presents separate Parcel and LTL buttons before shipment
  facts are entered.
- **Shipments** shows planned one-off records separately from carrier-confirmed
  Parcel shipments and successful LTL tender evidence.
- **Schedule Pickups** preserves separate Parcel and LTL readiness boundaries.
  It remains disabled until a pickup can be bound to the exact packed shipment,
  selected offer, pallet plan, credential revision, and carrier authority.

## Authorization

- Shipment records require Operations view access.
- Parcel planning and LTL classification evidence require Operations management
  plus warehouse execution access.
- LIVE carrier execution additionally requires Operations activation authority
  and the exact server-resolved provider capability.

Button state is never carrier authority. Every current and future mutation must
remain organization-fenced, idempotent, and durably prepared before provider I/O.
