import type { PoolClient } from 'pg'
import { recordAuditEvent } from '@/lib/auditWriter'
import type {
  OperationsPrinterInput,
  OperationsPrinterProfile,
  OperationsPrinterWorkspace,
} from '@/lib/operations/printing'
import { OperationsRequestError } from '@/lib/persistence/operations'
import {
  acquireTransactionAdvisoryLock,
  query,
  withTransaction,
} from '@/lib/persistence/postgres'

type PrinterRow = {
  id: string
  global_id: string
  warehouse_id: string
  warehouse_global_id: string
  warehouse_name: string
  code: string
  name: string
  station_type: OperationsPrinterProfile['stationType']
  printer_type: OperationsPrinterProfile['printerType']
  connection_mode: OperationsPrinterProfile['connectionMode']
  supported_formats: OperationsPrinterProfile['supportedFormats']
  supported_media: OperationsPrinterProfile['supportedMedia']
  supported_document_types: OperationsPrinterProfile['supportedDocumentTypes']
  default_document_types: OperationsPrinterProfile['defaultDocumentTypes']
  fallback_printer_global_id: string | null
  fallback_printer_name: string | null
  local_print_agent_global_id: string | null
  local_print_agent_name: string | null
  local_print_agent_status: OperationsPrinterProfile['localPrintAgentStatus']
  local_print_agent_last_seen_at: string | null
  priority: number
  status: OperationsPrinterProfile['status']
  row_version: number
  last_seen_at: string | null
  updated_at: string
}

type WarehouseRow = {
  id: string
  global_id: string
  name: string
}

const ORGANIZATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function requireOrganizationId(value: string) {
  const organizationId = String(value || '').trim()
  if (!ORGANIZATION_ID.test(organizationId)) {
    throw new OperationsRequestError(
      'OPERATIONS_ORGANIZATION_INVALID',
      'The active organization is invalid',
    )
  }
  return organizationId
}

function profile(row: PrinterRow): OperationsPrinterProfile {
  return {
    id: row.id,
    globalId: row.global_id,
    warehouseId: row.warehouse_id,
    warehouseGlobalId: row.warehouse_global_id,
    warehouseName: row.warehouse_name,
    code: row.code,
    name: row.name,
    stationType: row.station_type,
    printerType: row.printer_type,
    connectionMode: row.connection_mode,
    supportedFormats: row.supported_formats,
    supportedMedia: row.supported_media,
    supportedDocumentTypes: row.supported_document_types,
    defaultDocumentTypes: row.default_document_types,
    fallbackPrinterGlobalId: row.fallback_printer_global_id,
    fallbackPrinterName: row.fallback_printer_name,
    localPrintAgentGlobalId: row.local_print_agent_global_id,
    localPrintAgentName: row.local_print_agent_name,
    localPrintAgentStatus: row.local_print_agent_status,
    localPrintAgentLastSeenAt: row.local_print_agent_last_seen_at,
    priority: row.priority,
    status: row.status,
    rowVersion: row.row_version,
    lastSeenAt: row.last_seen_at,
    updatedAt: row.updated_at,
  }
}

const PRINTER_SELECT = `
  SELECT
    printer.id::text,
    printer.global_id,
    printer.warehouse_id::text,
    warehouse.global_id AS warehouse_global_id,
    warehouse.name AS warehouse_name,
    printer.code,
    printer.name,
    printer.station_type,
    printer.printer_type,
    printer.connection_mode,
    printer.supported_formats,
    printer.supported_media,
    printer.supported_document_types,
    printer.default_document_types,
    fallback.global_id AS fallback_printer_global_id,
    fallback.name AS fallback_printer_name,
    print_agent.global_id AS local_print_agent_global_id,
    print_agent.name AS local_print_agent_name,
    print_agent.status AS local_print_agent_status,
    print_agent.last_seen_at::text AS local_print_agent_last_seen_at,
    printer.priority,
    printer.status,
    printer.row_version,
    printer.last_seen_at::text,
    printer.updated_at::text
  FROM operations_printers printer
  JOIN operations_warehouses warehouse
    ON warehouse.organization_id = printer.organization_id
   AND warehouse.id = printer.warehouse_id
  LEFT JOIN operations_printers fallback
    ON fallback.organization_id = printer.organization_id
   AND fallback.id = printer.fallback_printer_id
  LEFT JOIN operations_print_agents print_agent
    ON print_agent.organization_id = printer.organization_id
   AND print_agent.warehouse_id = printer.warehouse_id
   AND print_agent.id = printer.local_print_agent_id
`

