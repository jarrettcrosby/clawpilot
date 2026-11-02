import { deleteSuiteCrmRecord, requestSuiteCrmNativeRecordLifecycle } from '@/lib/crm/suiteCrmClient'
import type { SuiteCrmOutboxRecord } from '@/lib/crm/types'

export type SuiteCrmRecordLifecycleIdentity = {
  module: 'Accounts' | 'Contacts'
  nativeId: string
  globalId: string
}

export type SuiteCrmRecordLifecycleSnapshot = SuiteCrmRecordLifecycleIdentity & {
  state: 'active' | 'deleted' | 'missing'
  dateModified: string | null
}

export class SuiteCrmRecordLifecycleUnavailableError extends Error {
  readonly code = 'SUITECRM_RECORD_LIFECYCLE_UNAVAILABLE'
  constructor() {
    super('SuiteCRM record lifecycle inspection is unavailable; no deletion was confirmed')
    this.name = 'SuiteCrmRecordLifecycleUnavailableError'
  }
}

function requireLifecycle(condition: unknown): asserts condition {
  if (!condition) throw new SuiteCrmRecordLifecycleUnavailableError()
}

function exactObject(value: unknown, keys: string[]): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join(',') === [...keys].sort().join(','))
}

function validIdentity(value: unknown): value is SuiteCrmRecordLifecycleIdentity {
  if (!exactObject(value, ['module', 'nativeId', 'globalId'])) return false
  const prefix = value.module === 'Accounts' ? 'ga' : value.module === 'Contacts' ? 'gc' : null
  return Boolean(prefix && typeof value.nativeId === 'string'
    && /^[a-zA-Z0-9][a-zA-Z0-9-]{0,63}$(?![\s\S])/.test(value.nativeId)
    && typeof value.globalId === 'string'
    && new RegExp(`^${prefix}(?:[0-9]{7}|[0-9a-v]{12})$(?![\\s\\S])`).test(value.globalId))
}

function validNativeDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$(?![\s\S])/.test(value)) return false
  const date = new Date(value.replace(' ', 'T') + 'Z')
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 19).replace('T', ' ') === value
}

/** Exact, read-only provider evidence. A missing row, HTTP 404, disabled route,
 * or malformed response is NEVER evidence that a local record was deleted.
 * The caller still owns pipeline/local-record binding and archive authorization.
 * No provider-wide scan, deletion, automatic retry, or fallback is performed. */
export async function inspectSuiteCrmRecordLifecycle(
  records: readonly SuiteCrmRecordLifecycleIdentity[],
  fetchImpl: typeof fetch = fetch,
): Promise<SuiteCrmRecordLifecycleSnapshot[]> {
  try {
    requireLifecycle(Array.isArray(records) && records.length <= 100)
    if (records.length === 0) return []
    requireLifecycle(process.env.CLAWPILOT_NATIVE_RECORD_LIFECYCLE_ENABLED === '1')
    const nativeIds = new Set<string>(), globalIds = new Set<string>()
    const requested = records.map(record => {
      requireLifecycle(validIdentity(record))
      const nativeKey = `${record.module}:${record.nativeId.toLowerCase()}`
      requireLifecycle(!nativeIds.has(nativeKey) && !globalIds.has(record.globalId))
      nativeIds.add(nativeKey); globalIds.add(record.globalId)
      return { module: record.module, nativeId: record.nativeId, globalId: record.globalId }
    })
    const response = await requestSuiteCrmNativeRecordLifecycle({ version: 1, records: requested }, fetchImpl)
    requireLifecycle(exactObject(response, ['version', 'records']) && response.version === 1
      && Array.isArray(response.records) && response.records.length === requested.length)
    return response.records.map((entry: unknown, index: number) => {
      requireLifecycle(exactObject(entry, ['module', 'nativeId', 'globalId', 'state', 'dateModified']))
      const identity = requested[index]
      requireLifecycle(entry.module === identity.module && entry.nativeId === identity.nativeId
        && entry.globalId === identity.globalId
        && ['active', 'deleted', 'missing'].includes(String(entry.state)))
      requireLifecycle(entry.state === 'missing' ? entry.dateModified === null : validNativeDate(entry.dateModified))
      return { ...identity, state: entry.state, dateModified: entry.dateModified } as SuiteCrmRecordLifecycleSnapshot
    })
  } catch {
    // Provider diagnostics may contain credentials, record contents or SQL.
    // Deliberately return one safe held state, with no partial batch evidence.
    throw new SuiteCrmRecordLifecycleUnavailableError()
  }
}

/** Called under the persistence layer's exact-record lifecycle/advisory guard.
 * The generic V8 DELETE tolerates 404; this wrapper does not count that as
 * success. Only an exact positive native tombstone settles the outgoing delete. */
export async function deleteSuiteCrmAccountContactVerified(
  record: SuiteCrmOutboxRecord,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  try {
    requireLifecycle(record && (record.entity === 'organizations' || record.entity === 'contacts'))
    const moduleName = record.entity === 'organizations' ? 'Accounts' : 'Contacts'
    requireLifecycle((record.suiteCrmModule === undefined || String(record.suiteCrmModule) === moduleName)
      && record.previousSuiteCrmModule === undefined
      && record.attributes && typeof record.attributes.global_id_c === 'string')
    const identity: SuiteCrmRecordLifecycleIdentity = {
      module: moduleName, nativeId: record.suiteCrmId, globalId: record.attributes.global_id_c,
    }
    requireLifecycle(validIdentity(identity))
    // Snapshot the target before awaiting provider I/O; caller mutation must not
    // change the native ID or module between inspection and DELETE.
    const deletion = { ...record, suiteCrmId: identity.nativeId, attributes: { global_id_c: identity.globalId } }
    const [before] = await inspectSuiteCrmRecordLifecycle([identity], fetchImpl)
    if (before.state === 'deleted') return
    requireLifecycle(before.state === 'active')
    await deleteSuiteCrmRecord(deletion, fetchImpl)
    const [after] = await inspectSuiteCrmRecordLifecycle([identity], fetchImpl)
    requireLifecycle(after.state === 'deleted')
  } catch {
    throw new SuiteCrmRecordLifecycleUnavailableError()
  }
}
