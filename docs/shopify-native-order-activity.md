---
id: cp-shopify-native-order-activity
title: Shopify Native Order Activity
summary: Provider-native order activity, bounded API coverage, safe text presentation, and append-only sensitive evidence retention.
status: active
kind: reference
area: integrations
tags: [commerce, shopify, orders, history, retention]
app_visible: false
---

# Shopify native order activity

ClawPilot reads Shopify Admin GraphQL `2026-07` `Order.events` in addition to
its existing reconstructed order/fulfillment/refund/return milestones. These
are different evidence sources, not interchangeable claims about the complete
Shopify Admin timeline.

## Available evidence

- `BasicEvent`: actual event ID, action, creation time, formatted message,
  secondary message, and the provider's nullable author label.
- `CommentEvent`: actual event ID, action, creation time and comment text.
  Nested author names are requested only when both the current token grant and
  installation probe include `read_users`; absent names remain unavailable.
- Provider labels are not local user emails, picker assignments, authenticated
  staff identities, or proof that the actor is still employed by the merchant.
  There is no name-to-user matching.

Shopify documents [BasicEvent](https://shopify.dev/docs/api/admin-graphql/latest/objects/BasicEvent)
and [CommentEvent](https://shopify.dev/docs/api/admin-graphql/latest/objects/CommentEvent)
as separate event types. `BasicEvent.author` is a string, not a staff ID.
[StaffMember](https://shopify.dev/docs/api/admin-graphql/latest/objects/StaffMember)
has a separate restricted `read_users` requirement. An AG Alchemy read-only
probe on September 4, 2026 confirmed BasicEvent author text without that scope;
it did not establish CommentEvent author access.

## Bounded coverage

Each order gets a separate optional timeline read, ordered newest first,
with comments included and a sealed upper event-creation time. Cursor pagination
reads at most two pages of 250 events. A nonterminal cursor, malformed/duplicate
event, truncated text, failed page, or unavailable access is reported explicitly
as partial or unavailable. A subsequent ordinary refresh starts at the newest
page again; it does not secretly claim to have resumed beyond the 500-event cap.

`complete` means the API returned no next page within this bounded read. It does
not mean all lifetime events, every native Admin UI entry, or all staff identity
fields were available. The UI also marks a retained timeline display cap as
partial. The [Order API](https://shopify.dev/docs/api/admin-graphql/latest/objects/Order)
documents a default 60-day order-access window unless `read_all_orders` is
granted, and separately documents one-year event retention.

Network attempts, including failed optional pages, are counted. One historical
page now contains one order: token + identity + list + detail + up to two native
pages = at most six reads. An exact read uses at most five. The existing
account/read lease and persistence authority checks still apply. No Shopify
mutation, inventory write, or browser-triggered extra reset is introduced.
Shopify [pagination](https://shopify.dev/docs/api/usage/pagination-graphql) and
[calculated query-cost limits](https://shopify.dev/docs/api/usage/limits) still
apply; throttled optional reads degrade coverage instead of discarding a valid
core order. This change does not use bulk-operation mutations.

## Content and retention

The stable base event uses the actual provider event ID. Mutable message,
action and display-name content is retained in append-only native activity
snapshots under the current authorized order observation. Changed text, including
an A → B → A edit, gets a new snapshot without changing a sealed base event.
The UI selects the latest eligible snapshot for one base event, including the
requested as-of observation boundary. Older-finishing reads cannot replace a
newer capture. Content and display names do not enter permanent identity hashes
or audit payloads.

Native snapshots inherit the base event's exact sensitive-evidence expiry.
Reads hide expired/redacted text immediately; maintenance clears action,
message and display name. Neither a later provider read nor a missing field
rehydrates expired evidence. Absence from a bounded API page is not treated as
proof that a provider deleted a comment.

Provider messages are converted to bounded plain text (8,000 characters), and
display labels to bounded single-line text (255 characters). Text truncation
marks coverage partial. React renders text only: no provider HTML, interactive
links, images, attachments, remote pixels, embeds, or additional arbitrary JSON
is mounted. Shopify's [FormattedString](https://shopify.dev/docs/api/admin-graphql/latest/scalars/FormattedString)
is HTML-containing data, not an instruction to trust it. See Shopify's
[security guidance](https://shopify.dev/docs/apps/build/security/following-security-best-practices)
for tenant isolation, minimization and retention obligations.

## Focused validation

`node scripts/test-shopify-native-activity.mjs` covers bounded pagination,
access/transport failures, controls and HTML safety, optional author attribution,
snapshot comparison, A → B → A edits, stale captures, expiry/redaction, audit
minimization and UI coverage. Existing order-sync foundation tests exercise the
real adapter's native integration and exact attempted-read counts. Database
tests separately enforce migration lineage, immutable snapshots and retention.
