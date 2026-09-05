import { NextResponse } from 'next/server'
import {
  isIntegrationCredentialRuntimeGateError,
} from '@/lib/integrations/integrationCredentialRuntimeGate.mjs'

const RUNTIME_MAINTENANCE_HEADERS = {
  'Cache-Control': 'no-store, max-age=0',
  Pragma: 'no-cache',
  Expires: '0',
  'Retry-After': '60',
  'X-Content-Type-Options': 'nosniff',
} as const

export function integrationCredentialRuntimeMaintenanceResponse(
  error: unknown,
) {
  if (!isIntegrationCredentialRuntimeGateError(error)) return null
  const code = String((error as { code?: unknown }).code || '')
  return NextResponse.json(
    {
      ok: false,
      error: 'Integration credential services are temporarily unavailable',
      code,
      retryable: true,
    },
    { status: 503, headers: RUNTIME_MAINTENANCE_HEADERS },
  )
}
