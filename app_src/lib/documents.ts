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
import { requireWorkspaceAppUser } from '@/lib/workspaceMemberships'

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

function markdownInline(value: unknown, fallback: string): string {
  return singleLine(value || fallback).replace(/([\\`*_\[\]<>])/g, '\\$1')
}

function money(value: number): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(value || 0)
}

async function upsertDocument(input: {
  ownerEmail: string
  organizationId: string
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
          owner_email, workspace_organization_id, source_key, source, kind, status, title, slug, category,
          content, excerpt, tags, source_path, content_hash, board_id, pipeline_id,
          generated_at, created_at, updated_at
        )
        VALUES (
          $1, $2::uuid, $3, $4, $5, $6, $7, $8, $9,
          $10, $11, $12::text[], $13, $14, $15::uuid, $16::uuid,
          $17::timestamptz, now(), now()
        )
        ON CONFLICT (owner_email, workspace_organization_id, source_key) DO UPDATE SET
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
    input.organizationId,
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

export const APPLICATION_USER_GUIDE_SOURCE_KEY = 'system:application-user-guide'

type ApplicationGuideUser = Pick<AppUser,
  'displayName' | 'organizationName' | 'organizationRole' | 'role'> & {
    permissions: Pick<AppUser['permissions'], 'viewAccounting' | 'manageLinks'>
  }

function applicationUserGuideContent(user: ApplicationGuideUser): string {
  const displayName = markdownInline(user.displayName, 'ClawPilot user')
  const organizationName = markdownInline(user.organizationName, 'Current workspace')
  const organizationRole = markdownInline(user.organizationRole || user.role, 'member')
  const accountingAccess = user.permissions.viewAccounting
    ? 'Your current access includes Accounting. Preparing, approving, and posting still depend on the separate accounting permissions shown in Settings.'
    : 'Accounting data is restricted in this workspace. Ask a workspace administrator if your role requires it.'
  const linkAccess = user.permissions.manageLinks
    ? 'You can create and manage organization-scoped short links.'
    : 'You can open links shared with you, while link management remains restricted to authorized users.'

  return [
    '# ClawPilot User Guide',
    '',
    `Prepared for: ${displayName}`,
    `Active workspace: ${organizationName}`,
    `Workspace role: ${organizationRole}`,
    '',
    '> ClawPilot keeps boards, pipelines, CRM records, documents, integrations, and agent context inside the active workspace. Check the workspace selector before creating or changing business data.',
    '',
    '## Start Here',
    '',
    '1. Open **Settings > Profile** and confirm your display name, job title, timezone, and locale.',
    '2. Check the workspace selector in the application header. Users with more than one business switch workspaces there; data does not combine across peer workspaces.',
    '3. On **Dashboard**, choose the board and pipeline you use most often. Those choices become your workspace defaults.',
    '4. Open **Settings > Integrations** to connect only the services you are authorized to use. Each user connects their own ChatGPT/Codex authorization.',
    '5. Return to this guide from **Docs** at any time. Search for `user guide`, `onboarding`, or a module name.',
    '',
    '## Application Map',
    '',
    '| Module | Use it for | Open |',
    '| --- | --- | --- |',
    '| Dashboard | Current work, agent attention, pipeline summary, recent documents, and workspace defaults | [Open Dashboard](/#dashboard) |',
    '| Docs | This guide, generated briefs, task working documents, release context, and private search | [Open Docs](/#docs) |',
    '| Projects | Personal or shared boards, tasks, checklists, comments, status, and agent assignment | [Open Projects](/#projects) |',
    '| Pipeline | Opportunities, stages, products, owners, insights, Google Sheet access, and sync status | [Open Pipeline](/#pipeline) |',
    '| CRM | Organizations, contacts, leads, opportunities, meetings, interactions, campaigns, and record relationships | [Open CRM](/#crm) |',
    '| Accounting | QuickBooks reports, invoices, receipts, attachments, products, customers, and controlled write reviews | [Open Accounting](/#accounting) |',
    '| POS | Toast orders, menu reporting, accounting mappings, draft generation, parity evidence, and posting controls | [Open POS](/#pos) |',
    '| Operations | Distributed orders, inventory reservations, warehouse execution, carrier rates, shipments, billable events, and fulfillment history | [Open Operations](/#operations) |',
    '| Links | Organization-scoped short links, slugs, expiration, click limits, and search | [Open Links](/#links) |',
    '| Agents | Task-specific discussion, durable work dispatches, execution state, and working-document results | [Open Agents](/#agents) |',
    '| Versions | User-facing releases, fixes, checkpoints, and authorized activity history | [Open Versions](/#versions) |',
    '',
    '## Projects and Agents',
    '',
    '1. Create a task with a concrete outcome, enough context to act, and a useful next action or checklist.',
    '2. Assign the product agent that matches the work: ClawPilot, Projects, Pipeline, Docs, or Calendar.',
    '3. Use **Discuss** in Agents when you want an answer or want to refine scope. Discussion does not change the card.',
    '4. Use **Work** when you want a durable execution. Work can update allowed task evidence, continue through checklist steps, and create or update one task-linked working document.',
    '5. On a card, explicitly mention the assigned agent when a new comment should start work. Ordinary comments remain human discussion.',
    '6. Review the status and linked document. `Input needed` requires a specific user decision; `Blocked` means a real capability or dependency is unavailable; `Review` means evidence is ready for a person.',
    '',
    'Agent roles are stable ClawPilot profiles, not separate custom GPTs. Every run rebuilds context from the role instruction, selected task, private workspace memory, and approved shared operating principles. Your ChatGPT/Codex credential is never shared with another user.',
    '',
    '## Pipeline and CRM',
    '',
    '1. Create or select the customer organization before adding an opportunity.',
    '2. Select one or more active products, an owner, stage, lifecycle status, probability, value, source, priority, and expected close date as applicable.',
    '3. Use stage for board position and status for lifecycle reporting. Open and On Hold remain active; Won/Closed are wins; Lost/Abandoned are losses.',
    '4. Record contacts and interactions against the correct organization and, when known, the related opportunity. This makes touchpoint and cadence insights actionable.',
    '5. Watch sync state. A queued or failed record is not yet synchronized with SuiteCRM or Google Sheets.',
    '6. Use **Open Sheet** for the managed workbook. Only the Opportunities operator table is writable; CRM and reporting tabs are generated projections.',
    '',
    'Global IDs are permanent record references: `ga` organizations, `gc` contacts, `gu` CRM employees, `go` opportunities, `gm` meetings, and related module prefixes. Use the Global ID or its short link when referring to an exact record.',
    '',
    '## Accounting and POS',
    '',
    accountingAccess,
    '',
    '1. Connect QuickBooks and Toast to the correct active workspace before reviewing data.',
    '2. In POS Accounting, bind the Toast location to the intended QuickBooks company and configure posting method, customer, clearing account, tax, memo, and optional class/location choices.',
    '3. Map every Toast sales item, service charge, tax, and tender to an exact QuickBooks item, account, or tax code. Create missing products through a reviewable draft.',
    '4. Reload sales when source data for one business date changed. Regenerate accounting when mappings or posting configuration changed but stored Toast sales are already current.',
    '5. Review the reconstructed Sales Receipt and Journal Entry, totals, mapping evidence, and parity details before any write.',
    '6. During a parallel run with another posting system, record the exact external result and QuickBooks references. Do not post the same business date again from ClawPilot.',
    '7. ClawPilot writes only after an authorized user prepares, submits, and approves the supported operation. A preview, draft, match, or provider response is not proof that QuickBooks changed.',
    '',
    '## Distributed Operations',
    '',
    '1. Confirm the active workspace before opening Operations. Warehouses, inventory pools, contracts, orders, shipments, and billable events are isolated by organization.',
    '2. Manage shared products and their default package data from **Pipeline > Configure > Products**. Authorized editors can add records one at a time or download and import the Products CSV template.',
    '3. A package profile stores package type, unit of measure, units per package, dimensions, and weight. Choose Metric for centimeters and kilograms or Imperial for inches and pounds, then enter length, width, height, and weight together. ClawPilot normalizes execution values while team updates retain the same permanent record and audit history.',
    '4. Imported orders must resolve to an existing CRM customer and active CRM product before inventory can be promised or reserved. Existing imports merge products by SKU or product name instead of creating a duplicate.',
    '5. Review warehouse feasibility, promise date, carton plan, selected carrier rate, expected cost, expected revenue, and margin before releasing live work.',
    '6. The current operator proof progresses through release, all-ready pick confirmation, and pack verification. Pack verification retains inventory reservations and does not buy a label, print, or confirm shipment.',
    '7. Inventory changes are append-only ledger entries. Do not correct inventory by editing totals; use a controlled adjustment with a reason and source reference.',
    '8. Contract directives create immutable billable events. Reconciliation and invoicing consume those events without changing their original amount or evidence.',
    '9. The current proof uses mock commerce, carrier, and printer adapters. Mock shipments are operational acceptance evidence, not real customer fulfillment.',
    '',
    '## Documents and Reports',
    '',
    '- System documents stay private to you inside this workspace.',
    '- **Build Brief** summarizes recent application releases.',
    '- **Project Board Brief** summarizes the selected board and next actions.',
    '- **Pipeline Brief** combines opportunities with linked interaction cadence, stale work, close-date risk, and an action queue.',
    '- **AI and Opportunity Radar** contains verified platform updates and the research queue.',
    '- **New document** creates a point-in-time snapshot without replacing the live brief.',
    '- Agent research and design work belongs in the linked working document; card comments remain concise status and navigation evidence.',
    '',
    '## People, Permissions, and Sharing',
    '',
    '- **Profile** controls your personal name, job title, timezone, and locale.',
    '- **People** is where authorized administrators invite users, choose an organization, set role and granular permissions, enable CRM employee identity, disable access, or manage existing users.',
    '- **Sharing** grants explicit board or pipeline viewer/editor access. Application administration does not automatically grant every organization record.',
    '- **Integrations** stores and tests the active workspace or user credentials allowed by the connector contract.',
    `- ${linkAccess}`,
    '- Demo access is off by default and appears only when an administrator grants it. Demo data is synthetic and separate from live business workspaces.',
    '',
    '## Mobile and Browser Sessions',
    '',
    '- On mobile, use the bottom navigation for frequent modules and **More** for the full menu.',
    '- Tables and boards may use a selected-stage or horizontal detail view on narrow screens; detail drawers retain their own vertical scrolling.',
    '- Each browser creates a separate authenticated session with device, browser, last activity, and IP attribution. Review or revoke sessions from Settings if a device is no longer trusted.',
    '- A root administrator may use audited impersonation for support. Activity records both the effective user and the impersonating administrator.',
    '',
    '## When Something Looks Wrong',
    '',
    '1. Confirm the active workspace, selected board, selected pipeline, and date range.',
    '2. Read the visible status before retrying. `Queued`, `syncing`, `needs review`, and `failed` represent different recovery paths.',
    '3. Refresh the module once. Avoid repeated submission while an operation is queued or working.',
    '4. Open the Activity detail or related Global ID to identify the exact record and last durable event.',
    '5. Send the administrator the module, workspace, Global ID, timestamp, visible error, and action you attempted. Do not send passwords, API keys, device codes, or service-account files.',
  ].join('\n')
}

export async function ensureApplicationUserGuide(user: AppUser): Promise<void> {
  const ownerEmail = normalizeUserEmail(user.email)
  const organizationId = String(user.organizationId || '').trim()
  if (!organizationId) throw new Error('Active workspace is required for documents')
  await upsertDocument({
    ownerEmail,
    organizationId,
    sourceKey: APPLICATION_USER_GUIDE_SOURCE_KEY,
    source: 'system',
    kind: 'application-user-guide',
    status: 'active',
    title: 'ClawPilot User Guide',
    slug: 'clawpilot-user-guide',
    category: 'getting-started',
    content: applicationUserGuideContent(user),
    tags: ['user-guide', 'onboarding', 'help', 'modules'],
  })
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
  organizationId: string
  taskId: string
  agentId: string
}): Promise<string | null> {
  const ownerEmail = normalizeUserEmail(input.ownerEmail)
  const agentId = singleLine(input.agentId).toLowerCase() || 'agent'
  const sourceKey = `agent-task:${input.taskId}:${agentId}`
  const result = await query<{ content: string }>(
    `SELECT content
     FROM app_documents
     WHERE owner_email = $1
       AND workspace_organization_id = $2::uuid
       AND source_key = $3
     LIMIT 1`,
    [ownerEmail, input.organizationId, sourceKey],
  )
  return result.rows[0]?.content || null
}

export async function appendAgentTaskDocument(input: {
  ownerEmail: string
  organizationId: string
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
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`${ownerEmail}:${input.organizationId}:${sourceKey}`])
    const existing = await client.query<ExistingAgentTaskDocumentRow>(
      `
        SELECT id::text, title, slug, content
        FROM app_documents
        WHERE owner_email = $1
          AND workspace_organization_id = $2::uuid
          AND source_key = $3
        LIMIT 1
      `,
      [ownerEmail, input.organizationId, sourceKey],
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
        organizationId: input.organizationId,
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
  const organizationId = String(user.organizationId || '').trim()
  if (!organizationId) throw new Error('Active workspace is required for documents')
  const [board, pipeline] = await Promise.all([
    resolveProjectBoardAccess({ actorEmail: user, boardId: selection.boardId })
      .catch((error) => selection.boardId
        ? resolveProjectBoardAccess({ actorEmail: user })
        : Promise.reject(error)),
    resolvePipelineSpaceAccess({ actorEmail: user, pipelineId: selection.pipelineId })
      .catch((error) => selection.pipelineId
        ? resolvePipelineSpaceAccess({ actorEmail: user })
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
        FROM (
          SELECT DISTINCT ON (commit_hash)
            commit_hash, title, summary, deployed_at, features, fixes
          FROM release_entries
          WHERE $1::boolean
            OR deployed_at >= now() - ($2::integer * interval '1 day')
          ORDER BY commit_hash, deployed_at DESC
        ) recent_releases
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
    upsertDocument({ ownerEmail, organizationId, sourceKey: 'system:build-brief', source: 'system', kind: 'build-brief', status: 'generated', title: 'Build Brief', slug: 'build-brief', category: 'briefings', content: buildContent, tags: ['build', 'releases'], generatedAt: now }),
    upsertDocument({ ownerEmail, organizationId, sourceKey: 'system:project-brief', source: 'system', kind: 'project-report', status: 'generated', title: 'Project Board Brief', slug: 'project-board-brief', category: 'projects', content: projectContent, tags: ['projects', 'tasks'], boardId: board.id, generatedAt: now }),
    upsertDocument({ ownerEmail, organizationId, sourceKey: 'system:pipeline-brief', source: 'system', kind: 'pipeline-report', status: 'generated', title: 'Pipeline Brief', slug: 'pipeline-brief', category: 'pipeline', content: pipelineContent, tags: ['pipeline', 'report'], pipelineId: pipeline.id, generatedAt: now }),
    upsertDocument({ ownerEmail, organizationId, sourceKey: 'system:ai-opportunity-radar', source: 'system', kind: 'research-radar', status: 'generated', title: 'AI and Opportunity Radar', slug: 'ai-opportunity-radar', category: 'radar', content: radarContent, tags: ['ai', 'research', 'opportunities'], generatedAt: now }),
  ])
}

export async function refreshActiveUserBriefs(): Promise<{ refreshed: number; errors: string[] }> {
  const activeUsers = await query<{ email: string; organization_id: string }>(
    `SELECT app_user.email, membership.organization_id::text
     FROM app_users app_user
     JOIN app_user_organization_memberships membership
       ON membership.user_email = app_user.email
      AND membership.status = 'active'
     WHERE app_user.status = 'active'
     ORDER BY app_user.email, membership.is_default DESC, membership.created_at`,
  )
  const users = await Promise.all(activeUsers.rows.map((row) => (
    requireWorkspaceAppUser(row.email, row.organization_id)
  )))
  const settled = await Promise.allSettled(users.map((user) => Promise.all([
    ensureApplicationUserGuide(user),
    refreshUserBriefs(user),
  ])))
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
  const organizationId = String(input.user.organizationId || '').trim()
  if (!organizationId) throw new Error('Active workspace is required for documents')
  if (!Object.hasOwn(GENERATED_SOURCE_KEYS, input.kind)) throw new Error('Unsupported document type')

  const [board, pipeline] = await Promise.all([
    resolveProjectBoardAccess({ actorEmail: input.user, boardId: input.boardId }),
    resolvePipelineSpaceAccess({ actorEmail: input.user, pipelineId: input.pipelineId }),
  ])
  await refreshUserBriefs(input.user, { boardId: board.id, pipelineId: pipeline.id })

  const template = await query<GeneratedDocumentTemplateRow>(
    `
      SELECT kind, title, category, content, tags, board_id::text, pipeline_id::text
      FROM app_documents
      WHERE owner_email = $1
        AND workspace_organization_id = $2::uuid
        AND source_key = $3
      LIMIT 1
    `,
    [ownerEmail, organizationId, GENERATED_SOURCE_KEYS[input.kind]],
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
    organizationId,
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
  const organizationId = String(user.organizationId || '').trim()
  if (!organizationId) throw new Error('Active workspace is required for documents')
  const [board, pipeline] = await Promise.all([
    resolveProjectBoardAccess({ actorEmail: user, boardId: selection.boardId })
      .catch((error) => selection.boardId
        ? resolveProjectBoardAccess({ actorEmail: user })
        : Promise.reject(error)),
    resolvePipelineSpaceAccess({ actorEmail: user, pipelineId: selection.pipelineId })
      .catch((error) => selection.pipelineId
        ? resolvePipelineSpaceAccess({ actorEmail: user })
        : Promise.reject(error)),
  ])
  const existing = await query<{ source_key: string; board_id: string | null; pipeline_id: string | null }>(
    `
      SELECT source_key, board_id::text, pipeline_id::text
      FROM app_documents
      WHERE owner_email = $1
        AND workspace_organization_id = $2::uuid
        AND source_key = ANY($3::text[])
    `,
    [ownerEmail, organizationId, GENERATED_BRIEF_KEYS],
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
  const organizationId = String(user.organizationId || '').trim()
  if (!organizationId) throw new Error('Active workspace is required for documents')
  const syncKey = `${user.email}:${organizationId}`
  const runtime = globalThis as RepositorySyncGlobal
  if (!runtime.__clawpilotRepositoryDocsSynced) runtime.__clawpilotRepositoryDocsSynced = new Set()
  if (!options.force && runtime.__clawpilotRepositoryDocsSynced.has(syncKey)) return
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
      organizationId,
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
        AND workspace_organization_id = $2::uuid
        AND source = 'repository'
        AND NOT (source_key = ANY($3::text[]))
    `,
    [user.email, organizationId, repositoryDocuments.map((document) => document.sourceKey)],
  )
  runtime.__clawpilotRepositoryDocsSynced.add(syncKey)
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

  const localGuideContent = applicationUserGuideContent({
    displayName: 'Local developer',
    organizationName: 'Local development workspace',
    organizationRole: 'owner',
    role: 'owner',
    permissions: { viewAccounting: true, manageLinks: true },
  })
  const localGuide: AppDocument = {
    id: APPLICATION_USER_GUIDE_SOURCE_KEY,
    title: 'ClawPilot User Guide',
    date: '',
    tags: ['user-guide', 'onboarding', 'help', 'modules'],
    category: 'getting-started',
    slug: 'clawpilot-user-guide',
    content: localGuideContent,
    excerpt: excerptFor(localGuideContent),
    kind: 'application-user-guide',
    status: 'active',
    source: 'system',
    sourcePath: null,
  }
  if (!search || [localGuide.title, localGuide.category, localGuide.excerpt, localGuide.content, ...localGuide.tags]
    .some(value => value.toLowerCase().includes(search))) documents.unshift(localGuide)

  return documents.sort((left, right) => {
    if (left.id === APPLICATION_USER_GUIDE_SOURCE_KEY) return -1
    if (right.id === APPLICATION_USER_GUIDE_SOURCE_KEY) return 1
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

export async function listUserDocuments(user: AppUser, searchValue?: unknown): Promise<AppDocument[]> {
  const ownerEmail = normalizeUserEmail(user.email)
  const organizationId = String(user.organizationId || '').trim()
  if (!organizationId) throw new Error('Active workspace is required for documents')
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
        AND workspace_organization_id = $2::uuid
        AND (
          $3 = ''
          OR search_vector @@ websearch_to_tsquery('english'::regconfig, $3)
          OR title ILIKE '%' || $3 || '%'
          OR array_to_string(tags, ' ') ILIKE '%' || $3 || '%'
          OR (
            embedding IS NOT NULL
            AND $4::vector IS NOT NULL
            AND embedding_model = $5
            AND 1 - (embedding <=> $4::vector) >= 0.35
          )
        )
      ORDER BY
        CASE WHEN $3 = '' THEN 0 ELSE GREATEST(
          ts_rank_cd(search_vector, websearch_to_tsquery('english'::regconfig, $3)) * 1.2,
          CASE WHEN title ILIKE '%' || $3 || '%' THEN 0.8 ELSE 0 END,
          CASE
            WHEN embedding IS NOT NULL AND $4::vector IS NOT NULL AND embedding_model = $5
            THEN 1 - (embedding <=> $4::vector)
            ELSE 0
          END
        ) END DESC,
        CASE source_key
          WHEN 'system:application-user-guide' THEN 0
          WHEN 'system:build-brief' THEN 1
          WHEN 'system:project-brief' THEN 2
          WHEN 'system:pipeline-brief' THEN 3
          WHEN 'system:ai-opportunity-radar' THEN 4
          ELSE 5
        END,
        CASE status WHEN 'active' THEN 0 WHEN 'generated' THEN 1 WHEN 'draft' THEN 2 ELSE 3 END,
        updated_at DESC,
        title ASC
    `,
    [ownerEmail, organizationId, search, semantic?.vector || null, semantic?.model || ''],
  )
  return result.rows.map(toDocument)
}
