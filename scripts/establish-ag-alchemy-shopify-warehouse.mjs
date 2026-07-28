#!/usr/bin/env node
import crypto from 'node:crypto'
import { createRequire } from 'node:module'

const requireFromApp = createRequire(
  new URL('../app_src/package.json', import.meta.url),
)
const { Pool } = requireFromApp('pg')

export const SCRIPT_VERSION = 'ag-alchemy-shopify-warehouse-v1'
export const EXECUTION_CONFIRMATION =
  'establish-ag-alchemy-shopify-warehouse-v1'
export const TRUSTED_RAILWAY_PROJECT_ID =
  'b5169ebd-8166-4b96-9a81-7cc8adaa9270'
export const TRUSTED_RAILWAY_DEVELOPMENT_ENVIRONMENT_ID =
  'e4abd95f-825c-4242-b37b-825a92597e98'
export const TARGET_ORGANIZATION_NAME = 'AG Alchemy, LLC'
export const TARGET_WAREHOUSE_CODE = 'AG-ALCHEMY-01'
export const SHOPIFY_ADMIN_API_VERSION = '2026-07'

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const SHOP_DOMAIN_PATTERN =
  /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.myshopify\.com$/

const STARTER_LOCATIONS = Object.freeze([
  { code: 'INBOUND', zone: 'INBOUND', type: 'receiving', level: 'zone', storage: 'work_area', sequence: 1, parent: null },
  { code: 'RECEIVE-01', zone: 'INBOUND', type: 'receiving', level: 'dock', storage: 'work_area', sequence: 10, parent: 'INBOUND' },
  { code: 'STAGE-IN-01', zone: 'INBOUND', type: 'staging', level: 'staging', storage: 'staging', sequence: 20, parent: 'INBOUND' },
  { code: 'STORAGE', zone: 'STORAGE', type: 'storage', level: 'zone', storage: 'reserve', sequence: 90, parent: null },
  { code: 'RESERVE-01', zone: 'STORAGE', type: 'storage', level: 'bin', storage: 'reserve', sequence: 100, parent: 'STORAGE' },
  { code: 'FULFILLMENT', zone: 'FULFILLMENT', type: 'pick', level: 'zone', storage: 'work_area', sequence: 190, parent: null },
  { code: 'PICKFACE-01', zone: 'FULFILLMENT', type: 'pick', level: 'bin', storage: 'forward_pick', sequence: 200, parent: 'FULFILLMENT' },
  { code: 'PACK-01', zone: 'FULFILLMENT', type: 'pack', level: 'station', storage: 'work_area', sequence: 300, parent: 'FULFILLMENT' },
  { code: 'OUTBOUND', zone: 'OUTBOUND', type: 'shipping', level: 'zone', storage: 'work_area', sequence: 390, parent: null },
  { code: 'STAGE-OUT-01', zone: 'OUTBOUND', type: 'staging', level: 'staging', storage: 'staging', sequence: 400, parent: 'OUTBOUND' },
  { code: 'SHIP-01', zone: 'OUTBOUND', type: 'shipping', level: 'dock', storage: 'work_area', sequence: 500, parent: 'OUTBOUND' },
  { code: 'RETURNS', zone: 'RETURNS', type: 'returns', level: 'zone', storage: 'work_area', sequence: 590, parent: null },
  { code: 'RETURNS-01', zone: 'RETURNS', type: 'returns', level: 'station', storage: 'work_area', sequence: 600, parent: 'RETURNS' },
])

function fail(message) {
  throw new Error(message)
}

function text(value, label, maximum = 255) {
  const normalized = String(value || '').trim()
  if (!normalized || normalized.length > maximum) {
    fail(`${label} is missing or invalid`)
  }
  return normalized
}

function environmentValue(name) {
  return String(process.env[name] || '').trim()
}

