import crypto from 'crypto'
import fs from 'fs/promises'
import path from 'path'
import matter from 'gray-matter'
import type { PoolClient } from 'pg'
import { listAiRadarItems } from '@/lib/aiRadar'
import { buildAgentTaskDocument } from '@/lib/agents/taskDocument'
import { embedSearchQuery } from '@/lib/documentEmbeddings'
import {
  buildPipelineEngagementInsights,
  type PipelineBriefOpportunityInput,
} from '@/lib/pipelineBrief'
import { query, withTransaction } from '@/lib/persistence/postgres'
import { MEMBER_RELEASE_HISTORY_DAYS, releaseAccessFor } from '@/lib/releases'
import {
  readPipelineProjectionForSpace,
  resolvePipelineSpaceAccess,
  resolveProjectBoardAccess,
} from '@/lib/tenancy'
import { configuredOwnerEmail, getAppUser, normalizeUserEmail, type AppUser } from '@/lib/users'

export type AppDocument = {
  id: string
  title: string
  date: string
  tags: string[]
  category: string
  slug: string
  content: string
  excerpt: string
  kind: string
  status: string
  source: string
  sourcePath: string | null
}

type DocumentRow = {
  id: string
  title: string
  document_date: string
  tags: string[] | null
  category: string
  slug: string
  content: string
  excerpt: string
  kind: string
  status: string
  source: string
  source_path: string | null
}

type TaskBriefRow = {
  title: string
  status: string
  priority: string
  updated_at: string
  next_action: string | null
  category: string
}

type ReleaseBriefRow = {
  title: string
  summary: string
  deployed_at: string
  features: string[] | null
  fixes: string[] | null
}

type PipelineEngagementBriefRow = {
  reference_code: string
  name: string
  organization_name: string
  status: string
  stage: string
  amount: string
  probability: string
  expected_close: string | null
  total_touches: string
  touches_30d: string
  touches_90d: string
  inbound_30d: string
  outbound_30d: string
  email_30d: string
  call_30d: string
  meeting_30d: string
  last_touch_at: string | null
}

type PipelineActivityBriefRow = {
  total_30d: string
  total_90d: string
  linked_30d: string
  email_30d: string
  call_30d: string
  meeting_30d: string
  inbound_30d: string
  outbound_30d: string
  failed_30d: string
}

export type DocumentBriefSelection = {
  boardId?: string | null
  pipelineId?: string | null
}

export type GeneratedDocumentKind = 'build-brief' | 'project-report' | 'pipeline-report' | 'research-radar'

type GeneratedDocumentTemplateRow = {
  kind: GeneratedDocumentKind
  title: string
  category: string
  content: string
  tags: string[]
  board_id: string | null
  pipeline_id: string | null
}

type RepositorySyncGlobal = typeof globalThis & {
  __clawpilotRepositoryDocsSynced?: Set<string>
}

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex')
}

function singleLine(value: unknown): string {
  return String(value || '').replace(/\s+/g, ' ').trim()
}

function pipelineSourceLabel(value: unknown): string {
  if (typeof value === 'string') return singleLine(value) || 'app'
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 'app'

  const provider = singleLine((value as Record<string, unknown>).provider)
  if (provider === 'native-google-sheets') return 'Managed Google Sheets'
  if (provider === 'maton-google-sheets') return 'Google Sheets via Maton'
  return provider || 'app'
}

