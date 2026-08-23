import { createHash } from 'node:crypto'

const RUNTIME_CREDENTIAL = /^cpprint\.v1\.[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}$/i
const PAIRING_GRANT = /^cppair\.v1\.[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}$/i

export function macPrintPairingSecretKind(value) {
  const secret = String(value || '').trim()
  if (PAIRING_GRANT.test(secret)) return 'pairing_grant'
  if (RUNTIME_CREDENTIAL.test(secret)) return 'legacy_runtime_credential'
  return null
}

export function assertMacPrintRuntimeCredential(value) {
  const credential = String(value || '').trim()
  if (!RUNTIME_CREDENTIAL.test(credential)) {
    throw new Error('ClawPilot did not return a valid print-agent runtime credential')
  }
  return credential
}

export function macPrintPairingIdempotencyKey(pairingCode) {
  if (macPrintPairingSecretKind(pairingCode) !== 'pairing_grant') {
    throw new Error('The supplied value is not a ClawPilot print-agent pairing grant')
  }
  return `print-agent-pair:${createHash('sha256').update(pairingCode).digest('hex')}`
}

export async function redeemMacPrintPairingGrant({
  baseUrl,
  pairingCode,
  idempotencyKey,
  fetchImplementation = fetch,
}) {
  if (macPrintPairingSecretKind(pairingCode) !== 'pairing_grant') {
    throw new Error('The supplied value is not a ClawPilot print-agent pairing grant')
  }
  const parsedBase = new URL(String(baseUrl || '').trim())
  if (
    parsedBase.protocol !== 'https:'
    && parsedBase.hostname !== '127.0.0.1'
    && parsedBase.hostname !== 'localhost'
  ) {
    throw new Error('Print-agent pairing redemption requires HTTPS outside local development')
  }
  const requestKey = String(idempotencyKey || '').trim()
  if (!/^[A-Za-z0-9._:-]{8,200}$/.test(requestKey)) {
    throw new Error('The print-agent pairing redemption key is invalid')
  }
  const response = await fetchImplementation(
    new URL('/api/operations/print-agent/pair', parsedBase),
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': requestKey,
      },
      body: JSON.stringify({ pairingCode }),
      signal: AbortSignal.timeout(20_000),
    },
  )
  const result = await response.json().catch(() => ({}))
  if (!response.ok) {
    const code = String(result?.code || `HTTP_${response.status}`)
    throw new Error(`The ClawPilot pairing grant could not be redeemed (${code})`)
  }
  return assertMacPrintRuntimeCredential(result.credential)
}
