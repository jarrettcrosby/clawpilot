export type OneOffShipmentCreateAttempt = {
  fingerprint: string
  idempotencyKey: string
}

export function resolveOneOffShipmentCreateAttempt(input: {
  current: OneOffShipmentCreateAttempt | null
  fingerprint: string
  nextIdempotencyKey: () => string
}): OneOffShipmentCreateAttempt {
  return input.current?.fingerprint === input.fingerprint
    ? input.current
    : {
        fingerprint: input.fingerprint,
        idempotencyKey: input.nextIdempotencyKey(),
      }
}
