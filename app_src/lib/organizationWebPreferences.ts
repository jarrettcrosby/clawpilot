import { recordAuditEvent } from '@/lib/auditWriter'
import { query, withTransaction } from '@/lib/persistence/postgres'
import { additionalPublicOrigins } from '@/lib/publicOriginRouting.mjs'
import { appPublicUrl } from '@/lib/publicUrl'
import { effectiveAuthorizationRole, type AppUser } from '@/lib/users'

export type OrganizationWebDomain = 'bpo' | 'eigenracing'
export type OrganizationAppDomainChoice = { key: OrganizationWebDomain; label: string; url: string }
export type OrganizationWebPreferences = {
  organizationId: string
  appDomain: OrganizationWebDomain
  shortLinkDomain: OrganizationWebDomain
  allowUserShortLinkOverride: boolean
  revision: number
}
type PreferenceRow = {
  organization_id: string
  app_domain: OrganizationWebDomain | null
  short_link_domain: OrganizationWebDomain | null
  allow_user_short_link_override: boolean | null
  revision: string | number | null
}
export class OrganizationWebPreferenceError extends Error {
  constructor(message: string, readonly status = 400) { super(message) }
}

function fromRow(row: PreferenceRow): OrganizationWebPreferences {
  return {
    organizationId: row.organization_id,
    appDomain: row.app_domain || 'bpo',
    shortLinkDomain: row.short_link_domain || 'bpo',
    allowUserShortLinkOverride: row.allow_user_short_link_override !== false,
    revision: Number(row.revision || 0),
  }
}

/** Only deployment-enabled fixed hosts in this environment are eligible. This
 * setting neither provisions DNS nor authorizes another browser origin. */
export function availableOrganizationAppDomains(): OrganizationAppDomainChoice[] {
  const canonical = appPublicUrl()
  const isDevelopment = ['https://dev.aiapp.eigenracing.com', 'https://dev.aiapp.bposupplychain.com'].includes(canonical)
  const isProduction = ['https://aiapp.eigenracing.com', 'https://aiapp.bposupplychain.com'].includes(canonical)
  if (!isDevelopment && !isProduction) return [{ key: 'eigenracing', label: new URL(canonical).host, url: canonical }]
  const enabled = new Set([canonical, ...additionalPublicOrigins(process.env.CLAWPILOT_ADDITIONAL_PUBLIC_ORIGINS_JSON)])
  const prefix = isDevelopment ? 'dev.aiapp' : 'aiapp'
  return [
    { key: 'bpo' as const, label: `${prefix}.bposupplychain.com`, url: `https://${prefix}.bposupplychain.com` },
    { key: 'eigenracing' as const, label: `${prefix}.eigenracing.com`, url: `https://${prefix}.eigenracing.com` },
  ].filter((choice) => enabled.has(choice.url))
}

export function effectiveOrganizationAppDomain(preferences: Pick<OrganizationWebPreferences, 'appDomain'>) {
  const available = availableOrganizationAppDomains()
  return available.find((choice) => choice.key === preferences.appDomain) || available[0]
}

export async function readOrganizationWebPreferences(organizationId: string): Promise<OrganizationWebPreferences> {
  const result = await query<PreferenceRow>(
    `SELECT organization.id::text AS organization_id, preference.app_domain,
      preference.short_link_domain, preference.allow_user_short_link_override, preference.revision
     FROM workspace_organizations organization
     LEFT JOIN workspace_organization_web_preferences preference ON preference.organization_id = organization.id
     WHERE organization.id = $1::uuid`, [organizationId],
  )
  if (!result.rows[0]) throw new OrganizationWebPreferenceError('Organization was not found', 404)
  return fromRow(result.rows[0])
}

/** Explicit organization only. Provider callbacks and general authentication
 * keep appPublicUrl(); no user/email-based organization inference is permitted. */
export async function organizationAppPublicUrl(organizationId: string): Promise<string> {
  if (!organizationId) throw new OrganizationWebPreferenceError('Organization is required')
  return effectiveOrganizationAppDomain(await readOrganizationWebPreferences(organizationId)).url
}

