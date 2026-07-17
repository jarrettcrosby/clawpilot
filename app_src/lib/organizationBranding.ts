import { appPublicUrl } from '@/lib/publicUrl'
import { query, withTransaction } from '@/lib/persistence/postgres'

export const DEFAULT_ORGANIZATION_PRIMARY_COLOR = '#1F2430'
export const DEFAULT_ORGANIZATION_ACCENT_COLOR = '#A8C7FA'

export type OrganizationBranding = {
  organizationId: string
  organizationReferenceCode: string
  organizationName: string
  primaryColor: string
  accentColor: string
  hasCustomLogo: boolean
  logoUrl: string
  revision: number
}

type BrandingRow = {
  organization_id: string
  reference_code: string
  organization_name: string
  primary_color: string | null
  accent_color: string | null
  has_custom_logo: boolean
  revision: string | number | null
}

function normalizeColor(value: unknown, fallback: string) {
  const color = String(value || '').trim().toUpperCase()
  return /^#[0-9A-F]{6}$/.test(color) ? color : fallback
}

function toBranding(row: BrandingRow): OrganizationBranding {
  const revision = Math.max(1, Number(row.revision || 1))
  const hasCustomLogo = row.has_custom_logo === true
  return {
    organizationId: row.organization_id,
    organizationReferenceCode: row.reference_code,
    organizationName: row.organization_name,
    primaryColor: normalizeColor(row.primary_color, DEFAULT_ORGANIZATION_PRIMARY_COLOR),
    accentColor: normalizeColor(row.accent_color, DEFAULT_ORGANIZATION_ACCENT_COLOR),
    hasCustomLogo,
    logoUrl: hasCustomLogo
      ? `${appPublicUrl()}/api/public/organization-branding/${row.reference_code}/logo?v=${revision}`
      : `${appPublicUrl()}/brand/email/clawpilot-mark-email.png`,
    revision,
  }
}

const brandingProjection = `
  SELECT organization.id::text AS organization_id,
    organization.reference_code,
    organization.name AS organization_name,
    branding.primary_color,
    branding.accent_color,
    (branding.logo_bytes IS NOT NULL) AS has_custom_logo,
    branding.revision::text
  FROM workspace_organizations organization
  LEFT JOIN workspace_organization_branding branding
    ON branding.organization_id = organization.id
`

export async function readWorkspaceOrganizationBranding(organizationId: string) {
  const result = await query<BrandingRow>(
    `${brandingProjection} WHERE organization.id = $1::uuid LIMIT 1`,
    [organizationId],
  )
  if (!result.rows[0]) throw new Error('Organization was not found')
  return toBranding(result.rows[0])
}

export async function readPipelineWorkbookBranding(pipelineId: string) {
  const result = await query<BrandingRow>(
    `${brandingProjection}
     JOIN pipeline_spaces pipeline ON pipeline.workspace_organization_id = organization.id
     WHERE pipeline.id = $1::uuid
     LIMIT 1`,
    [pipelineId],
  )
  if (!result.rows[0]) throw new Error('Pipeline organization branding was not found')
  return toBranding(result.rows[0])
}

export async function updateWorkspaceOrganizationBranding(input: {
  organizationId: string
  actorEmail: string
  primaryColor: string
  accentColor: string
  logoBytes?: Uint8Array | null
  logoMimeType?: string | null
}) {
  const primaryColor = normalizeColor(input.primaryColor, '')
  const accentColor = normalizeColor(input.accentColor, '')
  if (!primaryColor || !accentColor) throw new Error('Brand colors must use six-digit hex values')

  return withTransaction(async (client) => {
    const organization = await client.query<{ id: string }>(
      'SELECT id::text FROM workspace_organizations WHERE id = $1::uuid LIMIT 1 FOR UPDATE',
      [input.organizationId],
    )
    if (!organization.rows[0]) throw new Error('Organization was not found')
    const current = await client.query<{ logo_bytes: Buffer | null; logo_mime_type: string | null }>(
      `SELECT logo_bytes, logo_mime_type
       FROM workspace_organization_branding
       WHERE organization_id = $1::uuid
       LIMIT 1`,
      [input.organizationId],
    )
    const logoBytes = input.logoBytes === undefined
      ? current.rows[0]?.logo_bytes || null
      : input.logoBytes === null ? null : Buffer.from(input.logoBytes)
    const logoMimeType = input.logoBytes === undefined
      ? current.rows[0]?.logo_mime_type || null
      : input.logoBytes === null ? null : String(input.logoMimeType || '')
    const saved = await client.query<{ revision: string }>(
      `INSERT INTO workspace_organization_branding (
         organization_id, logo_mime_type, logo_bytes, primary_color, accent_color,
         revision, updated_by, created_at, updated_at
       ) VALUES ($1::uuid, $2, $3, $4, $5, 1, $6, now(), now())
       ON CONFLICT (organization_id) DO UPDATE SET
         logo_mime_type = EXCLUDED.logo_mime_type,
         logo_bytes = EXCLUDED.logo_bytes,
         primary_color = EXCLUDED.primary_color,
         accent_color = EXCLUDED.accent_color,
         revision = workspace_organization_branding.revision + 1,
         updated_by = EXCLUDED.updated_by,
         updated_at = now()
       RETURNING revision::text`,
      [input.organizationId, logoMimeType, logoBytes, primaryColor, accentColor, input.actorEmail],
    )
    const revision = Number(saved.rows[0]?.revision || 1)
    const pipelines = await client.query<{ id: string; sheet_id: string }>(
      `SELECT id::text, sheet_id
       FROM pipeline_spaces
       WHERE workspace_organization_id = $1::uuid
         AND sync_enabled = true
         AND sheet_id IS NOT NULL
       ORDER BY id`,
      [input.organizationId],
    )
    for (const pipeline of pipelines.rows) {
      await client.query(
        `INSERT INTO sync_outbox (
           aggregate_type, aggregate_id, operation, target_system, payload,
           status, attempts, idempotency_key, created_at, available_at, updated_at
         ) VALUES (
           'pipeline_branding', $1, 'apply_workbook_branding', 'google_sheets',
           $2::jsonb, 'queued', 0, $3, now(), now(), now()
         )
         ON CONFLICT (target_system, idempotency_key)
         WHERE idempotency_key IS NOT NULL
         DO NOTHING`,
        [
          pipeline.id,
          JSON.stringify({ pipelineId: pipeline.id, sheetId: pipeline.sheet_id, organizationId: input.organizationId, brandingRevision: revision }),
          `pipeline:${pipeline.id}:workbook-branding:${revision}`,
        ],
      )
    }
    await client.query(
      `INSERT INTO audit_events (
         actor, event_type, aggregate_type, aggregate_id, payload, event_key, created_at
       ) VALUES ($1, 'organization.branding.updated', 'workspace_organization', $2, $3::jsonb, $4, now())
       ON CONFLICT (event_key) WHERE event_key IS NOT NULL DO NOTHING`,
      [
        input.actorEmail,
        input.organizationId,
        JSON.stringify({ primaryColor, accentColor, hasCustomLogo: Boolean(logoBytes), brandingRevision: revision, workbookCount: pipelines.rows.length }),
        `organization-branding:${input.organizationId}:${revision}`,
      ],
    )
    const refreshed = await client.query<BrandingRow>(
      `${brandingProjection} WHERE organization.id = $1::uuid LIMIT 1`,
      [input.organizationId],
    )
    if (!refreshed.rows[0]) throw new Error('Organization branding could not be read after saving')
    return toBranding(refreshed.rows[0])
  })
}
