export type CommerceOrderHistoryOperationalStatus =
  | 'disabled'
  | 'stale'
  | 'degraded'
  | 'ready'

export function commerceOrderHistoryDurableDegraded(input: {
  staleProcessing: number
  failed: number
  blocked: number
  dead: number
  /** Superseded or stale-authority terminal sessions; retained as telemetry. */
  historicalDead?: number
  /** Superseded or stale-authority blocked sessions; telemetry only. */
  historicalBlocked?: number
  overduePolls: number
  expiredSensitiveEvidence: number
  cursorKeysReady: boolean
}) {
  return (
    input.staleProcessing > 0
    || input.failed > 0
    || input.blocked > 0
    || input.dead > 0
    || input.overduePolls > 0
    || input.expiredSensitiveEvidence > 0
    || !input.cursorKeysReady
  )
}

export function commerceOrderHistoryOperationalHealth(input: {
  runtimeAvailable: boolean
  heartbeatCheckedAt?: string | null
  checkedAtMs: number
  pollIntervalMs?: number
  durableDegraded: boolean
  workerDegraded?: boolean
}) {
  const pollIntervalMs = Math.max(
    5_000,
    Math.min(Number(input.pollIntervalMs || 60_000), 300_000),
  )
  const maxHeartbeatAgeMs = Math.max(180_000, pollIntervalMs * 3)
  const parsedHeartbeatAt = Date.parse(String(input.heartbeatCheckedAt || ''))
  const heartbeatAgeMs = Number.isFinite(parsedHeartbeatAt)
    ? input.checkedAtMs - parsedHeartbeatAt
    : null
  const workerReachable = (
    input.runtimeAvailable
    && heartbeatAgeMs !== null
    && heartbeatAgeMs >= 0
    && heartbeatAgeMs <= maxHeartbeatAgeMs
  )
  const status: CommerceOrderHistoryOperationalStatus = !input.runtimeAvailable
    ? 'disabled'
    : !workerReachable
      ? 'stale'
      : input.durableDegraded || input.workerDegraded === true
        ? 'degraded'
        : 'ready'

  return {
    status,
    runtimeAvailable: input.runtimeAvailable,
    worker: {
      status: !input.runtimeAvailable
        ? 'disabled' as const
        : workerReachable
          ? 'reachable' as const
          : 'stale' as const,
      heartbeatAt: input.heartbeatCheckedAt || null,
      ageMs: heartbeatAgeMs,
      maxAgeMs: maxHeartbeatAgeMs,
    },
  }
}
