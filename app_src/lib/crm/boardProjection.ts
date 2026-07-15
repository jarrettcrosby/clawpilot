import crypto from 'node:crypto'
import type { Task, CrmTaskContext } from '@/lib/types'
import { isPostgresStorageEnabled } from '@/lib/persistence/config'
import {
  ensurePipelineCrmReferenceLinks,
  normalizeCrmDescription,
  updateCrmDescriptionWithClient,
} from '@/lib/persistence/crm'
import { query, withTransaction } from '@/lib/persistence/postgres'
import { upsertTaskWithClient } from '@/lib/persistence/tasks'
import { shortLinkUrl } from '@/lib/shortlinks'

const CRM_BOARD_NAME = 'crm board'

type CrmBoardBinding = {
  board_id: string
  pipeline_id: string
  owner_email: string
}

type CrmBoardRecord = {
  entity_type: 'organizations' | 'contacts'
  entity_id: string
  pipeline_id: string
  reference_code: string
  record_name: string
  account_name: string
  account_reference_code: string
  email: string | null
  description: string | null
  updated_at: string
}

type CrmBoardCardRow = {
  board_id: string
  task_id: string
  pipeline_id: string
  entity_type: 'organizations' | 'contacts'
  entity_id: string
  reference_code: string
  last_synced_description: string
  last_common_hash: string
  card_description_hash: string
  crm_description_hash: string
  sync_status: 'synced' | 'conflict'
  payload: Task
}

type PreparedCard = {
  record: CrmBoardRecord
  task: Task
  commonDescription: string
  commonHash: string
  cardHash: string
  crmHash: string
  syncStatus: 'synced' | 'conflict'
}

function descriptionHash(value: unknown): string {
  return crypto.createHash('sha256').update(normalizeCrmDescription(value)).digest('hex')
}

function sameCrmContext(left: Task['crm'], right: Task['crm']): boolean {
  return JSON.stringify(left || null) === JSON.stringify(right || null)
}

function taskIdFor(boardId: string, entity: CrmBoardRecord['entity_type'], entityId: string): string {
  const digest = crypto.createHash('sha256').update(`${boardId}:${entity}:${entityId}`).digest('hex').slice(0, 24)
  return `crm-${digest}`
}

function crmTaskContext(record: CrmBoardRecord, description: string, syncStatus: 'synced' | 'conflict'): CrmTaskContext {
  const referenceCode = record.reference_code.toLowerCase()
  const accountReferenceCode = record.account_reference_code.toLowerCase()
  return {
    projectionVersion: 1,
    entity: record.entity_type,
    entityId: record.entity_id,
    pipelineId: record.pipeline_id,
    referenceCode,
    recordName: record.record_name,
    recordUrl: shortLinkUrl(referenceCode),
    accountName: record.account_name,
    accountReferenceCode,
    accountUrl: shortLinkUrl(accountReferenceCode),
    email: String(record.email || '').trim().toLowerCase(),
    emailUrl: record.email ? shortLinkUrl(`mail-${referenceCode}`) : undefined,
    description,
    descriptionHash: descriptionHash(description),
    syncStatus,
  }
}

function newCrmTask(boardId: string, record: CrmBoardRecord, now: string): Task {
  const description = normalizeCrmDescription(record.description)
  const title = `${record.reference_code} - ${record.record_name}`
  const taskId = taskIdFor(boardId, record.entity_type, record.entity_id)
  return {
    id: taskId,
    boardId,
    title,
    desc: description,
    status: 'backlog',
    priority: 'medium',
    category: 'pipeline',
    tags: ['crm', record.entity_type === 'organizations' ? 'account' : 'contact'],
    createdAt: now,
    updatedAt: now,
    activity: [{
      type: 'created',
      message: 'CRM card created in Backlog',
      timestamp: now,
      actor: 'ClawPilot CRM',
      taskId,
      taskTitle: title,
    }],
    comments: [],
    checklist: [],
    entityType: record.entity_type === 'organizations' ? 'crm-account' : 'crm-contact',
    crm: crmTaskContext(record, description, 'synced'),
  }
}

