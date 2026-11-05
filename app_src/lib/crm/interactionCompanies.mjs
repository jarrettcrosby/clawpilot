/** Display persisted associations only; this helper grants no routing authority.
 * @param {unknown} value
 */
export function interactionRelatedCompanies(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return []
  const record = /** @type {Record<string, unknown>} */ (value)
  const primaryId = typeof record.organizationId === 'string' ? record.organizationId : ''
  const supplied = Array.isArray(record.organizations) ? record.organizations : []
  const byId = new Map()
  for (const entry of supplied) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue
    if (typeof entry.id !== 'string' || !entry.id || byId.has(entry.id)) continue
    byId.set(entry.id, {
      id: entry.id,
      referenceCode: typeof entry.referenceCode === 'string' ? entry.referenceCode : '',
      name: typeof entry.name === 'string' ? entry.name : '',
      isPrimary: entry.id === primaryId,
    })
  }
  if (primaryId && !byId.has(primaryId)) byId.set(primaryId, {
    id: primaryId, referenceCode: '',
    name: typeof record.organizationName === 'string' ? record.organizationName : '',
    isPrimary: true,
  })
  return [...byId.values()].sort((left, right) => Number(right.isPrimary) - Number(left.isPrimary))
}

/** @param {unknown} record */
export function interactionCompanyDisplay(record) {
  const companies = interactionRelatedCompanies(record)
  return companies.map((company) => `${company.name || company.referenceCode || 'Company'}${companies.length > 1 && company.isPrimary ? ' (primary)' : ''}`).join(' · ')
}

/** Retain selected participants even when they are outside a paged contact list.
 * @param {unknown} value
 * @param {Record<string, unknown>[]} contacts
 */
export function interactionParticipantOptions(value, contacts) {
  const record = value && typeof value === 'object' && !Array.isArray(value)
    ? /** @type {Record<string, unknown>} */ (value) : {}
  const related = Array.isArray(record.contacts) ? record.contacts : []
  const byId = new Map()
  for (const contact of [...related, ...contacts]) {
    if (contact && typeof contact === 'object' && !Array.isArray(contact)
      && typeof contact.id === 'string' && contact.id) byId.set(contact.id, contact)
  }
  return [...byId.values()]
}
