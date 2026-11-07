import 'server-only'
import { types } from 'node:util'
import { writeNativeEmailPrivateJournalOnce } from './nativeEmailAccountRepairJournal'
import { nativeEmailCanonicalJson, requireNativeEmail } from './nativeEmailPublication'

const purpose = 'clawpilot-private-native-email-archive-journal-v1' as const
const keys = ['version', 'purpose', 'operationId', 'manifestDigest', 'approvalDigest', 'targetFingerprint', 'fenceEpoch'] as const
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}(?![\s\S])/u
const hash = /^[0-9a-f]{64}(?![\s\S])/u

export type NativeEmailArchiveJournal = Readonly<{
  version: 1
  purpose: typeof purpose
  operationId: string
  manifestDigest: string
  approvalDigest: string
  targetFingerprint: string
  fenceEpoch: string
}>

function need(value: unknown, code: string): asserts value {
  requireNativeEmail(value, 'legacy_email_archive_journal_' + code)
}

function matches(value: unknown, pattern: RegExp): value is string {
  return typeof value === 'string' && pattern.test(value)
}

/** Accept only scalar pins from the protected, canonically decoded journal,
 * not the manifest, signature, database credentials or mailbox data. */
export function parseNativeEmailArchiveJournal(value: unknown): NativeEmailArchiveJournal {
  need(value && typeof value === 'object' && !types.isProxy(value) && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value)), 'shape')
  need(Reflect.ownKeys(value).length === keys.length && keys.every(key => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    return descriptor?.enumerable && 'value' in descriptor
  }), 'shape')
  const { version, purpose: domain, operationId, manifestDigest, approvalDigest, targetFingerprint, fenceEpoch }
    = value as Record<typeof keys[number], unknown>
  need(version === 1 && domain === purpose, 'domain')
  need(matches(operationId, uuid) && matches(fenceEpoch, uuid) && matches(manifestDigest, hash)
    && matches(approvalDigest, hash) && matches(targetFingerprint, hash), 'pins')
  return Object.freeze({ version, purpose: domain, operationId, manifestDigest, approvalDigest, targetFingerprint, fenceEpoch })
}

/** Exactly one reservation, even when an older attempt left partial bytes.
 * Resolve an uncertain attempt by inspecting its receipt, never by retry. */
export function reserveNativeEmailArchiveJournal(path: string, input: unknown): NativeEmailArchiveJournal {
  const pins = parseNativeEmailArchiveJournal(input)
  writeNativeEmailPrivateJournalOnce(path, nativeEmailCanonicalJson(pins) + '\n', 'legacy_email_archive_journal_')
  return pins
}
