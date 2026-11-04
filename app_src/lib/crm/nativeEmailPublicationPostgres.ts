import { prepareNativeEmailPublication, requireNativeEmail, verifyNativeEmailTerminalReceipt,
  nativeEmailCanonicalJson, type NativeEmailAdmission, type NativeEmailAuthorityValidator,
  type NativeEmailFinalizer, type NativeEmailPublicationInput, type NativeEmailPublicationRequest,
  type NativeEmailPublicationStore, type NativeEmailTerminalReceipt } from './nativeEmailPublication'

export type NativeEmailSqlClient = { query(sql: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }> }
export type NativeEmailSqlTransaction = <T>(callback: (tx: NativeEmailSqlClient) => Promise<T>) => Promise<T>

function fromRow(row: Record<string, unknown>): NativeEmailAdmission {
  const request = prepareNativeEmailPublication({ command: row.command as NativeEmailPublicationInput['command'],
    nativePolicyFingerprint: row.native_policy_fingerprint as string,
    allowedReaderSuiteCrmUserIds: row.allowed_reader_ids as string[] })
  requireNativeEmail(request.commandHash === row.command_hash && request.requestFingerprint === row.request_fingerprint
    && request.command.operationId === row.operation_id && request.command.pipelineId === row.pipeline_id
    && request.command.localId === row.local_id && request.command.suiteCrmId === row.native_id
    && request.command.globalId === row.global_id && request.command.generation === Number(row.generation)
    && request.command.audienceFingerprint === row.audience_fingerprint, 'stored_admission_identity_changed')
  requireNativeEmail(['admitted','dispatched','unknown','committed','cancelled'].includes(String(row.state)), 'invalid_admission_state')
  const state = row.state as NativeEmailAdmission['state']
  const receipt = row.native_receipt === null ? null : verifyNativeEmailTerminalReceipt(request, row.native_receipt)
  requireNativeEmail((state === 'committed' || state === 'cancelled') === !!receipt && (!receipt || receipt.state === state),
    'stored_receipt_state_mismatch')
  return { request, state, receipt }
}

/** Migration 0375 is disabled by default. This store cannot activate, disable,
 * alter policy or transition membership. Enabled mode intentionally freezes ALL
 * authority-changing writes on the four guarded tables, including revocations,
 * until a separately implemented native-first transition can protect historical
 * access. There is no TTL, force-unlock, 404-unlock, or stale-generation fallback. */
export class PostgresNativeEmailPublicationStore implements NativeEmailPublicationStore<NativeEmailSqlClient> {
  constructor(private readonly transaction: NativeEmailSqlTransaction) {}