export async function listOperationsPrinterProfilesInPostgres(
  organizationId: string,
  client?: PoolClient,
) {
  const sql = `${PRINTER_SELECT}
    WHERE printer.organization_id = $1::uuid
      AND warehouse.status = 'active'
      AND upper(warehouse.code) <> 'MOCK-01'
    ORDER BY warehouse.name, printer.priority, printer.name`
  const result = client
    ? await client.query<PrinterRow>(sql, [organizationId])
    : await query<PrinterRow>(sql, [organizationId])
  return result.rows.map(profile)
}

async function oneProfile(
  organizationId: string,
  globalId: string,
  client: PoolClient,
) {
  const result = await client.query<PrinterRow>(
    `${PRINTER_SELECT}
     WHERE printer.organization_id = $1::uuid
       AND printer.global_id = $2
     LIMIT 1`,
    [organizationId, globalId],
  )
  if (!result.rows[0]) {
    throw new OperationsRequestError(
      'OPERATIONS_PRINTER_NOT_FOUND',
      'Printer profile was not found',
      404,
    )
  }
  return profile(result.rows[0])
}

export async function readOperationsPrinterWorkspaceFromPostgres(input: {
  organizationId: string
  canView: boolean
  canManage: boolean
  canExecute: boolean
}): Promise<OperationsPrinterWorkspace> {
  if (!input.canView) {
    throw new OperationsRequestError(
      'OPERATIONS_FORBIDDEN',
      'You do not have permission to view printer configuration',
      403,
    )
  }
  const organizationId = requireOrganizationId(input.organizationId)
  const warehousesResult = await query<WarehouseRow>(
    `SELECT id::text, global_id, name
     FROM operations_warehouses
     WHERE organization_id = $1::uuid
       AND status = 'active'
       AND upper(code) <> 'MOCK-01'
     ORDER BY name`,
    [organizationId],
  )
  return {
    organizationId,
    capabilities: {
      canView: input.canView,
      canManage: input.canManage,
      canExecute: input.canExecute,
    },
    warehouses: warehousesResult.rows.map((row) => ({
      id: row.id,
      globalId: row.global_id,
      name: row.name,
    })),
    printers: await listOperationsPrinterProfilesInPostgres(organizationId),
    generatedAt: new Date().toISOString(),
  }
}

