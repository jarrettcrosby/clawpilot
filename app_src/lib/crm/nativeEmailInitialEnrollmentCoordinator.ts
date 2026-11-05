import 'server-only'
import {nativeEmailCanonicalJson as json,requireNativeEmail} from './nativeEmailPublication'
import type {NativeEmailInitialApprovalEnvelope} from './nativeEmailInitialEnrollmentApproval'
import type {NativeEmailInitialExecution,NativeEmailInitialResolver,PostgresNativeEmailInitialEnrollmentStore} from './nativeEmailInitialEnrollmentPostgres'

export type NativeEmailInitialOperatorTransport=NativeEmailInitialResolver&{
  execute(execution:NativeEmailInitialExecution):Promise<unknown>
  cancelExpired(execution:NativeEmailInitialExecution):Promise<unknown>
}
type Store=Pick<PostgresNativeEmailInitialEnrollmentStore,'readExecution'|'markDispatched'|'markUnknown'|'resolveAndSettle'>
type Issuer={issue(operationId:string,expectedPlanHash:string):Promise<NativeEmailInitialApprovalEnvelope>}
export type NativeEmailInitialSettlement={state:string;receiptHash:string}

/** Private operator orchestration, not an endpoint, startup action or a
 * cross-database transaction. The real store reauthorizes every SQL phase;
 * its independent reviewed pin and durable envelope are mandatory. The native
 * adapter must run the fixed offline CLI against the maintained instance.
 * No retry creates a new operation, renews approval or treats expiry as release.
 * Even a successful execute response cannot activate PG: settlement always
 * invokes a separate fresh native resolve/current-state readback. */
export class NativeEmailInitialEnrollmentCoordinator{
  constructor(private readonly store:Store,private readonly issuer:Issuer,
    private readonly native:NativeEmailInitialOperatorTransport){
    requireNativeEmail(store&&issuer&&native&&['execute','cancelExpired','resolve'].every(method=>
      typeof native[method as keyof NativeEmailInitialOperatorTransport]==='function'),'initial_operator_ports_required')
  }
  private terminal(value:{state:string;receiptHash:string|null}):NativeEmailInitialSettlement|null{
    if(value.state!=='activated'&&value.state!=='cancelled')return null
    requireNativeEmail(typeof value.receiptHash==='string'&&/^[a-f0-9]{64}(?![\s\S])/.test(value.receiptHash),'initial_operator_terminal_evidence')
    return {state:value.state,receiptHash:value.receiptHash}
  }
  private async resolve(operationId:string){
    try{return await this.store.resolveAndSettle(operationId,this.native)}catch{
      // A failed fresh resolve is never evidence of non-execution. Preserve
      // the exact dispatched/unknown operation; do not expose provider errors.
      await this.unknown(operationId)
      requireNativeEmail(false,'initial_operator_outcome_held')
    }
  }
  private async unknown(operationId:string){
    try{await this.store.markUnknown(operationId)}catch{
      // The durable dispatch transaction may itself have an unknown outcome.
      // Do not retry a write or clear its barrier based on a local exception.
      requireNativeEmail(false,'initial_operator_barrier_status_held')
    }
  }
  private async perform(operationId:string,execution:NativeEmailInitialExecution,action:'execute'|'cancelExpired'){
    try{await this.native[action](execution)}catch{
      await this.unknown(operationId)
      // An execution response can be lost AFTER its native COMMIT. Fresh
      // resolution may settle that exact result without sending execute again.
    }
    return this.resolve(operationId)
  }
  async execute(operationId:string,expectedPlanHash:string){
    const approval=await this.issuer.issue(operationId,expectedPlanHash)
    const current=await this.store.readExecution(operationId),terminal=this.terminal(current)
    requireNativeEmail(current.execution.planHash===expectedPlanHash
      &&json(current.execution.approval)===json(approval),'initial_operator_approval_changed')
    if(terminal)return terminal
    requireNativeEmail(current.state==='admitted'&&current.nowEpoch<approval.proof.expiresAt,'initial_operator_resolve_existing_attempt')
    const execution=await this.store.markDispatched(operationId)
    requireNativeEmail(json(execution)===json(current.execution),'initial_operator_execution_changed')
    return this.perform(operationId,execution,'execute')
  }
  async resume(operationId:string){
    const current=await this.store.readExecution(operationId),terminal=this.terminal(current)
    // This is retained operation status, not a new current-native attestation.
    // Legitimate later generations must not replay the initial Email manifest.
    return terminal??this.resolve(operationId)
  }
  async cancelExpired(operationId:string){
    const current=await this.store.readExecution(operationId),terminal=this.terminal(current)
    if(terminal)return terminal // Never undo a committed enrollment.
    requireNativeEmail(current.nowEpoch>=current.execution.approval.proof.expiresAt,'initial_operator_approval_not_expired')
    requireNativeEmail(['admitted','dispatched','unknown'].includes(current.state),'initial_operator_state')
    const execution=current.state==='admitted'?await this.store.markDispatched(operationId):current.execution
    return this.perform(operationId,execution,'cancelExpired')
  }
}