  private async control(tx: NativeEmailSqlClient): Promise<Record<string, unknown>> {
    const result = await tx.query('SELECT * FROM crm_native_email_publication_control WHERE singleton FOR UPDATE')
    requireNativeEmail(result.rows.length === 1, 'admission_control_missing')
    return result.rows[0]
  }
  private enabled(control: Record<string, unknown>, request: NativeEmailPublicationRequest): void {
    requireNativeEmail(control.enabled === true && Number(control.generation) === request.command.generation
      && Number(control.verified_generation) === request.command.generation
      && control.native_policy_fingerprint === request.nativePolicyFingerprint
      && typeof control.activation_receipt_hash === 'string' && /^[a-f0-9]{64}$/.test(control.activation_receipt_hash),
    'publication_not_enabled_for_generation')
  }
  private async read(tx: NativeEmailSqlClient, id: string): Promise<NativeEmailAdmission> {
    requireNativeEmail(/^[a-f0-9]{64}$/.test(id), 'invalid_operation_id')
    const result = await tx.query('SELECT * FROM crm_native_email_publication_admissions WHERE operation_id=$1 FOR UPDATE', [id])
    requireNativeEmail(result.rows.length === 1, 'admission_missing')
    return fromRow(result.rows[0])
  }
  private active(control: Record<string, unknown>, admission: NativeEmailAdmission): void {
    this.enabled(control, admission.request)
    requireNativeEmail(control.active_operation_id === admission.request.command.operationId, 'admission_not_active')
  }
  async admit(input: NativeEmailPublicationInput, validate: NativeEmailAuthorityValidator<NativeEmailSqlClient>): Promise<NativeEmailAdmission> {
    const request = prepareNativeEmailPublication(input), c = request.command
    return this.transaction(async tx => {
      const control = await this.control(tx)
      this.enabled(control, request)
      const prior = await tx.query('SELECT * FROM crm_native_email_publication_admissions WHERE operation_id=$1 FOR UPDATE', [c.operationId])
      if (prior.rows.length) {
        const existing = fromRow(prior.rows[0])
        requireNativeEmail(existing.request.requestFingerprint === request.requestFingerprint, 'operation_identity_conflict')
        if (!existing.receipt) this.active(control, existing)
        return existing
      }
      requireNativeEmail(control.active_operation_id === null, 'another_publication_unresolved')
      requireNativeEmail(typeof validate === 'function', 'authority_validator_required')
      // Authority SELECTs must run under this control lock. Use plain reads for
      // those four tables (statement guards serialize writes); do not acquire
      // their row locks in reverse order. Validate outbox/identity too.
      await validate(tx, request)
      await tx.query(`INSERT INTO crm_native_email_publication_admissions
        (operation_id,pipeline_id,local_id,native_id,global_id,generation,native_policy_fingerprint,
         command_hash,audience_fingerprint,command,allowed_reader_ids,request_fingerprint)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb,$12)`,
      [c.operationId,c.pipelineId,c.localId,c.suiteCrmId,c.globalId,c.generation,request.nativePolicyFingerprint,
        request.commandHash,c.audienceFingerprint,nativeEmailCanonicalJson(c),JSON.stringify(request.allowedReaderSuiteCrmUserIds),request.requestFingerprint])
      await tx.query('UPDATE crm_native_email_publication_control SET active_operation_id=$1,updated_at=now() WHERE singleton', [c.operationId])
      return { request, state: 'admitted', receipt: null }
    })
  }
  async get(id: string): Promise<NativeEmailAdmission> {
    return this.transaction(async tx => { await this.control(tx); return this.read(tx, id) })
  }
  async markDispatched(id: string): Promise<boolean> {
    return this.transaction(async tx => {
      const control = await this.control(tx), admission = await this.read(tx, id)
      if (admission.receipt) return false
      this.active(control, admission)
      if (admission.state !== 'admitted') return false
      await tx.query("UPDATE crm_native_email_publication_admissions SET state='dispatched',updated_at=now() WHERE operation_id=$1", [id])
      return true
    })
  }
  async markUnknown(id: string): Promise<void> {
    await this.transaction(async tx => {
      const control = await this.control(tx), admission = await this.read(tx, id)
      if (admission.receipt) return
      this.active(control, admission)
      await tx.query("UPDATE crm_native_email_publication_admissions SET state='unknown',updated_at=now() WHERE operation_id=$1", [id])
    })
  }
  async settle(id: string, value: unknown, finalize: NativeEmailFinalizer<NativeEmailSqlClient>): Promise<NativeEmailTerminalReceipt> {
    return this.transaction(async tx => {
      const control = await this.control(tx), admission = await this.read(tx, id)
      const receipt = verifyNativeEmailTerminalReceipt(admission.request, value)
      if (admission.receipt) {
        // Native retry's replayed flag may differ; all substantive fields must not.
        requireNativeEmail(nativeEmailCanonicalJson({ ...receipt, replayed: false })
          === nativeEmailCanonicalJson({ ...admission.receipt, replayed: false }), 'terminal_receipt_conflict')
        return admission.receipt
      }
      this.active(control, admission)
      requireNativeEmail(typeof finalize === 'function', 'projection_finalizer_required')
      // Validate raw projection against the immutable admitted command, current
      // audience and an authorized resolver claim, then settle local operation/
      // outbox atomically. A changed source becomes superseded, not falsely
      // synced and not held forever waiting for its old revision/original lease.
      // A genuine identity/audience/projection mismatch must throw and retain
      // the unresolved admission. See NativeEmailFinalizer's full contract.
      await finalize(tx, admission.request, receipt)
      await tx.query('UPDATE crm_native_email_publication_admissions SET state=$2,native_receipt=$3::jsonb,updated_at=now() WHERE operation_id=$1',
        [id,receipt.state,nativeEmailCanonicalJson(receipt)])
      await tx.query('UPDATE crm_native_email_publication_control SET active_operation_id=NULL,updated_at=now() WHERE singleton')
      return receipt
    })
  }
}
