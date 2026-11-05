import { createHash } from 'node:crypto'

export type SuiteCrmEmailProjection = {
  version: 1
  accounts: string[]
  contacts: string[]
  contactAccounts: Array<{ contactId: string; accountId: string }>
  previousManaged: { accounts: string[]; contacts: string[] }
  audience: {
    policy: 'pipeline-internal'
    ownerSuiteCrmId: string
    allowedSuiteCrmUserIds: string[]
    fingerprint: string
    workspaceId: string
    pipelineId: string
  }
}

export type SuiteCrmEmailProjectionReadback = {
  version: 1
  suiteCrmId: string
  capturedAt: string
  attributes: Record<string, string>
  accounts: string[]
  contacts: string[]
  contactAccounts: Array<{ contactId: string; accountId: string }>
  audience: {
    fingerprint: string
    readerSuiteCrmUserIds: string[]
    administratorSuiteCrmUserIds: string[]
  }
}

type EmailRecord = {
  pipelineId: string
  suiteCrmId: string
  attributes: Record<string, unknown>
  emailProjection?: SuiteCrmEmailProjection
  relationships?: Array<{ linkFieldName: string; relatedModuleName: string; relatedBeanId: string }>
}
type Request = (path: string, init: RequestInit, allowNotFound?: boolean) => Promise<unknown>
type Resource = { id: string; type: string; attributes?: Record<string, unknown> }

export class SuiteCrmEmailProjectionHeldError extends Error {
  readonly code = 'SUITECRM_EMAIL_PROJECTION_HELD'
  constructor() {
    super('Native Email projection held: exact identity, relationships, or audience proof is unavailable')
    this.name = 'SuiteCrmEmailProjectionHeldError'
  }
}
function refuse(): never { throw new SuiteCrmEmailProjectionHeldError() }
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return refuse()
  return value as Record<string, unknown>
}
function id(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/i.test(value)) return refuse()
  return value
}
function ids(value: unknown, max = 200): string[] {
  if (!Array.isArray(value) || value.length > max) return refuse()
  const result = value.map(id)
  if (new Set(result).size !== result.length) return refuse()
  return result.sort()
}
function same(left: unknown, right: unknown) { return JSON.stringify(left) === JSON.stringify(right) }
function exactKeys(value: Record<string, unknown>, keys: string[]) {
  if (!same(Object.keys(value).sort(), [...keys].sort())) refuse()
}

export function suiteCrmEmailAudienceFingerprint(value: SuiteCrmEmailProjection['audience']): string {
  return createHash('sha256').update(JSON.stringify({
    policy: value.policy,
    ownerSuiteCrmId: value.ownerSuiteCrmId,
    allowedSuiteCrmUserIds: [...value.allowedSuiteCrmUserIds].sort(),
    workspaceId: value.workspaceId,
    pipelineId: value.pipelineId,
  })).digest('hex')
}

