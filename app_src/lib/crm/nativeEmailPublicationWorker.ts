import { randomUUID } from 'node:crypto'
import { NativeEmailPublicationHeld, requireNativeEmail, verifyNativeEmailTerminalReceipt,
  type NativeEmailAdmission, type NativeEmailPublicationRequest, type NativeEmailTerminalReceipt } from './nativeEmailPublication'
import type { NativeEmailPublicationWorkContext, NativeEmailPublicationWorkLease } from './nativeEmailPublicationWorkContext'
import type { CrmOutboxItem } from '../persistence/crm'

export type NativeEmailWorkerMode = { enabled: boolean; activeOperationId: string | null; activeTransitionId: string | null }
export type NativeEmailWorkerCandidate = { request: NativeEmailPublicationRequest; context: NativeEmailPublicationWorkContext }
export type NativeEmailWorkerSettlement = { synchronized: boolean; pipelineId: string; outboxId: string | null; projectionQueued?: boolean }
export type NativeEmailWorkerPersistence = {
  mode(): Promise<NativeEmailWorkerMode>
  candidate(item: CrmOutboxItem): Promise<NativeEmailWorkerCandidate>
  admit(item: CrmOutboxItem, candidate: NativeEmailWorkerCandidate, owner: string): Promise<{ admission: NativeEmailAdmission; lease: NativeEmailPublicationWorkLease }>
  markDispatched(request: NativeEmailPublicationRequest, lease: NativeEmailPublicationWorkLease): Promise<boolean>
  markUnknown(operationId: string): Promise<void>
  claimResolution(operationId: string, owner: string): Promise<{ admission: NativeEmailAdmission; lease: NativeEmailPublicationWorkLease }>
  settle(request: NativeEmailPublicationRequest, lease: NativeEmailPublicationWorkLease, value: unknown): Promise<NativeEmailWorkerSettlement>
  hold(item: CrmOutboxItem, code: string, maxAttempts: number): Promise<void>
}
export type NativeEmailWorkerClient = {
  prepare(command: NativeEmailPublicationRequest['command']): Promise<void>
  publish(command: NativeEmailPublicationRequest['command']): Promise<unknown>
  resolveOrCancel(command: NativeEmailPublicationRequest['command']): Promise<unknown>
}
export function touchesNativeEmail(item: CrmOutboxItem): boolean {
  return item.operation !== 'upsert_user_identity'
    && (item.payload?.suiteCrmModule === 'Emails' || item.payload?.previousSuiteCrmModule === 'Emails')
}
export function nativeEmailWorkerHeldCode(error: unknown): string {
  return error instanceof NativeEmailPublicationHeld && /^[a-z][a-z0-9_]{0,99}$/.test(error.code)
    ? error.code : 'native_email_publication_held'
}
function assertWorkerMode(mode: NativeEmailWorkerMode) {
  const pointer = (value: unknown) => value === null || typeof value === 'string' && /^[a-f0-9]{64}(?![\s\S])/.test(value)
  requireNativeEmail(typeof mode?.enabled === 'boolean' && pointer(mode.activeOperationId) && pointer(mode.activeTransitionId),
    'native_publication_control_missing')
  requireNativeEmail(mode.enabled || mode.activeOperationId === null && mode.activeTransitionId === null, 'disabled_mode_has_active_admission')
  requireNativeEmail(mode.activeOperationId === null || mode.activeTransitionId === null, 'native_publication_control_inconsistent')
}

/** Default-off coordinator. DB policy is authoritative on EVERY dispatch. No
 * provider call is made inside a persistence callback/transaction. A failed
 * response is never interpreted as no-write, and no active path falls back to
 * the legacy Email writer. Historical repair execution is deliberately absent. */
export function createNativeEmailPublicationWorker(persistence: NativeEmailWorkerPersistence,
  client: NativeEmailWorkerClient, owner = randomUUID()) {
  const terminal = async (request: NativeEmailPublicationRequest, run: () => Promise<unknown>): Promise<NativeEmailTerminalReceipt> => {
    try { return verifyNativeEmailTerminalReceipt(request, await run()) }
    catch {
      await persistence.markUnknown(request.command.operationId)
      throw new NativeEmailPublicationHeld('native_outcome_unknown')
    }
  }
  return {
    async resume(): Promise<{ enabled: boolean; blocked: boolean; settled?: NativeEmailWorkerSettlement }> {
      const mode = await persistence.mode()
      assertWorkerMode(mode)
      if (mode.activeTransitionId !== null) return { enabled: true, blocked: true }
      if (!mode.enabled || mode.activeOperationId === null) return { enabled: mode.enabled, blocked: false }
      try {
        const { admission, lease } = await persistence.claimResolution(mode.activeOperationId, owner)
        // Repair requires an independently reviewed manifest authorization path,
        // not a worker's possession of a matching hash or old command.
        requireNativeEmail(admission.request.command.mode === 'publish', 'repair_resolution_needs_reviewed_authority')
        const receipt = await terminal(admission.request, () => client.resolveOrCancel(admission.request.command))
        const settled = await persistence.settle(admission.request, lease, receipt)
        return { enabled: true, blocked: false, settled }
      } catch { return { enabled: true, blocked: true } }
    },
    async process(item: CrmOutboxItem, maxAttempts: number): Promise<
      { handled: false } | { handled: true; status: 'succeeded' | 'held'; settled?: NativeEmailWorkerSettlement }
    > {
      if (!touchesNativeEmail(item)) return { handled: false }
      // A missing/unreadable/inconsistent control row must throw, not opt back
      // into the old writer. The caller must not generic-fail that uncertainty.
      const mode = await persistence.mode()
      assertWorkerMode(mode)
      if (!mode.enabled) return { handled: false }
      try {
        requireNativeEmail(mode.activeTransitionId === null, 'native_authority_transition_unresolved')
        requireNativeEmail(mode.activeOperationId === null, 'another_publication_unresolved')
        requireNativeEmail(item.operation === 'upsert_record' && item.payload.suiteCrmModule === 'Emails'
          && !item.payload.previousSuiteCrmModule, 'native_email_transition_not_supported')
        const candidate = await persistence.candidate(item)
        await client.prepare(candidate.request.command)
        // Revalidate the exact source/claim/audience AFTER read-only provider
        // preparation and persist admission BEFORE any native mutation.
        const { admission, lease } = await persistence.admit(item, candidate, owner)
        requireNativeEmail(!admission.receipt, 'terminal_admission_requires_reconciliation')
        requireNativeEmail(await persistence.markDispatched(admission.request, lease), 'reconciliation_required')
        const receipt = await terminal(admission.request, () => client.publish(admission.request.command))
        const settled = await persistence.settle(admission.request, lease, receipt)
        return { handled: true, status: receipt.state === 'committed' ? 'succeeded' : 'held', settled }
      } catch (error) {
        // hold() is itself control-serialized and refuses to change any outbox
        // whose native outcome is unresolved, including an admission-commit
        // response lost before this process learned whether it succeeded.
        await persistence.hold(item, nativeEmailWorkerHeldCode(error), maxAttempts)
        return { handled: true, status: 'held' }
      }
    },
  }
}
