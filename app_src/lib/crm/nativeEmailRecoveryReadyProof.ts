import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

type ReadyAction = 'prepare' | 'publish' | 'resolve'
type ReadyContext = Readonly<{ action: ReadyAction; fenceEpoch: string; targetFingerprint: string; permitExpiresAt: number;
  expectedFenceExpiresAt?:number }>

const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}(?![\s\S])/u
const HEX = /^[a-f0-9]{64}(?![\s\S])/u
const PURPOSE = 'clawpilot-native-email-recovery-ready-v1'
const positiveEpoch = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0

/** The per-window key belongs only to the operator and the root-protected
 * native fence. It is never placed in argv, stdin, Railway environment or
 * permit data. A verified proof releases content only on this child. */
export function createNativeEmailRecoveryReadyChallenge(input: ReadyContext, secret: Buffer) {
  const { action, fenceEpoch, targetFingerprint, permitExpiresAt, expectedFenceExpiresAt } = input
  if (!['prepare', 'publish', 'resolve'].includes(action) || !UUID.test(fenceEpoch) || !HEX.test(targetFingerprint)
    || !positiveEpoch(permitExpiresAt) || (expectedFenceExpiresAt!==undefined&&(!positiveEpoch(expectedFenceExpiresAt)||expectedFenceExpiresAt<permitExpiresAt))
    || !Buffer.isBuffer(secret) || secret.length !== 32) throw new Error('legacy_dispatch_transport_ready_context')
  const key = Buffer.from(secret), nonce = randomBytes(32).toString('hex')
  let verified = false
  return Object.freeze({nonce, verifyReady(line: string) {
    if (verified || typeof line !== 'string' || line.length > 1024) return false
    let value: { mac?: unknown; proof?: { expiresAt?: unknown } }
    try { value = JSON.parse(line) } catch { return false }
    const expiresAt = value?.proof?.expiresAt, mac = value?.mac, now = Math.floor(Date.now() / 1000)
    if (typeof mac !== 'string' || !HEX.test(mac) || !positiveEpoch(expiresAt) || expiresAt < permitExpiresAt || permitExpiresAt <= now
      || (expectedFenceExpiresAt!==undefined&&expiresAt!==expectedFenceExpiresAt)) return false
    const proof = { action, expiresAt, fenceEpoch, nonce, purpose: PURPOSE, targetFingerprint, version: 1 }
    if (line !== JSON.stringify({mac, proof})) return false
    const expected = createHmac('sha256', key).update(JSON.stringify(proof), 'ascii').digest()
    verified = timingSafeEqual(Buffer.from(mac, 'hex'), expected)
    return verified
  }})
}
