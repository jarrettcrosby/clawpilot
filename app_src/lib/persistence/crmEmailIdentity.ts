import crypto from 'node:crypto'
import type { PoolClient } from 'pg'
import type { VerifiedGoogleIdentity } from '@/lib/googleSso'
import { recordAuditEvent } from '@/lib/auditWriter'
import { query, withTransaction } from '@/lib/persistence/postgres'
import {
  assertSameRetainedGmailEvidence, gmailEvidenceHash, gmailIntakeProvenance,
  retainedGmailMessageEvidence, verifyGmailMailboxBinding,
  type GmailMessageEvidence, type VerifiedGmailMailboxIdentity,
} from '@/lib/crm/emailIdentity'

const unavailable = () => new Error('Verified Gmail source identity is unavailable or changed')

/** Only call after cryptographic Google ID-token verification AND an independent
 * selected Maton Gmail-profile read. This function is not a public command that
 * accepts a caller-provided Google subject. Tokens are never retained. */
export async function bindVerifiedGmailMailboxInPostgres(input: {
  ownerEmail: string; connectionId: string; identity: VerifiedGoogleIdentity; observedAccountEmail: string
}) {
  const email = input.observedAccountEmail.trim().toLowerCase()
  if (email !== input.identity.email.trim().toLowerCase() || !input.identity.subject) throw unavailable()
  return withTransaction(async client => {
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`crm-mailbox-binding:${input.ownerEmail}:${input.connectionId}`])
    const connection = await client.query(`SELECT connection.connection_id FROM user_maton_connections connection
      JOIN app_users owner_user ON owner_user.email=connection.owner_email AND owner_user.status='active'
      WHERE connection.owner_email=$1 AND connection.connection_id=$2 AND connection.app='google-mail'
        AND connection.source='maton' AND connection.status='ACTIVE' AND connection.is_selected
        AND lower(btrim(connection.account_email))=$3 FOR SHARE OF connection, owner_user`,
    [input.ownerEmail, input.connectionId, email])
    if (connection.rows.length !== 1) throw unavailable()
    const current = await client.query<{ provider_account_id: string }>(`SELECT mailbox.provider_account_id
      FROM crm_email_mailbox_bindings binding JOIN crm_email_mailboxes mailbox ON mailbox.id=binding.mailbox_id
      WHERE binding.owner_email=$1 AND binding.connection_id=$2 FOR UPDATE OF binding`, [input.ownerEmail, input.connectionId])
    if (current.rows[0] && current.rows[0].provider_account_id !== input.identity.subject) throw unavailable()
    const mailbox = await client.query<{ id: string }>(`INSERT INTO crm_email_mailboxes
      (owner_email,provider,provider_account_id,account_email,verified_at) VALUES($1,'gmail',$2,$3,date_trunc('milliseconds',now()))
      ON CONFLICT(owner_email,provider,provider_account_id) DO UPDATE SET account_email=EXCLUDED.account_email
      RETURNING id::text`, [input.ownerEmail, input.identity.subject, email])
    await client.query(`INSERT INTO crm_email_mailbox_bindings(owner_email,connection_id,mailbox_id,account_email,verified_at)
      VALUES($1,$2,$3::uuid,$4,date_trunc('milliseconds',now())) ON CONFLICT(owner_email,connection_id) DO UPDATE SET
      account_email=EXCLUDED.account_email,verified_at=EXCLUDED.verified_at
      WHERE crm_email_mailbox_bindings.mailbox_id=EXCLUDED.mailbox_id`,
    [input.ownerEmail, input.connectionId, mailbox.rows[0].id, email])
    await recordAuditEvent({ actor: input.ownerEmail, eventType: 'crm.mailbox_identity.verified', aggregateType: 'crm_email_mailbox',
      aggregateId: mailbox.rows[0].id, eventKey: `crm-mailbox-verified:${mailbox.rows[0].id}:${input.connectionId}`,
      payload: { connectionId: input.connectionId, mailboxId: mailbox.rows[0].id, accountEmail: email, provider: 'gmail' } }, client)
    return { mailboxId: mailbox.rows[0].id, accountEmail: email, verified: true }
  })
}