function excerptFor(content: string): string {
  return content
    .replace(/^---[\s\S]*?---\s*/m, '')
    .replace(/^#+\s+/gm, '')
    .replace(/[`*_>[\]#|]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 180)
}

function titleFromMarkdown(content: string, fallback: string): string {
  const heading = content.split('\n').find((line) => /^#\s+\S/.test(line))
  return singleLine(heading?.replace(/^#\s+/, '') || fallback)
}

function safeSlug(value: string): string {
  return value
    .toLowerCase()
    .replace(/\.md$/i, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 180) || 'document'
}

function markdownList(items: string[], empty: string): string {
  return items.length > 0 ? items.map((item) => `- ${singleLine(item)}`).join('\n') : `- ${empty}`
}

function money(value: number): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(value || 0)
}

async function upsertDocument(input: {
  ownerEmail: string
  sourceKey: string
  source: 'system' | 'repository' | 'user' | 'agent'
  kind: string
  status: 'draft' | 'active' | 'superseded' | 'historical' | 'generated'
  title: string
  slug: string
  category: string
  content: string
  tags: string[]
  sourcePath?: string | null
  boardId?: string | null
  pipelineId?: string | null
  generatedAt?: string | null
}, client?: PoolClient): Promise<string | null> {
  const content = input.content.trim()
  const contentHash = sha256(content)
  const sql = `
      WITH changed_document AS (
        INSERT INTO app_documents (
          owner_email, source_key, source, kind, status, title, slug, category,
          content, excerpt, tags, source_path, content_hash, board_id, pipeline_id,
          generated_at, created_at, updated_at
        )
        VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8,
          $9, $10, $11::text[], $12, $13, $14::uuid, $15::uuid,
          $16::timestamptz, now(), now()
        )
        ON CONFLICT (owner_email, source_key) DO UPDATE SET
          source = EXCLUDED.source,
          kind = EXCLUDED.kind,
          status = EXCLUDED.status,
          title = EXCLUDED.title,
          slug = EXCLUDED.slug,
          category = EXCLUDED.category,
          content = EXCLUDED.content,
          excerpt = EXCLUDED.excerpt,
          tags = EXCLUDED.tags,
          source_path = EXCLUDED.source_path,
          content_hash = EXCLUDED.content_hash,
          board_id = EXCLUDED.board_id,
          pipeline_id = EXCLUDED.pipeline_id,
          generated_at = EXCLUDED.generated_at,
          updated_at = now()
        WHERE app_documents.content_hash <> EXCLUDED.content_hash
           OR app_documents.source IS DISTINCT FROM EXCLUDED.source
           OR app_documents.kind IS DISTINCT FROM EXCLUDED.kind
           OR app_documents.status <> EXCLUDED.status
           OR app_documents.title <> EXCLUDED.title
           OR app_documents.slug <> EXCLUDED.slug
           OR app_documents.category <> EXCLUDED.category
           OR app_documents.excerpt IS DISTINCT FROM EXCLUDED.excerpt
           OR app_documents.tags IS DISTINCT FROM EXCLUDED.tags
           OR app_documents.source_path IS DISTINCT FROM EXCLUDED.source_path
           OR app_documents.board_id IS DISTINCT FROM EXCLUDED.board_id
           OR app_documents.pipeline_id IS DISTINCT FROM EXCLUDED.pipeline_id
           OR app_documents.generated_at IS DISTINCT FROM EXCLUDED.generated_at
        RETURNING id, owner_email, content_hash
      )
      INSERT INTO document_embedding_jobs (document_id, owner_email, content_hash)
      SELECT id, owner_email, content_hash
      FROM changed_document
      ON CONFLICT (document_id) DO UPDATE SET
        owner_email = EXCLUDED.owner_email,
        content_hash = EXCLUDED.content_hash,
        status = 'pending',
        attempts = 0,
        available_at = now(),
        locked_at = NULL,
        last_error = NULL,
        updated_at = now()
      RETURNING document_id::text
    `
  const parameters = [
    input.ownerEmail,
    input.sourceKey,
    input.source,
    input.kind,
    input.status,
    input.title,
    input.slug,
    input.category,
    content,
    excerptFor(content),
    input.tags,
    input.sourcePath || null,
    contentHash,
    input.boardId || null,
    input.pipelineId || null,
    input.generatedAt || null,
  ]
  const result = client
    ? await client.query<{ document_id: string }>(sql, parameters)
    : await query<{ document_id: string }>(sql, parameters)
  return result.rows[0]?.document_id || null
}

export type AgentTaskDocumentReference = {
  id: string
  title: string
  slug: string
  url: string
  created: boolean
  appended: boolean
}

type ExistingAgentTaskDocumentRow = {
  id: string
  title: string
  slug: string
  content: string
}

export async function readAgentTaskDocumentContext(input: {
  ownerEmail: string
  taskId: string
  agentId: string
}): Promise<string | null> {
  const ownerEmail = normalizeUserEmail(input.ownerEmail)
  const agentId = singleLine(input.agentId).toLowerCase() || 'agent'
  const sourceKey = `agent-task:${input.taskId}:${agentId}`
  const result = await query<{ content: string }>(
    `SELECT content
     FROM app_documents
     WHERE owner_email = $1 AND source_key = $2
     LIMIT 1`,
    [ownerEmail, sourceKey],
  )
  return result.rows[0]?.content || null
}

export async function appendAgentTaskDocument(input: {
  ownerEmail: string
  boardId: string
  taskId: string
  taskTitle: string
  agentId: string
  resultId: string
  status: string
  summary: string
  deliverable: string
  changes: string[]
  nextAction: string
  waitingOn: string
  recordedAt: string
}): Promise<AgentTaskDocumentReference> {
  const ownerEmail = normalizeUserEmail(input.ownerEmail)
  const agentId = singleLine(input.agentId).toLowerCase() || 'agent'
  const sourceKey = `agent-task:${input.taskId}:${agentId}`
  const user = await getAppUser(ownerEmail)
  const recordedAt = Number.isFinite(Date.parse(input.recordedAt))
    ? new Date(input.recordedAt)
    : new Date()
  const displayTimestamp = new Intl.DateTimeFormat(user?.locale || 'en-US', {
    timeZone: user?.timezone || 'UTC',
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(recordedAt)
  return withTransaction(async (client) => {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`${ownerEmail}:${sourceKey}`])
    const existing = await client.query<ExistingAgentTaskDocumentRow>(
      `
        SELECT id::text, title, slug, content
        FROM app_documents
        WHERE owner_email = $1 AND source_key = $2
        LIMIT 1
      `,
      [ownerEmail, sourceKey],
    )
    const current = existing.rows[0] || null
    const built = buildAgentTaskDocument({
      existingContent: current?.content,
      taskId: input.taskId,
      taskTitle: input.taskTitle,
      boardId: input.boardId,
      agentId,
      resultId: input.resultId,
      status: input.status,
      summary: input.summary,
      deliverable: input.deliverable,
      changes: input.changes,
      nextAction: input.nextAction,
      waitingOn: input.waitingOn,
      recordedAt: recordedAt.toISOString(),
      displayTimestamp,
    })
    const slug = current?.slug || [
      'agent',
      safeSlug(input.taskTitle).slice(0, 100),
      sha256(`${input.taskId}:${agentId}`).slice(0, 10),
      safeSlug(agentId),
    ].join('-')
    let id = current?.id || null
    if (built.appended || !current || current.title !== built.title) {
      id = await upsertDocument({
        ownerEmail,
        sourceKey,
        source: 'agent',
        kind: 'agent-task-deliverable',
        status: 'active',
        title: built.title,
        slug,
        category: agentId === 'projects' ? 'projects' : agentId,
        content: built.content,
        tags: Array.from(new Set(['agent', 'task-linked', agentId, `task:${input.taskId}`])),
        boardId: input.boardId,
        generatedAt: recordedAt.toISOString(),
      }, client) || id
    }
    if (!id) throw new Error('Agent task document could not be persisted')
    return {
      id,
      title: built.title,
      slug,
      url: `/?doc=${encodeURIComponent(slug)}#docs`,
      created: !current,
      appended: built.appended,
    }
  })
}

