import { nativeEmailCanonicalJson, nativeEmailDigest, requireNativeEmail } from './nativeEmailPublication'
import { prepareNativeEmailAuthorityCommand, verifyNativeEmailAuthorityReceipt,
  type NativeEmailAuthorityCommand } from './nativeEmailAuthorityTransition'
import type { NativeEmailAuthorityApprovalEnvelope } from './nativeEmailAuthorityApproval'

export type NativeEmailAuthorityApprovalReadback = { version:1; operationId:string; transitionId:string
  phase:'revoke'|'grant'; commandHash:string; proofHash:string; appCommitFingerprint:string|null; replayed:boolean }
type Config = { baseUrl:string; clientId:string; clientSecret:string }
function exact(value: unknown, keys: string[]): asserts value is Record<string, unknown> {
  requireNativeEmail(value && typeof value === 'object' && !Array.isArray(value)
    && nativeEmailCanonicalJson(Object.keys(value).sort()) === nativeEmailCanonicalJson([...keys].sort()),
  'authority_transport_shape')
}
export function verifyNativeEmailAuthorityApprovalReadback(command: NativeEmailAuthorityCommand,
  envelope: NativeEmailAuthorityApprovalEnvelope, value: unknown): NativeEmailAuthorityApprovalReadback {
  const request = prepareNativeEmailAuthorityCommand(command)
  exact(value, ['version','operationId','transitionId','phase','commandHash','proofHash','appCommitFingerprint','replayed'])
  requireNativeEmail(value.version === 1 && value.operationId === command.operationId && value.transitionId === command.transitionId
    && value.phase === command.phase && value.commandHash === request.commandHash
    && value.proofHash === nativeEmailDigest(envelope.proof)
    && value.appCommitFingerprint === (envelope.proof.appCommit ? nativeEmailDigest(envelope.proof.appCommit) : null)
    && typeof value.replayed === 'boolean', 'authority_approval_readback_changed')
  return JSON.parse(nativeEmailCanonicalJson(value)) as NativeEmailAuthorityApprovalReadback
}
async function boundedJson(response: Response): Promise<unknown> {
  const reader = response.body?.getReader()
  requireNativeEmail(reader, 'authority_transport_empty')
  const chunks: Uint8Array[] = []; let size = 0
  try {
    while (true) {
      const part = await reader.read(); if (part.done) break
      size += part.value.byteLength
      if (size > 1000000) { await reader.cancel().catch(() => undefined); requireNativeEmail(false, 'authority_transport_oversized') }
      chunks.push(part.value)
    }
  } finally { reader.releaseLock() }
  try { return JSON.parse(new TextDecoder('utf-8',{ fatal:true }).decode(Buffer.concat(chunks))) }
  catch { requireNativeEmail(false, 'authority_transport_invalid_json') }
}

/** Dedicated service credentials, fixed native origin/routes and no automatic
 * retries or legacy fallback. Configuration does not enable/install anything.
 * Returned approvals are evidence of retained provisioning, not live execution
 * authorization: the native service checks expiry and revocation again. */
