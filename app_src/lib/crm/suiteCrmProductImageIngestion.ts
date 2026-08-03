import {
  createSuiteCrmProductImageReadClient,
  suiteCrmProductImageReadConfiguration,
} from '@/lib/crm/suiteCrmProductImageReadClient'
import {
  findSuiteCrmProductImageTargetInPostgres,
  ingestSuiteCrmProductImageSnapshotInPostgres,
  writeSuiteCrmProductImageIngestionHeartbeatInPostgres,
} from '@/lib/persistence/suiteCrmProductImageIngestion'
import { getPostgresPool } from '@/lib/persistence/postgres'
import type { PoolClient } from 'pg'

const CURSOR_KEY = 'crm.suitecrm.product_image_ingestion.cursor'
const CURSOR_VERSION = 2
const FULL_HISTORY_START = '1970-01-01T00:00:00.000Z'
const POLL_OVERLAP_MS = 5 * 60 * 1000
const MAX_PAGES_PER_RUN = 5
const MAX_SWEEP_MEMBERS = 5_000
const MAX_CURSOR_BYTES = 1024 * 1024
const SWEEP_PAGE_SIZES = [37, 53, 71] as const
const WORKER_LOCK_KEY = 'crm.suitecrm.product_image_ingestion.worker.v2'

type SweepMember = {
  id: string
  modifiedAt: string
}

type CursorState = {
  version: typeof CURSOR_VERSION
  baseline: boolean
  updatedSince: string
  pollStartedAt: string
  page: number
  phase: 'discover' | 'verify'
  seen: SweepMember[]
  expected: SweepMember[]
  restartCount: number
  pageSizeIndex: number
  reportedTotalRecords: number | null
}

type CursorDocument = {
  version: typeof CURSOR_VERSION
  baselineComplete: boolean
  state: CursorState | null
  lastPolledAt: string | null
  lastError: string | null
}

export type SuiteCrmProductImageIngestionCounts = {
  enabled: boolean
  ready: boolean
  pagesPolled: number
  productsListed: number
  productsMatched: number
  importedPrimary: number
  importedSecondary: number
  echoesSuppressed: number
  noImage: number
  identityConflicts: number
  mediaIntegrityConflicts: number
  staleIgnored: number
  deletedProductsIgnored: number
  unmatchedProducts: number
  providerWrites: 0
  pending: boolean
  errors: number
  baseline: boolean
  sweepPhase: 'discover' | 'verify' | 'complete'
  sweepRestarts: number
  duplicateIdsDetected: number
  membershipChangesDetected: number
}

function validDate(value: unknown) {
  const date = new Date(String(value || ''))
  return Number.isFinite(date.getTime()) ? date : null
}

function parseSweepMembers(value: unknown) {
  if (!Array.isArray(value) || value.length > MAX_SWEEP_MEMBERS) return null
  const members: SweepMember[] = []
  const ids = new Set<string>()
  for (const raw of value) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
    const record = raw as Record<string, unknown>
    const id = String(record.id || '').trim()
    const modifiedAt = validDate(record.modifiedAt)?.toISOString()
    if (
      !id
      || id.length > 100
      || /[\u0000-\u001f\u007f]/u.test(id)
      || !modifiedAt
      || ids.has(id)
    ) return null
    ids.add(id)
    members.push({ id, modifiedAt })
  }
  return members
}