export async function refreshUserBriefs(
  user: AppUser,
  selection: DocumentBriefSelection = {},
): Promise<void> {
  const ownerEmail = normalizeUserEmail(user.email)
  const [board, pipeline] = await Promise.all([
    resolveProjectBoardAccess({ actorEmail: ownerEmail, boardId: selection.boardId })
      .catch((error) => selection.boardId
        ? resolveProjectBoardAccess({ actorEmail: ownerEmail })
        : Promise.reject(error)),
    resolvePipelineSpaceAccess({ actorEmail: ownerEmail, pipelineId: selection.pipelineId })
      .catch((error) => selection.pipelineId
        ? resolvePipelineSpaceAccess({ actorEmail: ownerEmail })
        : Promise.reject(error)),
  ])
  const releaseAccess = releaseAccessFor(user)
  const [
    tasksResult,
    pipelineProjection,
    releasesResult,
    radarItems,
    engagementResult,
    activityResult,
  ] = await Promise.all([
    query<TaskBriefRow>(
      `
        SELECT
          title,
          status,
          priority,
          updated_at::text,
          NULLIF(payload->>'nextAction', '') AS next_action,
          category
        FROM tasks
        WHERE board_id = $1::uuid
          AND source <> 'crm-projection'
          AND archived = false
          AND deleted_at IS NULL
        ORDER BY
          CASE priority WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END,
          updated_at DESC
      `,
      [board.id],
    ),
    readPipelineProjectionForSpace(pipeline),
    query<ReleaseBriefRow>(
      `
        SELECT title, summary, deployed_at::text, features, fixes
        FROM release_entries
        WHERE $1::boolean
          OR deployed_at >= now() - ($2::integer * interval '1 day')
        ORDER BY deployed_at DESC
        LIMIT 5
      `,
      [releaseAccess.historyScope === 'full', MEMBER_RELEASE_HISTORY_DAYS],
    ),
    listAiRadarItems(12),
    query<PipelineEngagementBriefRow>(
      `
        SELECT
          opportunity.reference_code,
          opportunity.name,
          COALESCE(organization.name, opportunity.organization_name, '') AS organization_name,
          COALESCE(opportunity.status, '') AS status,
          COALESCE(opportunity.stage, '') AS stage,
          opportunity.amount::text,
          opportunity.probability::text,
          opportunity.expected_close::text,
          count(interaction.id)::text AS total_touches,
          count(interaction.id) FILTER (
            WHERE COALESCE(interaction.occurred_at, interaction.updated_at) >= now() - interval '30 days'
          )::text AS touches_30d,
          count(interaction.id) FILTER (
            WHERE COALESCE(interaction.occurred_at, interaction.updated_at) >= now() - interval '90 days'
          )::text AS touches_90d,
          count(interaction.id) FILTER (
            WHERE interaction.direction = 'inbound'
              AND COALESCE(interaction.occurred_at, interaction.updated_at) >= now() - interval '30 days'
          )::text AS inbound_30d,
          count(interaction.id) FILTER (
            WHERE interaction.direction = 'outbound'
              AND COALESCE(interaction.occurred_at, interaction.updated_at) >= now() - interval '30 days'
          )::text AS outbound_30d,
          count(interaction.id) FILTER (
            WHERE (lower(COALESCE(interaction.interaction_type, '')) LIKE '%email%'
              OR interaction.provider_message_id IS NOT NULL)
              AND COALESCE(interaction.occurred_at, interaction.updated_at) >= now() - interval '30 days'
          )::text AS email_30d,
          count(interaction.id) FILTER (
            WHERE lower(COALESCE(interaction.interaction_type, '')) LIKE '%call%'
              AND COALESCE(interaction.occurred_at, interaction.updated_at) >= now() - interval '30 days'
          )::text AS call_30d,
          count(interaction.id) FILTER (
            WHERE (interaction.meeting_id IS NOT NULL
              OR lower(COALESCE(interaction.interaction_type, '')) LIKE '%meeting%')
              AND COALESCE(interaction.occurred_at, interaction.updated_at) >= now() - interval '30 days'
          )::text AS meeting_30d,
          max(COALESCE(interaction.occurred_at, interaction.updated_at))::text AS last_touch_at
        FROM crm_opportunities opportunity
        LEFT JOIN crm_organizations organization
          ON organization.pipeline_id = opportunity.pipeline_id
         AND organization.id = opportunity.organization_id
        LEFT JOIN crm_interactions interaction
          ON interaction.pipeline_id = opportunity.pipeline_id
         AND interaction.opportunity_id = opportunity.id
        WHERE opportunity.pipeline_id = $1::uuid
          AND lower(btrim(COALESCE(opportunity.status, 'open'))) NOT IN ('won', 'lost', 'closed', 'abandoned')
        GROUP BY opportunity.id, organization.name
        ORDER BY opportunity.amount DESC, opportunity.updated_at DESC
      `,
      [pipeline.id],
    ),
    query<PipelineActivityBriefRow>(
      `
        SELECT
          count(*) FILTER (WHERE COALESCE(occurred_at, updated_at) >= now() - interval '30 days')::text AS total_30d,
          count(*) FILTER (WHERE COALESCE(occurred_at, updated_at) >= now() - interval '90 days')::text AS total_90d,
          count(*) FILTER (WHERE opportunity_id IS NOT NULL AND COALESCE(occurred_at, updated_at) >= now() - interval '30 days')::text AS linked_30d,
          count(*) FILTER (WHERE (lower(COALESCE(interaction_type, '')) LIKE '%email%' OR provider_message_id IS NOT NULL) AND COALESCE(occurred_at, updated_at) >= now() - interval '30 days')::text AS email_30d,
          count(*) FILTER (WHERE lower(COALESCE(interaction_type, '')) LIKE '%call%' AND COALESCE(occurred_at, updated_at) >= now() - interval '30 days')::text AS call_30d,
          count(*) FILTER (WHERE (meeting_id IS NOT NULL OR lower(COALESCE(interaction_type, '')) LIKE '%meeting%') AND COALESCE(occurred_at, updated_at) >= now() - interval '30 days')::text AS meeting_30d,
          count(*) FILTER (WHERE direction = 'inbound' AND COALESCE(occurred_at, updated_at) >= now() - interval '30 days')::text AS inbound_30d,
          count(*) FILTER (WHERE direction = 'outbound' AND COALESCE(occurred_at, updated_at) >= now() - interval '30 days')::text AS outbound_30d,
          count(*) FILTER (WHERE lower(COALESCE(delivery_status, '')) = 'failed' AND COALESCE(occurred_at, updated_at) >= now() - interval '30 days')::text AS failed_30d
        FROM crm_interactions
        WHERE pipeline_id = $1::uuid
      `,
      [pipeline.id],
    ),
  ])

  const now = new Date().toISOString()
  const tasks = tasksResult.rows
  const openTasks = tasks.filter((task) => task.status !== 'done')
  const statusCounts = ['backlog', 'todo', 'in-progress', 'review', 'done'].map((status) => ({
    status,
    count: tasks.filter((task) => task.status === status).length,
  }))
  const latestRelease = releasesResult.rows[0]
  const buildContent = [
    '# Build Brief',
    '',
    `Updated: ${now}`,
    '',
    '## Current Release',
    latestRelease
      ? `**${singleLine(latestRelease.title)}** - ${singleLine(latestRelease.summary) || 'Release recorded.'}`
      : 'No deployment release has been recorded yet.',
    '',
    '## Workspace Workload',
    `- Open tasks: ${openTasks.length}`,
    `- In progress: ${tasks.filter((task) => task.status === 'in-progress').length}`,
    `- In review: ${tasks.filter((task) => task.status === 'review').length}`,
    `- Completed: ${tasks.filter((task) => task.status === 'done').length}`,
    '',
    '## Recent Releases',
    markdownList(releasesResult.rows.map((release) => `${new Date(release.deployed_at).toLocaleDateString('en-US')} - ${release.title}`), 'No releases recorded.'),
  ].join('\n')

  const projectContent = [
    '# Project Board Brief',
    '',
    `Updated: ${now}`,
    '',
    '## Board Summary',
    `Board: ${singleLine(board.name)}`,
    ...statusCounts.map(({ status, count }) => `- ${status}: ${count}`),
    '',
    '## Priority Work',
    markdownList(openTasks.slice(0, 10).map((task) => `${task.title} (${task.status}, ${task.priority})${task.next_action ? ` - Next: ${task.next_action}` : ''}`), 'No open work.'),
  ].join('\n')

  const summary = pipelineProjection.summary || {}
  const opportunities = Array.isArray(pipelineProjection.opportunities) ? pipelineProjection.opportunities : []
  const activity = activityResult.rows[0] || {
    total_30d: '0', total_90d: '0', linked_30d: '0', email_30d: '0', call_30d: '0', meeting_30d: '0',
    inbound_30d: '0', outbound_30d: '0', failed_30d: '0',
  }
  const engagementInputs: PipelineBriefOpportunityInput[] = engagementResult.rows.map((row) => ({
    referenceCode: singleLine(row.reference_code),
    name: singleLine(row.name) || 'Untitled opportunity',
    organization: singleLine(row.organization_name),
    stage: singleLine(row.stage),
    status: singleLine(row.status),
    value: Number(row.amount || 0),
    probability: Number(row.probability || 0),
    expectedClose: row.expected_close,
    touches30d: Number(row.touches_30d || 0),
    touches90d: Number(row.touches_90d || 0),
    totalTouches: Number(row.total_touches || 0),
    inbound30d: Number(row.inbound_30d || 0),
    outbound30d: Number(row.outbound_30d || 0),
    email30d: Number(row.email_30d || 0),
    call30d: Number(row.call_30d || 0),
    meeting30d: Number(row.meeting_30d || 0),
    lastTouchAt: row.last_touch_at,
  }))
  const engagement = buildPipelineEngagementInsights(engagementInputs, new Date(now))
  const total30d = Number(activity.total_30d || 0)
  const linked30d = Number(activity.linked_30d || 0)
  const linkedRate = total30d > 0 ? Math.round((linked30d / total30d) * 100) : 0
  const actionQueue = engagement.opportunities.slice(0, 10).map((item) => {
    const identity = item.referenceCode
      ? `[${item.referenceCode}](/crm/${encodeURIComponent(item.referenceCode)}) - ${item.name}`
      : item.name
    const lastTouch = item.daysSinceLastTouch === null
      ? 'no linked touch history'
      : item.daysSinceLastTouch === 0 ? 'last touch today' : `last touch ${item.daysSinceLastTouch}d ago`
    const close = item.daysToClose === null
      ? 'no expected close date'
      : item.daysToClose < 0 ? `close date overdue by ${Math.abs(item.daysToClose)}d` : `closes in ${item.daysToClose}d`
    return `${identity}${item.organization ? ` (${item.organization})` : ''} - ${money(item.value)}, ${item.stage || 'No stage'} - ${item.touches30d} touches/30d vs ${item.benchmark30d} ${item.benchmarkLabel}; ${lastTouch}; ${close}. **Next:** ${item.recommendedAction}.`
  })
  const stageCadence = engagement.stageBenchmarks.map((benchmark) => (
    `${benchmark.stage}: median ${benchmark.medianTouches30d} and average ${benchmark.averageTouches30d} touches/30d across ${benchmark.opportunities} open opportunities`
  ))
  const pipelineContent = [
    '# Pipeline Brief',
    '',
    `Updated: ${now}`,
    '',
    `Pipeline: ${singleLine(pipeline.name || 'My pipeline')}`,
    `Source: ${pipelineSourceLabel(pipelineProjection.source)}`,
    `Last synchronized: ${singleLine(pipelineProjection.syncedAt || 'Not synchronized')}`,
    '',
    '## Summary',
    `- Opportunities: ${Number(summary.opportunities || 0)}`,
    `- Organizations: ${Number(summary.organizations || 0)}`,
    `- Contacts: ${Number(summary.contacts || 0)}`,
    `- Open value: ${money(Number(summary.totalOpenValue || 0))}`,
    `- Touches in the last 30 days: ${total30d} (${linked30d} linked to an opportunity; ${linkedRate}% coverage)`,
    `- Touches in the last 90 days: ${Number(activity.total_90d || 0)}`,
    `- Untouched open opportunities: ${engagement.untouched}`,
    `- Stale open opportunities (14+ days): ${engagement.stale}`,
    `- Closing within 30 days: ${engagement.closingWithin30Days}`,
    `- Overdue expected close dates: ${engagement.overdueCloseDates}`,
    '',
    '## Engagement Health',
    `- Email touches (30d): ${Number(activity.email_30d || 0)}`,
    `- Call touches (30d): ${Number(activity.call_30d || 0)}`,
    `- Meeting touches (30d): ${Number(activity.meeting_30d || 0)}`,
    `- Inbound / outbound (30d): ${Number(activity.inbound_30d || 0)} / ${Number(activity.outbound_30d || 0)}`,
    `- Failed deliveries (30d): ${Number(activity.failed_30d || 0)}`,
    `- Below normal cadence: ${engagement.lagging}`,
    `- Above normal cadence: ${engagement.aboveNormal}`,
    '',
    '## Priority Actions',
    markdownList(actionQueue, 'No open opportunities require an action.'),
    '',
    '## Stage Touch Benchmarks',
    markdownList(stageCadence, 'Not enough open opportunities to calculate a benchmark.'),
    '',
    '## Current Opportunities',
    markdownList(opportunities.slice(0, 10).map((item) => `${item.name || 'Untitled'} - ${item.stage || 'No stage'} - ${money(Number(item.value || 0))}${item.organization ? ` - ${item.organization}` : ''}`), 'No opportunities recorded.'),
    '',
    '## Measurement Notes',
    '- Opportunity cadence uses interactions explicitly linked to that opportunity so an organization-level email is not counted against every open deal.',
    '- The opportunity-link coverage rate shows how much of the recent interaction stream can support deal-level analysis.',
    '- Above-normal activity is a review signal, not an automatic positive result; verify that repeated touches are moving stage, close plan, or decision ownership.',
  ].join('\n')

  const researchTasks = tasks.filter((task) => task.category === 'research')
  const radarUpdates = radarItems.map((item) => {
    const published = new Date(item.publishedAt).toLocaleDateString('en-US')
    const title = item.title.replace(/[\[\]]/g, '')
    const summary = singleLine(item.summary).slice(0, 220)
    return `[${title}](${item.itemUrl}) - ${item.sourceName}, ${published}${summary ? ` - ${summary}` : ''}`
  })
  const radarContent = [
    '# AI and Opportunity Radar',
    '',
    `Updated: ${now}`,
    '',
    '## Verified Platform Updates',
    markdownList(radarUpdates, 'No verified platform updates have been collected yet.'),
    '',
    '## Research Queue',
    markdownList(researchTasks.map((task) => `${task.title} (${task.status})${task.next_action ? ` - Next: ${task.next_action}` : ''}`), 'No research items are queued.'),
    '',
    '## Intake Standard',
    '- Record the source and publication date.',
    '- State the relevant ClawPilot module, project, or pipeline opportunity.',
    '- Separate verified capability from a proposed experiment.',
    '- End with one concrete evaluation action.',
  ].join('\n')

  await Promise.all([
    upsertDocument({ ownerEmail, sourceKey: 'system:build-brief', source: 'system', kind: 'build-brief', status: 'generated', title: 'Build Brief', slug: 'build-brief', category: 'briefings', content: buildContent, tags: ['build', 'releases'], generatedAt: now }),
    upsertDocument({ ownerEmail, sourceKey: 'system:project-brief', source: 'system', kind: 'project-report', status: 'generated', title: 'Project Board Brief', slug: 'project-board-brief', category: 'projects', content: projectContent, tags: ['projects', 'tasks'], boardId: board.id, generatedAt: now }),
    upsertDocument({ ownerEmail, sourceKey: 'system:pipeline-brief', source: 'system', kind: 'pipeline-report', status: 'generated', title: 'Pipeline Brief', slug: 'pipeline-brief', category: 'pipeline', content: pipelineContent, tags: ['pipeline', 'report'], pipelineId: pipeline.id, generatedAt: now }),
    upsertDocument({ ownerEmail, sourceKey: 'system:ai-opportunity-radar', source: 'system', kind: 'research-radar', status: 'generated', title: 'AI and Opportunity Radar', slug: 'ai-opportunity-radar', category: 'radar', content: radarContent, tags: ['ai', 'research', 'opportunities'], generatedAt: now }),
  ])
}