function projectionFor(record: EmailRecord): SuiteCrmEmailProjection {
  const raw = object(record.emailProjection)
  exactKeys(raw, ['version', 'accounts', 'contacts', 'contactAccounts', 'previousManaged', 'audience'])
  if (raw.version !== 1) return refuse()
  const accounts = ids(raw.accounts, 25), contacts = ids(raw.contacts, 25)
  const previous = object(raw.previousManaged)
  exactKeys(previous, ['accounts', 'contacts'])
  const previousManaged = { accounts: ids(previous.accounts, 25), contacts: ids(previous.contacts, 25) }
  if (!Array.isArray(raw.contactAccounts) || raw.contactAccounts.length !== contacts.length) return refuse()
  const contactAccounts = raw.contactAccounts.map((entry) => {
    const binding = object(entry)
    exactKeys(binding, ['contactId', 'accountId'])
    return { contactId: id(binding.contactId), accountId: id(binding.accountId) }
  }).sort((a, b) => a.contactId.localeCompare(b.contactId))
  if (!same(contactAccounts.map((entry) => entry.contactId), contacts)
    || contactAccounts.some((entry) => !accounts.includes(entry.accountId))) return refuse()
  const audience = object(raw.audience)
  exactKeys(audience, ['policy', 'ownerSuiteCrmId', 'allowedSuiteCrmUserIds', 'fingerprint', 'workspaceId', 'pipelineId'])
  if (audience.policy !== 'pipeline-internal' || audience.pipelineId !== record.pipelineId
    || typeof audience.fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(audience.fingerprint)) return refuse()
  const expected = {
    policy: 'pipeline-internal' as const, ownerSuiteCrmId: id(audience.ownerSuiteCrmId),
    allowedSuiteCrmUserIds: ids(audience.allowedSuiteCrmUserIds),
    fingerprint: audience.fingerprint, workspaceId: id(audience.workspaceId), pipelineId: id(audience.pipelineId),
  }
  if (!expected.allowedSuiteCrmUserIds.includes(expected.ownerSuiteCrmId)
    || suiteCrmEmailAudienceFingerprint(expected) !== expected.fingerprint) return refuse()
  const related = record.relationships || []
  if (related.some((entry) => !['accounts', 'contacts'].includes(entry.linkFieldName)
    || entry.relatedModuleName !== (entry.linkFieldName === 'accounts' ? 'Accounts' : 'Contacts'))) return refuse()
  for (const [link, desired] of [['accounts', accounts], ['contacts', contacts]] as const) {
    if (!same(ids(related.filter((entry) => entry.linkFieldName === link).map((entry) => entry.relatedBeanId), 25), desired)) refuse()
  }
  return { version: 1, accounts, contacts, contactAccounts, previousManaged, audience: expected }
}

function resource(value: unknown, expectedId: string, module: string): Resource {
  const data = object(object(value).data)
  if (data.id !== expectedId || ![module, module.slice(0, -1)].includes(String(data.type))) return refuse()
  return { id: expectedId, type: String(data.type), attributes: object(data.attributes) }
}

async function readLinks(request: Request, emailId: string, link: 'accounts' | 'contacts'): Promise<string[]> {
  const result: string[] = []
  for (let page = 1; page <= 10; page++) {
    const response = object(await request(`/Api/V8/module/Emails/${encodeURIComponent(emailId)}/relationships/${link}?page[size]=200&page[number]=${page}`, { method: 'GET' }))
    // Pinned V8 RelationshipService returns a meta-only document for no links.
    if ((response.data === undefined || response.data === null)
      && object(response.meta).message === `There is no relationship set in Email module with ${link} link field`) return result.sort()
    if (!Array.isArray(response.data) || response.data.length > 200) return refuse()
    for (const entry of response.data) {
      const item = object(entry)
      const moduleName = link === 'accounts' ? 'Accounts' : 'Contacts'
      if (![moduleName, moduleName.slice(0, -1)].includes(String(item.type))) return refuse()
      const relatedId = id(item.id)
      if (result.includes(relatedId)) return refuse()
      result.push(relatedId)
    }
    const meta = response.meta === undefined ? {} : object(response.meta)
    const pages = meta['total-pages']
    const total = meta['total-records']
    if (pages !== undefined && (typeof pages !== 'number' || !Number.isSafeInteger(pages) || pages < 1 || pages > 10)) return refuse()
    if (total !== undefined && (typeof total !== 'number' || !Number.isSafeInteger(total) || total < 0 || total > 2000)) return refuse()
    if (pages === undefined ? response.data.length < 200 : page === pages) {
      if (total !== undefined && total !== result.length) return refuse()
      return result.sort()
    }
  }
  return refuse()
}