async function fallbackPrinterId(input: {
  client: PoolClient
  organizationId: string
  warehouseId: string
  fallbackPrinterGlobalId: string | null
  currentPrinterId: string | null
  printer: OperationsPrinterInput
}) {
  if (!input.fallbackPrinterGlobalId) return null
  const result = await input.client.query<{
    id: string
    warehouse_id: string
    status: string
    supported_formats: string[]
    supported_media: string[]
    supported_document_types: string[]
  }>(
    `SELECT id::text, warehouse_id::text, status,
       supported_formats, supported_media, supported_document_types
     FROM operations_printers
     WHERE organization_id = $1::uuid
       AND global_id = $2
     FOR SHARE`,
    [input.organizationId, input.fallbackPrinterGlobalId],
  )
  const fallback = result.rows[0]
  if (!fallback || fallback.warehouse_id !== input.warehouseId) {
    throw new OperationsRequestError(
      'OPERATIONS_PRINTER_FALLBACK_INVALID',
      'Fallback printer must belong to the same warehouse',
    )
  }
  if (fallback.id === input.currentPrinterId) {
    throw new OperationsRequestError(
      'OPERATIONS_PRINTER_FALLBACK_INVALID',
      'A printer cannot be its own fallback',
    )
  }
  if (fallback.status === 'disabled') {
    throw new OperationsRequestError(
      'OPERATIONS_PRINTER_FALLBACK_INVALID',
      'A disabled printer cannot be used as a fallback',
    )
  }
  if (
    input.printer.supportedFormats.some((value) => !fallback.supported_formats.includes(value))
    || input.printer.supportedMedia.some((value) => !fallback.supported_media.includes(value))
    || input.printer.supportedDocumentTypes.some((value) => (
      !fallback.supported_document_types.includes(value)
    ))
  ) {
    throw new OperationsRequestError(
      'OPERATIONS_PRINTER_FALLBACK_INCOMPATIBLE',
      'Fallback printer must support every configured document, media, and format',
    )
  }
  return fallback.id
}

async function localPrintAgentId(input: {
  client: PoolClient
  organizationId: string
  warehouseId: string
  localPrintAgentGlobalId: string | null
  connectionMode: OperationsPrinterInput['connectionMode']
  status: OperationsPrinterInput['status']
  printer: Pick<
    OperationsPrinterInput,
    'supportedFormats' | 'supportedMedia' | 'supportedDocumentTypes'
  >
}) {
  if (!input.localPrintAgentGlobalId) {
    if (input.connectionMode === 'local_agent' && input.status === 'online') {
      throw new OperationsRequestError(
        'OPERATIONS_PRINTER_AGENT_REQUIRED',
        'An online local-agent printer must be assigned to an active print agent',
      )
    }
    return null
  }
  if (input.connectionMode !== 'local_agent') {
    throw new OperationsRequestError(
      'OPERATIONS_PRINTER_AGENT_INVALID',
      'Only local-agent printer profiles can be assigned to a print agent',
    )
  }
  const result = await input.client.query<{
    id: string
    supported_formats: string[]
    supported_media: string[]
    supported_document_types: string[]
  }>(
    `SELECT id::text, supported_formats, supported_media,
       supported_document_types
     FROM operations_print_agents
     WHERE organization_id = $1::uuid
       AND warehouse_id = $2::uuid
       AND global_id = $3
       AND status = 'active'
     FOR SHARE`,
    [
      input.organizationId,
      input.warehouseId,
      input.localPrintAgentGlobalId,
    ],
  )
  if (!result.rows[0]) {
    throw new OperationsRequestError(
      'OPERATIONS_PRINTER_AGENT_INVALID',
      'Print agent must be active and enrolled for the same warehouse',
    )
  }
  const agent = result.rows[0]
  if (
    input.printer.supportedFormats.some((value) => (
      !agent.supported_formats.includes(value)
    ))
    || input.printer.supportedMedia.some((value) => (
      !agent.supported_media.includes(value)
    ))
    || input.printer.supportedDocumentTypes.some((value) => (
      !agent.supported_document_types.includes(value)
    ))
  ) {
    throw new OperationsRequestError(
      'OPERATIONS_PRINTER_AGENT_CAPABILITIES_INCOMPATIBLE',
      'Printer document, media, and format capabilities must be a subset of the assigned print agent',
    )
  }
  return agent.id
}