export async function refreshActiveUserBriefs(): Promise<{ refreshed: number; errors: string[] }> {
  const activeUsers = await query<{ email: string }>(
    `SELECT email FROM app_users WHERE status = 'active' ORDER BY email`,
  )
  const users = (await Promise.all(activeUsers.rows.map((row) => getAppUser(row.email))))
    .filter((user): user is AppUser => user !== null)
  const settled = await Promise.allSettled(users.map((user) => refreshUserBriefs(user)))
  return {
    refreshed: settled.filter((result) => result.status === 'fulfilled').length,
    errors: settled.flatMap((result) => result.status === 'rejected'
      ? [(result.reason instanceof Error ? result.reason.message : String(result.reason)).slice(0, 500)]
      : []),
  }
}

const GENERATED_SOURCE_KEYS: Record<GeneratedDocumentKind, string> = {
  'build-brief': 'system:build-brief',
  'project-report': 'system:project-brief',
  'pipeline-report': 'system:pipeline-brief',
  'research-radar': 'system:ai-opportunity-radar',
}

export async function generateUserDocument(input: {
  user: AppUser
  kind: GeneratedDocumentKind
  boardId?: string | null
  pipelineId?: string | null
}): Promise<{ id: string; title: string; slug: string }> {
  const ownerEmail = normalizeUserEmail(input.user.email)
  if (!Object.hasOwn(GENERATED_SOURCE_KEYS, input.kind)) throw new Error('Unsupported document type')

  const [board, pipeline] = await Promise.all([
    resolveProjectBoardAccess({ actorEmail: ownerEmail, boardId: input.boardId }),
    resolvePipelineSpaceAccess({ actorEmail: ownerEmail, pipelineId: input.pipelineId }),
  ])
  await refreshUserBriefs(input.user, { boardId: board.id, pipelineId: pipeline.id })

  const template = await query<GeneratedDocumentTemplateRow>(
    `
      SELECT kind, title, category, content, tags, board_id::text, pipeline_id::text
      FROM app_documents
      WHERE owner_email = $1
        AND source_key = $2
      LIMIT 1
    `,
    [ownerEmail, GENERATED_SOURCE_KEYS[input.kind]],
  )
  const source = template.rows[0]
  if (!source) throw new Error('Document source could not be prepared')

  const now = new Date()
  const generatedAt = now.toISOString()
  const displayTimestamp = new Intl.DateTimeFormat(input.user.locale || 'en-US', {
    timeZone: input.user.timezone || 'UTC',
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(now)
  const suffix = crypto.randomUUID().slice(0, 8)
  const title = `${source.title} - ${displayTimestamp}`
  const slug = `${safeSlug(source.title)}-${now.toISOString().slice(0, 10)}-${suffix}`
  const id = await upsertDocument({
    ownerEmail,
    sourceKey: `user-generated:${input.kind}:${crypto.randomUUID()}`,
    source: 'user',
    kind: source.kind,
    status: 'generated',
    title,
    slug,
    category: source.category,
    content: source.content,
    tags: Array.from(new Set([...source.tags, 'generated-on-demand'])),
    boardId: source.board_id,
    pipelineId: source.pipeline_id,
    generatedAt,
  })
  if (!id) throw new Error('Document was not created')
  return { id, title, slug }
}

const GENERATED_BRIEF_KEYS = [
  'system:build-brief',
  'system:project-brief',
  'system:pipeline-brief',
  'system:ai-opportunity-radar',
]

export async function ensureUserBriefs(
  user: AppUser,
  selection: DocumentBriefSelection = {},
): Promise<void> {
  const ownerEmail = normalizeUserEmail(user.email)
  const [board, pipeline] = await Promise.all([
    resolveProjectBoardAccess({ actorEmail: ownerEmail, boardId: selection.boardId })
      .catch((error) => selection.boardId
        ? resolveProjectBoardAccess({ actorEmail: ownerEmail })
        : Promise.reject(error)),
    resolvePipelineSpaceAccess({ actorEmail: ownerEmail, pipelineId: selection.pipelineId })
      .catch((error) => selection.pipelineId
        ? resolvePipelineSpaceAccess({ actorEmail: ownerEmail })
        : Promise.reject(error)),
  ])
  const existing = await query<{ source_key: string; board_id: string | null; pipeline_id: string | null }>(
    `
      SELECT source_key, board_id::text, pipeline_id::text
      FROM app_documents
      WHERE owner_email = $1
        AND source_key = ANY($2::text[])
    `,
    [ownerEmail, GENERATED_BRIEF_KEYS],
  )
  const byKey = new Map(existing.rows.map((row) => [row.source_key, row]))
  const complete = GENERATED_BRIEF_KEYS.every((key) => byKey.has(key))
    && byKey.get('system:project-brief')?.board_id === board.id
    && byKey.get('system:pipeline-brief')?.pipeline_id === pipeline.id
  if (!complete) {
    await refreshUserBriefs(user, { boardId: board.id, pipelineId: pipeline.id })
  }
}

async function repositoryDocsRoot(): Promise<string | null> {
  const candidates = [
    process.env.CLAWPILOT_REPO_ROOT || '',
    process.cwd(),
    path.resolve(process.cwd(), '..'),
  ].filter(Boolean)
  for (const candidate of candidates) {
    try {
      if ((await fs.stat(path.join(candidate, 'docs'))).isDirectory()) return candidate
    } catch {
      // Try the next runtime layout.
    }
  }
  return null
}

async function markdownFiles(root: string): Promise<string[]> {
  const entries = await fs.readdir(root, { withFileTypes: true })
  const nested = await Promise.all(entries.map(async (entry) => {
    const filePath = path.join(root, entry.name)
    if (entry.isDirectory()) {
      if (['.git', '.next', 'node_modules', 'data', 'data-dev', 'credentials'].includes(entry.name)) return []
      return markdownFiles(filePath)
    }
    if (path.dirname(filePath) === root && entry.name === 'AGENTS.md') return []
    return entry.isFile() && entry.name.toLowerCase().endsWith('.md') ? [filePath] : []
  }))
  return nested.flat().sort()
}

function repositoryClassification(relativePath: string, metadata: Record<string, unknown>) {
  const normalized = relativePath.replace(/\\/g, '/')
  const logicalPath = normalized.replace(/^docs\//, '')
  const explicitStatus = String(metadata.status || '')
  const currentRootDocument = normalized === 'README.md'
  const historical = (!explicitStatus && !currentRootDocument)
    || /(^|\/)(reviews|incidents|history)(\/|$)/.test(logicalPath)
    || /2026-0[3-5]/.test(logicalPath)
    || /audit|worklog|stabilization-report/i.test(logicalPath)
  const status = ['draft', 'active', 'superseded', 'historical', 'generated'].includes(explicitStatus)
    ? explicitStatus as 'draft' | 'active' | 'superseded' | 'historical' | 'generated'
    : historical ? 'historical' : 'active'
  const folder = logicalPath.split('/')[0]
  const categoryByFolder: Record<string, string> = {
    maps: 'maps',
    modules: 'modules',
    decisions: 'decisions',
    brand: 'brand',
    architecture: 'architecture',
    operations: 'operations',
    governance: 'operations',
    integrations: 'integrations',
    releases: 'releases',
  }
  const category = status === 'historical'
    ? 'archive'
    : categoryByFolder[folder] || 'knowledge'
  return { status, category }
}

export async function syncRepositoryDocuments(
  user: AppUser,
  options: { force?: boolean } = {},
): Promise<void> {
  if (normalizeUserEmail(user.email) !== configuredOwnerEmail()) return
  const runtime = globalThis as RepositorySyncGlobal
  if (!runtime.__clawpilotRepositoryDocsSynced) runtime.__clawpilotRepositoryDocsSynced = new Set()
  if (!options.force && runtime.__clawpilotRepositoryDocsSynced.has(user.email)) return
  const root = await repositoryDocsRoot()
  if (!root) return
  const files = await markdownFiles(root)
  const repositoryDocuments = (await Promise.all(files.map(async (filePath) => {
    const raw = await fs.readFile(filePath, 'utf8')
    const parsed = matter(raw)
    if (parsed.data.app_visible !== true) return null
    const relativePath = path.relative(root, filePath).replace(/\\/g, '/')
    const classification = repositoryClassification(relativePath, parsed.data)
    const title = singleLine(parsed.data.title) || titleFromMarkdown(parsed.content, path.basename(filePath, '.md'))
    const tags = Array.isArray(parsed.data.tags) ? parsed.data.tags.map(singleLine).filter(Boolean) : []
    const area = singleLine(parsed.data.area)
    return {
      ownerEmail: user.email,
      sourceKey: `repository:${relativePath}`,
      source: 'repository' as const,
      kind: singleLine(parsed.data.kind) || classification.category,
      status: classification.status,
      title,
      slug: `repo-${safeSlug(relativePath)}`,
      category: classification.category,
      content: parsed.content || raw,
      tags: Array.from(new Set(['clawpilot', area, ...tags].filter(Boolean))),
      sourcePath: relativePath,
    }
  }))).filter((document): document is NonNullable<typeof document> => document !== null)
  await Promise.all(repositoryDocuments.map((document) => upsertDocument(document)))
  await query(
    `
      DELETE FROM app_documents
      WHERE owner_email = $1
        AND source = 'repository'
        AND NOT (source_key = ANY($2::text[]))
    `,
    [user.email, repositoryDocuments.map((document) => document.sourceKey)],
  )
  runtime.__clawpilotRepositoryDocsSynced.add(user.email)
}

export async function listLocalRepositoryDocuments(searchValue?: unknown): Promise<AppDocument[]> {
  const root = await repositoryDocsRoot()
  if (!root) return []
  const search = singleLine(searchValue).toLowerCase()
  const files = await markdownFiles(root)
  const documents = (await Promise.all(files.map(async (filePath): Promise<AppDocument | null> => {
    const raw = await fs.readFile(filePath, 'utf8')
    const parsed = matter(raw)
    if (parsed.data.app_visible !== true) return null
    const relativePath = path.relative(root, filePath).replace(/\\/g, '/')
    const classification = repositoryClassification(relativePath, parsed.data)
    const title = singleLine(parsed.data.title) || titleFromMarkdown(parsed.content, path.basename(filePath, '.md'))
    const tags = Array.isArray(parsed.data.tags) ? parsed.data.tags.map(singleLine).filter(Boolean) : []
    const area = singleLine(parsed.data.area)
    const dateValue = parsed.data.date instanceof Date
      ? parsed.data.date.toISOString().slice(0, 10)
      : singleLine(parsed.data.date).slice(0, 10)
    const document: AppDocument = {
      id: `repository:${relativePath}`,
      title,
      date: dateValue,
      tags: Array.from(new Set(['clawpilot', area, ...tags].filter(Boolean))),
      category: classification.category,
      slug: `repo-${safeSlug(relativePath)}`,
      content: parsed.content || raw,
      excerpt: excerptFor(parsed.content || raw),
      kind: singleLine(parsed.data.kind) || classification.category,
      status: classification.status,
      source: 'repository',
      sourcePath: relativePath,
    }
    if (search && ![document.title, document.category, document.excerpt, document.content, ...document.tags]
      .some(value => value.toLowerCase().includes(search))) return null
    return document
  }))).filter((document): document is AppDocument => document !== null)

  return documents.sort((left, right) => {
    const statusOrder = (status: string) => status === 'active' ? 0 : status === 'generated' ? 1 : status === 'draft' ? 2 : 3
    return statusOrder(left.status) - statusOrder(right.status)
      || right.date.localeCompare(left.date)
      || left.title.localeCompare(right.title)
  })
}

function toDocument(row: DocumentRow): AppDocument {
  return {
    id: row.id,
    title: row.title,
    date: row.document_date ? new Date(row.document_date).toISOString().slice(0, 10) : '',
    tags: Array.isArray(row.tags) ? row.tags : [],
    category: row.category,
    slug: row.slug,
    content: row.content,
    excerpt: row.excerpt,
    kind: row.kind,
    status: row.status,
    source: row.source,
    sourcePath: row.source_path,
  }
}

export async function listUserDocuments(emailValue: unknown, searchValue?: unknown): Promise<AppDocument[]> {
  const ownerEmail = normalizeUserEmail(emailValue)
  const search = singleLine(searchValue).slice(0, 200)
  const semantic = search ? await embedSearchQuery(search) : null
  const result = await query<DocumentRow>(
    `
      SELECT
        id::text,
        title,
        COALESCE(generated_at, updated_at)::text AS document_date,
        tags,
        category,
        slug,
        content,
        excerpt,
        kind,
        status,
        source,
        source_path
      FROM app_documents
      WHERE owner_email = $1
        AND (
          $2 = ''
          OR search_vector @@ websearch_to_tsquery('english'::regconfig, $2)
          OR title ILIKE '%' || $2 || '%'
          OR array_to_string(tags, ' ') ILIKE '%' || $2 || '%'
          OR (
            embedding IS NOT NULL
            AND $3::vector IS NOT NULL
            AND embedding_model = $4
            AND 1 - (embedding <=> $3::vector) >= 0.35
          )
        )
      ORDER BY
        CASE WHEN $2 = '' THEN 0 ELSE GREATEST(
          ts_rank_cd(search_vector, websearch_to_tsquery('english'::regconfig, $2)) * 1.2,
          CASE WHEN title ILIKE '%' || $2 || '%' THEN 0.8 ELSE 0 END,
          CASE
            WHEN embedding IS NOT NULL AND $3::vector IS NOT NULL AND embedding_model = $4
            THEN 1 - (embedding <=> $3::vector)
            ELSE 0
          END
        ) END DESC,
        CASE source_key
          WHEN 'system:build-brief' THEN 0
          WHEN 'system:project-brief' THEN 1
          WHEN 'system:pipeline-brief' THEN 2
          WHEN 'system:ai-opportunity-radar' THEN 3
          ELSE 4
        END,
        CASE status WHEN 'active' THEN 0 WHEN 'generated' THEN 1 WHEN 'draft' THEN 2 ELSE 3 END,
        updated_at DESC,
        title ASC
    `,
    [ownerEmail, search, semantic?.vector || null, semantic?.model || ''],
  )
  return result.rows.map(toDocument)
}