export function createSuiteCrmNativeEmailAuthorityClient(config: Config, fetchImpl: typeof fetch = fetch) {
  let origin: string
  try {
    const url = new URL(config.baseUrl)
    requireNativeEmail((url.protocol === 'https:' || url.protocol === 'http:' && url.hostname.endsWith('.railway.internal'))
      && !url.username && !url.password && !url.search && !url.hash, 'authority_transport_origin')
    origin = url.toString().replace(/\/$/,'')
  } catch { requireNativeEmail(false, 'authority_transport_origin') }
  requireNativeEmail(typeof config.clientId === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9-]{0,35}(?![\s\S])/.test(config.clientId)
    && typeof config.clientSecret === 'string' && /^[\x21-\x7e]{1,4096}(?![\s\S])/.test(config.clientSecret),
  'authority_transport_credentials')
  // Capture config once; later mutation of the caller's object cannot retarget
  // a signed operation or replace the service identity between calls.
  const clientId = config.clientId, clientSecret = config.clientSecret
  let token: { value:string; expiresAt:number } | null = null
  async function accessToken(signal: AbortSignal) {
    if (token && token.expiresAt > Date.now() + 30000) return token.value
    const response = await fetchImpl(origin + '/Api/access_token', { method:'POST', cache:'no-store', redirect:'error', signal,
      headers:{ Accept:'application/json','Content-Type':'application/json' },
      body:JSON.stringify({ grant_type:'client_credentials',client_id:clientId,client_secret:clientSecret }) })
    requireNativeEmail(response.ok, 'authority_transport_authentication_failed')
    const parsed = await boundedJson(response) as { access_token?:unknown; expires_in?:unknown; token_type?:unknown }
    requireNativeEmail(parsed && typeof parsed.access_token === 'string' && /^[\x21-\x7e]{1,4096}(?![\s\S])/.test(parsed.access_token)
      && typeof parsed.expires_in === 'number' && Number.isFinite(parsed.expires_in) && parsed.expires_in > 30
      && typeof parsed.token_type === 'string' && parsed.token_type.toLowerCase() === 'bearer', 'authority_transport_authentication_invalid')
    token = { value:parsed.access_token, expiresAt:Date.now() + Math.min(parsed.expires_in, 3600) * 1000 }
    return token.value
  }
  async function call(operation: 'approve'|'execute'|'resolve'|'cancel-expired'|'inspect'|'project', body: unknown) {
    const bytes = nativeEmailCanonicalJson(body)
    requireNativeEmail(Buffer.byteLength(bytes,'utf8') <= 820000, 'authority_transport_command_size')
    const signal = AbortSignal.timeout(20000)
    const bearer = await accessToken(signal)
    const response = await fetchImpl(origin + '/Api/V8/custom/clawpilot-email-authority/' + operation,
      { method:'POST', cache:'no-store', redirect:'error', signal,
        headers:{ Accept:'application/vnd.api+json','Content-Type':'application/vnd.api+json', Authorization:'Bearer ' + bearer }, body:bytes })
    if (response.status === 401) token = null
    // Never return raw provider diagnostics, proof, credentials, or an invented
    // cancellation. Coordinator must resolve any unknown native outcome.
    requireNativeEmail(response.ok, 'authority_transport_response_held')
    return boundedJson(response)
  }
  function checkApproval(command: NativeEmailAuthorityCommand, authorization: NativeEmailAuthorityApprovalEnvelope) {
    const { commandHash } = prepareNativeEmailAuthorityCommand(command)
    exact(authorization, ['proof','signature'])
    const p = authorization.proof
    requireNativeEmail(p && p.commandHash === commandHash && p.operationId === command.operationId
      && p.transitionId === command.transitionId && p.phase === command.phase && p.oauthClientId === clientId,
    'authority_approval_command_changed')
  }
  return {
    // Provisional authenticated evidence only; the plan builder validates the
    // complete shape and PG independently authorizes its snapshot before sign.
    async inspect() { return call('inspect', { version:1 }) },
    async project(request: { version:1; beforePolicyFingerprint:string; beforeBindingsFingerprint:string;
      revokeMembershipChanges:NativeEmailAuthorityCommand['membershipChanges'];
      grantMembershipChanges:NativeEmailAuthorityCommand['membershipChanges'] }) {
      return call('project', request)
    },
    async approve(command: NativeEmailAuthorityCommand, authorization: NativeEmailAuthorityApprovalEnvelope) {
      checkApproval(command, authorization)
      return verifyNativeEmailAuthorityApprovalReadback(command, authorization, await call('approve',{ command,authorization }))
    },
    /** Explicit recovery using the exact original expired approval. A
     * native committed result remains committed; this method never interprets
     * time, missing approval or network failure as proof of cancellation. */
    async cancelExpired(command: NativeEmailAuthorityCommand, authorization: NativeEmailAuthorityApprovalEnvelope) {
      checkApproval(command, authorization)
      requireNativeEmail(Number.isSafeInteger(authorization.proof.expiresAt)
        && authorization.proof.expiresAt <= Math.floor(Date.now()/1000), 'authority_cancel_not_expired')
      const result = await call('cancel-expired', { command,authorization })
      exact(result, ['approval','receipt'])
      return {
        approval:verifyNativeEmailAuthorityApprovalReadback(command, authorization, result.approval),
        receipt:verifyNativeEmailAuthorityReceipt(prepareNativeEmailAuthorityCommand(command), result.receipt),
      }
    },
    /** Backward-compatible narrow original caller; newer runtime uses the
     * same endpoint for expired grants with independently verified ancestry. */
    async cancelExpiredRevoke(command: NativeEmailAuthorityCommand, authorization: NativeEmailAuthorityApprovalEnvelope) {
      checkApproval(command, authorization)
      requireNativeEmail(command.phase==='revoke' && Number.isSafeInteger(authorization.proof.expiresAt)
        && authorization.proof.expiresAt<=Math.floor(Date.now()/1000),'authority_cancel_not_expired_revoke')
      const result=await call('cancel-expired',{command,authorization})
      exact(result,['approval','receipt'])
      return {approval:verifyNativeEmailAuthorityApprovalReadback(command,authorization,result.approval),
        receipt:verifyNativeEmailAuthorityReceipt(prepareNativeEmailAuthorityCommand(command),result.receipt)}
    },
    async execute(command: NativeEmailAuthorityCommand) {
      const request = prepareNativeEmailAuthorityCommand(command)
      return verifyNativeEmailAuthorityReceipt(request, await call('execute', request.command))
    },
    async resolveOrCancel(command: NativeEmailAuthorityCommand) {
      const request = prepareNativeEmailAuthorityCommand(command)
      return verifyNativeEmailAuthorityReceipt(request, await call('resolve', request.command))
    },
  }
}
