import 'server-only'
import { types } from 'node:util'
import {
  previewExactLegacyEmailRecoveryStagePrivately,
  resolveExactLegacyEmailStagePrivately,
  stageExactLegacyEmailRecoveryPrivately,
} from '../persistence/crmLegacyEmailRecoveryStage'
import type { withTransaction } from '../persistence/postgres'
import {
  assertVerifiedLegacyEmailRecoveryReleaseApproval,
  type LegacyEmailRecoveryReleaseApproval,
} from './legacyEmailRecoveryReleaseApproval'
import { nativeEmailDigest, requireNativeEmail } from './nativeEmailPublication'

type StageTarget = Parameters<typeof previewExactLegacyEmailRecoveryStagePrivately>[1] & {
  expectedOrganizations: { primaryNativeId: string; nativeIds: string[] }
}
type StageSelection = { holdId: string; outboxId: string; nativeOperationId: string; requestFingerprint: string }

const HASH = /^[a-f0-9]{64}(?![\s\S])/u
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}(?![\s\S])/u
const GLOBAL_ID = /^gi(?:[0-9]{7}|[0-9a-v]{12})(?![\s\S])/u
const GMAIL_ID = /^[a-f0-9]{1,128}(?![\s\S])/u
const CONNECTION_ID = /^[A-Za-z0-9_-]{1,200}(?![\s\S])/u
const EMAIL = /^[^\s@\p{Cc}]+@[^\s@\p{Cc}]+\.[^\s@\p{Cc}]+(?![\s\S])/u
const selectionKeys = ['holdId', 'outboxId', 'nativeOperationId', 'requestFingerprint'] as const
const targetKeys = ['selected', 'retiredOutboxId', 'retirementReceiptHash', 'holdId', 'outboxId', 'lockToken', 'expectedOrganizations'] as const
const selectedKeys = ['ownerEmail', 'workspaceId', 'pipelineId', 'connectionId', 'messageIds'] as const
const previewPinKeys = [...selectionKeys, 'retiredOutboxId', 'retirementReceiptHash', 'localId', 'nativeId', 'globalId',
  'pipelineId', 'workspaceId', 'sourceFingerprint', 'activationReceiptHash'] as const

function need(value: unknown, code: string): asserts value {
  requireNativeEmail(value, 'private_native_email_stage_' + code)
}
function matches(value: unknown, expression: RegExp): value is string {
  return typeof value === 'string' && expression.test(value)
}
function hasDataKey(value: object, key: string): boolean {
  const descriptor = Object.getOwnPropertyDescriptor(value, key)
  return !!descriptor?.enumerable && 'value' in descriptor
}
function exact(value: unknown, keys: readonly string[], code: string): asserts value is Record<string, unknown> {
  need(value && typeof value === 'object' && !types.isProxy(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value))
    && Reflect.ownKeys(value).length === keys.length && keys.every(key => hasDataKey(value, key)), code)
}
function exactArray(value: unknown, min: number, max: number, code: string): asserts value is unknown[] {
  need(value && typeof value === 'object' && !types.isProxy(value) && Array.isArray(value)
    && Object.getPrototypeOf(value) === Array.prototype && value.length >= min && value.length <= max
    && Reflect.ownKeys(value).length === value.length + 1
    && Array.from({ length: value.length }, (_, index) => String(index)).every(key => hasDataKey(value, key)), code)
}

/** Snapshot precisely one reviewed mailbox message and its explicit, ordered
 * organization expectation before any database call. */
export function parseNativeEmailRecoveryStageTarget(value: unknown): StageTarget {
  exact(value, targetKeys, 'target')
  const { selected, retiredOutboxId, retirementReceiptHash, holdId, outboxId, lockToken, expectedOrganizations } = value
  need(matches(retiredOutboxId, UUID) && matches(holdId, UUID) && matches(outboxId, UUID)
    && matches(lockToken, UUID) && retiredOutboxId !== outboxId && matches(retirementReceiptHash, HASH), 'target')
  exact(selected, selectedKeys, 'mailbox')
  const { ownerEmail, workspaceId, pipelineId, connectionId, messageIds } = selected
  need(matches(ownerEmail, EMAIL) && ownerEmail.length <= 254 && ownerEmail === ownerEmail.toLowerCase()
    && matches(workspaceId, UUID) && matches(pipelineId, UUID) && matches(connectionId, CONNECTION_ID), 'mailbox')
  exactArray(messageIds, 1, 1, 'one_message')
  const [messageId] = messageIds
  need(matches(messageId, GMAIL_ID), 'one_message')

  exact(expectedOrganizations, ['primaryNativeId', 'nativeIds'], 'organizations')
  const { primaryNativeId, nativeIds } = expectedOrganizations
  exactArray(nativeIds, 1, 25, 'organizations')
  need(matches(primaryNativeId, UUID) && nativeIds.every(id => matches(id, UUID))
    && nativeIds.includes(primaryNativeId) && nativeIds.every((id, index) => index === 0 || nativeIds[index - 1] < id), 'organizations')

  const messages = [messageId], organizations = [...nativeIds]
  Object.freeze(messages)
  Object.freeze(organizations)
  return Object.freeze({ retiredOutboxId, retirementReceiptHash, holdId, outboxId, lockToken,
    selected: Object.freeze({ ownerEmail, workspaceId, pipelineId, connectionId, messageIds: messages }),
    expectedOrganizations: Object.freeze({ primaryNativeId, nativeIds: organizations }),
  })
}

