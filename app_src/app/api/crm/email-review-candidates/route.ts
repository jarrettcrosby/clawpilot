import { NextRequest, NextResponse } from 'next/server'
import { isBrowserSameOriginRequest } from '@/lib/browserSameOrigin'
import { isPostgresStorageEnabled } from '@/lib/persistence/config'
import { query } from '@/lib/persistence/postgres'
import { readVerifiedGmailMailboxIdentityInPostgres } from '@/lib/persistence/crmEmailIdentity'
import { appPublicUrl } from '@/lib/publicUrl'
import { requestSession, requireRequestUser } from '@/lib/requestUser'
import { resolvePipelineSpaceAccess } from '@/lib/tenancy'

export const dynamic = 'force-dynamic'
export const revalidate = 0
export const runtime = 'nodejs'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const GMAIL_ID = /^[a-f0-9]{1,128}$/i
const EMAIL = /^[^\s@]{1,64}@[^\s@]+\.[^\s@]+$/
const CONTACT_REFERENCE = /^gc(?:[0-9]{7}|[0-9a-v]{12})$/i
const COMPANY_REFERENCE = /^ga(?:[0-9]{7}|[0-9a-v]{12})$/i
// The same deliberately finite bridge as emailReconciliation.ts. This does
// not authorize a mailbox-wide scan, adoption, or an additional legacy message.
const LEGACY_PIPELINE = '587c8746-ecf6-40ae-8c50-e456f99ad555'
const LEGACY_THREAD = '1a179e9e2743f926'
const LEGACY_MESSAGES = ['1a17e730c78d319c', '1a17f5004f29592c', '1a17f5d46a224e0a']
// A separately requested historical pair. It never expands the default bridge
// or exposes a general cross-workspace cache browser.
const CASEY_SCOPE = 'casey-reviewed-two-v1'
const CASEY_OWNER = 'jarrett@suburbiasandwichco.com'
const CASEY_CONNECTION = 'eb13a0fd-c0b2-4ad1-99b7-3bbda178a027'
const CASEY_INTAKE_PIPELINE = '0ce9d945-0b71-495b-88ef-420ddd51fd9c'
const CASEY_MESSAGES = ['1a18e03ea586cd7e', '1a18f01749eb87a6']
const CASEY_CACHES = ['756e4e17-2458-470b-b00c-129c85ee821a', '78a5b2cc-ba50-4a71-a17c-adaf0c1041c2']

function json(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: {
    'Cache-Control': 'private, no-store, max-age=0', Pragma: 'no-cache',
    'X-Content-Type-Options': 'nosniff', Vary: 'Cookie, Origin',
  } })
}

