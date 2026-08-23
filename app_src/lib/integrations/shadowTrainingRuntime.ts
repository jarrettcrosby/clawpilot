import {
  assertShadowTrainingSandboxCarrierBeforeIo,
  OperationsShadowTrainingError,
} from '@/lib/operations/shadowTraining'

export const SHADOW_TRAINING_LABEL_CAPABILITY = {
  available: false,
  code: 'OPERATIONS_SHADOW_TRAINING_LABEL_EVIDENCE_NOT_BOUND',
  message: 'Order-bound training labels require sandbox_rate_test evidence owned by the exact training package. Shipping Settings diagnostics remain separate.',
} as const

/**
 * Fail-closed pre-I/O boundary for the future order-bound training label seam.
 * Commerce connection environment is intentionally absent: it never controls
 * training eligibility. Carrier execution is a separate sandbox-only concern.
 */
export function assertShadowTrainingLabelRuntimeBeforeIo(input: {
  carrierEnvironment: string
  ratePurpose: string
  carrierProvider: string
  exactTrainingRunGlobalId: string | null
  exactTrainingPackageGlobalId: string | null
  evidenceOwnedByExactPackage: boolean
}) {
  assertShadowTrainingSandboxCarrierBeforeIo({
    environment: input.carrierEnvironment,
    purpose: input.ratePurpose,
    provider: input.carrierProvider,
  })
  if (
    !input.exactTrainingRunGlobalId
    || !input.exactTrainingPackageGlobalId
    || !input.evidenceOwnedByExactPackage
  ) {
    throw new OperationsShadowTrainingError(
      SHADOW_TRAINING_LABEL_CAPABILITY.message,
      409,
      SHADOW_TRAINING_LABEL_CAPABILITY.code,
    )
  }
}

export function requireBoundShadowTrainingLabelCapability(): never {
  throw new OperationsShadowTrainingError(
    SHADOW_TRAINING_LABEL_CAPABILITY.message,
    409,
    SHADOW_TRAINING_LABEL_CAPABILITY.code,
  )
}

