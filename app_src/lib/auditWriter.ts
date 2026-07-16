import type { PoolClient } from 'pg'
import { query } from '@/lib/persistence/postgres'

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
  const sql = `INSERT INTO audit_events (
      actor, event_type, aggregate_type, aggregate_id, payload, event_key,
      subject, organization_id, is_system
    )
    VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8::uuid, $9)
    ON CONFLICT (event_key) WHERE event_key IS NOT NULL DO NOTHING`
  const values = [
    input.actor || null,
    input.eventType,
    input.aggregateType || null,
    input.aggregateId || null,
    JSON.stringify(input.payload || {}),
    input.eventKey || null,
    input.subject || input.actor || null,
    input.organizationId || null,
    input.isSystem === true,
  ]
  if (client) await client.query(sql, values)
  else await query(sql, values)
}
