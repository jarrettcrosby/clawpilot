import crypto from 'crypto'
import type { ProductAgentId } from '@/lib/agents/routing'
import { detectPromptInjectionIndicators } from '@/lib/agents/promptSecurity'
import { query, withTransaction } from '@/lib/persistence/postgres'
import { normalizeUserEmail } from '@/lib/users'

export type AgentContextMemory = {
  scope: 'shared' | 'operator'
  content: string
}

type MemoryRow = AgentContextMemory & {
  id: string
}

function normalizedLearning(value: unknown): string {
  return String(value || '')
    .replace(/^[-*]\s+/, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 320)
}

function learningHash(content: string): string {
  return crypto.createHash('sha256').update(content.toLowerCase()).digest('hex')
}

export function extractAgentLearning(responseText: unknown): string | null {
  const lines = String(responseText || '').split(/\r?\n/).map((line) => line.trim())
  const inline = lines.find((line) => /^learned\s*:\s*\S/i.test(line))
  const headingIndex = lines.findIndex((line) => /^learned\s*:?$/i.test(line))
  const value = inline
    ? inline.replace(/^learned\s*:\s*/i, '')
    : headingIndex >= 0
      ? lines.slice(headingIndex + 1).find((line) => line.length > 0) || ''
      : ''
  const learning = normalizedLearning(value)
  return learning && !/^(?:none|n\/a|not applicable)[.!]?$/i.test(learning) ? learning : null
}

export function isShareableAgentLearning(value: unknown): boolean {
  const learning = normalizedLearning(value)
  if (learning.length < 24 || learning.length > 280) return false
  return !(
    /[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(learning)
    || /https?:\/\//i.test(learning)
    || /\b[0-9a-f]{8}-[0-9a-f-]{27,}\b/i.test(learning)
    || /\bg[a-z]{1,4}(?:[0-9]{7}|[0-9a-v]{12})\b/i.test(learning)
    || /%gslt/i.test(learning)
    || /\b\d{7,}\b/.test(learning)
  )
}

export async function readAgentContextMemories(input: {
  operatorId: string
  organizationId: string
  agentId: ProductAgentId
  limit?: number
}): Promise<AgentContextMemory[]> {
  const operatorId = normalizeUserEmail(input.operatorId)
  const limit = Math.max(1, Math.min(Math.trunc(Number(input.limit) || 8), 12))
  const result = await query<MemoryRow>(
    `
      SELECT id::text, scope, content
      FROM agent_context_memories
      WHERE agent_id = $1
        AND status = 'active'
        AND (
          (scope = 'shared' AND operator_id IS NULL)
          OR (scope = 'operator' AND operator_id = $2 AND organization_id = $3::uuid)
        )
      ORDER BY
        CASE scope WHEN 'shared' THEN 0 ELSE 1 END,
        evidence_count DESC,
        updated_at DESC,
        id
      LIMIT $4
    `,
    [input.agentId, operatorId, input.organizationId, limit],
  )
  return result.rows.map((row) => ({ scope: row.scope, content: row.content }))
}

export function formatAgentContextMemories(memories: AgentContextMemory[]): string | null {
  const shared = memories.filter((memory) => memory.scope === 'shared')
  const operator = memories.filter((memory) => memory.scope === 'operator')
  const sections = [
    shared.length > 0
      ? `Shared role context:\n${shared.map((memory) => `- ${memory.content}`).join('\n')}`
      : null,
    operator.length > 0
      ? `Private user context:\n${operator.map((memory) => `- ${memory.content}`).join('\n')}`
      : null,
  ].filter(Boolean)
  return sections.length > 0 ? sections.join('\n\n') : null
}

export async function captureAgentLearning(input: {
  operatorId: string
  organizationId: string
  agentId: ProductAgentId
  responseText: string
}): Promise<{ captured: boolean; shared: boolean }> {
  const operatorId = normalizeUserEmail(input.operatorId)
  const content = extractAgentLearning(input.responseText)
  if (!content) return { captured: false, shared: false }
  if (detectPromptInjectionIndicators(content).length > 0) {
    return { captured: false, shared: false }
  }
  const contentHash = learningHash(content)

  return withTransaction(async (client) => {
    const membership = await client.query(
      `SELECT 1
       FROM app_user_organization_memberships
       WHERE user_email = $1 AND organization_id = $2::uuid AND status = 'active'
       LIMIT 1`,
      [operatorId, input.organizationId],
    )
    if (!membership.rows[0]) return { captured: false, shared: false }
    await client.query(
      `
        INSERT INTO agent_context_memories (
          agent_id, scope, operator_id, organization_id, content, content_hash, status, source, evidence_count
        )
        VALUES ($1, 'operator', $2, $3::uuid, $4, $5, 'active', 'agent_learning', 1)
        ON CONFLICT (agent_id, scope, identity_key, organization_id, content_hash) DO UPDATE SET
          evidence_count = agent_context_memories.evidence_count + 1,
          updated_at = now()
      `,
      [input.agentId, operatorId, input.organizationId, content, contentHash],
    )

    if (!isShareableAgentLearning(content)) return { captured: true, shared: false }

    const shared = await client.query<{ id: string }>(
      `
        INSERT INTO agent_context_memories (
          agent_id, scope, operator_id, organization_id, content, content_hash, status, source, evidence_count
        )
        VALUES ($1, 'shared', NULL, NULL, $2, $3, 'needs_review', 'agent_learning', 1)
        ON CONFLICT (agent_id, scope, identity_key, organization_id, content_hash) DO UPDATE SET
          updated_at = now()
        RETURNING id::text
      `,
      [input.agentId, content, contentHash],
    )
    const memoryId = shared.rows[0]?.id
    if (!memoryId) return { captured: true, shared: false }

    await client.query(
      `
        INSERT INTO agent_context_memory_evidence (memory_id, organization_id, operator_id)
        VALUES ($1::uuid, $2::uuid, $3)
        ON CONFLICT (memory_id, organization_id) DO NOTHING
      `,
      [memoryId, input.organizationId, operatorId],
    )
    await client.query(
      `
        UPDATE agent_context_memories memory
        SET evidence_count = evidence.count,
            updated_at = now()
        FROM (
          SELECT memory_id, count(*)::integer AS count
          FROM agent_context_memory_evidence
          WHERE memory_id = $1::uuid
          GROUP BY memory_id
        ) evidence
        WHERE memory.id = evidence.memory_id
      `,
      [memoryId],
    )
    return { captured: true, shared: false }
  })
}