export async function resolveCrmBoardBinding(boardId: string): Promise<CrmBoardBinding | null> {
  return withTransaction(async (client) => {
    const selected = await client.query<CrmBoardBinding & { board_name: string }>(
      `SELECT board.id::text AS board_id, projection.pipeline_id::text, board.owner_email,
         board.name AS board_name
       FROM project_boards board
       LEFT JOIN crm_board_projections projection ON projection.board_id = board.id
       WHERE board.id = $1::uuid
       FOR UPDATE OF board`,
      [boardId],
    )
    const board = selected.rows[0]
    if (!board || board.board_name.trim().toLowerCase() !== CRM_BOARD_NAME) return null
    if (board.pipeline_id) return board

    const pipeline = await client.query<{ id: string }>(
      `SELECT id::text
       FROM pipeline_spaces
       WHERE owner_email = $1
       ORDER BY is_default DESC, created_at, id
       LIMIT 1`,
      [board.owner_email],
    )
    if (!pipeline.rows[0]) return null
    const inserted = await client.query<{ pipeline_id: string }>(
      `INSERT INTO crm_board_projections (board_id, pipeline_id, created_at, updated_at)
       VALUES ($1::uuid, $2::uuid, now(), now())
       ON CONFLICT DO NOTHING
       RETURNING pipeline_id::text`,
      [board.board_id, pipeline.rows[0].id],
    )
    const pipelineId = inserted.rows[0]?.pipeline_id
      || (await client.query<{ pipeline_id: string }>(
        'SELECT pipeline_id::text FROM crm_board_projections WHERE board_id = $1::uuid',
        [board.board_id],
      )).rows[0]?.pipeline_id
    return pipelineId ? { board_id: board.board_id, pipeline_id: pipelineId, owner_email: board.owner_email } : null
  })
}

async function readCrmBoardRecords(pipelineId: string): Promise<CrmBoardRecord[]> {
  const result = await query<CrmBoardRecord>(
    `SELECT 'organizations'::text AS entity_type, organization.id::text AS entity_id,
       organization.pipeline_id::text, organization.reference_code,
       organization.name AS record_name, organization.name AS account_name,
       organization.reference_code AS account_reference_code, organization.email,
       organization.description, organization.updated_at::text
     FROM crm_organizations organization
     WHERE organization.pipeline_id = $1::uuid
     UNION ALL
     SELECT 'contacts'::text AS entity_type, contact.id::text AS entity_id,
       contact.pipeline_id::text, contact.reference_code,
       contact.full_name AS record_name, organization.name AS account_name,
       organization.reference_code AS account_reference_code, contact.email,
       contact.description, contact.updated_at::text
     FROM crm_contacts contact
     JOIN crm_organizations organization ON organization.id = contact.organization_id
     WHERE contact.pipeline_id = $1::uuid
     ORDER BY entity_type, record_name, reference_code`,
    [pipelineId],
  )
  return result.rows
}

async function readCrmBoardCards(boardId: string): Promise<CrmBoardCardRow[]> {
  const result = await query<CrmBoardCardRow>(
    `SELECT card.board_id::text, card.task_id, card.pipeline_id::text, card.entity_type,
       card.entity_id::text, card.reference_code, card.last_synced_description,
       card.last_common_hash, card.card_description_hash, card.crm_description_hash,
       card.sync_status, task.payload
     FROM crm_board_cards card
     JOIN tasks task ON task.id = card.task_id AND task.board_id = card.board_id
     WHERE card.board_id = $1::uuid`,
    [boardId],
  )
  return result.rows
}

