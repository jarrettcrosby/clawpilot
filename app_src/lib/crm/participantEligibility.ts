const DEFAULT_ARCHIVE_EMAIL = 'archive@eigenracing.com'
export const CRM_EMAIL_PATTERN = /^[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?(?:\.[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?)+$/i

export function ordinaryGmailArchiveAddress(): string {
  const configured = String(process.env.CLAWPILOT_ARCHIVE_EMAIL || '').trim().toLowerCase()
  return CRM_EMAIL_PATTERN.test(configured) ? configured : DEFAULT_ARCHIVE_EMAIL
}

/**
 * Exact-email CRM participant lookup shared by automatic communication intake.
 * Parameters are $1: eligible owned pipeline UUIDs and $2: normalized emails.
 *
 * QuickBooks customer synchronization can mirror the same person into an
 * accounting workspace. That projection is not a second independent CRM
 * relationship. Prefer a real CRM record for that same email only when the
 * accounting provenance and durable provider link both agree. A standalone
 * QuickBooks contact remains eligible, and any explicit adoption/source marker
 * makes the record ordinary CRM evidence again. Explicit reference routing does
 * not use this automatic-lookup policy.
 */
export function crmParticipantEmailCandidatesSql(): string {
  return `WITH participant_candidates AS (
    SELECT contact.id::text, contact.pipeline_id::text,
      contact.organization_id::text, contact.reference_code,
      lower(btrim(contact.email)) AS email, 'contacts'::text AS entity,
      COALESCE(
        contact.source_payload->>'provider' = 'quickbooks'
        AND COALESCE(btrim(contact.source_payload->>'source'), '') = ''
        AND contact.source_payload - ARRAY['provider', 'customerId', 'customer']::text[] = '{}'::jsonb
        AND COALESCE(btrim(contact.source_payload->>'customerId'), '') <> ''
        AND contact.source_payload->'customer'->>'Id' = contact.source_payload->>'customerId'
        AND EXISTS (
          SELECT 1 FROM quickbooks_crm_links accounting_link
          JOIN pipeline_spaces accounting_pipeline
            ON accounting_pipeline.id = accounting_link.pipeline_id
            AND accounting_pipeline.workspace_organization_id = accounting_link.organization_id
          WHERE accounting_link.pipeline_id = contact.pipeline_id
            AND accounting_link.crm_record_id = contact.id
            AND accounting_link.crm_entity_type = 'contact'
            AND accounting_link.provider_entity_type = 'customer'
            AND accounting_link.provider_entity_id = contact.source_payload->>'customerId'
        ), false
      ) AS accounting_mirror
    FROM crm_contacts contact
    WHERE contact.pipeline_id = ANY($1::uuid[])
      AND lower(btrim(contact.email)) = ANY($2::text[])
      AND COALESCE(lower(contact.source_payload->>'archived'), 'false') NOT IN ('true', '1', 'yes')
    UNION ALL
    SELECT lead.id::text, lead.pipeline_id::text, lead.organization_id::text,
      lead.reference_code, lower(btrim(lead.email)) AS email,
      'leads'::text AS entity, false AS accounting_mirror
    FROM crm_leads lead
    WHERE lead.pipeline_id = ANY($1::uuid[])
      AND lower(btrim(lead.email)) = ANY($2::text[])
      AND COALESCE(lower(lead.source_payload->>'archived'), 'false') NOT IN ('true', '1', 'yes')
  )
  SELECT candidate.id, candidate.pipeline_id, candidate.organization_id,
    candidate.reference_code, candidate.email, candidate.entity
  FROM participant_candidates candidate
  WHERE NOT candidate.accounting_mirror OR NOT EXISTS (
    SELECT 1 FROM participant_candidates crm_candidate
    WHERE crm_candidate.email = candidate.email AND NOT crm_candidate.accounting_mirror
  )
  ORDER BY candidate.reference_code ASC
  LIMIT 101`
}

/** Choose one primary contact without dropping the remaining participants.
 * Commercial account type, not the hierarchy relationship, identifies a customer. */
export function orderOrdinarySharedGmailContacts<T extends { organizationId: string; email: string; referenceCode: string }>(
  targets: readonly T[], accountTypes: ReadonlyMap<string, string | null>, senderEmail: string,
): T[] {
  const customer = (target: T) => accountTypes.get(target.organizationId)?.trim().toLowerCase() === 'customer'
  return [...targets].sort((left, right) => (
    Number(customer(right)) - Number(customer(left))
    || Number(right.email.toLowerCase() === senderEmail.toLowerCase())
      - Number(left.email.toLowerCase() === senderEmail.toLowerCase())
    || left.referenceCode.localeCompare(right.referenceCode)
  ))
}