export async function GET(req: NextRequest) {
  try {
    // Ordinary same-origin browser GETs omit Origin. SOP + the exact owner
    // session protects this read; reject cross-site fetches and foreign Origin
    // when supplied, without adding any permissive CORS response headers.
    if (req.headers.get('sec-fetch-site')?.toLowerCase() === 'cross-site'
      || (req.headers.has('origin') && !isBrowserSameOriginRequest({ headers: req.headers,
        requestOrigin: req.nextUrl.origin, trustedOrigins: [appPublicUrl()] }))) {
      return json({ ok: false, error: 'A same-origin browser request is required' }, 403)
    }
    const allowed = ['pipelineId', 'connectionId', 'participantEmail', 'messageIds', 'admissionScope']
    if ([...req.nextUrl.searchParams.keys()].some(key => !allowed.includes(key)
      || req.nextUrl.searchParams.getAll(key).length !== 1)) return json({ ok: false, error: 'Invalid candidate selection' }, 400)
    const pipelineId = req.nextUrl.searchParams.get('pipelineId') || ''
    const connectionId = req.nextUrl.searchParams.get('connectionId') || ''
    const participantEmail = (req.nextUrl.searchParams.get('participantEmail') || '').trim().toLowerCase()
    const rawIds = req.nextUrl.searchParams.get('messageIds')
    const messageIds = rawIds === null ? [] : rawIds.split(',').map(id => id.toLowerCase())
    const admissionScope = req.nextUrl.searchParams.get('admissionScope')
    const caseyPair = admissionScope === CASEY_SCOPE
    if (!UUID.test(pipelineId) || !/^[A-Za-z0-9_-]{1,200}$/.test(connectionId)
      || (admissionScope !== null && !caseyPair)
      || (caseyPair && (participantEmail !== '' || pipelineId !== LEGACY_PIPELINE || connectionId !== CASEY_CONNECTION
        || (rawIds !== null && [...messageIds].sort().join() !== [...CASEY_MESSAGES].sort().join())))
      || (participantEmail && (participantEmail.length > 254 || !EMAIL.test(participantEmail)))
      || (rawIds !== null && (!messageIds.length || messageIds.length > 25
        || messageIds.some(id => !GMAIL_ID.test(id)) || new Set(messageIds).size !== messageIds.length))) {
      return json({ ok: false, error: 'Provide a pipeline, linked mailbox, and bounded candidate selection' }, 400)
    }
    const session = await requestSession(req)
    if (!session?.authenticatedUser || !session.effectiveUser) return json({ ok: false, error: 'Unauthorized' }, 401)
    if (session.impersonating || session.authenticatedUser !== session.effectiveUser) {
      return json({ ok: false, error: 'Exit user view before reviewing email' }, 403)
    }
    const actor = await requireRequestUser(req)
    const pipeline = await resolvePipelineSpaceAccess({ actorEmail: actor, pipelineId })
    if (pipeline.id !== pipelineId || pipeline.ownerEmail !== actor.email || actor.email !== session.effectiveUser
      || !actor.organizationId || pipeline.workspaceOrganizationId !== actor.organizationId
      || (caseyPair && actor.email !== CASEY_OWNER)
      || (session.activeWorkspaceOrganizationId && session.activeWorkspaceOrganizationId !== actor.organizationId)) {
      return json({ ok: false, error: 'Pipeline owner access is required in the active workspace' }, 403)
    }
    if (!isPostgresStorageEnabled()) return json({ ok: false, error: 'Email review requires Postgres storage' }, 503)
    const connection = await query<{ account_email: string }>(`SELECT account_email FROM user_maton_connections
      WHERE owner_email=$1 AND connection_id=$2 AND app='google-mail' AND source='maton'
        AND status='ACTIVE' AND is_selected`, [actor.email, connectionId])
    if (connection.rows.length !== 1) return json({ ok: false, error: 'The selected mailbox is unavailable' }, 409)
    const mailbox = await readVerifiedGmailMailboxIdentityInPostgres({ ownerEmail: actor.email,
      connectionId, accountEmail: connection.rows[0].account_email })
    if (!mailbox) return json({ ok: false, error: 'Verify the selected Google mailbox before reviewing email' }, 409)
    // Default SQL and its three-message parameters stay unchanged. The explicit
    // pair uses the same owner/header/membership/verified-mailbox protections,
    // plus exact retained cache identities and original intake pipeline.
    const historicalPredicate = caseyPair
      ? `($2::uuid=$7::uuid AND message.external_thread_id=$8
          AND EXISTS (SELECT 1 FROM pipeline_spaces target_pipeline WHERE target_pipeline.id=$2::uuid
            AND target_pipeline.owner_email=$1 AND target_pipeline.workspace_organization_id=$3::uuid
            AND NOT target_pipeline.reference_access_disabled)
          AND message.external_message_id=ANY($9::text[])
          AND message.pipeline_id=$10::uuid
          AND message.id=CASE message.external_message_id WHEN $11 THEN $12::uuid WHEN $13 THEN $14::uuid END
          AND (message.mailbox_id IS NULL OR message.mailbox_id=$4::uuid))`
      : `((source_pipeline.workspace_organization_id=$3::uuid AND message.mailbox_id=$4::uuid)
          OR ($2::uuid=$7::uuid AND message.external_thread_id=$8
            AND message.external_message_id=ANY($9::text[])
            AND (message.mailbox_id IS NULL OR message.mailbox_id=$4::uuid)))`
    const result = await query<{
      message_id: string; thread_id: string; subject: string; received_at: string | Date
      participant_emails: string[]; participant_contacts: unknown; legacy: boolean
    }>(`WITH owned_cached_candidates AS (
      SELECT message.external_message_id AS message_id, message.external_thread_id AS thread_id,
        left(message.subject, 500) AS subject, message.received_at,
        (${caseyPair ? 'true' : "source_pipeline.workspace_organization_id IS DISTINCT FROM $3::uuid OR message.mailbox_id IS NULL"}) AS legacy,
        ARRAY(SELECT DISTINCT lower(btrim(mailbox_header->>'address'))
          FROM unnest(ARRAY['from','to','cc','bcc']) AS header_kind(kind)
          CROSS JOIN LATERAL jsonb_array_elements(CASE
            WHEN jsonb_typeof(message.raw_metadata->'emailAddressHeaders'->header_kind.kind)='array'
            THEN message.raw_metadata->'emailAddressHeaders'->header_kind.kind ELSE '[]'::jsonb END) mailbox_header
          WHERE jsonb_typeof(mailbox_header->'address')='string'
          ORDER BY 1) AS participant_emails
      FROM crm_inbound_messages message
      JOIN pipeline_spaces source_pipeline ON source_pipeline.id=message.pipeline_id
        AND source_pipeline.owner_email=message.owner_email AND NOT source_pipeline.reference_access_disabled
      JOIN app_users source_owner ON source_owner.email=source_pipeline.owner_email AND source_owner.status='active'
      JOIN app_user_organization_memberships source_membership
        ON source_membership.organization_id=source_pipeline.workspace_organization_id
        AND source_membership.user_email=source_pipeline.owner_email AND source_membership.status='active'
      WHERE message.owner_email=$1 AND message.raw_metadata->>'provider'='gmail'
        AND message.raw_metadata->'emailAddressHeaders'->>'version'='1'
        AND jsonb_array_length(CASE WHEN jsonb_typeof(message.raw_metadata->'emailAddressHeaders'->'from')='array'
          THEN message.raw_metadata->'emailAddressHeaders'->'from' ELSE '[]'::jsonb END)=1
        AND ${historicalPredicate}
        AND (cardinality($6::text[])=0 OR message.external_message_id=ANY($6::text[]))
    ) SELECT candidate.*, (
        SELECT COALESCE(jsonb_agg(choice.option ORDER BY choice.id), '[]'::jsonb)
        FROM (
          SELECT contact.id, jsonb_build_object(
            'id', contact.id, 'reference', contact.reference_code, 'name', left(contact.full_name, 300),
            'email', lower(btrim(contact.email)), 'organizationId', company.id,
            'organizationReference', company.reference_code, 'company', left(company.name, 300)
          ) AS option
          FROM crm_contacts contact
          JOIN crm_organizations company ON company.id=contact.organization_id AND company.pipeline_id=contact.pipeline_id
          WHERE contact.pipeline_id=$2::uuid
            AND lower(btrim(contact.email))=ANY(candidate.participant_emails)
            AND COALESCE(lower(contact.source_payload->>'archived'),'false') NOT IN ('true','1','yes')
            AND COALESCE(lower(company.source_payload->>'archived'),'false') NOT IN ('true','1','yes')
            AND contact.reference_code IS NOT NULL AND company.reference_code IS NOT NULL
          ORDER BY contact.id LIMIT 100
        ) choice
      ) AS participant_contacts
      FROM owned_cached_candidates candidate
      WHERE ($5='' OR $5=ANY(candidate.participant_emails))
      ORDER BY candidate.legacy DESC,candidate.received_at DESC,candidate.message_id LIMIT 25`,
    [actor.email, pipelineId, actor.organizationId, mailbox.mailboxId, participantEmail,
      messageIds, LEGACY_PIPELINE, LEGACY_THREAD, caseyPair ? CASEY_MESSAGES : LEGACY_MESSAGES,
      ...(caseyPair ? [CASEY_INTAKE_PIPELINE, CASEY_MESSAGES[0], CASEY_CACHES[0], CASEY_MESSAGES[1], CASEY_CACHES[1]] : [])])
    if (caseyPair && (result.rows.map(row => row.message_id).sort().join() !== [...CASEY_MESSAGES].sort().join()
      || result.rows.some(row => row.thread_id !== LEGACY_THREAD))) {
      return json({ ok: false, error: 'Both exact retained Casey messages are required; the historical records may have changed' }, 409)
    }
    const messages = result.rows.filter(row => GMAIL_ID.test(row.message_id) && GMAIL_ID.test(row.thread_id)).map(row => {
      const participantEmails = (row.participant_emails || []).filter(email =>
        typeof email === 'string' && email.length <= 254 && EMAIL.test(email)).slice(0, 200)
      const seen = new Set<string>()
      const participantContacts = (Array.isArray(row.participant_contacts) ? row.participant_contacts.slice(0, 100) : []).flatMap((value: unknown) => {
        if (!value || typeof value !== 'object') return []
        const { id, reference, name, email, organizationId, organizationReference, company } = value as Record<string, unknown>
        if (typeof id !== 'string' || !UUID.test(id) || seen.has(id)
          || typeof reference !== 'string' || !CONTACT_REFERENCE.test(reference)
          || typeof organizationId !== 'string' || !UUID.test(organizationId)
          || typeof organizationReference !== 'string' || !COMPANY_REFERENCE.test(organizationReference)
          || typeof email !== 'string' || !participantEmails.includes(email)
          || typeof name !== 'string' || !name.trim() || typeof company !== 'string' || !company.trim()) return []
        seen.add(id)
        return [{ id, reference: reference.toLowerCase(), name: name.slice(0, 300), email, organizationId,
          organizationReference: organizationReference.toLowerCase(), company: company.slice(0, 300) }]
      })
      return {
        messageId: row.message_id.toLowerCase(), threadId: row.thread_id.toLowerCase(), subject: row.subject || '(No subject)',
        receivedAt: new Date(row.received_at).toISOString(), legacy: row.legacy === true,
        ...(caseyPair ? { admissionScope: CASEY_SCOPE } : {}),
        participantEmails, participantContacts, participantContactIds: participantContacts.map(contact => contact.id),
      }
    })
    return json({ ok: true, pipelineId, connectionId, messages, maximum: caseyPair ? 2 : 25,
      ...(caseyPair ? { admissionScope: CASEY_SCOPE } : {}),
      scope: 'Selected cached Gmail messages only; no bodies, mailbox replay, or future thread rule' })
  } catch {
    return json({ ok: false, error: 'Email review candidates are unavailable or pipeline owner access was revoked' }, 403)
  }
}
