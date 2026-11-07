import 'server-only'
import { requireNativeEmail, type NativeEmailPublicationRequest } from './nativeEmailPublication'
import { verifyNativeEmailPreparation, verifyNativeEmailPublicationReceipt } from './nativeEmailPublicationTransport'
import type { NativeEmailRecoveryDispatchPermit } from './nativeEmailRecoveryDispatchPermit'
import type { NativeEmailRecoveryDeferredPublish } from './nativeEmailRecoveryCliTransport'
import type { createPrivateLegacyEmailRecoveryPersistence } from '../persistence/crmNativeEmailPublication'
import type { NativeEmailPublicationWorkLease } from './nativeEmailPublicationWorkContext'

type Persistence = ReturnType<typeof createPrivateLegacyEmailRecoveryPersistence>
type Packet = Readonly<{request:NativeEmailPublicationRequest;permit:NativeEmailRecoveryDispatchPermit}>

/** Private controller only. The caller supplies independently authorized DB
 * access, a writer fence held by the persistence adapter, and an explicitly
 * pinned native maintenance exchange. No URL or normal OAuth fallback exists. */
export function createNativeEmailRecoveryMaintenanceOperator(options:{persistence:Persistence;
  exchange:(packet:Packet)=>Promise<unknown>;exchangePublish:(input:NativeEmailRecoveryDeferredPublish)=>Promise<unknown>;owner:string}) {
  const {persistence,exchange,exchangePublish,owner}=options
  requireNativeEmail(typeof exchange==='function'&&typeof exchangePublish==='function'
    &&/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}(?![\s\S])/u.test(owner),
    'legacy_dispatch_operator_invalid')
  const sendPublish=async(input:NativeEmailRecoveryDeferredPublish)=>{
    let closing=false, authorization:Promise<NativeEmailRecoveryDispatchPermit>|undefined
    try {
      return await exchangePublish(Object.freeze({...input,authorize:()=>{
        requireNativeEmail(!closing&&!authorization,'legacy_dispatch_authorization_reentered')
        authorization=input.authorize()
        return authorization
      }}))
    } finally {
      closing=true
      // A child can die while the fenced database transaction is in flight.
      // Classify the exact admission only after that call commits or aborts.
      if(authorization)await authorization.catch(()=>{})
    }
  }
  const finish=(request:NativeEmailPublicationRequest,committedLease:()=>NativeEmailPublicationWorkLease|null,
    send:()=>Promise<unknown>,publishMode?:'initial'|'admitted')=> (async()=>{
      let terminal
      try {
        terminal=verifyNativeEmailPublicationReceipt(request,await send())
      } catch (error) {
        if(publishMode){
          // Only durable state can say the first publish permit was never
          // committed. A lost database acknowledgement is not a zero-byte proof.
          const state=await persistence.maintenancePublishState(request)
          if(publishMode==='initial'?state==='not_admitted':state==='admitted')throw error
          requireNativeEmail(state==='dispatched'||state==='unknown','native_outcome_unknown')
        }
        await persistence.markUnknown(request.command.operationId)
        requireNativeEmail(false,'native_outcome_unknown')
      }
      // Finish under the same external writer fence, but never hold a PG
      // transaction during the native action. A PG acknowledgement loss does
      // not trigger another native call in this invocation.
      const lease=committedLease()
      requireNativeEmail(lease,'reconciliation_required')
      return persistence.settle(request,lease,terminal)
    })()
  const publishAdmitted=(request:NativeEmailPublicationRequest,lease:NativeEmailPublicationWorkLease)=>
    persistence.withMaintenancePublish(request,lease,input=>finish(request,()=>lease,()=>sendPublish(input),'admitted'))
  return Object.freeze({
    async publish() {
      const mode=await persistence.mode()
      requireNativeEmail(mode.enabled&&mode.activeTransitionId===null,'native_publication_not_available')
      if(mode.activeOperationId){
        // A failed readiness proof leaves the exact original admission in
        // place; reclaim its lease, never repeat native prepare or create a
        // second admission. A committed dispatch is resolution-only.
        const {admission,lease}=await persistence.claimResolution(mode.activeOperationId,owner)
        requireNativeEmail(!admission.receipt&&admission.state==='admitted','native_publication_not_available')
        return publishAdmitted(admission.request,lease)
      }
      const item=await persistence.loadItem(),expected=await persistence.candidate(item)
      await persistence.withMaintenanceDispatch({action:'prepare',item},async packet=>{
        requireNativeEmail(packet.request.requestFingerprint===expected.request.requestFingerprint,'legacy_dispatch_candidate_changed')
        await verifyNativeEmailPreparation(packet.request.command,()=>exchange(packet))
      })
      return persistence.withMaintenanceInitialPublish(item,expected,owner,(input,committedLease)=>
        finish(input.request,committedLease,()=>sendPublish(input),'initial'))
    },
    async resolve() {
      const mode=await persistence.mode()
      requireNativeEmail(mode.enabled&&mode.activeTransitionId===null&&mode.activeOperationId,'legacy_dispatch_no_unresolved_operation')
      const {admission,lease}=await persistence.claimResolution(mode.activeOperationId,owner)
      requireNativeEmail(admission.state==='dispatched'||admission.state==='unknown','legacy_dispatch_publish_not_sent')
      return persistence.withMaintenanceDispatch({action:'resolve',request:admission.request,lease},packet=>
        finish(packet.request,()=>lease,()=>exchange(packet)))
    },
  })
}