async function verifyContactAccounts(request: Request, bindings: SuiteCrmEmailProjection['contactAccounts']) {
  for (const binding of bindings) {
    const contact = resource(await request(`/Api/V8/module/Contacts/${encodeURIComponent(binding.contactId)}`, { method: 'GET' }), binding.contactId, 'Contacts')
    if (contact.attributes?.account_id !== binding.accountId) refuse()
  }
}

async function audienceProof(request: Request, record: EmailRecord, projection: SuiteCrmEmailProjection, phase: 'before' | 'after') {
  const response = object(await request('/Api/V8/custom/clawpilot-email-audience', { method: 'POST', body: JSON.stringify({
    version: 1, phase, suiteCrmId: record.suiteCrmId, globalId: record.attributes.global_id_c,
    assignedUserId: record.attributes.assigned_user_id ?? null,
    accounts: projection.accounts, contacts: projection.contacts, audience: projection.audience,
  }) }))
  if (response.version !== 1 || response.suiteCrmId !== record.suiteCrmId || response.phase !== phase
    || response.complete !== true || response.noImplicitSharing !== true
    || response.fingerprint !== projection.audience.fingerprint) return refuse()
  const capturedAt = typeof response.capturedAt === 'string' ? Date.parse(response.capturedAt) : NaN
  if (!Number.isFinite(capturedAt) || Math.abs(Date.now() - capturedAt) > 30_000) return refuse()
  const readers = ids(response.readerSuiteCrmUserIds)
  const administrators = ids(response.administratorSuiteCrmUserIds)
  if (!same(readers, projection.audience.allowedSuiteCrmUserIds)
    || administrators.some((entry) => !readers.includes(entry))) return refuse()
  return { fingerprint: projection.audience.fingerprint,
    readerSuiteCrmUserIds: readers, administratorSuiteCrmUserIds: administrators }
}

const EMAIL_FIELDS = new Set(['global_id_c', 'name', 'date_sent_received', 'type', 'status', 'parent_type', 'parent_id',
  'assigned_user_id', 'description', 'description_html', 'from_addr_name', 'to_addrs_names', 'cc_addrs_names', 'bcc_addrs_names', 'reply_to_addrs_names'])
function emailAttributes(value: unknown): Record<string, string> {
  const raw = object(value), result: Record<string, string> = {}
  for (const [key, entry] of Object.entries(raw)) {
    if (!EMAIL_FIELDS.has(key) || typeof entry !== 'string' || entry.length > 100_000
      || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(entry)) return refuse()
    result[key] = entry
  }
  for (const key of ['global_id_c', 'name', 'date_sent_received', 'type', 'status', 'parent_type', 'parent_id', 'description', 'description_html']) {
    if (!Object.hasOwn(result, key)) return refuse()
  }
  if (!/^gi(?:[0-9]{7}|[0-9a-v]{12})$/.test(result.global_id_c) || result.type !== 'archived'
    || !['read', 'sent'].includes(result.status) || result.description_html !== ''
    || !Number.isFinite(Date.parse(result.date_sent_received))) return refuse()
  return result
}