function requireTrustedDevelopmentEnvironment() {
  if (
    environmentValue('RAILWAY_PROJECT_ID') !== TRUSTED_RAILWAY_PROJECT_ID
    || environmentValue('RAILWAY_ENVIRONMENT_ID')
      !== TRUSTED_RAILWAY_DEVELOPMENT_ENVIRONMENT_ID
  ) {
    fail('This command is restricted to the trusted ClawPilot development environment')
  }
}

function encryptionKey() {
  const secret = environmentValue('INTEGRATION_CREDENTIAL_ENCRYPTION_KEY')
    || environmentValue('AGENT_CREDENTIAL_ENCRYPTION_KEY')
  if (secret.length < 32) {
    fail('Commerce credential encryption is not configured')
  }
  return crypto.createHash('sha256').update(secret).digest()
}

function decryptShopifyCredential(row) {
  const aad = Buffer.from(
    `clawpilot:commerce:${row.organization_id}:shopify:${row.environment}:${row.external_account_id}:credential:v1`,
    'utf8',
  )
  try {
    const decipher = crypto.createDecipheriv(
      'aes-256-gcm',
      encryptionKey(),
      row.credential_iv,
    )
    decipher.setAAD(aad)
    decipher.setAuthTag(row.credential_tag)
    const credential = JSON.parse(Buffer.concat([
      decipher.update(row.credential_ciphertext),
      decipher.final(),
    ]).toString('utf8'))
    if (
      credential?.provider !== 'shopify'
      || credential?.authMode !== 'shopify_client_credentials'
    ) {
      fail('AG Alchemy Shopify credential has an unexpected authentication mode')
    }
    return {
      clientId: text(credential.clientId, 'Shopify client ID'),
      clientSecret: text(credential.clientSecret, 'Shopify client secret', 4096),
    }
  } catch (error) {
    if (
      error instanceof Error
      && error.message.startsWith('AG Alchemy Shopify credential')
    ) {
      throw error
    }
    fail('Stored AG Alchemy Shopify credential could not be decrypted')
  }
}

async function fetchJson(url, options, label) {
  const response = await fetch(url, {
    ...options,
    redirect: 'error',
    signal: AbortSignal.timeout(20_000),
  })
  const payload = await response.json().catch(() => null)
  if (!response.ok || !payload) {
    fail(`${label} failed with HTTP ${response.status}`)
  }
  return payload
}

export function canonicalWarehouseOrigin(providerState) {
  const nodes = Array.isArray(providerState?.locations?.nodes)
    ? providerState.locations.nodes
    : []
  const eligible = nodes.filter((location) => (
    location?.isActive === true
    && location?.fulfillsOnlineOrders === true
    && location?.shipsInventory === true
  ))
  if (eligible.length !== 1) {
    fail(
      `AG Alchemy must expose exactly one active Shopify shipping origin; found ${eligible.length}`,
    )
  }
  const location = eligible[0]
  const address = location?.address || {}
  const warehouse = {
    sourceLocationId: text(location.id, 'Shopify location ID'),
    name: text(location.name, 'Shopify location name', 160),
    timezone: text(providerState?.shop?.ianaTimezone, 'Shopify shop timezone', 80),
    address: {
      name: text(location.name, 'Shopify location name', 160),
      line1: text(address.address1, 'Shopify address line 1', 255),
      line2: String(address.address2 || '').trim() || null,
      city: text(address.city, 'Shopify address city', 120),
      region: text(address.provinceCode, 'Shopify address region', 80),
      postalCode: text(address.zip, 'Shopify address postal code', 32),
      country: text(address.countryCode, 'Shopify address country', 2)
        .toUpperCase(),
    },
  }
  try {
    new Intl.DateTimeFormat('en-US', {
      timeZone: warehouse.timezone,
    }).format()
  } catch {
    fail('Shopify returned an invalid IANA timezone')
  }
  return warehouse
}

