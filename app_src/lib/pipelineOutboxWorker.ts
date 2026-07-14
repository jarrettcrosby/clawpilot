import { getErrorMessage } from '@/lib/errorUtils'
import { resolveManagedGoogleWorkspaceRuntime } from '@/lib/integrations/googleWorkspace'
import { googleSheetsJson, type GoogleWorkspaceRuntime } from '@/lib/integrations/googleWorkspaceClient'
import { matonFetch } from '@/lib/maton'
import {
  provisionPipelineGoogleResources,
  reconcilePipelineGooglePermissions,
  replaceManagedPipelineDropdowns,
  sanitizePipelineProvisioningError,
} from '@/lib/pipelineProvisioning'
import {
  claimPipelineSyncOutboxInPostgres,
  completePipelineSyncOutboxInPostgres,
  failPipelineSyncOutboxInPostgres,
  InvalidPipelineOutboxContextError,
  resolvePipelineOutboxSheetContextInPostgres,
  type PipelineDropdownCatalog,
  type PipelineOutboxItem,
  type ResolvedPipelineOutboxSheetContext,
} from '@/lib/persistence/pipeline'

class PermanentOutboxError extends Error {}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function workspacePipelineId(item: PipelineOutboxItem) {
  const pipelineId = String(item.pipelineId || item.payload.pipelineId || item.aggregateId || '').trim()
  if (!UUID_PATTERN.test(pipelineId)) throw new PermanentOutboxError('Managed pipeline operation has an invalid pipeline ID')
  return pipelineId
}

function readRangeAndValues(item: PipelineOutboxItem): { range: string; values: unknown[][] } {
  const range = String(item.payload.range || '').trim()
  const values = item.payload.values
  if (!range || !Array.isArray(values) || !values.every((row) => Array.isArray(row))) {
    throw new PermanentOutboxError(`Invalid Sheet payload for ${item.operation}`)
  }
  return { range, values: values as unknown[][] }
}

function hasManagedSheetsBinding(context: ResolvedPipelineOutboxSheetContext): context is ResolvedPipelineOutboxSheetContext & {
  ownerEmail: string
  googleServiceAccountEmail: string
  googleSharedDriveId: string
} {
  return Boolean(
    context.ownerEmail
    && context.googleServiceAccountEmail
    && context.googleSharedDriveId
    && !context.legacyOwnerFallback,
  )
}

async function readValues(
  context: ResolvedPipelineOutboxSheetContext,
  range: string,
  managedRuntime: GoogleWorkspaceRuntime | null,
): Promise<unknown[][]> {
  if (managedRuntime) {
    const parsed = await googleSheetsJson<{ values?: unknown[][] }>(
      managedRuntime,
      `/v4/spreadsheets/${context.sheetId}/values/${encodeURIComponent(range)}`,
    )
    return Array.isArray(parsed.values) ? parsed.values : []
  }
  const response = await matonFetch(
    `/google-sheets/v4/spreadsheets/${context.sheetId}/values/${encodeURIComponent(range)}`,
  )
  const text = await response.text()
  if (!response.ok) {
    throw new Error(`Sheet read failed (${response.status}): ${text.slice(0, 1000)}`)
  }
  const parsed = text ? JSON.parse(text) as { values?: unknown[][] } : {}
  return Array.isArray(parsed.values) ? parsed.values : []
}

function canonicalCell(value: unknown, columnIndex: number) {
  const normalized = String(value ?? '').replace(/\r\n/g, '\n').trim()
  if (columnIndex === 8 || columnIndex === 9) {
    const numeric = Number(normalized.replace(/[$,%]/g, '').replace(/,/g, '') || 0)
    if (Number.isFinite(numeric)) return String(numeric)
  }
  return normalized
}

function rowsMatch(actual: unknown[] | undefined, expected: unknown[] | undefined) {
  const width = 12
  return Array.from({ length: width }, (_, index) => (
    canonicalCell(actual?.[index], index) === canonicalCell(expected?.[index], index)
  )).every(Boolean)
}

async function writeValues(input: {
  context: ResolvedPipelineOutboxSheetContext
  range: string
  values: unknown[][]
  mode: 'update' | 'append'
  managedRuntime: GoogleWorkspaceRuntime | null
}) {
  const endpoint = input.mode === 'append'
    ? `/google-sheets/v4/spreadsheets/${input.context.sheetId}/values/${encodeURIComponent(input.range)}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`
    : `/google-sheets/v4/spreadsheets/${input.context.sheetId}/values/${encodeURIComponent(input.range)}?valueInputOption=USER_ENTERED`

  if (input.managedRuntime) {
    await googleSheetsJson(input.managedRuntime, endpoint.slice('/google-sheets'.length), {
      method: input.mode === 'append' ? 'POST' : 'PUT',
      body: { range: input.range, majorDimension: 'ROWS', values: input.values },
      idempotent: input.mode === 'update',
    })
    return
  }

  const response = await matonFetch(endpoint, {
    method: input.mode === 'append' ? 'POST' : 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ range: input.range, majorDimension: 'ROWS', values: input.values }),
  })
  if (!response.ok) {
    const detail = await response.text()
    throw new Error(`Sheet ${input.mode} failed (${response.status}): ${detail.slice(0, 1000)}`)
  }
}

