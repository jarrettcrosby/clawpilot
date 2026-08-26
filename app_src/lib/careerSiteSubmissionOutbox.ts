import {
  CAREER_SITE_SUBMISSION_SHEET_HEADERS,
  CareerSiteSubmissionConfigurationError,
  CareerSiteSubmissionSheetBoundaryError,
  assertPrivateCareerSiteSheetBoundary,
  careerSiteSubmissionSheetRow,
  resolveCareerSiteSubmissionConfiguration,
  type CareerSiteGoogleDriveFile,
} from '@/lib/careerSiteSubmissionContract'
import {
  GoogleWorkspaceRequestError,
  resolveGoogleWorkspacePrivateFileRuntime,
} from '@/lib/integrations/googleWorkspace'
import {
  GoogleWorkspaceClientError,
  googleDriveJson,
  googleSheetsJson,
  type GoogleWorkspaceRuntime,
} from '@/lib/integrations/googleWorkspaceClient'
import {
  claimCareerSiteSubmissionOutboxInPostgres,
  completeCareerSiteSubmissionOutboxInPostgres,
  failCareerSiteSubmissionOutboxInPostgres,
  renewCareerSiteSubmissionOutboxLeaseInPostgres,
  withCareerSiteSubmissionSheetLock,
  type CareerSiteSubmissionOutboxItem,
} from '@/lib/persistence/careerSiteSubmissions'

const MAX_SHEET_DATA_ROWS = 50_000
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

class CareerSiteSubmissionSheetContractError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CareerSiteSubmissionSheetContractError'
  }
}

function quotedSheetName(value: string) {
  return `'${value.replaceAll("'", "''")}'`
}

function valuesPath(sheetId: string, range: string) {
  return `/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(range)}`
}

function exactRow(actual: unknown[] | undefined, expected: readonly string[]) {
  return expected.every((value, index) => String(actual?.[index] ?? '') === value)
    && (actual?.slice(expected.length).every((value) => String(value ?? '') === '') ?? true)
}

async function readValues(runtime: GoogleWorkspaceRuntime, sheetId: string, range: string) {
  const response = await googleSheetsJson<{ values?: unknown[][] }>(
    runtime,
    valuesPath(sheetId, range),
  )
  return Array.isArray(response.values) ? response.values : []
}

async function verifyPrivateSheetBoundary(input: {
  runtime: GoogleWorkspaceRuntime
  sheetId: string
  ownerEmail: string
}) {
  const metadataParameters = new URLSearchParams({
    supportsAllDrives: 'true',
    fields: [
      'id',
      'mimeType',
      'trashed',
      'driveId',
      'writersCanShare',
      'capabilities(canEdit)',
      'owners(emailAddress)',
    ].join(','),
  })
  const file = await googleDriveJson<CareerSiteGoogleDriveFile>(
    input.runtime,
    `/drive/v3/files/${input.sheetId}?${metadataParameters.toString()}`,
  )

  const permissions: Array<{
    id?: unknown
    type?: unknown
    role?: unknown
    emailAddress?: unknown
    deleted?: unknown
    pendingOwner?: unknown
    view?: unknown
  }> = []
  let pageToken = ''
  for (let page = 0; page < 10; page += 1) {
    const permissionParameters = new URLSearchParams({
      supportsAllDrives: 'true',
      includePermissionsForView: 'published',
      pageSize: '100',
      fields: 'nextPageToken,permissions(id,type,role,emailAddress,deleted,pendingOwner,view)',
    })
    if (pageToken) permissionParameters.set('pageToken', pageToken)
    const response = await googleDriveJson<{
      nextPageToken?: unknown
      permissions?: typeof permissions
    }>(
      input.runtime,
      `/drive/v3/files/${input.sheetId}/permissions?${permissionParameters.toString()}`,
    )
    permissions.push(...(Array.isArray(response.permissions) ? response.permissions : []))
    pageToken = typeof response.nextPageToken === 'string' ? response.nextPageToken.trim() : ''
    if (!pageToken) {
      assertPrivateCareerSiteSheetBoundary({
        sheetId: input.sheetId,
        ownerEmail: input.ownerEmail,
        serviceAccountEmail: input.runtime.serviceAccountEmail,
        file,
        permissions,
      })
      return
    }
  }
  throw new CareerSiteSubmissionSheetContractError(
    'Career-site Sheet permission listing exceeded the safe page limit',
  )
}

