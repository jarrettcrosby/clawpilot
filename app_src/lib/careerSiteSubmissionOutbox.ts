import {
  CAREER_SITE_SUBMISSION_SHEET_HEADERS,
  CareerSiteSubmissionConfigurationError,
  careerSiteSubmissionSheetRow,
  resolveCareerSiteSubmissionConfiguration,
} from '@/lib/careerSiteSubmissionContract'
import {
  GoogleWorkspaceRequestError,
  resolveGoogleWorkspaceProvisioningRuntime,
} from '@/lib/integrations/googleWorkspace'
import {
  GoogleWorkspaceClientError,
  googleSheetsJson,
  type GoogleWorkspaceRuntime,
} from '@/lib/integrations/googleWorkspaceClient'
import {
  claimCareerSiteSubmissionOutboxInPostgres,
  completeCareerSiteSubmissionOutboxInPostgres,
  failCareerSiteSubmissionOutboxInPostgres,
  type CareerSiteSubmissionOutboxItem,
} from '@/lib/persistence/careerSiteSubmissions'

const MAX_DEDUPE_ROWS = 50_000

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

async function prepareSheet(input: {
  runtime: GoogleWorkspaceRuntime
  sheetId: string
  sheetTab: string
  sheetHeaderRow: number
}) {
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
  const idRange = `${quotedTab}!A${firstDataRow}:A${firstDataRow + MAX_DEDUPE_ROWS - 1}`
  const existingRows = await readValues(input.runtime, input.sheetId, idRange)
  if (
    existingRows.length >= MAX_DEDUPE_ROWS
    && String(existingRows[MAX_DEDUPE_ROWS - 1]?.[0] || '').trim()
  ) {
    throw new CareerSiteSubmissionSheetContractError(
      'Configured career-site Google Sheet exceeded the verified deduplication range',
    )
  }
  const existingSubmissionIds = new Set(
    existingRows
      .map((row) => String(row[0] || '').trim().toLowerCase())
      .filter(Boolean),
  )
  return {
    appendRange: `${quotedTab}!A${input.sheetHeaderRow}:S`,
    existingSubmissionIds,
  }
}

async function appendSubmission(input: {
  runtime: GoogleWorkspaceRuntime
  sheetId: string
  appendRange: string
  item: CareerSiteSubmissionOutboxItem
}) {
  const range = input.appendRange
  await googleSheetsJson(
    input.runtime,
    `${valuesPath(input.sheetId, range)}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
    {
      method: 'POST',
      body: {
        range,
        majorDimension: 'ROWS',
        values: [careerSiteSubmissionSheetRow(input.item)],
      },
      idempotent: false,
    },
  )
}

function permanentError(error: unknown) {
  if (error instanceof CareerSiteSubmissionSheetContractError) return true
  if (error instanceof CareerSiteSubmissionConfigurationError) return true
  if (error instanceof GoogleWorkspaceClientError) return !error.retryable
  if (error instanceof GoogleWorkspaceRequestError) return error.status < 500
  return false
}

function safeErrorMessage(error: unknown) {
  if (
    error instanceof CareerSiteSubmissionSheetContractError
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
  if (!configuration.enabled || !configuration.sheetId) {
    return { claimed: 0, succeeded: 0, failed: 0, dead: 0, items: [] }
  }

  const maxAttempts = Math.max(1, Math.min(Math.trunc(Number(input.maxAttempts) || 8), 20))
  const items = await claimCareerSiteSubmissionOutboxInPostgres({
    limit: input.limit,
    maxAttempts,
  })
  const results: Array<{ id: string; status: 'succeeded' | 'failed' | 'dead' }> = []
  let runtime: GoogleWorkspaceRuntime | null = null
  let sheet: Awaited<ReturnType<typeof prepareSheet>> | null = null

  for (const item of items) {
    try {
      if (item.sourceApp !== configuration.sourceApp || item.ownerEmail !== configuration.ownerEmail) {
        throw new CareerSiteSubmissionSheetContractError(
          'Claimed career-site submission is outside the configured owner or source scope',
        )
      }
      runtime ||= await resolveGoogleWorkspaceProvisioningRuntime()
      sheet ||= await prepareSheet({
        runtime,
        sheetId: configuration.sheetId,
        sheetTab: configuration.sheetTab,
        sheetHeaderRow: configuration.sheetHeaderRow,
      })
      if (!sheet.existingSubmissionIds.has(item.externalSubmissionId)) {
        await appendSubmission({
          runtime,
          sheetId: configuration.sheetId,
          appendRange: sheet.appendRange,
          item,
        })
        sheet.existingSubmissionIds.add(item.externalSubmissionId)
      }
      await completeCareerSiteSubmissionOutboxInPostgres(item)
      results.push({ id: item.id, status: 'succeeded' })
    } catch (error) {
      const status = await failCareerSiteSubmissionOutboxInPostgres({
        item,
        error: safeErrorMessage(error),
        maxAttempts: permanentError(error) ? item.attempts : maxAttempts,
      })
      results.push({ id: item.id, status })
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