/** No permission writes. Unknown native policy/extra unmanaged links hold before content publication. */
export async function projectSuiteCrmNativeEmail(record: EmailRecord, requestImpl: Request): Promise<SuiteCrmEmailProjectionReadback> {
  const deadline = AbortSignal.timeout(60_000)
  // One deadline reaches token acquisition, every fetch and body read. Await
  // cancellation; never race/abandon a writer after the publication TX releases.
  const request: Request = async (path, init, allowNotFound) => {
    deadline.throwIfAborted()
    const result = await requestImpl(path, { ...init,
      signal: init.signal ? AbortSignal.any([deadline, init.signal]) : deadline }, allowNotFound)
    deadline.throwIfAborted()
    return result
  }
  try {
    id(record.suiteCrmId)
    const projection = projectionFor(record), expectedAttributes = emailAttributes(record.attributes)
    if ((expectedAttributes.parent_type !== '' || expectedAttributes.parent_id !== '')
      && (expectedAttributes.parent_type !== 'Accounts' || !projection.accounts.includes(expectedAttributes.parent_id))) refuse()
    const beforeAudience = await audienceProof(request, record, projection, 'before')
    const existing = await request(`/Api/V8/module/Emails/${encodeURIComponent(record.suiteCrmId)}`, { method: 'GET' }, true)
    if (existing && resource(existing, record.suiteCrmId, 'Emails').attributes?.global_id_c !== expectedAttributes.global_id_c) refuse()
    const lookup = object(await request(`/Api/V8/module/Emails?${new URLSearchParams({
      'filter[global_id_c][eq]': expectedAttributes.global_id_c, 'page[size]': '2', 'page[number]': '1',
    })}`, { method: 'GET' }))
    if (!Array.isArray(lookup.data) || lookup.data.length > 1
      || lookup.data.some((entry) => object(entry).id !== record.suiteCrmId
        || !['Emails', 'Email'].includes(String(object(entry).type)))) refuse()
    const lookupMeta = lookup.meta === undefined ? {} : object(lookup.meta)
    const lookupPages = lookupMeta['total-pages']
    if ((lookupMeta['total-records'] !== undefined && lookupMeta['total-records'] !== lookup.data.length)
      || (lookupPages !== undefined && (typeof lookupPages !== 'number' || ![0, 1].includes(lookupPages)))) refuse()
    const current = { accounts: existing ? await readLinks(request, record.suiteCrmId, 'accounts') : [],
      contacts: existing ? await readLinks(request, record.suiteCrmId, 'contacts') : [] }
    for (const link of ['accounts', 'contacts'] as const) {
      if (current[link].some((entry) => !projection[link].includes(entry) && !projection.previousManaged[link].includes(entry))) refuse()
    }
    await verifyContactAccounts(request, projection.contactAccounts)
    const written = await request('/Api/V8/module', { method: existing ? 'PATCH' : 'POST', body: JSON.stringify({
      data: { type: 'Emails', id: record.suiteCrmId, attributes: expectedAttributes },
    }) })
    resource(written, record.suiteCrmId, 'Emails')
    for (const link of ['accounts', 'contacts'] as const) {
      const path = `/Api/V8/module/Emails/${encodeURIComponent(record.suiteCrmId)}/relationships/${link}`
      for (const relatedId of current[link].filter((entry) => !projection[link].includes(entry))) {
        await request(`${path}/${encodeURIComponent(relatedId)}`, { method: 'DELETE' })
      }
      for (const relatedId of projection[link].filter((entry) => !current[link].includes(entry))) {
        await request(path, { method: 'POST', body: JSON.stringify({ data: {
          type: link === 'accounts' ? 'Accounts' : 'Contacts', id: relatedId,
        } }) })
      }
    }
    const saved = resource(await request(`/Api/V8/module/Emails/${encodeURIComponent(record.suiteCrmId)}`, { method: 'GET' }), record.suiteCrmId, 'Emails')
    for (const [key, expected] of Object.entries(expectedAttributes)) {
      const actual = saved.attributes?.[key]
      // Native empty optional columns may be NULL. Content and identity are never transformed.
      if (actual !== expected && !(expected === '' && actual === null)) refuse()
    }
    const accounts = await readLinks(request, record.suiteCrmId, 'accounts')
    const contacts = await readLinks(request, record.suiteCrmId, 'contacts')
    if (!same(accounts, projection.accounts) || !same(contacts, projection.contacts)) refuse()
    await verifyContactAccounts(request, projection.contactAccounts)
    const audience = await audienceProof(request, record, projection, 'after')
    if (!same(audience, beforeAudience)) refuse()
    return { version: 1, suiteCrmId: record.suiteCrmId, capturedAt: new Date().toISOString(),
      attributes: expectedAttributes, accounts, contacts, contactAccounts: projection.contactAccounts, audience }
  } catch { return refuse() }
}