async function discoverShopifyWarehouse(credentialRow) {
  const credential = decryptShopifyCredential(credentialRow)
  const shopDomain = text(
    credentialRow.configuration?.shopDomain,
    'Shopify store domain',
  ).toLowerCase()
  if (!SHOP_DOMAIN_PATTERN.test(shopDomain)) {
    fail('AG Alchemy Shopify store domain is invalid')
  }
  const grant = await fetchJson(
    `https://${shopDomain}/admin/oauth/access_token`,
    {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: credential.clientId,
        client_secret: credential.clientSecret,
      }),
    },
    'Shopify access-token request',
  )
  const grantedScopes = String(grant.scope || '')
    .split(/[,\s]+/)
    .filter(Boolean)
  if (!grantedScopes.includes('read_locations')) {
    fail('AG Alchemy Shopify connection must grant read_locations')
  }
  const accessToken = text(
    grant.access_token,
    'Shopify access token',
    4096,
  )
  const locations = []
  let shop = null
  let after = null
  for (let page = 0; page < 20; page += 1) {
    const payload = await fetchJson(
      `https://${shopDomain}/admin/api/${SHOPIFY_ADMIN_API_VERSION}/graphql.json`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Shopify-Access-Token': accessToken,
        },
        body: JSON.stringify({
          operationName: 'ClawPilotWarehouseOrigin',
          variables: { after },
          query: `query ClawPilotWarehouseOrigin($after: String) {
            shop { ianaTimezone }
            locations(
              first: 250
              after: $after
              includeInactive: false
            ) {
              nodes {
                id
                name
                isActive
                fulfillsOnlineOrders
                shipsInventory
                address {
                  address1
                  address2
                  city
                  provinceCode
                  zip
                  countryCode
                }
              }
              pageInfo {
                hasNextPage
                endCursor
              }
            }
          }`,
        }),
      },
      'Shopify location discovery',
    )
    if (payload.errors) {
      fail('Shopify location discovery returned a GraphQL error')
    }
    if (!shop) shop = payload.data?.shop || null
    const connection = payload.data?.locations
    if (!connection || !Array.isArray(connection.nodes)) {
      fail('Shopify location discovery returned an invalid connection')
    }
    locations.push(...connection.nodes)
    if (connection.pageInfo?.hasNextPage !== true) {
      return canonicalWarehouseOrigin({
        shop,
        locations: { nodes: locations },
      })
    }
    after = text(
      connection.pageInfo?.endCursor,
      'Shopify location continuation',
      4096,
    )
  }
  fail('Shopify location discovery exceeded the bounded page limit')
}

function sameAddress(left, right) {
  return [
    'name',
    'line1',
    'line2',
    'city',
    'region',
    'postalCode',
    'country',
  ].every((key) => (
    String(left?.[key] || '').trim().toLowerCase()
      === String(right?.[key] || '').trim().toLowerCase()
  ))
}

function sameLegacyAddress(left, right) {
  return [
    'line1',
    'line2',
    'city',
    'region',
    'postalCode',
  ].every((key) => (
    String(left?.[key] || '').trim().toLowerCase()
      === String(right?.[key] || '').trim().toLowerCase()
  )) && (
    String(left?.countryCode || '').trim().toLowerCase()
      === String(right?.country || '').trim().toLowerCase()
  ) && !String(left?.name || '').trim() && !String(left?.country || '').trim()
}