export async function readVerifiedGmailMailboxIdentityInPostgres(input: {
  ownerEmail: string; connectionId: string; accountEmail: string
}): Promise<VerifiedGmailMailboxIdentity | null> {
  const result = await query<{ id: string; provider_account_id: string; account_email: string; verified_at: Date }>(`
    SELECT mailbox.id::text,mailbox.provider_account_id,binding.account_email,binding.verified_at
    FROM crm_email_mailboxes mailbox JOIN crm_email_mailbox_bindings binding
      ON binding.mailbox_id=mailbox.id AND binding.owner_email=mailbox.owner_email
    JOIN user_maton_connections connection ON connection.owner_email=binding.owner_email
      AND connection.connection_id=binding.connection_id AND connection.app='google-mail'
      AND connection.source='maton' AND connection.status='ACTIVE' AND connection.is_selected
    JOIN app_users owner_user ON owner_user.email=mailbox.owner_email AND owner_user.status='active'
    WHERE mailbox.owner_email=$1 AND binding.connection_id=$2
      AND lower(btrim(binding.account_email))=$3 AND lower(btrim(connection.account_email))=$3
      AND COALESCE((to_jsonb(connection)->>'remote_updated_at')::timestamptz,'-infinity')<=binding.verified_at`,
  [input.ownerEmail, input.connectionId, input.accountEmail.trim().toLowerCase()])
  if (result.rows.length !== 1) return null
  const row = result.rows[0]
  return { version: 1, provider: 'gmail', mailboxId: row.id, providerAccountId: row.provider_account_id,
    accountEmail: row.account_email, verifiedAt: new Date(row.verified_at).toISOString(), verifiedConnectionId: input.connectionId }
}

export async function lockGmailMailboxBindingWithClient(client: PoolClient, input: {
  ownerEmail: string; connectionId: string; identity: VerifiedGmailMailboxIdentity; observedAt: string
}) {
  verifyGmailMailboxBinding({ identity: input.identity, connectionId: input.connectionId,
    profileEmail: input.identity.accountEmail, observedAt: input.observedAt })
  const result = await client.query(`SELECT mailbox.id FROM crm_email_mailboxes mailbox
    JOIN crm_email_mailbox_bindings binding ON binding.mailbox_id=mailbox.id AND binding.owner_email=mailbox.owner_email
    JOIN user_maton_connections connection ON connection.owner_email=binding.owner_email
      AND connection.connection_id=binding.connection_id AND connection.app='google-mail'
      AND connection.source='maton' AND connection.status='ACTIVE' AND connection.is_selected
    WHERE mailbox.id=$1::uuid AND mailbox.owner_email=$2 AND mailbox.provider='gmail'
      AND mailbox.provider_account_id=$3 AND binding.connection_id=$4
      AND lower(btrim(binding.account_email))=$5 AND lower(btrim(connection.account_email))=$5
      AND COALESCE((to_jsonb(connection)->>'remote_updated_at')::timestamptz,'-infinity')<=binding.verified_at
      AND binding.verified_at=$6::timestamptz FOR SHARE OF mailbox,binding,connection`,
  [input.identity.mailboxId, input.ownerEmail, input.identity.providerAccountId, input.connectionId,
    input.identity.accountEmail, input.identity.verifiedAt])
  if (result.rows.length !== 1) throw unavailable()
}

export async function ensureGmailSourceWithClient(client: PoolClient, input: {
  ownerEmail: string; connectionId: string; identity: VerifiedGmailMailboxIdentity; observedAt: string
  intakePipelineId: string; intakeWorkspaceId: string; evidence: GmailMessageEvidence
}) {
  await lockGmailMailboxBindingWithClient(client, input)
  const provenance = gmailIntakeProvenance({ ...input, intakeWorkspaceOrganizationId: input.intakeWorkspaceId })
  const hash = gmailEvidenceHash(input.evidence)
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',
    [`crm-email-source:${input.identity.mailboxId}:${input.evidence.messageId}`])
  await client.query(`INSERT INTO crm_email_sources(mailbox_id,owner_email,provider_message_id,provider_thread_id,
    intake_pipeline_id,intake_workspace_id,observed_connection_id,observed_account_email,evidence,evidence_hash,provenance)
    VALUES($1::uuid,$2,$3,$4,$5::uuid,$6::uuid,$7,$8,$9::jsonb,$10,$11::jsonb)
    ON CONFLICT(mailbox_id,provider_message_id) DO NOTHING`,
  [input.identity.mailboxId, input.ownerEmail, input.evidence.messageId, input.evidence.threadId,
    input.intakePipelineId, input.intakeWorkspaceId, input.connectionId, input.identity.accountEmail,
    JSON.stringify(input.evidence), hash, JSON.stringify(provenance)])
  const selected = await client.query<{ id: string; evidence_hash: string; owner_email: string }>(`SELECT id::text,evidence_hash,owner_email
    FROM crm_email_sources WHERE mailbox_id=$1::uuid AND provider_message_id=$2 FOR UPDATE`,
  [input.identity.mailboxId, input.evidence.messageId])
  const row = selected.rows[0]
  if (!row || row.evidence_hash !== hash || row.owner_email !== input.ownerEmail) throw unavailable()
  return { sourceId: row.id, provenance }
}