function parseCursor(value: unknown): CursorDocument | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const document = value as Record<string, unknown>
  if (
    document.version !== CURSOR_VERSION
    || typeof document.baselineComplete !== 'boolean'
  ) return null
  const lastPolledAt = validDate(document.lastPolledAt)?.toISOString() || null
  if (document.baselineComplete && !lastPolledAt) return null
  const rawState = document.state
  if (rawState === null) {
    return {
      version: CURSOR_VERSION,
      baselineComplete: document.baselineComplete,
      state: null,
      lastPolledAt,
      lastError: typeof document.lastError === 'string'
        ? document.lastError.slice(0, 500)
        : null,
    }
  }
  if (!rawState || typeof rawState !== 'object' || Array.isArray(rawState)) {
    return null
  }
  const state = rawState as Record<string, unknown>
  const updatedSince = validDate(state.updatedSince)
  const pollStartedAt = validDate(state.pollStartedAt)
  const page = Number(state.page)
  const phase = state.phase
  const seen = parseSweepMembers(state.seen)
  const expected = parseSweepMembers(state.expected)
  const restartCount = Number(state.restartCount)
  const pageSizeIndex = Number(state.pageSizeIndex)
  const reportedTotalRecords = state.reportedTotalRecords === null
    ? null
    : Number(state.reportedTotalRecords)
  if (
    state.version !== CURSOR_VERSION
    || typeof state.baseline !== 'boolean'
    || state.baseline === document.baselineComplete
    || !updatedSince
    || !pollStartedAt
    || updatedSince.getTime() > pollStartedAt.getTime()
    || !Number.isSafeInteger(page)
    || page < 1
    || page > 10_000
    || (phase !== 'discover' && phase !== 'verify')
    || !seen
    || !expected
    || (phase === 'discover' && expected.length > 0)
    || !Number.isSafeInteger(restartCount)
    || restartCount < 0
    || restartCount > 1_000_000
    || !Number.isSafeInteger(pageSizeIndex)
    || pageSizeIndex < 0
    || pageSizeIndex >= SWEEP_PAGE_SIZES.length
    || (reportedTotalRecords !== null && (
      !Number.isSafeInteger(reportedTotalRecords)
      || reportedTotalRecords < 0
      || reportedTotalRecords > MAX_SWEEP_MEMBERS
    ))
  ) return null
  return {
    version: CURSOR_VERSION,
    baselineComplete: document.baselineComplete,
    state: {
      version: CURSOR_VERSION,
      baseline: state.baseline,
      updatedSince: updatedSince.toISOString(),
      pollStartedAt: pollStartedAt.toISOString(),
      page,
      phase,
      seen,
      expected,
      restartCount,
      pageSizeIndex,
      reportedTotalRecords,
    },
    lastPolledAt,
    lastError: typeof document.lastError === 'string'
      ? document.lastError.slice(0, 500)
      : null,
  }
}

function createSweepState(input: {
  baseline: boolean
  updatedSince: string
  pollStartedAt: string
}): CursorState {
  return {
    version: CURSOR_VERSION,
    baseline: input.baseline,
    updatedSince: input.updatedSince,
    pollStartedAt: input.pollStartedAt,
    page: 1,
    phase: 'discover',
    seen: [],
    expected: [],
    restartCount: 0,
    pageSizeIndex: 0,
    reportedTotalRecords: null,
  }
}

function sortedMembers(members: SweepMember[]) {
  return [...members].sort((left, right) => (
    left.id.localeCompare(right.id)
    || left.modifiedAt.localeCompare(right.modifiedAt)
  ))
}

function sameMembership(left: SweepMember[], right: SweepMember[]) {
  if (left.length !== right.length) return false
  const sortedLeft = sortedMembers(left)
  const sortedRight = sortedMembers(right)
  return sortedLeft.every((member, index) => (
    member.id === sortedRight[index]?.id
    && member.modifiedAt === sortedRight[index]?.modifiedAt
  ))
}

function appendPageMembers(
  state: CursorState,
  products: Array<{ id: string; modifiedAt: string }>,
) {
  const ids = new Set(state.seen.map((member) => member.id))
  const appended = [...state.seen]
  for (const product of products) {
    if (ids.has(product.id)) return null
    ids.add(product.id)
    appended.push({ id: product.id, modifiedAt: product.modifiedAt })
    if (appended.length > MAX_SWEEP_MEMBERS) {
      throw new Error('SuiteCRM Product image sweep exceeds the membership limit')
    }
  }
  return appended
}

function restartSweep(state: CursorState): CursorState {
  return {
    ...state,
    page: 1,
    phase: 'discover',
    seen: [],
    expected: [],
    restartCount: state.restartCount + 1,
    pageSizeIndex: (state.pageSizeIndex + 1) % SWEEP_PAGE_SIZES.length,
    reportedTotalRecords: null,
  }
}

