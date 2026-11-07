import 'server-only'
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, openSync, realpathSync, writeFileSync, type Stats } from 'node:fs'
import { dirname, isAbsolute, resolve } from 'node:path'
import { types } from 'node:util'
import { nativeEmailCanonicalJson, requireNativeEmail } from './nativeEmailPublication'

const purpose = 'clawpilot-private-native-email-account-repair-journal-v1' as const
const keys = ['version', 'purpose', 'operationId', 'reviewDigest', 'approvalDigest', 'targetFingerprint', 'fenceEpoch'] as const
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}(?![\s\S])/u
const hash = /^[0-9a-f]{64}(?![\s\S])/u

export type NativeEmailAccountRepairJournal = Readonly<{
  version: 1
  purpose: typeof purpose
  operationId: string
  reviewDigest: string
  approvalDigest: string
  targetFingerprint: string
  fenceEpoch: string
}>

function need(value: unknown, code: string): asserts value {
  requireNativeEmail(value, 'legacy_email_account_repair_journal_' + code)
}

function matches(value: unknown, pattern: RegExp): value is string {
  return typeof value === 'string' && pattern.test(value)
}

/** Input is already protected and canonically decoded by the caller. Refuse
 * extra fields rather than silently accepting an alternate scope or secret. */
export function parseNativeEmailAccountRepairJournal(value: unknown): NativeEmailAccountRepairJournal {
  need(value && typeof value === 'object' && !types.isProxy(value) && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value)), 'shape')
  need(Reflect.ownKeys(value).length === keys.length && keys.every(key => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    return descriptor?.enumerable && 'value' in descriptor
  }), 'shape')
  const { version, purpose: domain, operationId, reviewDigest, approvalDigest, targetFingerprint, fenceEpoch }
    = value as Record<typeof keys[number], unknown>
  need(version === 1 && domain === purpose, 'domain')
  need(matches(operationId, uuid) && matches(fenceEpoch, uuid) && matches(reviewDigest, hash)
    && matches(approvalDigest, hash) && matches(targetFingerprint, hash), 'pins')
  return Object.freeze({ version, purpose: domain, operationId, reviewDigest, approvalDigest, targetFingerprint, fenceEpoch })
}

const sameEntry = (left: Stats, right: Stats) => left.dev === right.dev && left.ino === right.ino
const ownedDirectory = (entry: Stats, uid: number) => entry.isDirectory() && entry.uid === uid && (entry.mode & 0o7777) === 0o700
const ownedFile = (entry: Stats, uid: number) => entry.isFile() && entry.uid === uid && entry.nlink === 1
  && (entry.mode & 0o7777) === 0o600

/** Reserve this execution exactly once, even if a previous attempt left an
 * empty or partial journal. A failure is never a reason to remove or rewrite
 * the path: the operator may only inspect the exact retained operation pins. */
export function reserveNativeEmailAccountRepairJournal(path: string, input: unknown): NativeEmailAccountRepairJournal {
  const pins = parseNativeEmailAccountRepairJournal(input)
  writeNativeEmailPrivateJournalOnce(path, nativeEmailCanonicalJson(pins) + '\n', 'legacy_email_account_repair_journal_')
  return pins
}

/** Internal filesystem primitive. Each caller must first parse and encode
 * its own exact journal domain. No fallback, overwrite, or removal. */
export function writeNativeEmailPrivateJournalOnce(path: string, bytes: string,
  codePrefix: 'legacy_email_account_repair_journal_' | 'legacy_email_archive_journal_'): void {
  function requireFile(value: unknown, code: string): asserts value {
    requireNativeEmail(value, codePrefix + code)
  }
  const uid = process.geteuid?.()
  const size = Buffer.byteLength(bytes, 'utf8')
  requireFile(size > 0 && size <= 4096, 'size')
  requireFile(typeof path === 'string' && isAbsolute(path) && resolve(path) === path && dirname(path) !== path
    && Buffer.byteLength(path, 'utf8') <= 4096 && Buffer.from(path, 'utf8').toString('utf8') === path
    && !/\p{Cc}/u.test(path), 'path')
  const parent = dirname(path)
  requireFile(typeof uid === 'number' && Number.isSafeInteger(uid) && uid >= 0
    && realpathSync(parent) === parent && ownedDirectory(lstatSync(parent), uid), 'directory')
  const directory = openSync(parent, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  try {
    const parentEntry = fstatSync(directory)
    const checkParent = () => requireFile(ownedDirectory(parentEntry, uid) && sameEntry(parentEntry, lstatSync(parent))
      && ownedDirectory(fstatSync(directory), uid), 'directory')
    checkParent()
    let file: number
    try {
      file = openSync(path, constants.O_WRONLY | constants.O_EXCL | constants.O_NOFOLLOW | constants.O_CREAT, 0o600)
    } catch (error) {
      requireFile((error as NodeJS.ErrnoException).code !== 'EEXIST', 'already_reserved')
      throw error
    }
    try {
      const entry = fstatSync(file)
      const checkFile = (size: number) => {
        const current = fstatSync(file)
        requireFile(ownedFile(current, uid) && current.size === size && sameEntry(entry, lstatSync(path)), 'file')
      }
      checkParent()
      checkFile(0)
      writeFileSync(file, bytes, 'utf8')
      fsyncSync(file)
      checkFile(size)
      checkParent()
      fsyncSync(directory)
      checkParent()
      checkFile(size)
    } finally { closeSync(file) }
  } finally { closeSync(directory) }
}