async function prepareExistingCard(
  binding: CrmBoardBinding,
  record: CrmBoardRecord,
  card: CrmBoardCardRow,
  now: string,
): Promise<PreparedCard> {
  const previous = card.payload
  const nextDescription = normalizeCrmDescription(record.description)
  const nextCommonDescription = nextDescription
  const nextCommonHash = descriptionHash(nextDescription)
  const cardHash = nextCommonHash
  const crmHash = nextCommonHash
  const syncStatus = 'synced' as const

  const context = crmTaskContext(record, nextDescription, syncStatus)
  const title = `${record.reference_code} - ${record.record_name}`
  const conflictTag = 'crm-sync-conflict'
  const tags = Array.from(new Set([
    ...(previous.tags || []).filter((tag) => tag !== conflictTag),
    'crm',
    record.entity_type === 'organizations' ? 'account' : 'contact',
  ]))
  const projectionChanged = previous.title !== title
    || previous.desc !== nextDescription
    || previous.archived === true
    || previous.entityType !== (record.entity_type === 'organizations' ? 'crm-account' : 'crm-contact')
    || !sameCrmContext(previous.crm, context)
    || JSON.stringify(previous.tags || []) !== JSON.stringify(tags)
  const conflictResolved = card.sync_status === 'conflict'
  const activity = [...(previous.activity || [])]
  if (conflictResolved) {
    activity.push({
      type: 'updated',
      message: 'CRM description sync conflict resolved',
      timestamp: now,
      actor: 'ClawPilot CRM',
      taskId: previous.id,
      taskTitle: title,
    })
  }
  return {
    record,
    task: {
      ...previous,
      boardId: binding.board_id,
      title,
      desc: nextDescription,
      tags,
      archived: false,
      archivedAt: undefined,
      entityType: record.entity_type === 'organizations' ? 'crm-account' : 'crm-contact',
      crm: context,
      activity,
      updatedAt: projectionChanged || conflictResolved ? now : previous.updatedAt,
    },
    commonDescription: nextCommonDescription,
    commonHash: nextCommonHash,
    cardHash,
    crmHash,
    syncStatus,
  }
}

export async function reconcileCrmBoardProjection(input: { boardId: string }): Promise<{
  projected: boolean
  pipelineId: string | null
  cards: number
  conflicts: number
}> {
  if (!isPostgresStorageEnabled()) return { projected: false, pipelineId: null, cards: 0, conflicts: 0 }
  const binding = await resolveCrmBoardBinding(input.boardId)
  if (!binding) return { projected: false, pipelineId: null, cards: 0, conflicts: 0 }
  await ensurePipelineCrmReferenceLinks(binding.pipeline_id)
  const [records, existingCards] = await Promise.all([
    readCrmBoardRecords(binding.pipeline_id),
    readCrmBoardCards(binding.board_id),
  ])
  const cardsByRecord = new Map(existingCards.map((card) => [`${card.entity_type}:${card.entity_id}`, card]))
  const now = new Date().toISOString()
  const prepared: PreparedCard[] = []

  for (const record of records) {
    const existing = cardsByRecord.get(`${record.entity_type}:${record.entity_id}`)
    if (existing) {
      prepared.push(await prepareExistingCard(binding, record, existing, now))
      continue
    }
    const task = newCrmTask(binding.board_id, record, now)
    const hash = descriptionHash(task.desc)
    prepared.push({
      record,
      task,
      commonDescription: task.desc,
      commonHash: hash,
      cardHash: hash,
      crmHash: hash,
      syncStatus: 'synced',
    })
  }

  await withTransaction(async (client) => {
    for (const card of prepared) {
      await upsertTaskWithClient(client, card.task, binding.board_id, 'crm-projection')
      await client.query(
        `INSERT INTO crm_board_cards (
           board_id, task_id, pipeline_id, entity_type, entity_id, reference_code,
           last_synced_description, last_common_hash, card_description_hash,
           crm_description_hash, sync_status, conflict_at, created_at, updated_at
         )
         VALUES ($1::uuid, $2, $3::uuid, $4, $5::uuid, $6, $7, $8, $9, $10, $11,
           CASE WHEN $11 = 'conflict' THEN now() ELSE NULL END, now(), now())
         ON CONFLICT (board_id, entity_type, entity_id) DO UPDATE SET
           task_id = EXCLUDED.task_id,
           pipeline_id = EXCLUDED.pipeline_id,
           reference_code = EXCLUDED.reference_code,
           last_synced_description = EXCLUDED.last_synced_description,
           last_common_hash = EXCLUDED.last_common_hash,
           card_description_hash = EXCLUDED.card_description_hash,
           crm_description_hash = EXCLUDED.crm_description_hash,
           sync_status = EXCLUDED.sync_status,
           conflict_at = CASE
             WHEN EXCLUDED.sync_status = 'conflict' THEN COALESCE(crm_board_cards.conflict_at, now())
             ELSE NULL
           END,
           updated_at = now()`,
        [
          binding.board_id,
          card.task.id,
          binding.pipeline_id,
          card.record.entity_type,
          card.record.entity_id,
          card.record.reference_code,
          card.commonDescription,
          card.commonHash,
          card.cardHash,
          card.crmHash,
          card.syncStatus,
        ],
      )
    }
  })

  return {
    projected: true,
    pipelineId: binding.pipeline_id,
    cards: prepared.length,
    conflicts: prepared.filter((card) => card.syncStatus === 'conflict').length,
  }
}