/** The custodian can sign this exact preview scope before the real operation
 * and request fingerprints are known. These are not real publication pins. */
export function nativeEmailRecoveryStagePreviewPins(value: unknown) {
  const target = parseNativeEmailRecoveryStageTarget(value)
  return Object.freeze({
    nativeOperationId: nativeEmailDigest({ version: 1, purpose: 'clawpilot-native-email-stage-preview-operation-v1', target }),
    requestFingerprint: nativeEmailDigest({ version: 1, purpose: 'clawpilot-native-email-stage-preview-request-v1', target }),
  })
}

/** Execute one chosen private staging action. The caller owns custody and a
 * scoped transaction; this adapter never establishes authority or retries. */
export async function runNativeEmailRecoveryPrivateStage(input: {
  action: 'stage-preview' | 'stage' | 'stage-inspect'
  target: unknown
  selection: StageSelection
  intentHash: string | undefined
  approval: Readonly<LegacyEmailRecoveryReleaseApproval> | undefined
  transaction: typeof withTransaction
}) {
  exact(input, ['action', 'target', 'selection', 'intentHash', 'approval', 'transaction'], 'input')
  const { action, selection, intentHash, approval, transaction } = input
  need(typeof transaction === 'function', 'transaction')
  const target = parseNativeEmailRecoveryStageTarget(input.target)
  exact(selection, selectionKeys, 'selection')
  const { holdId, outboxId, nativeOperationId, requestFingerprint } = selection
  need(holdId === target.holdId && outboxId === target.outboxId
    && matches(nativeOperationId, HASH) && matches(requestFingerprint, HASH), 'selection')
  const previewPins = nativeEmailRecoveryStagePreviewPins(target)

  if (action === 'stage-preview') {
    need(nativeOperationId === previewPins.nativeOperationId && requestFingerprint === previewPins.requestFingerprint
      && intentHash === undefined && approval === undefined, 'preview_scope')
    const preview = await previewExactLegacyEmailRecoveryStagePrivately(transaction, target)
    exact(preview, ['pins', 'inspectionDigest'], 'preview_receipt')
    const { pins, inspectionDigest } = preview
    exact(pins, previewPinKeys, 'preview_receipt')
    need(pins.holdId === holdId && pins.outboxId === outboxId && pins.retiredOutboxId === target.retiredOutboxId
      && pins.retirementReceiptHash === target.retirementReceiptHash && pins.pipelineId === target.selected.pipelineId
      && pins.workspaceId === target.selected.workspaceId && matches(pins.localId, UUID) && matches(pins.nativeId, UUID)
      && matches(pins.globalId, GLOBAL_ID) && matches(pins.sourceFingerprint, HASH) && matches(pins.activationReceiptHash, HASH)
      && matches(pins.nativeOperationId, HASH) && pins.nativeOperationId !== nativeOperationId
      && matches(pins.requestFingerprint, HASH) && pins.requestFingerprint !== requestFingerprint
      && matches(inspectionDigest, HASH), 'preview_receipt')
    return Object.freeze({ pins: Object.freeze({ ...pins }), inspectionDigest })
  }

  need(matches(intentHash, HASH) && nativeOperationId !== previewPins.nativeOperationId
    && requestFingerprint !== previewPins.requestFingerprint, 'intent_scope')
  if (action === 'stage-inspect') {
    need(approval === undefined, 'inspect_scope')
    return resolveExactLegacyEmailStagePrivately(transaction, { holdId, outboxId, retiredOutboxId: target.retiredOutboxId, intentHash })
  }
  need(action === 'stage', 'action')
  assertVerifiedLegacyEmailRecoveryReleaseApproval(approval)
  need(approval.holdId === holdId && approval.outboxId === outboxId && approval.nativeOperationId === nativeOperationId
    && approval.requestFingerprint === requestFingerprint && approval.intentHash === intentHash
    && approval.retiredOutboxId === target.retiredOutboxId && approval.retirementReceiptHash === target.retirementReceiptHash
    && approval.pipelineId === target.selected.pipelineId && approval.workspaceId === target.selected.workspaceId, 'approval_scope')
  return stageExactLegacyEmailRecoveryPrivately(transaction, target, approval)
}
