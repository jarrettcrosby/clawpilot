import { normalizedPairingInput } from './validation.mjs'

export async function pairGatewayInstance({
  input,
  store,
  operationGuard = () => undefined,
  probe,
  redeem,
  createRecovery,
  pairingCodeHash,
  allowLocalDevelopment = false,
}) {
  await operationGuard()
  const pairing = normalizedPairingInput(input, { allowLocalDevelopment })
  store.preflightPairingPersistence()
  const codeHash = pairingCodeHash(pairing.pairingCode)
  const pending = store.preparePairingRecovery({
    baseUrl: pairing.baseUrl,
    pairingCodeHash: codeHash,
    createRecovery: () => createRecovery(pairing.pairingCode),
  })
  const recoveringSentRequest = pending.phase === 'request_sent'
  if (!recoveringSentRequest) {
    await probe(pairing.printerHost, pairing.printerPort)
    store.markPairingRecoveryRequestSent(codeHash)
  }
  const recovery = pending.recovery
  let enrollment
  try {
    enrollment = await redeem(pairing, recovery)
  } catch (error) {
    if (error?.retryableRecovery === true) {
      const failure = new Error(
        'The recovery-safe pairing response was interrupted. Keep this exact pairing code and select Pair again on this computer; the same encrypted installation key will recover the original enrollment without creating another credential.',
      )
      failure.cause = error
      throw failure
    }
    if (error?.outcomeUnknown === true) {
      const failure = new Error(
        'This installation cannot safely recover the pairing result. Inspect ClawPilot Operations > Printing > Agents; revoke any newly enrolled agent, then issue a new pairing code.',
      )
      failure.cause = error
      throw failure
    }
    throw error
  }
  let instance
  try {
    instance = store.createInstance({
      ...pairing,
      displayName: enrollment.agent.name,
      serverAgentId: enrollment.agent.id,
      serverAgentGlobalId: enrollment.agent.globalId,
      serverAgentName: enrollment.agent.name,
      warehouseId: enrollment.agent.warehouseId,
      warehouseGlobalId: enrollment.agent.warehouseGlobalId,
      warehouseName: enrollment.agent.warehouseName,
    }, enrollment.credential, {
      completedPairingCodeHash: recovery.pairingCodeHash,
      enabled: !recoveringSentRequest,
    })
  } catch (error) {
    const failure = new Error(
      'ClawPilot returned a verified enrollment, but this computer could not durably save it. Repair local storage, then retry the exact same pairing code on this computer to recover the same credential. If this computer loses its encrypted recovery state, revoke the agent in ClawPilot and issue a new code.',
    )
    failure.cause = error
    throw failure
  }
  if (!recoveringSentRequest) return instance

  try {
    await probe(pairing.printerHost, pairing.printerPort)
    return store.setEnabled(instance.id, true)
  } catch (error) {
    return {
      ...instance,
      pairingWarning: 'The original ClawPilot enrollment was recovered safely, but this printer is not reachable. The workspace remains stopped; use Test connection or Edit connection before starting it.',
    }
  }
}