export async function recordGmailMessageIntakeInPostgres(input: {
  ownerEmail: string; connectionId: string; intakePipelineId: string
  mailboxIdentity: VerifiedGmailMailboxIdentity | null; observedAccountEmail: string; observedAt: string
  messageEvidence: GmailMessageEvidence; rawMetadata: Record<string, unknown>
}): Promise<{ id: string; pipelineId: string; inserted: boolean; identityStatus: 'verified' | 'unknown'; sourceId?: string }> {
  return withTransaction(async client => {
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`crm-email-intake:${input.ownerEmail}:${input.messageEvidence.messageId}`])
    const scope = await client.query<{ workspace_id: string }>(`SELECT pipeline.workspace_organization_id::text AS workspace_id
      FROM pipeline_spaces pipeline JOIN app_users owner_user ON owner_user.email=pipeline.owner_email AND owner_user.status='active'
      JOIN app_user_organization_memberships membership ON membership.organization_id=pipeline.workspace_organization_id
        AND membership.user_email=pipeline.owner_email AND membership.status='active'
      JOIN user_maton_connections connection ON connection.owner_email=pipeline.owner_email
        AND connection.connection_id=$3 AND connection.app='google-mail' AND connection.source='maton'
        AND connection.status='ACTIVE' AND connection.is_selected AND lower(btrim(connection.account_email))=$4
      WHERE pipeline.id=$1::uuid AND pipeline.owner_email=$2 AND NOT pipeline.reference_access_disabled
      FOR SHARE OF pipeline,owner_user,membership,connection`,
    [input.intakePipelineId, input.ownerEmail, input.connectionId, input.observedAccountEmail.trim().toLowerCase()])
    if (scope.rows.length !== 1) throw unavailable()
    if (input.mailboxIdentity) verifyGmailMailboxBinding({ identity: input.mailboxIdentity, connectionId: input.connectionId,
      profileEmail: input.observedAccountEmail, observedAt: input.observedAt })
    const source = input.mailboxIdentity ? await ensureGmailSourceWithClient(client, {
      ownerEmail: input.ownerEmail, connectionId: input.connectionId, identity: input.mailboxIdentity,
      observedAt: input.observedAt, intakePipelineId: input.intakePipelineId,
      intakeWorkspaceId: scope.rows[0].workspace_id, evidence: input.messageEvidence,
    }) : null
    const evidence = input.messageEvidence
    const raw = { ...input.rawMetadata, provider: 'gmail', emailAddressHeaders: evidence.emailAddressHeaders,
      identityStatus: source ? 'verified' : 'unknown',
      ...(source ? { intakeProvenance: source.provenance } : { originalMailboxProvenance: 'unknown',
        intakeObservation: { version: 1, observedConnectionId: input.connectionId,
          observedAccountEmail: input.observedAccountEmail, observedAt: input.observedAt,
          intakePipelineId: input.intakePipelineId, intakeWorkspaceOrganizationId: scope.rows[0].workspace_id,
          providerAccountIdentity: 'unknown' } }) }
    const inserted = await client.query<{ id: string }>(`INSERT INTO crm_inbound_messages
      (owner_email,pipeline_id,external_message_id,external_thread_id,sender_email,recipient_emails,subject,received_at,
       snippet,body_text,marker_references,raw_metadata,mailbox_id,canonical_source_id)
      VALUES($1,$2::uuid,$3,$4,$5,$6,$7,$8::timestamptz,$9,$10,$11,$12::jsonb,$13::uuid,$14::uuid)
      ON CONFLICT(owner_email,external_message_id) DO NOTHING RETURNING id::text`,
    [input.ownerEmail, input.intakePipelineId, evidence.messageId, evidence.threadId, evidence.senderEmail,
      evidence.recipientEmails, evidence.subject, evidence.receivedAt, evidence.snippet, evidence.bodyText,
      evidence.markerReferences, JSON.stringify(raw), input.mailboxIdentity?.mailboxId || null, source?.sourceId || null])
    const selected = await client.query<Record<string, unknown>>(`SELECT * FROM crm_inbound_messages
      WHERE owner_email=$1 AND external_message_id=$2 FOR UPDATE`, [input.ownerEmail, evidence.messageId])
    const cached = selected.rows[0]
    if (!cached) throw unavailable()
    const verified = Boolean(source && cached.canonical_source_id === source.sourceId
      && cached.mailbox_id === input.mailboxIdentity!.mailboxId)
    if (verified) assertSameRetainedGmailEvidence(retainedGmailMessageEvidence(cached), evidence)
    // A second mailbox's colliding provider ID is preserved in canonical sources
    // but cannot borrow the old cache, links or activity. It remains held.
    return { id: String(cached.id), pipelineId: String(cached.pipeline_id), inserted: inserted.rows.length === 1,
      identityStatus: verified ? 'verified' : 'unknown', ...(source ? { sourceId: source.sourceId } : {}) }
  })
}

export function gmailDecisionId() { return crypto.randomUUID() }