async function removeConflictingDefaults(input: {
  client: PoolClient
  organizationId: string
  warehouseId: string
  printerId: string | null
  defaultDocumentTypes: OperationsPrinterInput['defaultDocumentTypes']
}) {
  if (input.defaultDocumentTypes.length === 0) return
  await input.client.query(
    `UPDATE operations_printers
     SET default_document_types = ARRAY(
       SELECT document_type
       FROM unnest(default_document_types) AS document_type
       WHERE NOT (document_type = ANY($4::text[]))
     ),
     row_version = row_version + 1,
     updated_at = now()
     WHERE organization_id = $1::uuid
       AND warehouse_id = $2::uuid
       AND ($3::uuid IS NULL OR id <> $3::uuid)
       AND default_document_types && $4::text[]`,
    [
      input.organizationId,
      input.warehouseId,
      input.printerId,
      input.defaultDocumentTypes,
    ],
  )
}

export async function saveOperationsPrinterInPostgres(input: {
  organizationId: string
  actorEmail: string
  printer: OperationsPrinterInput
}): Promise<OperationsPrinterProfile> {
  const organizationId = requireOrganizationId(input.organizationId)
  const actorEmail = String(input.actorEmail || '').trim().toLowerCase()
  if (!actorEmail) {
    throw new OperationsRequestError('OPERATIONS_ACTOR_REQUIRED', 'Signed-in user is required')
  }

  try {
    return await withTransaction(async (client) => {
      await acquireTransactionAdvisoryLock(
        client,
        `operations:printer-configuration:${organizationId}:${input.printer.warehouseId}`,
      )
      const warehouseResult = await client.query<{ id: string }>(
        `SELECT id::text
         FROM operations_warehouses
         WHERE organization_id = $1::uuid
           AND id = $2::uuid
           AND status = 'active'
           AND upper(code) <> 'MOCK-01'
         FOR SHARE`,
        [organizationId, input.printer.warehouseId],
      )
      if (!warehouseResult.rows[0]) {
        throw new OperationsRequestError(
          'OPERATIONS_PRINTER_WAREHOUSE_INVALID',
          'Select an active non-test warehouse',
        )
      }

      let printerId: string | null = null
      let existingRowVersion: number | null = null
      if (input.printer.globalId) {
        const existingResult = await client.query<{
          id: string
          row_version: number
          warehouse_id: string
        }>(
          `SELECT id::text, row_version, warehouse_id::text
           FROM operations_printers
           WHERE organization_id = $1::uuid
             AND global_id = $2
           FOR UPDATE`,
          [organizationId, input.printer.globalId],
        )
        const existing = existingResult.rows[0]
        if (!existing) {
          throw new OperationsRequestError(
            'OPERATIONS_PRINTER_NOT_FOUND',
            'Printer profile was not found',
            404,
          )
        }
        printerId = existing.id
        existingRowVersion = existing.row_version
        if (existing.warehouse_id !== input.printer.warehouseId) {
          throw new OperationsRequestError(
            'OPERATIONS_PRINTER_WAREHOUSE_IMMUTABLE',
            'Create a new printer profile when assigning a physical printer to another warehouse',
          )
        }
        if (existing.row_version !== input.printer.expectedRowVersion) {
          throw new OperationsRequestError(
            'OPERATIONS_PRINTER_VERSION_CONFLICT',
            'Printer configuration changed. Refresh and try again.',
            409,
          )
        }
      }

      const fallbackId = await fallbackPrinterId({
        client,
        organizationId,
        warehouseId: input.printer.warehouseId,
        fallbackPrinterGlobalId: input.printer.fallbackPrinterGlobalId,
        currentPrinterId: printerId,
        printer: input.printer,
      })
      const printAgentId = await localPrintAgentId({
        client,
        organizationId,
        warehouseId: input.printer.warehouseId,
        localPrintAgentGlobalId: input.printer.localPrintAgentGlobalId,
        connectionMode: input.printer.connectionMode,
        status: input.printer.status,
        printer: input.printer,
      })
      await removeConflictingDefaults({
        client,
        organizationId,
        warehouseId: input.printer.warehouseId,
        printerId,
        defaultDocumentTypes: input.printer.defaultDocumentTypes,
      })

      let globalId = input.printer.globalId || ''
      if (printerId) {
        await client.query(
          `UPDATE operations_printers
           SET code = $3,
               name = $4,
               station_type = $5,
               printer_type = $6,
               connection_mode = $7,
               supports_zpl = 'ZPL' = ANY($8::text[]),
               supported_formats = $8::text[],
               supported_media = $9::text[],
               supported_document_types = $10::text[],
               default_document_types = $11::text[],
               fallback_printer_id = $12::uuid,
               local_print_agent_id = $13::uuid,
               priority = $14,
               status = $15,
               row_version = row_version + 1,
               updated_at = now()
           WHERE organization_id = $1::uuid
             AND id = $2::uuid`,
          [
            organizationId,
            printerId,
            input.printer.code,
            input.printer.name,
            input.printer.stationType,
            input.printer.printerType,
            input.printer.connectionMode,
            input.printer.supportedFormats,
            input.printer.supportedMedia,
            input.printer.supportedDocumentTypes,
            input.printer.defaultDocumentTypes,
            fallbackId,
            printAgentId,
            input.printer.priority,
            input.printer.status,
          ],
        )
      } else {
        const inserted = await client.query<{ id: string; global_id: string }>(
          `INSERT INTO operations_printers (
             organization_id,
             warehouse_id,
             code,
             name,
             station_type,
             printer_type,
             connection_mode,
             supports_zpl,
             supported_formats,
             supported_media,
             supported_document_types,
             default_document_types,
             fallback_printer_id,
             local_print_agent_id,
             priority,
             status,
             created_by
           ) VALUES (
             $1::uuid, $2::uuid, $3, $4, $5, $6, $7,
             'ZPL' = ANY($8::text[]), $8::text[], $9::text[], $10::text[],
             $11::text[], $12::uuid, $13::uuid, $14, $15, $16
           )
           RETURNING id::text, global_id`,
          [
            organizationId,
            input.printer.warehouseId,
            input.printer.code,
            input.printer.name,
            input.printer.stationType,
            input.printer.printerType,
            input.printer.connectionMode,
            input.printer.supportedFormats,
            input.printer.supportedMedia,
            input.printer.supportedDocumentTypes,
            input.printer.defaultDocumentTypes,
            fallbackId,
            printAgentId,
            input.printer.priority,
            input.printer.status,
            actorEmail,
          ],
        )
        printerId = inserted.rows[0].id
        globalId = inserted.rows[0].global_id
      }

      const saved = await oneProfile(organizationId, globalId, client)
      const eventType = existingRowVersion === null
        ? 'operations.printer.created'
        : 'operations.printer.updated'
      await recordAuditEvent({
        actor: actorEmail,
        eventType,
        aggregateType: 'operations.printer',
        aggregateId: saved.globalId,
        eventKey: `${eventType}:${saved.globalId}:${saved.rowVersion}`,
        subject: saved.name,
        organizationId,
        payload: {
          printerGlobalId: saved.globalId,
          warehouseGlobalId: saved.warehouseGlobalId,
          printerType: saved.printerType,
          connectionMode: saved.connectionMode,
          supportedFormats: saved.supportedFormats,
          supportedMedia: saved.supportedMedia,
          supportedDocumentTypes: saved.supportedDocumentTypes,
          defaultDocumentTypes: saved.defaultDocumentTypes,
          fallbackPrinterGlobalId: saved.fallbackPrinterGlobalId,
          localPrintAgentGlobalId: saved.localPrintAgentGlobalId,
          status: saved.status,
        },
      }, client)
      return saved
    })
  } catch (error) {
    if (
      error
      && typeof error === 'object'
      && 'code' in error
      && error.code === '23505'
    ) {
      throw new OperationsRequestError(
        'OPERATIONS_PRINTER_CODE_CONFLICT',
        'Printer code already exists in this warehouse',
        409,
      )
    }
    throw error
  }
}
