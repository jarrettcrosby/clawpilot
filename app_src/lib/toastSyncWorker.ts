import crypto from 'crypto'
import {
  getToastAnalyticsPayouts,
  getToastAnalyticsSales,
  getToastStandardOrderUpdates,
  getToastStandardOrders,
  type ToastRuntimeCredential,
} from '@/lib/integrations/toastClient'
import { decryptToastClientSecret } from '@/lib/integrations/toastCredentialCrypto'
import {
  processPosAccountingNotificationOutbox,
  reconcilePosAccountingIssueForDateInPostgres,
  reconcileStaleOpenPosAccountingIssuesInPostgres,
} from '@/lib/persistence/posAccountingNotifications'
import {
  finalizePosAccountingReloadForDateInPostgres,
  regeneratePosAccountingDraftInPostgres,
} from '@/lib/persistence/posAccounting'
import {
  claimToastSyncJobsInPostgres,
  completeToastSyncJobInPostgres,
  deferToastSyncJobInPostgres,
  failToastSyncJobInPostgres,
  finishToastSyncPostProcessingInPostgres,
  listToastAutomaticSyncTargetsInPostgres,
  queueAutomaticToastSyncInPostgres,
  queueAutomaticToastOrderUpdateInPostgres,
  readToastRuntimeCredentialFromPostgres,
  storeToastSnapshotsInPostgres,
  projectToastStandardOrdersInPostgres,
  upsertToastAnalyticsSalesInPostgres,
  type ToastSyncJob,
} from '@/lib/persistence/toastIntegrations'

export function currentBusinessDate(timezoneValue: string | null, now = new Date()) {
  const timezone = timezoneValue || 'UTC'
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(now)
    const value = Object.fromEntries(parts.map((part) => [part.type, part.value]))
    return `${value.year}-${value.month}-${value.day}`
  } catch {
    return now.toISOString().slice(0, 10)
  }
}

function previousBusinessDate(timezoneValue: string | null) {
  return offsetDate(currentBusinessDate(timezoneValue), -1)
}

function offsetDate(dateValue: string, days: number) {
  const date = new Date(`${dateValue}T00:00:00.000Z`)
  date.setUTCDate(date.getUTCDate() + days)
  return date.toISOString().slice(0, 10)
}

function timeZoneOffsetMilliseconds(instant: Date, timezone: string) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(instant)
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]))
  const hour = Number(value.hour) === 24 ? 0 : Number(value.hour)
  const representedAsUtc = Date.UTC(
    Number(value.year),
    Number(value.month) - 1,
    Number(value.day),
    hour,
    Number(value.minute),
    Number(value.second),
  )
  return representedAsUtc - Math.floor(instant.getTime() / 1000) * 1000
}

function localMidnightUtc(dateValue: string, timezoneValue: string | null) {
  const timezone = timezoneValue || 'UTC'
  const [year, month, day] = dateValue.split('-').map(Number)
  const localMidnightAsUtc = Date.UTC(year, month - 1, day)
  try {
    let candidate = localMidnightAsUtc
    for (let iteration = 0; iteration < 3; iteration += 1) {
      const corrected = localMidnightAsUtc - timeZoneOffsetMilliseconds(new Date(candidate), timezone)
      if (corrected === candidate) break
      candidate = corrected
    }
    return new Date(candidate).toISOString()
  } catch {
    return new Date(localMidnightAsUtc).toISOString()
  }
}

export function modifiedWindow(dateValue: string, timezoneValue: string | null, now = new Date()) {
  const naturalEnd = localMidnightUtc(offsetDate(dateValue, 1), timezoneValue)
  const endDate = dateValue === currentBusinessDate(timezoneValue, now) && now.getTime() < new Date(naturalEnd).getTime()
    ? now.toISOString()
    : naturalEnd
  return {
    startDate: localMidnightUtc(dateValue, timezoneValue),
    endDate,
  }
}

function orderBusinessDate(value: unknown) {
  const raw = String(record(value).businessDate || '').replace(/[^0-9]/g, '')
  if (!/^\d{8}$/.test(raw)) return null
  const normalized = `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`
  return Number.isFinite(new Date(`${normalized}T00:00:00.000Z`).getTime()) ? normalized : null
}

function catchUpDates(latestDate: string | null, targetDate: string) {
  if (!latestDate || latestDate >= targetDate) return []
  const first = offsetDate(latestDate, 1)
  const floor = offsetDate(targetDate, -30)
  const dates: string[] = []
  for (let cursor = first < floor ? floor : first; cursor <= targetDate; cursor = offsetDate(cursor, 1)) {
    dates.push(cursor)
  }
  return dates
}