async function readCursor(client: PoolClient) {
  const result = await client.query<{ value: unknown }>(
    'SELECT value FROM app_settings WHERE key = $1 LIMIT 1',
    [CURSOR_KEY],
  )
  return parseCursor(result.rows[0]?.value)
}

async function writeCursor(client: PoolClient, document: CursorDocument) {
  const serialized = JSON.stringify(document)
  if (Buffer.byteLength(serialized, 'utf8') > MAX_CURSOR_BYTES) {
    throw new Error('SuiteCRM Product image cursor exceeds the storage limit')
  }
  await client.query(
    `INSERT INTO app_settings (key, value, updated_at)
     VALUES ($1, $2::jsonb, clock_timestamp())
     ON CONFLICT (key) DO UPDATE SET
       value = EXCLUDED.value,
       updated_at = clock_timestamp()`,
    [CURSOR_KEY, serialized],
  )
}

function safeError(error: unknown) {
  const message = error instanceof Error ? error.message : ''
  if (
    /^SUITECRM_PRODUCT_IMAGE_READ_[A-Z_]+ is not configured safely$/u
      .test(message)
    || /^SuiteCRM Product image/u.test(message)
    || /^SuiteCRM returned/u.test(message)
    || /^SuiteCRM read/u.test(message)
  ) return message.replace(/[\r\n]+/gu, ' ').trim().slice(0, 500)
  return 'SuiteCRM Product image ingestion failed'
}

function emptyCounts(input: { enabled: boolean; ready: boolean }): SuiteCrmProductImageIngestionCounts {
  return {
    ...input,
    pagesPolled: 0,
    productsListed: 0,
    productsMatched: 0,
    importedPrimary: 0,
    importedSecondary: 0,
    echoesSuppressed: 0,
    noImage: 0,
    identityConflicts: 0,
    mediaIntegrityConflicts: 0,
    staleIgnored: 0,
    deletedProductsIgnored: 0,
    unmatchedProducts: 0,
    providerWrites: 0,
    pending: false,
    errors: 0,
    baseline: false,
    sweepPhase: 'complete',
    sweepRestarts: 0,
    duplicateIdsDetected: 0,
    membershipChangesDetected: 0,
  }
}

export async function processSuiteCrmProductImageIngestion(): Promise<
  SuiteCrmProductImageIngestionCounts
