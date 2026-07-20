import type { PoolClient } from 'pg'
import type { ToastMenuCatalogSnapshot } from '@/lib/integrations/toastClient'
import { query, withTransaction } from '@/lib/persistence/postgres'

type TimestampValue = string | Date

type CatalogStatusRow = {
  restaurant_guid: string
  restaurant_name: string
  selected: boolean
  location_active: boolean
  location_archived: boolean
  source_provider: string
  provider_restaurant_id: string
  source_revision: TimestampValue | null
  observed_source_revision: TimestampValue | null
  status: string
  unavailable_reason: string | null
  last_error_code: string | null
  menu_count: number
  group_count: number
  item_count: number
  sales_category_count: number
  last_checked_at: TimestampValue | null
  last_synced_at: TimestampValue | null
}

export type ToastCatalogRefreshTarget = {
  restaurantGuid: string
  restaurantName: string
  timezone: string | null
  sourceRevision: string | null
}

export type ToastCatalogUnavailableReason = 'menus_scope_required' | 'menu_not_published'

function iso(value: TimestampValue | null | undefined) {
  return value ? new Date(value).toISOString() : null
}

function numeric(value: string | number | null | undefined) {
  if (value === null || value === undefined) return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

export async function readToastCatalogRefreshTargetsInPostgres(
  organizationId: string,
): Promise<ToastCatalogRefreshTarget[]> {
  const result = await query<{
    restaurant_guid: string
    restaurant_name: string
    timezone: string | null
    source_revision: TimestampValue | null
  }>(
    `SELECT location.restaurant_guid::text, location.restaurant_name, location.timezone,
       sync.source_revision
     FROM toast_locations location
     LEFT JOIN toast_menu_catalog_sync_status sync
       ON sync.organization_id = location.organization_id
      AND sync.restaurant_guid = location.restaurant_guid
     WHERE location.organization_id = $1::uuid
       AND location.standard_access = true
       AND location.selected = true
       AND location.active = true
       AND location.archived = false
     ORDER BY location.restaurant_name, location.restaurant_guid`,
    [organizationId],
  )
  return result.rows.map((row) => ({
    restaurantGuid: row.restaurant_guid,
    restaurantName: row.restaurant_name,
    timezone: row.timezone,
    sourceRevision: iso(row.source_revision),
  }))
}

export async function readPosCatalogFromPostgres(organizationId: string) {
  const [statusResult, restaurantResult, menuResult, groupResult, itemResult, categoryResult] = await Promise.all([
    query<CatalogStatusRow>(
      `SELECT location.restaurant_guid::text, location.restaurant_name, location.selected,
         location.active AS location_active, location.archived AS location_archived,
         COALESCE(sync.source_provider, 'toast') AS source_provider,
         COALESCE(sync.provider_restaurant_id, location.restaurant_guid::text) AS provider_restaurant_id,
         sync.source_revision, sync.observed_source_revision,
         COALESCE(sync.status, 'never_synced') AS status,
         sync.unavailable_reason, sync.last_error_code,
         COALESCE(sync.menu_count, 0) AS menu_count,
         COALESCE(sync.group_count, 0) AS group_count,
         COALESCE(sync.item_count, 0) AS item_count,
         COALESCE(sync.sales_category_count, 0) AS sales_category_count,
         sync.last_checked_at, sync.last_synced_at
       FROM toast_locations location
       LEFT JOIN toast_menu_catalog_sync_status sync
         ON sync.organization_id = location.organization_id
        AND sync.restaurant_guid = location.restaurant_guid
       WHERE location.organization_id = $1::uuid AND location.standard_access = true
       ORDER BY location.restaurant_name, location.restaurant_guid`,
      [organizationId],
    ),
    query<{
      restaurant_guid: string; source_provider: string; provider_restaurant_id: string
      name: string; timezone: string | null; active: boolean; archived: boolean
      source_revision: TimestampValue; synced_at: TimestampValue
    }>(
      `SELECT restaurant_guid::text, source_provider, provider_restaurant_id, name, timezone,
         active, archived, source_revision, synced_at
       FROM toast_menu_catalog_restaurants
       WHERE organization_id = $1::uuid
       ORDER BY active DESC, name, restaurant_guid`,
      [organizationId],
    ),
    query<{
      restaurant_guid: string; menu_guid: string; source_provider: string; provider_menu_id: string
      name: string; visibility: string[]; active: boolean; archived: boolean; position: number
      source_revision: TimestampValue; synced_at: TimestampValue
    }>(
      `SELECT restaurant_guid::text, menu_guid::text, source_provider, provider_menu_id, name,
         visibility, active, archived, position, source_revision, synced_at
       FROM toast_menu_catalog_menus
       WHERE organization_id = $1::uuid
       ORDER BY restaurant_guid, active DESC, position, name, menu_guid`,
      [organizationId],
    ),
    query<{
      restaurant_guid: string; menu_guid: string; group_guid: string; parent_group_guid: string | null
      source_provider: string; provider_group_id: string; name: string; visibility: string[]
      active: boolean; archived: boolean; position: number; source_revision: TimestampValue
      synced_at: TimestampValue
    }>(
      `SELECT restaurant_guid::text, menu_guid::text, group_guid::text, parent_group_guid::text,
         source_provider, provider_group_id, name, visibility, active, archived, position,
         source_revision, synced_at
       FROM toast_menu_catalog_groups
       WHERE organization_id = $1::uuid
       ORDER BY restaurant_guid, menu_guid, active DESC, parent_group_guid NULLS FIRST, position, name, group_guid`,
      [organizationId],
    ),
    query<{
      restaurant_guid: string; menu_guid: string; group_guid: string; item_guid: string
      source_provider: string; provider_item_id: string; name: string; plu: string | null
      price: string | null; visibility: string[]; sales_category_guid: string | null
      provider_sales_category_id: string | null; active: boolean; archived: boolean; position: number
      source_revision: TimestampValue; synced_at: TimestampValue
    }>(
      `SELECT restaurant_guid::text, menu_guid::text, group_guid::text, item_guid::text,
         source_provider, provider_item_id, name, plu, price::text, visibility,
         sales_category_guid::text, provider_sales_category_id, active, archived, position,
         source_revision, synced_at
       FROM toast_menu_catalog_items
       WHERE organization_id = $1::uuid
       ORDER BY restaurant_guid, menu_guid, group_guid, active DESC, position, name, item_guid`,
      [organizationId],
    ),
    query<{
      restaurant_guid: string; sales_category_guid: string; source_provider: string
      provider_sales_category_id: string; name: string; plu: string | null
      active: boolean; archived: boolean; source_revision: TimestampValue; synced_at: TimestampValue
    }>(
      `SELECT restaurant_guid::text, sales_category_guid::text, source_provider,
         provider_sales_category_id, name, plu, active, archived, source_revision, synced_at
       FROM toast_menu_catalog_sales_categories
       WHERE organization_id = $1::uuid
       ORDER BY restaurant_guid, active DESC, name, sales_category_guid`,
      [organizationId],
    ),
  ])

  const locations = statusResult.rows.map((row) => ({
    restaurantGuid: row.restaurant_guid,
    restaurantName: row.restaurant_name,
    selected: row.selected,
    active: row.location_active,
    archived: row.location_archived,
    sourceProvider: row.source_provider,
    providerRestaurantId: row.provider_restaurant_id,
    sourceRevision: iso(row.source_revision),
    observedSourceRevision: iso(row.observed_source_revision),
    status: row.status,
    unavailableReason: row.unavailable_reason,
    lastErrorCode: row.last_error_code,
    counts: {
      menus: row.menu_count,
      groups: row.group_count,
      items: row.item_count,
      salesCategories: row.sales_category_count,
    },
    lastCheckedAt: iso(row.last_checked_at),
    lastSyncedAt: iso(row.last_synced_at),
  }))
  return {
    organizationId,
    sourceProvider: 'toast' as const,
    sync: {
      hasCatalog: restaurantResult.rows.length > 0,
      locations,
    },
    restaurants: restaurantResult.rows.map((row) => ({
      restaurantGuid: row.restaurant_guid,
      sourceProvider: row.source_provider,
      providerRestaurantId: row.provider_restaurant_id,
      name: row.name,
      timezone: row.timezone,
      active: row.active,
      archived: row.archived,
      sourceRevision: iso(row.source_revision),
      syncedAt: iso(row.synced_at),
    })),
    menus: menuResult.rows.map((row) => ({
      restaurantGuid: row.restaurant_guid,
      menuGuid: row.menu_guid,
      sourceProvider: row.source_provider,
      providerMenuId: row.provider_menu_id,
      name: row.name,
      visibility: row.visibility,
      active: row.active,
      archived: row.archived,
      position: row.position,
      sourceRevision: iso(row.source_revision),
      syncedAt: iso(row.synced_at),
    })),
    groups: groupResult.rows.map((row) => ({
      restaurantGuid: row.restaurant_guid,
      menuGuid: row.menu_guid,
      groupGuid: row.group_guid,
      parentGroupGuid: row.parent_group_guid,
      sourceProvider: row.source_provider,
      providerGroupId: row.provider_group_id,
      name: row.name,
      visibility: row.visibility,
      active: row.active,
      archived: row.archived,
      position: row.position,
      sourceRevision: iso(row.source_revision),
      syncedAt: iso(row.synced_at),
    })),
    items: itemResult.rows.map((row) => ({
      restaurantGuid: row.restaurant_guid,
      menuGuid: row.menu_guid,
      groupGuid: row.group_guid,
      itemGuid: row.item_guid,
      sourceProvider: row.source_provider,
      providerItemId: row.provider_item_id,
      name: row.name,
      plu: row.plu,
      price: numeric(row.price),
      visibility: row.visibility,
      salesCategoryGuid: row.sales_category_guid,
      providerSalesCategoryId: row.provider_sales_category_id,
      active: row.active,
      archived: row.archived,
      position: row.position,
      sourceRevision: iso(row.source_revision),
      syncedAt: iso(row.synced_at),
    })),
    salesCategories: categoryResult.rows.map((row) => ({
      restaurantGuid: row.restaurant_guid,
      salesCategoryGuid: row.sales_category_guid,
      sourceProvider: row.source_provider,
      providerSalesCategoryId: row.provider_sales_category_id,
      name: row.name,
      plu: row.plu,
      active: row.active,
      archived: row.archived,
      sourceRevision: iso(row.source_revision),
      syncedAt: iso(row.synced_at),
    })),
  }
}

async function assertCatalogLocation(
  client: PoolClient,
  organizationId: string,
  restaurantGuid: string,
) {
  const result = await client.query<{
    restaurant_name: string; timezone: string | null; active: boolean; archived: boolean
  }>(
    `SELECT restaurant_name, timezone, active, archived
     FROM toast_locations
     WHERE organization_id = $1::uuid AND restaurant_guid = $2::uuid
       AND standard_access = true
     FOR UPDATE`,
    [organizationId, restaurantGuid],
  )
  if (!result.rows[0]) throw new Error('Toast Standard location is not available for this organization')
  return result.rows[0]
}

async function lockCatalog(client: PoolClient, organizationId: string, restaurantGuid: string) {
  await client.query(
    `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`,
    [`toast-menu-catalog:v1:${organizationId}:${restaurantGuid}`],
  )
}

export async function recordToastMenuCatalogCheckInPostgres(input: {
  organizationId: string
  restaurantGuid: string
  sourceRevision: string
}) {
  return withTransaction(async (client) => {
    await lockCatalog(client, input.organizationId, input.restaurantGuid)
    await assertCatalogLocation(client, input.organizationId, input.restaurantGuid)
    await client.query(
      `INSERT INTO toast_menu_catalog_sync_status (
         organization_id, restaurant_guid, source_provider, provider_restaurant_id,
         source_revision, observed_source_revision, status, last_checked_at, created_at, updated_at
       ) VALUES (
         $1::uuid, $2::uuid, 'toast', $2::uuid::text,
         $3::timestamptz, $3::timestamptz, 'unchanged', now(), now(), now()
       )
       ON CONFLICT (organization_id, restaurant_guid) DO UPDATE SET
         source_revision = CASE
           WHEN toast_menu_catalog_sync_status.source_revision IS NULL THEN EXCLUDED.source_revision
           ELSE GREATEST(toast_menu_catalog_sync_status.source_revision, EXCLUDED.source_revision)
         END,
         observed_source_revision = CASE
           WHEN toast_menu_catalog_sync_status.observed_source_revision IS NULL
             THEN EXCLUDED.observed_source_revision
           ELSE GREATEST(
             toast_menu_catalog_sync_status.observed_source_revision,
             EXCLUDED.observed_source_revision
           )
         END,
         status = 'unchanged', unavailable_reason = NULL, last_error_code = NULL,
         last_checked_at = now(), updated_at = now()`,
      [input.organizationId, input.restaurantGuid, input.sourceRevision],
    )
    return { status: 'unchanged' as const, sourceRevision: input.sourceRevision }
  })
}

export async function recordToastMenuCatalogUnavailableInPostgres(input: {
  organizationId: string
  restaurantGuid: string
  sourceRevision?: string | null
  reason: ToastCatalogUnavailableReason
  errorCode: string
}) {
  return withTransaction(async (client) => {
    await lockCatalog(client, input.organizationId, input.restaurantGuid)
    await assertCatalogLocation(client, input.organizationId, input.restaurantGuid)
    await client.query(
      `INSERT INTO toast_menu_catalog_sync_status (
         organization_id, restaurant_guid, source_provider, provider_restaurant_id,
         observed_source_revision, status, unavailable_reason, last_error_code,
         last_checked_at, created_at, updated_at
       ) VALUES (
         $1::uuid, $2::uuid, 'toast', $2::uuid::text,
         $3::timestamptz, 'unavailable', $4, $5,
         now(), now(), now()
       )
       ON CONFLICT (organization_id, restaurant_guid) DO UPDATE SET
         observed_source_revision = CASE
           WHEN EXCLUDED.observed_source_revision IS NULL
             THEN toast_menu_catalog_sync_status.observed_source_revision
           WHEN toast_menu_catalog_sync_status.observed_source_revision IS NULL
             THEN EXCLUDED.observed_source_revision
           ELSE GREATEST(
             toast_menu_catalog_sync_status.observed_source_revision,
             EXCLUDED.observed_source_revision
           )
         END,
         status = 'unavailable', unavailable_reason = EXCLUDED.unavailable_reason,
         last_error_code = EXCLUDED.last_error_code, last_checked_at = now(), updated_at = now()`,
      [input.organizationId, input.restaurantGuid, input.sourceRevision || null, input.reason, input.errorCode],
    )
    return { status: 'unavailable' as const, reason: input.reason, errorCode: input.errorCode }
  })
}

export async function recordToastMenuCatalogErrorInPostgres(input: {
  organizationId: string
  restaurantGuid: string
  errorCode: string
}) {
  return withTransaction(async (client) => {
    await lockCatalog(client, input.organizationId, input.restaurantGuid)
    await assertCatalogLocation(client, input.organizationId, input.restaurantGuid)
    await client.query(
      `INSERT INTO toast_menu_catalog_sync_status (
         organization_id, restaurant_guid, source_provider, provider_restaurant_id,
         status, last_error_code, last_checked_at, created_at, updated_at
       ) VALUES (
         $1::uuid, $2::uuid, 'toast', $2::uuid::text, 'error', $3, now(), now(), now()
       )
       ON CONFLICT (organization_id, restaurant_guid) DO UPDATE SET
         status = 'error', unavailable_reason = NULL, last_error_code = EXCLUDED.last_error_code,
         last_checked_at = now(), updated_at = now()`,
      [input.organizationId, input.restaurantGuid, input.errorCode],
    )
    return { status: 'error' as const, errorCode: input.errorCode }
  })
}

export async function replaceToastMenuCatalogInPostgres(input: {
  organizationId: string
  restaurantName: string
  catalog: ToastMenuCatalogSnapshot
}) {
  return withTransaction(async (client) => {
    await lockCatalog(client, input.organizationId, input.catalog.restaurantGuid)
    const location = await assertCatalogLocation(client, input.organizationId, input.catalog.restaurantGuid)
    const existing = await client.query<{ source_revision: TimestampValue | null }>(
      `SELECT source_revision FROM toast_menu_catalog_sync_status
       WHERE organization_id = $1::uuid AND restaurant_guid = $2::uuid
       FOR UPDATE`,
      [input.organizationId, input.catalog.restaurantGuid],
    )
    const existingRevision = existing.rows[0]?.source_revision
    if (existingRevision && Date.parse(String(existingRevision)) > Date.parse(input.catalog.sourceRevision)) {
      return { applied: false, status: 'unchanged' as const, sourceRevision: iso(existingRevision) }
    }

    await client.query(
      `INSERT INTO toast_menu_catalog_restaurants (
         organization_id, restaurant_guid, source_provider, provider_restaurant_id, name,
         timezone, active, archived, source_revision, synced_at, created_at, updated_at
       ) VALUES (
         $1::uuid, $2::uuid, 'toast', $3, $4, $5, $6, $7, $8::timestamptz, now(), now(), now()
       )
       ON CONFLICT (organization_id, restaurant_guid) DO UPDATE SET
         source_provider = EXCLUDED.source_provider,
         provider_restaurant_id = EXCLUDED.provider_restaurant_id,
         name = EXCLUDED.name, timezone = EXCLUDED.timezone,
         active = EXCLUDED.active, archived = EXCLUDED.archived,
         source_revision = EXCLUDED.source_revision, synced_at = now(), updated_at = now()`,
      [
        input.organizationId,
        input.catalog.restaurantGuid,
        input.catalog.providerRestaurantId,
        input.restaurantName || location.restaurant_name,
        input.catalog.restaurantTimeZone || location.timezone,
        location.active && !location.archived,
        location.archived,
        input.catalog.sourceRevision,
      ],
    )

    for (const table of [
      'toast_menu_catalog_items',
      'toast_menu_catalog_groups',
      'toast_menu_catalog_menus',
      'toast_menu_catalog_sales_categories',
    ]) {
      await client.query(
        `UPDATE ${table} SET active = false, archived = true,
           source_revision = $3::timestamptz, synced_at = now(), updated_at = now()
         WHERE organization_id = $1::uuid AND restaurant_guid = $2::uuid`,
        [input.organizationId, input.catalog.restaurantGuid, input.catalog.sourceRevision],
      )
    }

    await client.query(
      `INSERT INTO toast_menu_catalog_menus (
         organization_id, restaurant_guid, menu_guid, source_provider, provider_menu_id,
         name, visibility, active, archived, position, source_revision, synced_at, created_at, updated_at
       )
       SELECT $1::uuid, $2::uuid, row."menuGuid"::uuid, 'toast', row."providerMenuId",
         row.name, ARRAY(SELECT jsonb_array_elements_text(COALESCE(row.visibility, '[]'::jsonb))),
         row.active, row.archived, row.position, $3::timestamptz, now(), now(), now()
       FROM jsonb_to_recordset($4::jsonb) AS row(
         "menuGuid" text, "providerMenuId" text, name text, visibility jsonb,
         active boolean, archived boolean, position integer
       )
       ON CONFLICT (organization_id, restaurant_guid, menu_guid) DO UPDATE SET
         source_provider = EXCLUDED.source_provider, provider_menu_id = EXCLUDED.provider_menu_id,
         name = EXCLUDED.name, visibility = EXCLUDED.visibility, active = EXCLUDED.active,
         archived = EXCLUDED.archived, position = EXCLUDED.position,
         source_revision = EXCLUDED.source_revision, synced_at = now(), updated_at = now()`,
      [
        input.organizationId,
        input.catalog.restaurantGuid,
        input.catalog.sourceRevision,
        JSON.stringify(input.catalog.menus),
      ],
    )

    await client.query(
      `INSERT INTO toast_menu_catalog_groups (
         organization_id, restaurant_guid, menu_guid, group_guid, parent_group_guid,
         source_provider, provider_group_id, name, visibility, active, archived, position,
         source_revision, synced_at, created_at, updated_at
       )
       SELECT $1::uuid, $2::uuid, row."menuGuid"::uuid, row."groupGuid"::uuid,
         row."parentGroupGuid"::uuid, 'toast', row."providerGroupId", row.name,
         ARRAY(SELECT jsonb_array_elements_text(COALESCE(row.visibility, '[]'::jsonb))),
         row.active, row.archived, row.position, $3::timestamptz, now(), now(), now()
       FROM jsonb_to_recordset($4::jsonb) AS row(
         "menuGuid" text, "groupGuid" text, "parentGroupGuid" text,
         "providerGroupId" text, name text, visibility jsonb,
         active boolean, archived boolean, position integer
       )
       ON CONFLICT (organization_id, restaurant_guid, menu_guid, group_guid) DO UPDATE SET
         parent_group_guid = EXCLUDED.parent_group_guid, source_provider = EXCLUDED.source_provider,
         provider_group_id = EXCLUDED.provider_group_id, name = EXCLUDED.name,
         visibility = EXCLUDED.visibility, active = EXCLUDED.active, archived = EXCLUDED.archived,
         position = EXCLUDED.position, source_revision = EXCLUDED.source_revision,
         synced_at = now(), updated_at = now()`,
      [
        input.organizationId,
        input.catalog.restaurantGuid,
        input.catalog.sourceRevision,
        JSON.stringify(input.catalog.groups),
      ],
    )

    await client.query(
      `INSERT INTO toast_menu_catalog_sales_categories (
         organization_id, restaurant_guid, sales_category_guid, source_provider,
         provider_sales_category_id, name, plu, active, archived, source_revision,
         synced_at, created_at, updated_at
       )
       SELECT $1::uuid, $2::uuid, row."salesCategoryGuid"::uuid, 'toast',
         row."providerSalesCategoryId", row.name, row.plu, row.active, row.archived,
         $3::timestamptz, now(), now(), now()
       FROM jsonb_to_recordset($4::jsonb) AS row(
         "salesCategoryGuid" text, "providerSalesCategoryId" text, name text, plu text,
         active boolean, archived boolean
       )
       ON CONFLICT (organization_id, restaurant_guid, sales_category_guid) DO UPDATE SET
         source_provider = EXCLUDED.source_provider,
         provider_sales_category_id = EXCLUDED.provider_sales_category_id,
         name = EXCLUDED.name, plu = EXCLUDED.plu, active = EXCLUDED.active,
         archived = EXCLUDED.archived, source_revision = EXCLUDED.source_revision,
         synced_at = now(), updated_at = now()`,
      [
        input.organizationId,
        input.catalog.restaurantGuid,
        input.catalog.sourceRevision,
        JSON.stringify(input.catalog.salesCategories),
      ],
    )

    await client.query(
      `INSERT INTO toast_menu_catalog_items (
         organization_id, restaurant_guid, menu_guid, group_guid, item_guid,
         source_provider, provider_item_id, name, plu, price, visibility,
         sales_category_guid, provider_sales_category_id, active, archived, position,
         source_revision, synced_at, created_at, updated_at
       )
       SELECT $1::uuid, $2::uuid, row."menuGuid"::uuid, row."groupGuid"::uuid,
         row."itemGuid"::uuid, 'toast', row."providerItemId", row.name, row.plu, row.price,
         ARRAY(SELECT jsonb_array_elements_text(COALESCE(row.visibility, '[]'::jsonb))),
         row."salesCategoryGuid"::uuid, row."providerSalesCategoryId",
         row.active, row.archived, row.position, $3::timestamptz, now(), now(), now()
       FROM jsonb_to_recordset($4::jsonb) AS row(
         "menuGuid" text, "groupGuid" text, "itemGuid" text, "providerItemId" text,
         name text, plu text, price numeric, visibility jsonb, "salesCategoryGuid" text,
         "providerSalesCategoryId" text, active boolean, archived boolean, position integer
       )
       ON CONFLICT (organization_id, restaurant_guid, menu_guid, group_guid, item_guid) DO UPDATE SET
         source_provider = EXCLUDED.source_provider, provider_item_id = EXCLUDED.provider_item_id,
         name = EXCLUDED.name, plu = EXCLUDED.plu, price = EXCLUDED.price,
         visibility = EXCLUDED.visibility, sales_category_guid = EXCLUDED.sales_category_guid,
         provider_sales_category_id = EXCLUDED.provider_sales_category_id,
         active = EXCLUDED.active, archived = EXCLUDED.archived, position = EXCLUDED.position,
         source_revision = EXCLUDED.source_revision, synced_at = now(), updated_at = now()`,
      [
        input.organizationId,
        input.catalog.restaurantGuid,
        input.catalog.sourceRevision,
        JSON.stringify(input.catalog.items),
      ],
    )

    await client.query(
      `INSERT INTO toast_menu_catalog_sync_status (
         organization_id, restaurant_guid, source_provider, provider_restaurant_id,
         source_revision, observed_source_revision, status, unavailable_reason, last_error_code,
         menu_count, group_count, item_count, sales_category_count,
         last_checked_at, last_synced_at, created_at, updated_at
       ) VALUES (
         $1::uuid, $2::uuid, 'toast', $3,
         $4::timestamptz, $4::timestamptz, 'ready', NULL, NULL,
         $5, $6, $7, $8, now(), now(), now(), now()
       )
       ON CONFLICT (organization_id, restaurant_guid) DO UPDATE SET
         source_provider = EXCLUDED.source_provider,
         provider_restaurant_id = EXCLUDED.provider_restaurant_id,
         source_revision = EXCLUDED.source_revision,
         observed_source_revision = EXCLUDED.observed_source_revision, status = 'ready',
         unavailable_reason = NULL, last_error_code = NULL,
         menu_count = EXCLUDED.menu_count, group_count = EXCLUDED.group_count,
         item_count = EXCLUDED.item_count, sales_category_count = EXCLUDED.sales_category_count,
         last_checked_at = now(), last_synced_at = now(), updated_at = now()`,
      [
        input.organizationId,
        input.catalog.restaurantGuid,
        input.catalog.providerRestaurantId,
        input.catalog.sourceRevision,
        input.catalog.menus.length,
        input.catalog.groups.length,
        input.catalog.items.length,
        input.catalog.salesCategories.length,
      ],
    )
    return {
      applied: true,
      status: 'ready' as const,
      sourceRevision: input.catalog.sourceRevision,
      counts: {
        menus: input.catalog.menus.length,
        groups: input.catalog.groups.length,
        items: input.catalog.items.length,
        salesCategories: input.catalog.salesCategories.length,
      },
    }
  })
}
