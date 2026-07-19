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
  claimToastSyncJobsInPostgres,
  completeToastSyncJobInPostgres,
  deferToastSyncJobInPostgres,
  failToastSyncJobInPostgres,
  listToastAutomaticSyncTargetsInPostgres,
  queueAutomaticToastSyncInPostgres,
  queueAutomaticToastOrderUpdateInPostgres,
  readToastRuntimeCredentialFromPostgres,
  refreshToastAccountingDraftInPostgres,
  storeToastSnapshotsInPostgres,
  projectToastStandardOrdersInPostgres,
  upsertToastAnalyticsSalesInPostgres,
  type ToastSyncJob,
} from '@/lib/persistence/toastIntegrations'

function previousBusinessDate(timezoneValue: string | null) {
  const timezone = timezoneValue || 'UTC'
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(new Date())
    const value = Object.fromEntries(parts.map((part) => [part.type, part.value]))
    const today = new Date(Date.UTC(Number(value.year), Number(value.month) - 1, Number(value.day)))
    today.setUTCDate(today.getUTCDate() - 1)
    return today.toISOString().slice(0, 10)
  } catch {
    const yesterday = new Date(Date.now() - 86_400_000)
    return yesterday.toISOString().slice(0, 10)
  }
}

function offsetDate(dateValue: string, days: number) {
  const date = new Date(`${dateValue}T00:00:00.000Z`)
  date.setUTCDate(date.getUTCDate() + days)
  return date.toISOString().slice(0, 10)
}

function modifiedWindow(dateValue: string) {
  return {
    startDate: `${dateValue}T00:00:00.000Z`,
    endDate: `${offsetDate(dateValue, 1)}T00:00:00.000Z`,
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
    const datedJob = { ...job, businessDate }
    await refreshToastAccountingDraftInPostgres(datedJob)
    await reconcilePosAccountingIssueForDateInPostgres({
      organizationId: job.organizationId,
      restaurantGuid: job.restaurantGuid,
      businessDate,
    })
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
    await refreshAccountingState(job, [job.businessDate])
    if (!await completeToastSyncJobInPostgres({ job, resultSummary: { records: report.records.length, totals } })) {
      throw new Error('Toast sync worker lease expired')
    }
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
    if (!await completeToastSyncJobInPostgres({ job, resultSummary: { records: report.records.length } })) {
      throw new Error('Toast sync worker lease expired')
    }
    return { deferred: false }
  }
  if (job.syncKind === 'standard_order_updates') {
    const updates = await getToastStandardOrderUpdates({
      credential,
      restaurantGuid: job.restaurantGuid,
      ...modifiedWindow(job.businessDate),
    })
    const affectedDates = [...new Set(updates.map(orderBusinessDate).filter((value): value is string => Boolean(value)))].sort()
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
      await projectToastStandardOrdersInPostgres({ job: datedJob, orders })
    }
    await refreshAccountingState(job, affectedDates)
    if (!await completeToastSyncJobInPostgres({
      job,
      resultSummary: { records: updates.length, affectedBusinessDates: affectedDates },
    })) throw new Error('Toast sync worker lease expired')
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
  await refreshAccountingState(job, [job.businessDate])
  if (!await completeToastSyncJobInPostgres({ job, resultSummary: { records: orders.length, totals } })) {
    throw new Error('Toast sync worker lease expired')
  }
  return { deferred: false }
}

async function queueAutomaticSyncs() {
  const targets = await listToastAutomaticSyncTargetsInPostgres()
  for (const target of targets) {
    const businessDate = previousBusinessDate(target.timezone)
    await queueAutomaticToastSyncInPostgres({
      ...target,
      businessDate,
    })
    if (target.standardEnabled) {
      for (const catchUpDate of catchUpDates(target.latestStandardUpdateDate, businessDate)) {
        await queueAutomaticToastOrderUpdateInPostgres({ ...target, businessDate: catchUpDate })
      }
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
    }
  }
  let staleAccountingIssues = { checked: 0, reconciled: 0, failed: 0 }
  let accountingNotifications = { claimed: 0, succeeded: 0, failed: 0, dead: 0 }
  let accountingNotificationError: string | null = null
  try {
    staleAccountingIssues = await reconcileStaleOpenPosAccountingIssuesInPostgres({ limit: 1 })
    accountingNotifications = await processPosAccountingNotificationOutbox({ limit: 10, workerId })
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
