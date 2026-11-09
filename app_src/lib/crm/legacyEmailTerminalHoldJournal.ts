import 'server-only'
import { types } from 'node:util'
import { writeNativeEmailPrivateJournalOnce } from './nativeEmailAccountRepairJournal'
import { nativeEmailCanonicalJson, requireNativeEmail } from './nativeEmailPublication'

const purpose = 'clawpilot-private-legacy-email-terminal-hold-journal-v1' as const
const keys = ['version', 'purpose', 'operationId', 'manifestDigest', 'approvalDigest',
  'targetFingerprint', 'fenceEpoch', 'expectedRows'] as const
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}(?![\s\S])/u
const hash = /^[0-9a-f]{64}(?![\s\S])/u
const prefix = 'legacy_email_terminal_hold_journal_' as const

export type LegacyEmailTerminalHoldJournal = Readonly<{
  version: 1; purpose: typeof purpose; operationId: string; manifestDigest: string
  approvalDigest: string; targetFingerprint: string; fenceEpoch: string; expectedRows: number
}>

function need(value: unknown, code: string): asserts value { requireNativeEmail(value, prefix + code) }
function matches(value: unknown, pattern: RegExp): value is string {
  return typeof value === 'string' && pattern.test(value)
}

/** Scalar resolution pins only. This is neither an approval nor a replay token. */
export function parseLegacyEmailTerminalHoldJournal(value: unknown): LegacyEmailTerminalHoldJournal {
  need(value && typeof value === 'object' && !types.isProxy(value) && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value)), 'shape')
  need(Reflect.ownKeys(value).length === keys.length && keys.every(key => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    return descriptor?.enumerable && 'value' in descriptor
  }), 'shape')
  const { version, purpose: domain, operationId, manifestDigest, approvalDigest, targetFingerprint,
    fenceEpoch, expectedRows } = value as Record<typeof keys[number], unknown>
  need(version === 1 && domain === purpose, 'domain')
  need(matches(operationId, uuid) && matches(fenceEpoch, uuid) && matches(manifestDigest, hash)
    && matches(approvalDigest, hash) && matches(targetFingerprint, hash)
    && typeof expectedRows === 'number' && Number.isSafeInteger(expectedRows)
    && expectedRows >= 1 && expectedRows <= 25, 'pins')
  return Object.freeze({ version, purpose: domain, operationId, manifestDigest, approvalDigest,
    targetFingerprint, fenceEpoch, expectedRows })
}

/** Reserve before the first possible write. Even partial bytes forbid a second
 * attempt: inspect the same original operation, never delete or overwrite. */
export function reserveLegacyEmailTerminalHoldJournal(path: string, input: unknown): LegacyEmailTerminalHoldJournal {
  const pins = parseLegacyEmailTerminalHoldJournal(input)
  writeNativeEmailPrivateJournalOnce(path, nativeEmailCanonicalJson(pins) + '\n', prefix)
  return pins
}
