import {
  claimCommerceFulfillmentRecoveryInPostgres,
  COMMERCE_FULFILLMENT_AUTOMATIC_ATTEMPT_LIMIT,
  finalizeExhaustedCommerceFulfillmentRecoveriesInPostgres,
  parkCommerceFulfillmentRecoveryForRuntimeMaintenanceInPostgres,
  type CommerceFulfillmentRecoveryClaim,
} from '@/lib/persistence/commerceFulfillmentRecovery'
import {
  executeOperationsCommerceFulfillmentExportFromPostgres,
} from '@/lib/persistence/operations'
import {
  isIntegrationCredentialRuntimeGateError,
} from '@/lib/integrations/integrationCredentialRuntimeGate.mjs'

type Dependencies = {
  claim: typeof claimCommerceFulfillmentRecoveryInPostgres
  finalizeExhausted:
    typeof finalizeExhaustedCommerceFulfillmentRecoveriesInPostgres
  parkRuntimeMaintenance:
    typeof parkCommerceFulfillmentRecoveryForRuntimeMaintenanceInPostgres
  execute: typeof executeOperationsCommerceFulfillmentExportFromPostgres
}

const DEFAULT_DEPENDENCIES: Dependencies = {
  claim: claimCommerceFulfillmentRecoveryInPostgres,
  finalizeExhausted:
    finalizeExhaustedCommerceFulfillmentRecoveriesInPostgres,
  parkRuntimeMaintenance:
    parkCommerceFulfillmentRecoveryForRuntimeMaintenanceInPostgres,
  execute: executeOperationsCommerceFulfillmentExportFromPostgres,
}

const CONTENTION_CODES = new Set([
  'OPERATIONS_COMMERCE_EXPORT_CHANGED',
  'OPERATIONS_COMMERCE_EXPORT_IN_PROGRESS',
])

function errorCode(error: unknown) {
  if (!error || typeof error !== 'object' || !('code' in error)) return null
  const code = String(error.code || '').trim()
  return /^[A-Z][A-Z0-9_]{2,127}$/.test(code) ? code : null
}

function auditEventKey(claim: CommerceFulfillmentRecoveryClaim) {
  return (
    `operations:commerce-fulfillment:${claim.commerceExportGlobalId}:`
    + `recovery-worker-attempt:${claim.attempt}`
  )
}

function boundedClaimLimit(value: unknown) {
  const parsed = Number(value)
  return Number.isSafeInteger(parsed)
    ? Math.max(1, Math.min(parsed, 5))
    : 1
}

export function commerceFulfillmentRecoveryRuntimeAvailable() {
  return String(
    process.env.CLAWPILOT_COMMERCE_FULFILLMENT_RECOVERY_ENABLED || '0',
  ) === '1'
}

export async function processCommerceFulfillmentRecovery(input: {
  limit?: number
  workerId: string
}, dependencies: Dependencies = DEFAULT_DEPENDENCIES) {
  const requestedLimit = boundedClaimLimit(input.limit)
  let claimed = 0
  let queuedClaims = 0
  let recoveryClaims = 0
  let succeeded = 0
  let unresolved = 0
  let terminalFailures = 0
  let contentionSkipped = 0
  let executionErrors = 0
  const exhausted = await dependencies.finalizeExhausted({
    workerId: input.workerId,
    limit: 5,
  })

  for (let index = 0; index < requestedLimit; index += 1) {
    const claim = await dependencies.claim({ workerId: input.workerId })
    if (!claim) break
    claimed += 1
    if (claim.priorState === 'queued') queuedClaims += 1
    else recoveryClaims += 1
    try {
      const result = await dependencies.execute({
        organizationId: claim.organizationId,
        actorEmail: claim.actorEmail,
        commerceExportGlobalId: claim.commerceExportGlobalId,
        reason: 'Bounded scheduled commerce fulfillment export recovery',
        auditEventKey: auditEventKey(claim),
        preclaimed: {
          attempt: claim.attempt,
          priorState: claim.priorState,
          priorErrorCode: claim.priorErrorCode,
          workerId: input.workerId,
        },
      })
      if (result.state === 'succeeded') succeeded += 1
      else if (
        result.errorCode ===
          'OPERATIONS_COMMERCE_EXPORT_RECONCILIATION_REQUIRED'
      ) {
        unresolved += 1
      } else {
        terminalFailures += 1
      }
    } catch (error) {
      if (isIntegrationCredentialRuntimeGateError(error)) {
        const maintenanceError = error
        await Promise.allSettled([
          dependencies.parkRuntimeMaintenance({
            workerId: input.workerId,
            claim,
          }),
        ])
        throw maintenanceError
      }
      const code = errorCode(error)
      if (code && CONTENTION_CODES.has(code)) contentionSkipped += 1
      else executionErrors += 1
    }
  }

  return {
    claimed,
    queuedClaims,
    recoveryClaims,
    succeeded,
    unresolved,
    terminalFailures,
    contentionSkipped,
    executionErrors,
    exhausted,
    automaticAttemptLimit: COMMERCE_FULFILLMENT_AUTOMATIC_ATTEMPT_LIMIT,
    maxClaimsPerInvocation: 5,
  }
}
