export type CommerceProductImageImportOperationalHealthInput = {
  deadCount: number
  staleLeaseCount: number
  overdueCount: number
  retryCount: number
  heartbeatPhase: string | null | undefined
  loopReachable: boolean
  progressAgeMs: number | null
  maxProgressAgeMs: number
}

export function classifyCommerceProductImageImportOperationalHealth(
  input: CommerceProductImageImportOperationalHealthInput,
) {
  const activelyDraining = (
    input.overdueCount > 0
    && input.deadCount === 0
    && input.staleLeaseCount === 0
    && input.heartbeatPhase !== 'degraded'
    && input.loopReachable
    && input.progressAgeMs !== null
    && input.progressAgeMs <= input.maxProgressAgeMs
  )
  const stalledOverdue = (
    input.overdueCount > 0
    && !activelyDraining
  )
  const operationalDegraded = (
    input.deadCount > 0
    || input.staleLeaseCount > 0
    || stalledOverdue
    || input.retryCount > 0
    || input.heartbeatPhase === 'degraded'
  )
  return { activelyDraining, stalledOverdue, operationalDegraded }
}
