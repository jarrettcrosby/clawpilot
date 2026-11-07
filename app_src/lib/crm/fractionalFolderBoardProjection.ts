import { createHash } from 'node:crypto'
import type { PoolClient } from 'pg'
import { FractionalCrmGatewayError } from '@/lib/fractionalCrmGatewayAuth'
import { normalizeCrmDescription } from '@/lib/persistence/crm'
import type { Task } from '@/lib/types'

type Scope = { pipelineId: string; workspaceOrganizationId: string; accountId: string; referenceCode: string }
type Card = {
  board_id: string
  card_id: string
  payload: Task
  last_synced_description: string
  last_common_hash: string
  card_description_hash: string
  crm_description_hash: string
  sync_status: string
  conflict_at: Date | null
}
type LockedCards = { scope: Scope; rows: Card[] }
const hash = (description: string) => createHash('sha256').update(description).digest('hex')
const review = (): never => { throw new FractionalCrmGatewayError(409, 'FOLDER_CARD_REVIEW_REQUIRED') }

/** The caller already holds the exact account and pipeline CRM lifecycle lock.
 * Never provision boards, change ACLs, or repair another account's projection. */
export async function lockFractionalFolderBoardCards(client: PoolClient, scope: Scope): Promise<LockedCards> {
  const boards = await client.query<{ board_id: string }>(
    `SELECT board.id::text AS board_id
     FROM crm_board_projections projection
     JOIN project_boards board ON board.id = projection.board_id
     JOIN pipeline_spaces pipeline ON pipeline.id = projection.pipeline_id
     JOIN app_users owner ON owner.email = board.owner_email AND owner.status = 'active'
     JOIN app_user_organization_memberships membership ON membership.user_email = board.owner_email
       AND membership.organization_id = projection.workspace_organization_id
       AND membership.status = 'active' AND membership.trashed_at IS NULL
     LEFT JOIN LATERAL (
       SELECT true AS allowed FROM pipeline_space_members editor
       WHERE editor.pipeline_id = pipeline.id AND editor.user_email = board.owner_email
         AND editor.access_role = 'editor' FOR SHARE
     ) editor_access ON true
     WHERE projection.pipeline_id = $1::uuid AND projection.workspace_organization_id = $2::uuid
       AND board.workspace_organization_id = $2::uuid AND pipeline.workspace_organization_id = $2::uuid
       AND lower(btrim(board.name)) = 'crm board' AND NOT pipeline.reference_access_disabled
       AND (membership.role = 'owner' OR COALESCE((membership.permissions->>'viewCrm')::boolean, true))
       AND (pipeline.owner_email = board.owner_email OR editor_access.allowed)
     ORDER BY board.id LIMIT 51 FOR SHARE OF board, projection, pipeline, owner, membership`,
    [scope.pipelineId, scope.workspaceOrganizationId],
  )
  if (!boards.rows.length || boards.rows.length > 50) review()
  const { rows } = await client.query<Card>(
    `SELECT board_id::text, card_id, payload, last_synced_description, last_common_hash,
       card_description_hash, crm_description_hash, sync_status, conflict_at
     FROM crm_board_cards
     WHERE board_id = ANY($1::uuid[]) AND pipeline_id = $2::uuid AND entity_type = 'organizations'
       AND entity_id = $3::uuid AND reference_code = $4
     ORDER BY board_id FOR UPDATE`,
    [boards.rows.map(row => row.board_id), scope.pipelineId, scope.accountId, scope.referenceCode],
  )
  if (rows.length !== boards.rows.length) review()
  for (const row of rows) {
    const card = row.payload, crm = card?.crm
    const synced = row.last_synced_description
    const syncedHash = hash(synced)
    if (!crm || card.id !== row.card_id || card.boardId !== row.board_id || card.archived
      || crm.entity !== 'organizations' || crm.entityId !== scope.accountId
      || crm.pipelineId !== scope.pipelineId || crm.referenceCode !== scope.referenceCode
      || card.desc !== synced || crm.description !== synced || crm.descriptionHash !== syncedHash
      || row.last_common_hash !== syncedHash || row.card_description_hash !== syncedHash
      || row.crm_description_hash !== syncedHash || row.sync_status !== 'synced'
      || crm.syncStatus !== 'synced' || row.conflict_at !== null) review()
  }
  return { scope, rows }
}

/** Update description fields only; preserve board identity, status, and notes.
 * An unchanged account/card adoption does not write the card at all. */
export async function projectFractionalFolderBoardCards(
  client: PoolClient, locked: LockedCards, accountDescription: string,
) {
  const description = normalizeCrmDescription(accountDescription)
  const descriptionHash = hash(description)
  const { scope } = locked
  for (const row of locked.rows) {
    if (row.last_synced_description === description) continue
    const payload = {
      ...row.payload, desc: description, updatedAt: new Date().toISOString(),
      crm: { ...row.payload.crm, description, descriptionHash },
    }
    const result = await client.query<{ description: string }>(
      `UPDATE crm_board_cards
       SET payload = $6::jsonb, last_synced_description = $7, last_common_hash = $8,
           card_description_hash = $8, crm_description_hash = $8, updated_at = now()
       WHERE board_id = $1::uuid AND pipeline_id = $2::uuid AND entity_type = 'organizations'
         AND entity_id = $3::uuid AND reference_code = $4 AND card_id = $5
       RETURNING payload->>'desc' AS description`,
      [row.board_id, scope.pipelineId, scope.accountId, scope.referenceCode, row.card_id, JSON.stringify(payload), description, descriptionHash],
    )
    if (result.rowCount !== 1 || result.rows[0].description !== description) review()
  }
}

export function assertFractionalFolderBoardCardsCurrent(locked: LockedCards, accountDescription: string) {
  const description = normalizeCrmDescription(accountDescription)
  if (locked.rows.some(row => row.last_synced_description !== description)) review()
}