async function loadTarget(client) {
  const organizations = await client.query(
    `SELECT id::text, name, reference_code
     FROM workspace_organizations
     WHERE lower(name) = lower($1)
     ORDER BY id`,
    [TARGET_ORGANIZATION_NAME],
  )
  if (organizations.rowCount !== 1) {
    fail(`Expected exactly one ${TARGET_ORGANIZATION_NAME} organization`)
  }
  const organization = organizations.rows[0]
  if (!UUID_PATTERN.test(organization.id)) {
    fail('AG Alchemy organization identity is invalid')
  }
  const memberships = await client.query(
    `SELECT membership.user_email
     FROM app_user_organization_memberships membership
     WHERE membership.organization_id = $1::uuid
       AND membership.status = 'active'
       AND membership.role IN ('owner', 'admin')
     ORDER BY membership.role = 'owner' DESC, membership.user_email`,
    [organization.id],
  )
  if (memberships.rowCount !== 1) {
    fail('AG Alchemy must have exactly one active owner or admin for provisioning')
  }
  const credentials = await client.query(
    `SELECT
       account.organization_id::text,
       account.environment,
       account.configuration,
       credential.external_account_id,
       credential.credential_ciphertext,
       credential.credential_iv,
       credential.credential_tag
     FROM operations_integration_accounts account
     JOIN operations_commerce_credentials credential
       ON credential.organization_id = account.organization_id
      AND credential.integration_account_id = account.id
     WHERE account.organization_id = $1::uuid
       AND account.integration_type = 'commerce'
       AND account.provider = 'shopify'
       AND credential.verification_status = 'verified'
       AND credential.credential_version
         = account.commerce_credential_generation`,
    [organization.id],
  )
  if (credentials.rowCount !== 1) {
    fail('AG Alchemy must have exactly one verified Shopify connection')
  }
  return {
    organization,
    actorEmail: memberships.rows[0].user_email,
    credential: credentials.rows[0],
  }
}