async function prepareSheet(input: {
  runtime: GoogleWorkspaceRuntime
  sheetId: string
  ownerEmail: string
  sheetTab: string
  sheetHeaderRow: number
}) {
  await verifyPrivateSheetBoundary(input)
  const metadata = await googleSheetsJson<{
    spreadsheetId?: string
    sheets?: Array<{ properties?: { title?: string } }>
  }>(
    input.runtime,
    `/v4/spreadsheets/${input.sheetId}?fields=spreadsheetId,sheets.properties.title`,
  )
  if (metadata.spreadsheetId !== input.sheetId) {
    throw new CareerSiteSubmissionSheetContractError('Configured career-site Google Sheet did not verify')
  }
  const tabExists = (metadata.sheets || []).some((sheet) => sheet.properties?.title === input.sheetTab)
  if (!tabExists) {
    throw new CareerSiteSubmissionSheetContractError('Configured career-site Google Sheet tab was not found')
  }

  const quotedTab = quotedSheetName(input.sheetTab)
  const lastColumn = 'S'
  const headerRange = `${quotedTab}!A${input.sheetHeaderRow}:${lastColumn}${input.sheetHeaderRow}`
  const currentHeaders = await readValues(input.runtime, input.sheetId, headerRange)
  if (currentHeaders.length === 0 || currentHeaders[0]?.every((value) => String(value ?? '') === '')) {
    await googleSheetsJson(
      input.runtime,
      `${valuesPath(input.sheetId, headerRange)}?valueInputOption=RAW`,
      {
        method: 'PUT',
        body: {
          range: headerRange,
          majorDimension: 'ROWS',
          values: [[...CAREER_SITE_SUBMISSION_SHEET_HEADERS]],
        },
      },
    )
  } else if (!exactRow(currentHeaders[0], CAREER_SITE_SUBMISSION_SHEET_HEADERS)) {
    throw new CareerSiteSubmissionSheetContractError('Configured career-site Google Sheet headers do not match')
  }

  const firstDataRow = input.sheetHeaderRow + 1
  const idRange = `${quotedTab}!A${firstDataRow}:A${firstDataRow + MAX_SHEET_DATA_ROWS}`
  const existingRows = await readValues(input.runtime, input.sheetId, idRange)
  if (existingRows.length > MAX_SHEET_DATA_ROWS) {
    throw new CareerSiteSubmissionSheetContractError(
      `Configured career-site Google Sheet exceeded its ${MAX_SHEET_DATA_ROWS}-row data limit`,
    )
  }
  const existingSubmissionRows = new Map<string, number>()
  for (const [index, row] of existingRows.entries()) {
    const id = String(row[0] || '').trim().toLowerCase()
    if (!UUID_PATTERN.test(id) || existingSubmissionRows.has(id)) {
      throw new CareerSiteSubmissionSheetContractError(
        'Configured career-site Google Sheet contains a missing, invalid, or duplicate submission ID',
      )
    }
    existingSubmissionRows.set(id, firstDataRow + index)
  }
  return {
    firstDataRow,
    nextDataRow: firstDataRow + existingRows.length,
    atCapacity: existingRows.length >= MAX_SHEET_DATA_ROWS,
    quotedTab,
    existingSubmissionRows,
  }
}

async function writeSubmission(input: {
  runtime: GoogleWorkspaceRuntime
  sheetId: string
  rowNumber: number
  quotedTab: string
  item: CareerSiteSubmissionOutboxItem
}) {
  const range = `${input.quotedTab}!A${input.rowNumber}:S${input.rowNumber}`
  const existing = await readValues(input.runtime, input.sheetId, range)
  if (existing.some((row) => row.some((value) => String(value ?? '') !== ''))) {
    throw new CareerSiteSubmissionSheetContractError(
      'Configured career-site Google Sheet next row is not empty',
    )
  }
  await googleSheetsJson(
    input.runtime,
    `${valuesPath(input.sheetId, range)}?valueInputOption=RAW`,
    {
      method: 'PUT',
      body: {
        range,
        majorDimension: 'ROWS',
        values: [careerSiteSubmissionSheetRow(input.item)],
      },
    },
  )
}