function delay(milliseconds: number) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

async function runtimeCredential(job: ToastSyncJob): Promise<ToastRuntimeCredential> {
  const accessType = job.syncKind.startsWith('analytics_') ? 'analytics' : 'standard'
  const stored = await readToastRuntimeCredentialFromPostgres(job.organizationId, accessType)
  if (!stored) throw new Error(`Toast ${accessType} credential is not configured`)
  return {
    accessType,
    apiBaseUrl: stored.apiBaseUrl,
    clientId: stored.clientId,
    clientSecret: decryptToastClientSecret(stored.secret, job.organizationId, accessType),
  }
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function sourceId(value: unknown, fallback: string) {
  const item = record(value)
  const candidate = String(
    item.guid || item.payoutGuid || item.depositGuid || item.paymentGuid || item.externalId || item.id || '',
  ).trim()
  return (candidate || fallback).slice(0, 512)
}

async function refreshAccountingState(job: ToastSyncJob, businessDates: string[]) {
  const dates = [...new Set(businessDates)].sort()
  for (const businessDate of dates) {
    const reload = await finalizePosAccountingReloadForDateInPostgres({
      organizationId: job.organizationId,
      restaurantGuid: job.restaurantGuid,
      businessDate,
    })
    if (reload.pending) continue
    if (!reload.finalized && !reload.failed) {
      await regeneratePosAccountingDraftInPostgres({
        organizationId: job.organizationId,
        restaurantGuid: job.restaurantGuid,
        businessDate,
        generationReason: 'automatic_sync',
      })
    }
    await reconcilePosAccountingIssueForDateInPostgres({
      organizationId: job.organizationId,
      restaurantGuid: job.restaurantGuid,
      businessDate,
    })
  }
}

async function completeJob(
  job: ToastSyncJob,
  resultSummary: Record<string, unknown>,
  accountingBusinessDates: string[] = [],
) {
  if (!await completeToastSyncJobInPostgres({ job, resultSummary })) {
    throw new Error('Toast sync worker lease expired')
  }
  await refreshAccountingState(job, accountingBusinessDates)
  if (!await finishToastSyncPostProcessingInPostgres({ job })) {
    throw new Error('Toast sync worker post-processing lease expired')
  }
}

async function processJob(job: ToastSyncJob) {
  const credential = await runtimeCredential(job)
  if (job.syncKind === 'analytics_sales') {
    const report = await getToastAnalyticsSales({
      credential,
      restaurantGuid: job.restaurantGuid,
      businessDate: job.businessDate,
      requestGuid: typeof job.requestState.reportRequestGuid === 'string' ? job.requestState.reportRequestGuid : null,
    })
    if (!report.ready) {
      const accepted = await deferToastSyncJobInPostgres({
        job,
        requestState: { reportRequestGuid: report.requestGuid },
        delaySeconds: 15,
      })
      if (!accepted) throw new Error('Toast sync worker lease expired')
      return { deferred: true }
    }
    await storeToastSnapshotsInPostgres({
      job,
      sourceKind: 'analytics_sales',
      records: report.records.map((payload, index) => ({
        sourceId: sourceId(payload, `${report.requestGuid}:${index}`), payload,
      })),
    })
    const totals = await upsertToastAnalyticsSalesInPostgres({ job, records: report.records })
    await completeJob(job, { records: report.records.length, totals }, [job.businessDate])
    return { deferred: false }
  }
  if (job.syncKind === 'analytics_payouts') {
    const report = await getToastAnalyticsPayouts({
      credential,
      restaurantGuid: job.restaurantGuid,
      businessDate: job.businessDate,
      requestGuid: typeof job.requestState.reportRequestGuid === 'string' ? job.requestState.reportRequestGuid : null,
    })
    if (!report.ready) {
      const accepted = await deferToastSyncJobInPostgres({
        job,
        requestState: { reportRequestGuid: report.requestGuid },
        delaySeconds: 20,
      })
      if (!accepted) throw new Error('Toast sync worker lease expired')
      return { deferred: true }
    }
    await storeToastSnapshotsInPostgres({
      job,
      sourceKind: 'analytics_payout',
      records: report.records.map((payload, index) => ({
        sourceId: sourceId(payload, `${report.requestGuid}:${index}`), payload,
      })),
    })
    await completeJob(job, { records: report.records.length })
    return { deferred: false }
  }
  if (job.syncKind === 'standard_order_updates') {
    const updates = await getToastStandardOrderUpdates({
      credential,
      restaurantGuid: job.restaurantGuid,
      ...modifiedWindow(job.businessDate, job.timezone),
    })
    const affectedDates = [...new Set(updates.map(orderBusinessDate).filter((value): value is string => Boolean(value)))].sort()
    const accountingBusinessDates = new Set(affectedDates)
    for (const [index, businessDate] of affectedDates.entries()) {
      if (index > 0) await delay(250)
      const orders = await getToastStandardOrders({ credential, restaurantGuid: job.restaurantGuid, businessDate })
      const datedJob = { ...job, businessDate }
      await storeToastSnapshotsInPostgres({
        job: datedJob,
        sourceKind: 'standard_order',
        records: orders.map((payload, recordIndex) => ({
          sourceId: sourceId(payload, `${job.restaurantGuid}:${businessDate}:${recordIndex}`), payload,
        })),
      })
      const totals = await projectToastStandardOrdersInPostgres({ job: datedJob, orders })
      totals.accountingBusinessDates.forEach((date) => accountingBusinessDates.add(date))
    }
    await completeJob(
      job,
      {
        records: updates.length,
        affectedBusinessDates: affectedDates,
        accountingBusinessDates: [...accountingBusinessDates].sort(),
      },
      [...accountingBusinessDates],
    )
    return { deferred: false }
  }
  const orders = await getToastStandardOrders({
    credential,
    restaurantGuid: job.restaurantGuid,
    businessDate: job.businessDate,
  })
  await storeToastSnapshotsInPostgres({
    job,
    sourceKind: 'standard_order',
    records: orders.map((payload, index) => ({
      sourceId: sourceId(payload, `${job.restaurantGuid}:${job.businessDate}:${index}`), payload,
    })),
  })
  const totals = await projectToastStandardOrdersInPostgres({ job, orders })
  await completeJob(job, { records: orders.length, totals }, totals.accountingBusinessDates)
  return { deferred: false }
}

async function queueAutomaticSyncs() {
  const targets = await listToastAutomaticSyncTargetsInPostgres()
  for (const target of targets) {
    const currentDate = currentBusinessDate(target.timezone)
    const businessDate = previousBusinessDate(target.timezone)
    await queueAutomaticToastSyncInPostgres({
      ...target,
      businessDate,
    })
    if (target.standardEnabled) {
      for (const catchUpDate of catchUpDates(target.latestStandardUpdateDate, businessDate)) {
        await queueAutomaticToastOrderUpdateInPostgres({ ...target, businessDate: catchUpDate })
      }
      await queueAutomaticToastOrderUpdateInPostgres({ ...target, businessDate: currentDate })
    }
  }
  return targets.length
}

function safeError(error: unknown) {
  const message = error instanceof Error ? error.message : 'Toast sync failed'
  return message.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 1000)
}

