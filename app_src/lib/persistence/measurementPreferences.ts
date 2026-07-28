import type { PoolClient } from 'pg'
import { recordAuditEvent } from '@/lib/auditWriter'
import {
  DEFAULT_MEASUREMENT_SYSTEM,
  isMeasurementSystem,
  type MeasurementPreferenceSnapshot,
  type MeasurementPreferenceSource,
  type MeasurementSystem,
} from '@/lib/measurements'
import { query, withTransaction } from '@/lib/persistence/postgres'
import {
  effectiveAuthorizationRole,
  type AppUser,
} from '@/lib/users'

type MeasurementPreferenceRow = {
  organization_id: string
  organization_measurement_system: string | null
  organization_revision: string | number | null
  organization_preference_present: boolean
  user_measurement_system_override: string | null
}

export class MeasurementPreferenceError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code: string,
  ) {
    super(message)
    this.name = 'MeasurementPreferenceError'
  }
}

const preferenceProjection = `
  SELECT membership.organization_id::text,
    organization_preference.measurement_system
      AS organization_measurement_system,
    organization_preference.revision::text
      AS organization_revision,
    (organization_preference.organization_id IS NOT NULL)
      AS organization_preference_present,
    user_preference.measurement_system_override
      AS user_measurement_system_override
  FROM app_user_organization_memberships membership
  JOIN workspace_organizations organization
    ON organization.id = membership.organization_id
  LEFT JOIN workspace_organization_preferences organization_preference
    ON organization_preference.organization_id = membership.organization_id
  LEFT JOIN app_user_workspace_preferences user_preference
    ON user_preference.user_email = membership.user_email
   AND user_preference.workspace_organization_id = membership.organization_id
  WHERE membership.user_email = $1
    AND membership.organization_id = $2::uuid
    AND membership.status = 'active'
  LIMIT 1
`

function activeOrganizationId(actor: AppUser): string {
  const organizationId = String(actor.organizationId || '').trim()
  if (!organizationId) {
    throw new MeasurementPreferenceError(
      'Active workspace is not available',
      400,
      'active_workspace_required',
    )
  }
  return organizationId
}

function requireMeasurementSystem(value: unknown): MeasurementSystem {
  if (!isMeasurementSystem(value)) {
    throw new MeasurementPreferenceError(
      'Measurement system must be imperial or metric',
      400,
      'measurement_system_invalid',
    )
  }
  return value
}

function toMeasurementPreferences(
  row: MeasurementPreferenceRow,
): MeasurementPreferenceSnapshot {
  const organizationDefault = isMeasurementSystem(row.organization_measurement_system)
    ? row.organization_measurement_system
    : DEFAULT_MEASUREMENT_SYSTEM
  const userOverride = isMeasurementSystem(row.user_measurement_system_override)
    ? row.user_measurement_system_override
    : null
  const effectiveSource: MeasurementPreferenceSource = userOverride
    ? 'user'
    : row.organization_preference_present ? 'organization' : 'fallback'
  const revision = Number(row.organization_revision || 1)

  return {
    measurementSystem: userOverride || organizationDefault,
    effectiveSource,
    organizationDefault,
    organizationRevision: Number.isSafeInteger(revision) && revision >= 1 ? revision : 1,
    userOverride,
  }
}

async function readPreferenceRow(
  actor: AppUser,
  client?: PoolClient,
): Promise<MeasurementPreferenceRow> {
  const organizationId = activeOrganizationId(actor)
  const values = [actor.email, organizationId]
  const result = client
    ? await client.query<MeasurementPreferenceRow>(preferenceProjection, values)
    : await query<MeasurementPreferenceRow>(preferenceProjection, values)
  if (!result.rows[0]) {
    throw new MeasurementPreferenceError(
      'Active workspace membership is not available',
      403,
      'active_workspace_membership_required',
    )
  }
  return result.rows[0]
}

async function requireActiveMembership(
  client: PoolClient,
  actor: AppUser,
): Promise<string> {
  const organizationId = activeOrganizationId(actor)
  const membership = await client.query<{ organization_id: string }>(
    `SELECT organization_id::text
     FROM app_user_organization_memberships
     WHERE user_email = $1
       AND organization_id = $2::uuid
       AND status = 'active'
     LIMIT 1
     FOR SHARE`,
    [actor.email, organizationId],
  )
  if (!membership.rows[0]) {
    throw new MeasurementPreferenceError(
      'Active workspace membership is not available',
      403,
      'active_workspace_membership_required',
    )
  }
  return organizationId
}

export async function readMeasurementPreferences(
  actor: AppUser,
): Promise<MeasurementPreferenceSnapshot> {
  return toMeasurementPreferences(await readPreferenceRow(actor))
}