export async function reconcileCrmBoardProjectionsForPipeline(input: { pipelineId: string }): Promise<void> {
  if (!isPostgresStorageEnabled()) return
  const boards = await query<{ board_id: string }>(
    'SELECT board_id::text FROM crm_board_projections WHERE pipeline_id = $1::uuid ORDER BY board_id',
    [input.pipelineId],
  )
  for (const board of boards.rows) await reconcileCrmBoardProjection({ boardId: board.board_id })
}

export function prepareCrmTaskDescriptionUpdate(task: Task, value: unknown): Task {
  if (!task.crm) return task
  const description = normalizeCrmDescription(value)
  return {
    ...task,
    desc: description,
    crm: { ...task.crm, description, descriptionHash: descriptionHash(description), syncStatus: 'synced' },
  }
}

export class CrmDescriptionConflictError extends Error {
  constructor() {
    super('This CRM description changed after you opened the card. Refresh and try again.')
    this.name = 'CrmDescriptionConflictError'
  }
}

export async function updateCrmBoardTaskDescription(input: {
  boardId: string
  taskId: string
  description: unknown
  expectedDescriptionHash: unknown
  actorEmail: string
}): Promise<Task> {
  if (!isPostgresStorageEnabled()) throw new Error('CRM board descriptions require Postgres storage')
  const expectedHash = String(input.expectedDescriptionHash || '').trim().toLowerCase()
  if (!/^[a-f0-9]{64}$/.test(expectedHash)) throw new CrmDescriptionConflictError()
  const description = normalizeCrmDescription(input.description)

  return withTransaction(async (client) => {
    const selected = await client.query<CrmBoardCardRow>(
      `SELECT card.board_id::text, card.task_id, card.pipeline_id::text, card.entity_type,
         card.entity_id::text, card.reference_code, card.last_synced_description,
         card.last_common_hash, card.card_description_hash, card.crm_description_hash,
         card.sync_status, task.payload
       FROM crm_board_cards card
       JOIN tasks task ON task.id = card.task_id AND task.board_id = card.board_id
       WHERE card.board_id = $1::uuid AND card.task_id = $2
       FOR UPDATE OF card, task`,
      [input.boardId, input.taskId],
    )
    const card = selected.rows[0]
    if (!card) throw new Error('CRM board card was not found')

    const table = card.entity_type === 'organizations' ? 'crm_organizations' : 'crm_contacts'
    const current = await client.query<{ description: string | null }>(
      `SELECT description FROM ${table}
       WHERE id = $1::uuid AND pipeline_id = $2::uuid
       FOR UPDATE`,
      [card.entity_id, card.pipeline_id],
    )
    if (!current.rows[0]) throw new Error('CRM record was not found')
    const currentHash = descriptionHash(current.rows[0].description)
    const projectedHash = card.last_common_hash || descriptionHash(card.payload.crm?.description ?? card.payload.desc)
    if (expectedHash !== projectedHash || expectedHash !== currentHash) throw new CrmDescriptionConflictError()

    if (normalizeCrmDescription(current.rows[0].description) !== description) {
      await updateCrmDescriptionWithClient(client, {
        pipelineId: card.pipeline_id,
        entity: card.entity_type,
        id: card.entity_id,
        description,
        actorEmail: input.actorEmail,
      })
    }

    const now = new Date().toISOString()
    const task = prepareCrmTaskDescriptionUpdate(card.payload, description)
    const updated: Task = {
      ...task,
      updatedAt: now,
      activity: [
        ...(task.activity || []),
        {
          type: 'updated',
          message: 'CRM description updated',
          timestamp: now,
          actor: input.actorEmail,
          taskId: task.id,
          taskTitle: task.title,
        },
      ],
    }
    await upsertTaskWithClient(client, updated, input.boardId, 'crm-projection')
    const hash = descriptionHash(description)
    await client.query(
      `UPDATE crm_board_cards
       SET last_synced_description = $3, last_common_hash = $4,
         card_description_hash = $4, crm_description_hash = $4,
         sync_status = 'synced', conflict_at = NULL, updated_at = now()
       WHERE board_id = $1::uuid AND task_id = $2`,
      [input.boardId, input.taskId, description, hash],
    )
    return updated
  })
}