async function provisionWarehouse(client, target, warehouse, apply) {
  await client.query('BEGIN')
  try {
    await client.query(
      'SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))',
      [`operations:warehouse:${target.organization.id}:${TARGET_WAREHOUSE_CODE}`],
    )
    const existing = await client.query(
      `SELECT id::text, global_id, code, name, facility_type, timezone,
              address, status
       FROM operations_warehouses
       WHERE organization_id = $1::uuid
       ORDER BY created_at, id
       FOR UPDATE`,
      [target.organization.id],
    )
    if (existing.rowCount > 1) {
      fail(`AG Alchemy already has ${existing.rowCount} warehouses; refusing to add another`)
    }
    if (existing.rowCount === 1) {
      const current = existing.rows[0]
      const fixedWarehouseFacts = (
        current.code === TARGET_WAREHOUSE_CODE
        && current.name === warehouse.name
        && current.facility_type === 'distribution_center'
        && current.timezone === warehouse.timezone
        && current.status === 'active'
      )
      const legacyAddress = fixedWarehouseFacts
        && sameLegacyAddress(current.address, warehouse.address)
      if (
        !fixedWarehouseFacts
        || (
          !sameAddress(current.address, warehouse.address)
          && !legacyAddress
        )
      ) {
        fail('The existing AG Alchemy warehouse does not match its sole Shopify shipping origin')
      }
      let addressRepaired = false
      if (legacyAddress && apply) {
        await client.query(
          `UPDATE operations_warehouses
           SET address = $3::jsonb,
               updated_by = $4,
               updated_at = now()
           WHERE organization_id = $1::uuid
             AND id = $2::uuid`,
          [
            target.organization.id,
            current.id,
            JSON.stringify(warehouse.address),
            target.actorEmail,
          ],
        )
        await client.query(
          `INSERT INTO audit_events (
             actor, event_type, aggregate_type, aggregate_id, payload,
             event_key, subject, organization_id, is_system
           ) VALUES (
             $1, 'operations.warehouse.origin_address_repaired',
             'operations.warehouse', $2, $3::jsonb, $4, $5, $6::uuid, false
           )
           ON CONFLICT (event_key) WHERE event_key IS NOT NULL DO NOTHING`,
          [
            target.actorEmail,
            current.global_id,
            JSON.stringify({
              sourceProvider: 'shopify',
              sourceLocationId: warehouse.sourceLocationId,
              addressContract: 'operations-address-v1',
              scriptVersion: SCRIPT_VERSION,
            }),
            `operations:warehouse:${current.global_id}:origin-address-repaired:v1`,
            warehouse.name,
            target.organization.id,
          ],
        )
        addressRepaired = true
      }
      const existingLocations = await client.query(
        `SELECT global_id, code, active
         FROM operations_locations
         WHERE organization_id = $1::uuid
           AND warehouse_id = $2::uuid
         ORDER BY code, id`,
        [target.organization.id, current.id],
      )
      const expectedLocationCodes = new Set(
        STARTER_LOCATIONS.map((location) => location.code),
      )
      if (
        existingLocations.rowCount !== STARTER_LOCATIONS.length
        || existingLocations.rows.some((location) => (
          location.active !== true
          || !expectedLocationCodes.has(location.code)
        ))
      ) {
        fail('The existing AG Alchemy warehouse topology is incomplete or unexpected')
      }
      if (addressRepaired) {
        await client.query('COMMIT')
      } else {
        await client.query('ROLLBACK')
      }
      return {
        applied: addressRepaired,
        addressRepaired,
        addressRepairRequired: legacyAddress && !apply,
        warehouseGlobalId: current.global_id,
        locationGlobalIds: existingLocations.rows.map(
          (location) => location.global_id,
        ),
      }
    }
    if (!apply) {
      await client.query('ROLLBACK')
      return {
        applied: false,
        addressRepaired: false,
        addressRepairRequired: false,
        warehouseGlobalId: null,
        locationGlobalIds: [],
      }
    }
    const created = await client.query(
      `INSERT INTO operations_warehouses (
         organization_id, code, name, facility_type, timezone, address, status,
         operating_days, opens_at, closes_at, standard_processing_minutes,
         created_by, updated_by
       ) VALUES (
         $1::uuid, $2, $3, 'distribution_center', $4, $5::jsonb, 'active',
         ARRAY[1,2,3,4,5]::smallint[], '08:00'::time, '17:00'::time, 120,
         $6, $6
       )
       RETURNING id::text, global_id`,
      [
        target.organization.id,
        TARGET_WAREHOUSE_CODE,
        warehouse.name,
        warehouse.timezone,
        JSON.stringify(warehouse.address),
        target.actorEmail,
      ],
    )
    const warehouseRow = created.rows[0]
    const locationIdsByCode = new Map()
    const locationGlobalIds = []
    for (const location of STARTER_LOCATIONS) {
      const inserted = await client.query(
        `INSERT INTO operations_locations (
           organization_id, warehouse_id, code, zone, location_type,
           topology_level, parent_location_id, pick_sequence, active,
           storage_function, created_by, updated_by
         ) VALUES (
           $1::uuid, $2::uuid, $3, $4, $5, $6, $7::uuid, $8, true, $9, $10, $10
         )
         RETURNING id::text, global_id`,
        [
          target.organization.id,
          warehouseRow.id,
          location.code,
          location.zone,
          location.type,
          location.level,
          location.parent ? locationIdsByCode.get(location.parent) : null,
          location.sequence,
          location.storage,
          target.actorEmail,
        ],
      )
      locationIdsByCode.set(location.code, inserted.rows[0].id)
      locationGlobalIds.push(inserted.rows[0].global_id)
    }
    await client.query(
      `INSERT INTO audit_events (
         actor, event_type, aggregate_type, aggregate_id, payload, event_key,
         subject, organization_id, is_system
       ) VALUES (
         $1, 'operations.warehouse.created', 'operations.warehouse', $2,
         $3::jsonb, $4, $5, $6::uuid, false
       )
       ON CONFLICT (event_key) WHERE event_key IS NOT NULL DO NOTHING`,
      [
        target.actorEmail,
        warehouseRow.global_id,
        JSON.stringify({
          code: TARGET_WAREHOUSE_CODE,
          facilityType: 'distribution_center',
          timezone: warehouse.timezone,
          starterLocationCount: locationGlobalIds.length,
          sourceProvider: 'shopify',
          sourceLocationId: warehouse.sourceLocationId,
          sourceScope: 'read_locations',
          scriptVersion: SCRIPT_VERSION,
        }),
        `operations:warehouse:${warehouseRow.global_id}:created`,
        warehouse.name,
        target.organization.id,
      ],
    )
    await client.query('COMMIT')
    return {
      applied: true,
      addressRepaired: false,
      addressRepairRequired: false,
      warehouseGlobalId: warehouseRow.global_id,
      locationGlobalIds,
    }
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  }
}