function safeErrorMessage(error: unknown) {
  if (
    error instanceof CareerSiteSubmissionSheetContractError
    || error instanceof CareerSiteSubmissionSheetBoundaryError
    || error instanceof CareerSiteSubmissionConfigurationError
    || error instanceof GoogleWorkspaceClientError
    || error instanceof GoogleWorkspaceRequestError
  ) {
    return `${error.name}: ${error.message}`.slice(0, 1000)
  }
  return 'CareerSiteSubmissionOutboxError: Google Sheet synchronization failed'
}

export async function processCareerSiteSubmissionOutbox(input: {
  limit?: number
  maxAttempts?: number
} = {}) {
  const configuration = resolveCareerSiteSubmissionConfiguration()
  if (
    !configuration.enabled
    || !configuration.sheetId
    || !configuration.ownerEmail
    || !configuration.organizationId
  ) {
    return { claimed: 0, succeeded: 0, failed: 0, dead: 0, items: [] }
  }
  const sheetId = configuration.sheetId
  const ownerEmail = configuration.ownerEmail
  const organizationId = configuration.organizationId

  const maxAttempts = Math.max(1, Math.min(Math.trunc(Number(input.maxAttempts) || 8), 20))
  const locked = await withCareerSiteSubmissionSheetLock(sheetId, async () => {
    const items = await claimCareerSiteSubmissionOutboxInPostgres({
      sourceApp: configuration.sourceApp,
      ownerEmail,
      organizationId,
      limit: input.limit,
      maxAttempts,
      leaseSeconds: 900,
    })
    const item = items[0]
    if (!item) {
      return { claimed: 0, succeeded: 0, failed: 0, dead: 0, items: [] }
    }
    try {
      const runtime = await resolveGoogleWorkspacePrivateFileRuntime()
      const sheet = await prepareSheet({
        runtime,
        sheetId,
        ownerEmail,
        sheetTab: configuration.sheetTab,
        sheetHeaderRow: configuration.sheetHeaderRow,
      })
      const existingRowNumber = sheet.existingSubmissionRows.get(item.externalSubmissionId)
      if (existingRowNumber !== undefined) {
        const existingRange = `${sheet.quotedTab}!A${existingRowNumber}:S${existingRowNumber}`
        const existing = await readValues(runtime, sheetId, existingRange)
        const expected = careerSiteSubmissionSheetRow(item)
        if (existing.length !== 1 || !exactRow(existing[0], expected)) {
          throw new CareerSiteSubmissionSheetContractError(
            'Existing career-site Sheet submission row does not match the durable record',
          )
        }
      } else {
        if (sheet.atCapacity) {
          throw new CareerSiteSubmissionSheetContractError(
            `Configured career-site Google Sheet reached its ${MAX_SHEET_DATA_ROWS}-row data limit`,
          )
        }
        await verifyPrivateSheetBoundary({ runtime, sheetId, ownerEmail })
        await renewCareerSiteSubmissionOutboxLeaseInPostgres(item)
        await writeSubmission({
          runtime,
          sheetId,
          rowNumber: sheet.nextDataRow,
          quotedTab: sheet.quotedTab,
          item,
        })
      }
      await completeCareerSiteSubmissionOutboxInPostgres(item)
      return {
        claimed: 1,
        succeeded: 1,
        failed: 0,
        dead: 0,
        items: [{ id: item.id, status: 'succeeded' as const }],
      }
    } catch (error) {
      const status = await failCareerSiteSubmissionOutboxInPostgres({
        item,
        error: safeErrorMessage(error),
        maxAttempts,
      })
      return {
        claimed: 1,
        succeeded: 0,
        failed: status === 'failed' ? 1 : 0,
        dead: status === 'dead' ? 1 : 0,
        items: [{ id: item.id, status }],
      }
    }
  })

  if (!locked.acquired || !locked.value) {
    return { claimed: 0, succeeded: 0, failed: 0, dead: 0, busy: true, items: [] }
  }
  return { ...locked.value, busy: false }
}