> {
  const configuration = suiteCrmProductImageReadConfiguration()
  const counts = emptyCounts({
    enabled: configuration.enabled,
    ready: configuration.ready,
  })
  if (!configuration.enabled) {
    await writeSuiteCrmProductImageIngestionHeartbeatInPostgres({
      phase: 'disabled',
      details: { providerWrites: 0 },
    })
    return counts
  }
  if (!configuration.ready) {
    counts.errors = 1
    await writeSuiteCrmProductImageIngestionHeartbeatInPostgres({
      phase: 'degraded',
      details: {
        error: 'SuiteCRM Product image read activation is not ready',
        missing: configuration.missing,
        invalid: configuration.invalid,
        credentialConflicts: configuration.credentialConflicts,
        aclAttestation: configuration.aclAttestation,
        providerWrites: 0,
      },
    })
    return counts
  }

  const lockClient = await getPostgresPool().connect()
  let lockAcquired = false
  let activeState: CursorState | null = null
  let activeBaselineComplete = false
  let activeLastPolledAt: string | null = null
  try {
    const lock = await lockClient.query<{ acquired: boolean }>(
      `SELECT pg_try_advisory_lock(hashtextextended($1::text, 0)) AS acquired`,
      [WORKER_LOCK_KEY],
    )
    lockAcquired = lock.rows[0]?.acquired === true
    if (!lockAcquired) {
      counts.pending = true
      return counts
    }

    const now = new Date()
    const cursor = await readCursor(lockClient)
    let baselineComplete = cursor?.baselineComplete || false
    const lastPolledAt = cursor?.lastPolledAt || null
    let state = cursor?.state || createSweepState({
      baseline: !baselineComplete,
      updatedSince: baselineComplete && lastPolledAt
        ? new Date(Date.parse(lastPolledAt) - POLL_OVERLAP_MS).toISOString()
        : FULL_HISTORY_START,
      pollStartedAt: now.toISOString(),
    })
    counts.baseline = state.baseline
    counts.sweepPhase = state.phase
    counts.sweepRestarts = state.restartCount
    activeState = state
    activeBaselineComplete = baselineComplete
    activeLastPolledAt = lastPolledAt

    await writeSuiteCrmProductImageIngestionHeartbeatInPostgres({
      phase: 'starting',
      details: {
        baseline: state.baseline,
        page: state.page,
        pageSize: SWEEP_PAGE_SIZES[state.pageSizeIndex],
        phase: state.phase,
        providerWrites: 0,
      },
    })
    let lastProgressHeartbeatAt = Date.now()
    const refreshProgressHeartbeat = async (force = false) => {
      if (!force && Date.now() - lastProgressHeartbeatAt < 30_000) return
      await writeSuiteCrmProductImageIngestionHeartbeatInPostgres({
        phase: 'starting',
        details: {
          ...counts,
          page: state.page,
          pageSize: SWEEP_PAGE_SIZES[state.pageSizeIndex],
          phase: state.phase,
        },
      })
      lastProgressHeartbeatAt = Date.now()
    }

    const cursorDocument = (): CursorDocument => {
      activeState = state
      activeBaselineComplete = baselineComplete
      activeLastPolledAt = lastPolledAt
      return {
        version: CURSOR_VERSION,
        baselineComplete,
        state,
        lastPolledAt,
        lastError: null,
      }
    }
    const restartAndReturn = async (
      reason: 'duplicate' | 'membership_changed',
    ) => {
      state = restartSweep(state)
      counts.pending = true
      counts.sweepPhase = state.phase
      counts.sweepRestarts = state.restartCount
      if (reason === 'duplicate') counts.duplicateIdsDetected += 1
      else counts.membershipChangesDetected += 1
      await writeCursor(lockClient, cursorDocument())
      await writeSuiteCrmProductImageIngestionHeartbeatInPostgres({
        phase: 'degraded',
        details: {
          ...counts,
          restartReason: reason,
          nextPageSize: SWEEP_PAGE_SIZES[state.pageSizeIndex],
        },
      })
      return counts
    }

    await writeCursor(lockClient, cursorDocument())
    const reader = createSuiteCrmProductImageReadClient()
    for (let attempt = 0; attempt < MAX_PAGES_PER_RUN; attempt += 1) {
      const page = await reader.listProductsUpdatedSince({
        updatedSince: state.updatedSince,
        updatedBeforeOrAt: state.pollStartedAt,
        page: state.page,
        pageSize: SWEEP_PAGE_SIZES[state.pageSizeIndex],
      })
      counts.pagesPolled += 1
      counts.productsListed += page.products.length

      if (page.products.length === 0 && state.page < page.totalPages) {
        return restartAndReturn('membership_changed')
      }

      if (page.totalRecords > MAX_SWEEP_MEMBERS) {
        throw new Error(
          'SuiteCRM Product image sweep exceeds the membership limit',
        )
      }
      if (
        state.reportedTotalRecords !== null
        && state.reportedTotalRecords !== page.totalRecords
      ) return restartAndReturn('membership_changed')
      state = { ...state, reportedTotalRecords: page.totalRecords }

      const appended = appendPageMembers(state, page.products)
      if (!appended) return restartAndReturn('duplicate')

      if (state.phase === 'verify') {
        const expected = new Map(
          state.expected.map((member) => [member.id, member.modifiedAt]),
        )
        if (
          page.totalRecords !== state.expected.length
          || page.products.some((product) => (
            expected.get(product.id) !== product.modifiedAt
          ))
        ) return restartAndReturn('membership_changed')

        for (const product of page.products) {
          if (product.deleted) {
            counts.deletedProductsIgnored += 1
            await refreshProgressHeartbeat()
            continue
          }
          const target = await findSuiteCrmProductImageTargetInPostgres(
            product.globalId,
          )
          if (!target) {
            counts.unmatchedProducts += 1
            await refreshProgressHeartbeat()
            continue
          }
          counts.productsMatched += 1
          const media = await reader.readProductImage(
            product.id,
            product.modifiedAt,
          )
          const result = await ingestSuiteCrmProductImageSnapshotInPostgres({
            organizationId: target.organizationId,
            suiteCrmId: product.id,
            suiteCrmGlobalId: product.globalId,
            suiteCrmModifiedAt: product.modifiedAt,
            productName: product.name,
            media,
            actorEmail: target.actorEmail,
          })
          if (result.resolution === 'imported_primary') counts.importedPrimary += 1
          else if (result.resolution === 'imported_secondary') {
            counts.importedSecondary += 1
          } else if (result.resolution === 'echo_suppressed') {
            counts.echoesSuppressed += 1
          } else if (result.resolution === 'no_image') counts.noImage += 1
          else if (result.resolution === 'identity_conflict') {
            counts.identityConflicts += 1
          } else if (result.resolution === 'media_integrity_conflict') {
            counts.mediaIntegrityConflicts += 1
          } else counts.staleIgnored += 1
          await refreshProgressHeartbeat()
        }
      }

      state = { ...state, seen: appended }
      await refreshProgressHeartbeat(true)
      if (state.page >= page.totalPages) {
        if (state.seen.length !== state.reportedTotalRecords) {
          return restartAndReturn('membership_changed')
        }

        if (state.phase === 'discover') {
          state = {
            ...state,
            page: 1,
            phase: 'verify',
            seen: [],
            expected: sortedMembers(state.seen),
            pageSizeIndex: (state.pageSizeIndex + 1)
              % SWEEP_PAGE_SIZES.length,
            reportedTotalRecords: null,
          }
          counts.sweepPhase = state.phase
          await writeCursor(lockClient, cursorDocument())
          continue
        }

        if (!sameMembership(state.expected, state.seen)) {
          return restartAndReturn('membership_changed')
        }
        baselineComplete = baselineComplete || state.baseline
        counts.baseline = state.baseline
        counts.sweepPhase = 'complete'
        await writeCursor(lockClient, {
          version: CURSOR_VERSION,
          baselineComplete,
          state: null,
          lastPolledAt: state.pollStartedAt,
          lastError: null,
        })
        await writeSuiteCrmProductImageIngestionHeartbeatInPostgres({
          phase: counts.identityConflicts > 0
            || counts.mediaIntegrityConflicts > 0
            || counts.importedSecondary > 0
            ? 'degraded'
            : 'completed',
          details: counts,
        })
        return counts
      }
      state = { ...state, page: state.page + 1 }
      counts.sweepPhase = state.phase
      await writeCursor(lockClient, cursorDocument())
    }
    counts.pending = true
    await writeSuiteCrmProductImageIngestionHeartbeatInPostgres({
      phase: counts.identityConflicts > 0
        || counts.mediaIntegrityConflicts > 0
        || counts.importedSecondary > 0
        ? 'degraded'
        : 'completed',
      details: counts,
    })
    return counts
  } catch (error) {
    counts.errors += 1
    const message = safeError(error)
    if (lockAcquired && activeState) {
      await writeCursor(lockClient, {
        version: CURSOR_VERSION,
        baselineComplete: activeBaselineComplete,
        state: activeState,
        lastPolledAt: activeLastPolledAt,
        lastError: message,
      }).catch(() => {})
    }
    await writeSuiteCrmProductImageIngestionHeartbeatInPostgres({
      phase: 'degraded',
      details: { ...counts, error: message },
    }).catch(() => {})
    return counts
  } finally {
    let releaseError: Error | undefined
    if (lockAcquired) {
      try {
        const unlocked = await lockClient.query<{ unlocked: boolean }>(
          `SELECT pg_advisory_unlock(hashtextextended($1::text, 0)) AS unlocked`,
          [WORKER_LOCK_KEY],
        )
        if (unlocked.rows[0]?.unlocked !== true) {
          releaseError = new Error('SuiteCRM Product image worker lock was lost')
        }
      } catch {
        releaseError = new Error('SuiteCRM Product image worker lock release failed')
      }
    }
    lockClient.release(releaseError)
  }
}