export async function processToastSyncOutbox(input: { limit?: number; workerId?: string } = {}) {
  const workerId = String(input.workerId || process.env.RAILWAY_REPLICA_ID || process.env.HOSTNAME || crypto.randomUUID()).slice(0, 200)
  const automaticTargets = await queueAutomaticSyncs()
  const jobs = await claimToastSyncJobsInPostgres({ limit: input.limit || 4, workerId })
  let succeeded = 0
  let failed = 0
  let dead = 0
  let deferred = 0
  for (const job of jobs) {
    try {
      const result = await processJob(job)
      if (result.deferred) deferred += 1
      else succeeded += 1
    } catch (error) {
      const outcome = await failToastSyncJobInPostgres({ job, error: safeError(error) })
      if (outcome.accepted) failed += 1
      if (outcome.dead) dead += 1
      if (outcome.accepted) {
        await finalizePosAccountingReloadForDateInPostgres({
          organizationId: job.organizationId,
          restaurantGuid: job.restaurantGuid,
          businessDate: job.businessDate,
        }).catch(() => undefined)
      }
    }
  }
  let staleAccountingIssues = { checked: 0, reconciled: 0, failed: 0 }
  let accountingNotifications = { claimed: 0, succeeded: 0, failed: 0, dead: 0 }
  let accountingNotificationError: string | null = null
  try {
    staleAccountingIssues = await reconcileStaleOpenPosAccountingIssuesInPostgres({ limit: 1 })
    accountingNotifications = await processPosAccountingNotificationOutbox({ limit: 2, workerId })
  } catch (error) {
    accountingNotificationError = safeError(error)
  }
  return {
    claimed: jobs.length,
    succeeded,
    failed,
    dead,
    deferred,
    automaticTargets,
    staleAccountingIssues,
    accountingNotifications,
    accountingNotificationError,
  }
}
