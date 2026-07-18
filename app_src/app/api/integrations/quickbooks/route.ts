import { NextRequest, NextResponse } from 'next/server'
import {
  bindSelectedQuickBooksConnection,
  configureQuickBooksCatalogSync,
  disconnectQuickBooksConnection,
  getQuickBooksIntegrationState,
  importQuickBooksProducts,
  queueQuickBooksCatalogSync,
  sanitizeQuickBooksIntegrationError,
  saveQuickBooksAccountMappings,
  QuickBooksIntegrationRequestError,
} from '@/lib/integrations/quickBooksIntegrations'
import { isPostgresStorageEnabled } from '@/lib/persistence/config'
import { QUICKBOOKS_MAPPING_KEYS, type QuickBooksMappingKey } from '@/lib/persistence/quickBooksIntegrations'
import { requireRequestUser } from '@/lib/requestUser'
import { PIPELINE_SELECTION_COOKIE, requireResourceEditor, resolvePipelineSpaceAccess } from '@/lib/tenancy'
import { effectiveAuthorizationRole, effectiveUserPermissions, type AppUser } from '@/lib/users'

export const dynamic = 'force-dynamic'
export const revalidate = 0
export const runtime = 'nodejs'

const MAX_REQUEST_BYTES = 64 * 1024

function json(payload: Record<string, unknown>, status = 200) {
  return NextResponse.json(payload, { status, headers: { 'Cache-Control': 'no-store' } })
}

function errorResponse(error: unknown) {
  if (error instanceof Error && error.message === 'Unauthorized') {
    return json({ ok: false, error: 'Unauthorized', code: 'UNAUTHORIZED' }, 401)
  }
  const sanitized = sanitizeQuickBooksIntegrationError(error)
  return json({ ok: false, error: sanitized.message, code: sanitized.code }, sanitized.status)
}

function requirePostgres() {
  if (!isPostgresStorageEnabled()) {
    throw new QuickBooksIntegrationRequestError('QuickBooks integrations require Postgres storage', 503, 'QUICKBOOKS_POSTGRES_REQUIRED')
  }
}

function organizationId(actor: AppUser) {
  if (!actor.organizationId) {
    throw new QuickBooksIntegrationRequestError('Your active organization is not configured', 409, 'QUICKBOOKS_ORGANIZATION_REQUIRED')
  }
  return actor.organizationId
}

function requireManager(actor: AppUser) {
  const role = effectiveAuthorizationRole(actor)
  const permissions = effectiveUserPermissions(actor)
  if (role !== 'owner' && (role !== 'admin' || !permissions.manageUserAccess)) {
    throw new QuickBooksIntegrationRequestError(
      'Only an organization owner or access administrator can manage QuickBooks',
      403,
      'QUICKBOOKS_MANAGER_REQUIRED',
    )
  }
}

async function requestBody(req: NextRequest) {
  const raw = await req.text()
  if (Buffer.byteLength(raw, 'utf8') > MAX_REQUEST_BYTES) {
    throw new QuickBooksIntegrationRequestError('QuickBooks request is too large', 413, 'QUICKBOOKS_REQUEST_TOO_LARGE')
  }
  try {
    const value = JSON.parse(raw)
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('not an object')
    return value as Record<string, unknown>
  } catch {
    throw new QuickBooksIntegrationRequestError('Request body must be valid JSON')
  }
}

function only(body: Record<string, unknown>, fields: string[]) {
  const unsupported = Object.keys(body).find((field) => !fields.includes(field))
  if (unsupported) throw new QuickBooksIntegrationRequestError(`Unsupported QuickBooks action field: ${unsupported}`)
}

async function selectedPipeline(req: NextRequest, actor: AppUser) {
  const selected = req.cookies.get(PIPELINE_SELECTION_COOKIE)?.value
  const pipeline = selected
    ? await resolvePipelineSpaceAccess({ actorEmail: actor, pipelineId: selected })
    : await resolvePipelineSpaceAccess({ actorEmail: actor })
  requireResourceEditor(pipeline)
  if (pipeline.workspaceOrganizationId !== actor.organizationId) {
    throw new QuickBooksIntegrationRequestError('The selected pipeline does not belong to the active organization', 409, 'QUICKBOOKS_PIPELINE_SCOPE_INVALID')
  }
  return pipeline
}

export async function GET(req: NextRequest) {
  try {
    const actor = await requireRequestUser(req)
    requirePostgres()
    requireManager(actor)
    return json({ ok: true, integration: await getQuickBooksIntegrationState(organizationId(actor)) })
  } catch (error) {
    return errorResponse(error)
  }
}

export async function PATCH(req: NextRequest) {
  try {
    const actor = await requireRequestUser(req)
    requirePostgres()
    requireManager(actor)
    const organization = organizationId(actor)
    const body = await requestBody(req)
    const action = String(body.action || '').trim()
    if (action === 'bind-selected-connection') {
      only(body, ['action'])
      return json({ ok: true, integration: await bindSelectedQuickBooksConnection({ organizationId: organization, actorEmail: actor.email }) })
    }
    if (action === 'refresh-catalog') {
      only(body, ['action'])
      return json({ ok: true, integration: await queueQuickBooksCatalogSync({ organizationId: organization, actorEmail: actor.email }) })
    }
    if (action === 'configure-sync') {
      only(body, ['action', 'enabled'])
      return json({
        ok: true,
        integration: await configureQuickBooksCatalogSync({ organizationId: organization, enabled: body.enabled === true, actorEmail: actor.email }),
      })
    }
    if (action === 'save-mappings') {
      only(body, ['action', 'restaurantGuid', 'mappings'])
      const rawMappings = body.mappings && typeof body.mappings === 'object' && !Array.isArray(body.mappings)
        ? body.mappings as Record<string, unknown>
        : {}
      const unsupportedMapping = Object.keys(rawMappings).find((key) => !QUICKBOOKS_MAPPING_KEYS.includes(key as QuickBooksMappingKey))
      if (unsupportedMapping) throw new QuickBooksIntegrationRequestError(`Unsupported QuickBooks mapping: ${unsupportedMapping}`)
      const restaurantGuid = String(body.restaurantGuid || '').trim()
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(restaurantGuid)) {
        throw new QuickBooksIntegrationRequestError('A valid Toast restaurant is required')
      }
      const mappings: Partial<Record<QuickBooksMappingKey, string | null>> = {}
      for (const key of QUICKBOOKS_MAPPING_KEYS) {
        if (key in rawMappings) mappings[key] = String(rawMappings[key] || '').trim() || null
      }
      return json({
        ok: true,
        integration: await saveQuickBooksAccountMappings({
          organizationId: organization,
          restaurantGuid,
          mappings,
          actorEmail: actor.email,
        }),
      })
    }
    if (action === 'import-products') {
      only(body, ['action', 'itemIds'])
      const pipeline = await selectedPipeline(req, actor)
      const imported = await importQuickBooksProducts({
        organizationId: organization,
        pipelineId: pipeline.id,
        itemIds: body.itemIds,
        actorEmail: actor.email,
      })
      return json({ ok: true, imported, integration: await getQuickBooksIntegrationState(organization) })
    }
    if (action === 'disconnect') {
      only(body, ['action'])
      return json({ ok: true, integration: await disconnectQuickBooksConnection({ organizationId: organization, actorEmail: actor.email }) })
    }
    throw new QuickBooksIntegrationRequestError('Unsupported QuickBooks action')
  } catch (error) {
    return errorResponse(error)
  }
}
