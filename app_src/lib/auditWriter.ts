import type { PoolClient } from 'pg'
import { headers } from 'next/headers'
import { verifyAuthAttributionHeaders } from '@/lib/authAttribution'
import { query } from '@/lib/persistence/postgres'

async function requestAttribution() {
  try {
    return verifyAuthAttributionHeaders(await headers())
  } catch {
    return null
  }
}

export async function recordAuditEvent(input: {
  actor?: string | null
  eventType: string
  aggregateType?: string | null
  aggregateId?: string | null
  payload?: Record<string, unknown>
  eventKey?: string | null
  subject?: string | null
  organizationId?: string | null
  isSystem?: boolean
}, client?: PoolClient): Promise<void> {
  const attribution = await requestAttribution()
  const suppliedActor = input.actor || null
  const impersonatedAction = Boolean(
    attribution?.impersonating
    && suppliedActor
    && suppliedActor.toLowerCase() === attribution.effectiveUser,
  )
  const actor = impersonatedAction ? attribution!.authenticatedUser : suppliedActor
  const subject = input.subject || (impersonatedAction ? attribution!.effectiveUser : actor)
  const payload = impersonatedAction
    ? {
        ...(input.payload || {}),
        authenticatedUser: attribution!.authenticatedUser,
        effectiveUser: attribution!.effectiveUser,
        sessionId: attribution!.sessionId,
        impersonated: true,
      }
    : input.payload || {}
  const sql = `INSERT INTO audit_events (
      actor, event_type, aggregate_type, aggregate_id, payload, event_key,
      subject, organization_id, is_system
    )
    VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8::uuid, $9)
    ON CONFLICT (event_key) WHERE event_key IS NOT NULL DO NOTHING`
  const values = [
    actor,
    input.eventType,
    input.aggregateType || null,
    input.aggregateId || null,
    JSON.stringify(payload),
    input.eventKey || null,
    subject,
    input.organizationId || attribution?.activeWorkspaceOrganizationId || null,
    input.isSystem === true,
  ]
  if (client) await client.query(sql, values)
  else await query(sql, values)
}