export async function run({
  apply = false,
  pool = null,
} = {}) {
  requireTrustedDevelopmentEnvironment()
  const databaseUrl = environmentValue('DATABASE_URL')
  if (!databaseUrl) fail('DATABASE_URL is required')
  const normalizedDatabaseUrl = new URL(databaseUrl)
  normalizedDatabaseUrl.searchParams.delete('sslmode')
  const ownedPool = pool || new Pool({
    connectionString: normalizedDatabaseUrl.toString(),
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 10_000,
    query_timeout: 20_000,
  })
  const client = await ownedPool.connect()
  try {
    const target = await loadTarget(client)
    const warehouse = await discoverShopifyWarehouse(target.credential)
    const result = await provisionWarehouse(client, target, warehouse, apply)
    return {
      ok: true,
      scriptVersion: SCRIPT_VERSION,
      mode: apply ? 'apply' : 'plan',
      organization: {
        name: target.organization.name,
        referenceCode: target.organization.reference_code,
      },
      warehouse: {
        code: TARGET_WAREHOUSE_CODE,
        name: warehouse.name,
        timezone: warehouse.timezone,
        address: warehouse.address,
        sourceProvider: 'shopify',
        sourceLocationId: warehouse.sourceLocationId,
        globalId: result.warehouseGlobalId,
        applied: result.applied,
        addressRepaired: result.addressRepaired,
        addressRepairRequired: result.addressRepairRequired,
        starterLocationCount: result.locationGlobalIds.length,
      },
    }
  } finally {
    client.release()
    if (!pool) await ownedPool.end()
  }
}

function selfTest() {
  const result = canonicalWarehouseOrigin({
    shop: { ianaTimezone: 'America/Chicago' },
    locations: {
      nodes: [{
        id: 'gid://shopify/Location/35568222286',
        name: 'Ag-Alchemy',
        isActive: true,
        fulfillsOnlineOrders: true,
        shipsInventory: true,
        address: {
          address1: '7009 S 108th St',
          address2: '',
          city: 'La Vista',
          provinceCode: 'NE',
          zip: '68128',
          countryCode: 'US',
        },
      }],
    },
  })
  if (
    result.name !== 'Ag-Alchemy'
    || result.timezone !== 'America/Chicago'
    || result.address.postalCode !== '68128'
    || result.address.name !== 'Ag-Alchemy'
    || result.address.country !== 'US'
  ) {
    fail('Warehouse origin self-test failed')
  }
  let rejected = false
  try {
    canonicalWarehouseOrigin({
      shop: { ianaTimezone: 'America/Chicago' },
      locations: {
        nodes: [
          { ...result, isActive: true, fulfillsOnlineOrders: true, shipsInventory: true },
          { ...result, id: 'other', isActive: true, fulfillsOnlineOrders: true, shipsInventory: true },
        ],
      },
    })
  } catch {
    rejected = true
  }
  if (!rejected) fail('Multiple shipping origins must be rejected')
  return { ok: true, scriptVersion: SCRIPT_VERSION }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const selfTestOnly = process.argv.includes('--self-test')
  if (selfTestOnly) {
    console.log(JSON.stringify(selfTest(), null, 2))
  } else {
    const apply = process.argv.includes('--apply')
    if (apply) {
      const confirmation = process.argv.find((value) => (
        value.startsWith('--confirm=')
      ))?.slice('--confirm='.length)
      if (confirmation !== EXECUTION_CONFIRMATION) {
        fail(`Apply requires --confirm=${EXECUTION_CONFIRMATION}`)
      }
    }
    const result = await run({ apply })
    console.log(JSON.stringify(result, null, 2))
  }
}