async function executeOutboxItem(
  item: PipelineOutboxItem,
  context: ResolvedPipelineOutboxSheetContext,
  managedRuntime: GoogleWorkspaceRuntime | null,
) {
  if (item.operation === 'update_opportunity') {
    const { range, values } = readRangeAndValues(item)
    if (!/^Opportunities!B(\d+):M\1$/.test(range)) {
      throw new PermanentOutboxError('Opportunity update has an invalid Sheet range')
    }
    const beforeValues = item.payload.beforeValues
    if (!Array.isArray(beforeValues) || !Array.isArray(beforeValues[0]) || !Array.isArray(values[0])) {
      throw new PermanentOutboxError('Opportunity update is missing its expected Sheet row')
    }

    const current = (await readValues(context, range, managedRuntime))[0] || []
    if (rowsMatch(current, values[0])) return
    if (!rowsMatch(current, beforeValues[0] as unknown[])) {
      throw new PermanentOutboxError(
        `Opportunity Sheet row changed before outbox item ${item.id}; refresh before retrying`,
      )
    }
    await writeValues({ context, range, values, mode: 'update', managedRuntime })
    return
  }

  if (item.operation === 'append_interaction') {
    const { range, values } = readRangeAndValues(item)
    if (range !== 'Interactions!B:I' || !Array.isArray(values[0])) {
      throw new PermanentOutboxError('Interaction append has an invalid Sheet range')
    }
    const marker = `[ClawPilot sync:${item.id}]`
    const existing = await readValues(context, range, managedRuntime)
    if (existing.some((row) => row.some((cell) => String(cell || '').includes(marker)))) return

    const markedValues = values.map((row) => {
      const next = row.slice(0, 8)
      while (next.length < 8) next.push('')
      const notes = String(next[7] || '').trim()
      next[7] = notes ? `${notes}\n${marker}` : marker
      return next
    })
    await writeValues({ context, range, values: markedValues, mode: 'append', managedRuntime })
    return
  }

  if (item.operation === 'replace_dropdowns') {
    const catalog = item.payload.catalog as PipelineDropdownCatalog | undefined
    if (!catalog || typeof catalog !== 'object') {
      throw new PermanentOutboxError('Dropdown replacement is missing a catalog')
    }
    if (managedRuntime) {
      await replaceManagedPipelineDropdowns({
        runtime: managedRuntime,
        sheetId: context.sheetId,
        catalog,
      })
      return
    }
    const { pushDropdownsToSheet } = await import('@/lib/pipelineDropdownSync')
    await pushDropdownsToSheet(catalog, {
      pipelineId: context.pipelineId || undefined,
      sheetId: context.sheetId,
      legacyOwnerFallback: context.legacyOwnerFallback,
    })
    return
  }

  throw new PermanentOutboxError(`Unsupported pipeline outbox operation: ${item.operation}`)
}

export async function processPipelineSyncOutbox(input: {
  limit?: number
  maxAttempts?: number
} = {}) {
  const maxAttempts = Math.max(1, Math.min(Math.trunc(Number(input.maxAttempts) || 5), 20))
  const items = await claimPipelineSyncOutboxInPostgres({ limit: input.limit, maxAttempts })
  const results: Array<{ id: string; operation: string; status: 'succeeded' | 'failed' | 'dead' }> = []

  for (const item of items) {
    try {
      if (item.operation === 'provision_pipeline') {
        const pipelineId = workspacePipelineId(item)
        item.pipelineId = pipelineId
        await provisionPipelineGoogleResources(pipelineId)
        await completePipelineSyncOutboxInPostgres(item)
        results.push({ id: item.id, operation: item.operation, status: 'succeeded' })
        continue
      }
      if (item.operation === 'sync_pipeline_permissions') {
        const pipelineId = workspacePipelineId(item)
        item.pipelineId = pipelineId
        await reconcilePipelineGooglePermissions(pipelineId)
        await completePipelineSyncOutboxInPostgres(item)
        results.push({ id: item.id, operation: item.operation, status: 'succeeded' })
        continue
      }
      const context = await resolvePipelineOutboxSheetContextInPostgres(item)
      item.pipelineId = context.pipelineId
      item.sheetId = context.sheetId
      const managedRuntime = hasManagedSheetsBinding(context)
        ? await resolveManagedGoogleWorkspaceRuntime({
            serviceAccountEmail: context.googleServiceAccountEmail,
            sharedDriveId: context.googleSharedDriveId,
          })
        : null
      await executeOutboxItem(item, context, managedRuntime)
      await completePipelineSyncOutboxInPostgres(item)
      results.push({ id: item.id, operation: item.operation, status: 'succeeded' })
    } catch (error) {
      const managedWorkspaceOperation = item.operation === 'provision_pipeline'
        || item.operation === 'sync_pipeline_permissions'
      const status = await failPipelineSyncOutboxInPostgres({
        item,
        error: managedWorkspaceOperation ? sanitizePipelineProvisioningError(error) : getErrorMessage(error),
        maxAttempts: error instanceof PermanentOutboxError || error instanceof InvalidPipelineOutboxContextError
          ? item.attempts
          : maxAttempts,
      })
      results.push({ id: item.id, operation: item.operation, status })
    }
  }

  return {
    claimed: items.length,
    succeeded: results.filter((result) => result.status === 'succeeded').length,
    failed: results.filter((result) => result.status === 'failed').length,
    dead: results.filter((result) => result.status === 'dead').length,
    items: results,
  }
}
