import crypto from 'crypto'
import {
  getToastAnalyticsPayouts,
  getToastAnalyticsSales,
  getToastStandardOrders,
  type ToastRuntimeCredential,
} from '@/lib/integrations/toastClient'
import { decryptToastClientSecret } from '@/lib/integrations/toastCredentialCrypto'
import {
  claimToastSyncJobsInPostgres,
  completeToastSyncJobInPostgres,
  deferToastSyncJobInPostgres,
  failToastSyncJobInPostgres,
  listToastAutomaticSyncTargetsInPostgres,
  queueAutomaticToastSyncInPostgres,
  readToastRuntimeCredentialFromPostgres,
  refreshToastAccountingDraftInPostgres,
  storeToastSnapshotsInPostgres,
  updateToastStandardOrdersCountInPostgres,
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
      await deferToastSyncJobInPostgres({
        id: job.id,
        requestState: { reportRequestGuid: report.requestGuid },
        delaySeconds: 15,
      })
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
    await completeToastSyncJobInPostgres({ job, resultSummary: { records: report.records.length, totals } })
    await refreshToastAccountingDraftInPostgres(job)
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
      await deferToastSyncJobInPostgres({
        id: job.id,
        requestState: { reportRequestGuid: report.requestGuid },
        delaySeconds: 20,
      })
      return { deferred: true }
    }
    await storeToastSnapshotsInPostgres({
      job,
      sourceKind: 'analytics_payout',
      records: report.records.map((payload, index) => ({
        sourceId: sourceId(payload, `${report.requestGuid}:${index}`), payload,
      })),
    })
    await completeToastSyncJobInPostgres({ job, resultSummary: { records: report.records.length } })
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
  await updateToastStandardOrdersCountInPostgres({ job, count: orders.length })
  await completeToastSyncJobInPostgres({ job, resultSummary: { records: orders.length } })
  await refreshToastAccountingDraftInPostgres(job)
  return { deferred: false }
}

async function queueAutomaticSyncs() {
  const targets = await listToastAutomaticSyncTargetsInPostgres()
  for (const target of targets) {
    await queueAutomaticToastSyncInPostgres({
      ...target,
      businessDate: previousBusinessDate(target.timezone),
    })
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
      const becameDead = await failToastSyncJobInPostgres({ job, error: safeError(error) })
      failed += 1
      if (becameDead) dead += 1
    }
  }
  return { claimed: jobs.length, succeeded, failed, dead, deferred, automaticTargets }
}