export async function updateUserMeasurementOverride(input: {
  actor: AppUser
  measurementSystem: MeasurementSystem | null
}): Promise<MeasurementPreferenceSnapshot> {
  const measurementSystem = input.measurementSystem === null
    ? null
    : requireMeasurementSystem(input.measurementSystem)

  return withTransaction(async (client) => {
    const organizationId = await requireActiveMembership(client, input.actor)
    const current = toMeasurementPreferences(await readPreferenceRow(input.actor, client))

    await client.query(
      `INSERT INTO app_user_workspace_preferences (
         user_email,
         workspace_organization_id,
         measurement_system_override,
         created_at,
         updated_at
       ) VALUES ($1, $2::uuid, $3, now(), now())
       ON CONFLICT (user_email, workspace_organization_id) DO UPDATE SET
         measurement_system_override = EXCLUDED.measurement_system_override,
         updated_at = now()`,
      [input.actor.email, organizationId, measurementSystem],
    )

    await recordAuditEvent({
      actor: input.actor.email,
      subject: input.actor.email,
      eventType: 'user.workspace.measurement_preference.updated',
      aggregateType: 'app_user',
      aggregateId: input.actor.email,
      organizationId,
      payload: {
        fields: ['measurementSystemOverride'],
        from: current.userOverride,
        to: measurementSystem,
      },
    }, client)

    return toMeasurementPreferences(await readPreferenceRow(input.actor, client))
  })
}

export async function updateOrganizationMeasurementDefault(input: {
  actor: AppUser
  measurementSystem: MeasurementSystem
  expectedRevision: number
}): Promise<MeasurementPreferenceSnapshot> {
  const role = effectiveAuthorizationRole(input.actor)
  if (role !== 'owner' && role !== 'admin') {
    throw new MeasurementPreferenceError(
      'Organization admin permission is required',
      403,
      'organization_admin_required',
    )
  }
  const measurementSystem = requireMeasurementSystem(input.measurementSystem)
  if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1) {
    throw new MeasurementPreferenceError(
      'A valid organization preference revision is required',
      400,
      'organization_revision_invalid',
    )
  }

  return withTransaction(async (client) => {
    const organizationId = activeOrganizationId(input.actor)
    const organization = await client.query<{ id: string }>(
      `SELECT organization.id::text
       FROM workspace_organizations organization
       JOIN app_user_organization_memberships membership
         ON membership.organization_id = organization.id
        AND membership.user_email = $1
        AND membership.status = 'active'
       WHERE organization.id = $2::uuid
       LIMIT 1
       FOR UPDATE OF organization`,
      [input.actor.email, organizationId],
    )
    if (!organization.rows[0]) {
      throw new MeasurementPreferenceError(
        'Active workspace membership is not available',
        403,
        'active_workspace_membership_required',
      )
    }

    await client.query(
      `INSERT INTO workspace_organization_preferences (
         organization_id,
         measurement_system,
         revision,
         updated_by,
         created_at,
         updated_at
       ) VALUES ($1::uuid, $2, 1, $3, now(), now())
       ON CONFLICT (organization_id) DO NOTHING`,
      [organizationId, DEFAULT_MEASUREMENT_SYSTEM, input.actor.email],
    )

    const current = await client.query<{
      measurement_system: string
      revision: string | number
    }>(
      `SELECT measurement_system, revision::text
       FROM workspace_organization_preferences
       WHERE organization_id = $1::uuid
       LIMIT 1
       FOR UPDATE`,
      [organizationId],
    )
    const currentRevision = Number(current.rows[0]?.revision || 1)
    if (currentRevision !== input.expectedRevision) {
      throw new MeasurementPreferenceError(
        'Organization measurement preference changed; reload and try again',
        409,
        'organization_revision_conflict',
      )
    }

    const saved = await client.query<{ revision: string | number }>(
      `UPDATE workspace_organization_preferences
       SET measurement_system = $2,
           revision = revision + 1,
           updated_by = $3,
           updated_at = now()
       WHERE organization_id = $1::uuid
         AND revision = $4
       RETURNING revision::text`,
      [
        organizationId,
        measurementSystem,
        input.actor.email,
        input.expectedRevision,
      ],
    )
    if (!saved.rows[0]) {
      throw new MeasurementPreferenceError(
        'Organization measurement preference changed; reload and try again',
        409,
        'organization_revision_conflict',
      )
    }
    const nextRevision = Number(saved.rows[0].revision)

    await recordAuditEvent({
      actor: input.actor.email,
      eventType: 'organization.measurement_preference.updated',
      aggregateType: 'workspace_organization',
      aggregateId: organizationId,
      organizationId,
      payload: {
        fields: ['measurementSystem'],
        from: current.rows[0]?.measurement_system || DEFAULT_MEASUREMENT_SYSTEM,
        to: measurementSystem,
        revision: nextRevision,
      },
      eventKey: `organization-measurement-preference:${organizationId}:${nextRevision}`,
    }, client)

    return toMeasurementPreferences(await readPreferenceRow(input.actor, client))
  })
}