export async function saveOrganizationWebPreferences(
  actor: AppUser,
  input: Record<string, unknown>,
  availableShortLinkDomains: readonly { key: OrganizationWebDomain }[],
): Promise<OrganizationWebPreferences> {
  const role = effectiveAuthorizationRole(actor)
  if (!actor.organizationId || (role !== 'owner' && role !== 'admin')) throw new OrganizationWebPreferenceError('Organization admin permission is required', 403)
  if (!['bpo', 'eigenracing'].includes(String(input.appDomain))
    || !['bpo', 'eigenracing'].includes(String(input.shortLinkDomain))
    || typeof input.allowUserShortLinkOverride !== 'boolean'
    || !Number.isSafeInteger(input.revision) || Number(input.revision) < 0) throw new OrganizationWebPreferenceError('Invalid organization web settings')
  return withTransaction(async (client) => {
    const membership = await client.query(
      `SELECT organization.id FROM workspace_organizations organization
       JOIN app_user_organization_memberships membership ON membership.organization_id = organization.id
       JOIN app_users app_user ON app_user.email = membership.user_email
       WHERE organization.id = $1::uuid AND membership.user_email = $2
         AND membership.status = 'active' AND membership.role IN ('owner', 'admin') AND app_user.status = 'active'
       FOR UPDATE OF organization FOR SHARE OF membership, app_user`, [actor.organizationId, actor.email],
    )
    if (!membership.rows.length) throw new OrganizationWebPreferenceError('Active organization access is required', 403)
    const currentResult = await client.query<PreferenceRow>(
      'SELECT organization_id::text, app_domain, short_link_domain, allow_user_short_link_override, revision FROM workspace_organization_web_preferences WHERE organization_id = $1::uuid', [actor.organizationId],
    )
    const current = currentResult.rows[0] ? fromRow(currentResult.rows[0]) : {
      organizationId: actor.organizationId, appDomain: 'bpo', shortLinkDomain: 'bpo', allowUserShortLinkOverride: true, revision: 0,
    }
    if (input.revision !== current.revision) throw new OrganizationWebPreferenceError('Organization settings changed. Reload before saving.', 409)
    if (input.appDomain !== current.appDomain && !availableOrganizationAppDomains().some((choice) => choice.key === input.appDomain)) throw new OrganizationWebPreferenceError('That app address is not enabled for this environment')
    if (input.shortLinkDomain !== current.shortLinkDomain && !availableShortLinkDomains.some((choice) => choice.key === input.shortLinkDomain)) throw new OrganizationWebPreferenceError('That short-link domain is not enabled for this organization')
    const result = await client.query<PreferenceRow>(
      `INSERT INTO workspace_organization_web_preferences
        (organization_id, app_domain, short_link_domain, allow_user_short_link_override, updated_by)
       VALUES ($1::uuid, $2, $3, $4, $5)
       ON CONFLICT (organization_id) DO UPDATE SET app_domain = EXCLUDED.app_domain,
        short_link_domain = EXCLUDED.short_link_domain, allow_user_short_link_override = EXCLUDED.allow_user_short_link_override,
        revision = workspace_organization_web_preferences.revision + 1, updated_by = EXCLUDED.updated_by, updated_at = now()
       RETURNING organization_id::text, app_domain, short_link_domain, allow_user_short_link_override, revision`,
      [actor.organizationId, input.appDomain, input.shortLinkDomain, input.allowUserShortLinkOverride, actor.email],
    )
    const saved = fromRow(result.rows[0])
    await recordAuditEvent({ actor: actor.email, subject: actor.email, eventType: 'organization.web_preferences.updated',
      aggregateType: 'workspace_organization', aggregateId: actor.organizationId, organizationId: actor.organizationId,
      payload: { appDomain: saved.appDomain, shortLinkDomain: saved.shortLinkDomain, allowUserShortLinkOverride: saved.allowUserShortLinkOverride, revision: saved.revision },
    }, client)
    return saved
  })
}
