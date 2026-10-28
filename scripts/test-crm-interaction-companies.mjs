#!/usr/bin/env node
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import vm from 'node:vm'
import { interactionCompanyDisplay, interactionParticipantOptions, interactionRelatedCompanies } from '../app_src/lib/crm/interactionCompanies.mjs'
import { loadInteractionCompanyReader } from './lib/crm-interaction-company-fixture.mjs'

const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const pipeline = id(1), emailId = id(2), primaryId = id(3), partnerId = id(4)
const row = { id: emailId, pipeline_id: pipeline, organization_id: primaryId,
  organization_name: 'Customer', reference_code: 'gi1234567', source_key: 'synthetic-provider-message',
  subject: 'Synthetic shared email', interaction_type: 'email', provider_message_id: 'abc1',
  contact_id: id(5), occurred_at: '2026-10-27T10:00:00.123Z', metadata: {}, updated_at: '2026-10-27' }
const companies = [
  { interaction_id: emailId, id: primaryId, reference_code: 'ga1234567', name: 'Customer', is_primary: true },
  { interaction_id: emailId, id: partnerId, reference_code: 'ga2345678', name: 'Supplier', is_primary: false },
]
const contacts = [
  { interaction_id: emailId, id: id(5), full_name: 'Customer Person', email: 'person@customer.example.test',
    organization_id: primaryId, organization_name: 'Customer', organization_reference_code: 'ga1234567', is_primary: true },
  { interaction_id: emailId, id: id(6), full_name: 'Supplier Person', email: 'person@supplier.example.test',
    organization_id: partnerId, organization_name: 'Supplier', organization_reference_code: 'ga2345678', is_primary: false },
]
const queries = []
const runQuery = async (sql, values) => {
  queries.push({ sql, values: structuredClone(values) })
  assert.equal(values[0], pipeline, 'All queries retain the authorized pipeline parameter')
  if (sql.includes('SELECT interaction.*')) {
    assert.ok(sql.includes('WHERE interaction.pipeline_id = $1::uuid'))
    assert.ok(sql.includes('EXISTS (\n           SELECT 1 FROM crm_interaction_organizations related_organization'))
    assert.ok(sql.includes('related_organization.pipeline_id = interaction.pipeline_id'))
    assert.ok(!sql.includes('LEFT JOIN crm_interaction_organizations'), 'Account filtering must not multiply email rows')
    return { rows: [row] }
  }
  assert.deepEqual(values[1], [emailId])
  assert.ok(sql.includes('relationship.pipeline_id = $1::uuid'))
  if (sql.includes('FROM crm_interaction_contacts')) return { rows: contacts }
  if (sql.includes('FROM crm_interaction_organizations')) {
    assert.ok(sql.includes('organization.pipeline_id = relationship.pipeline_id'))
    assert.ok(sql.includes("organization.source_payload->>'archived'"))
    return { rows: companies }
  }
  assert.fail('Unexpected reader operation')
}
const reader = loadInteractionCompanyReader(runQuery)
const plain = (value) => JSON.parse(JSON.stringify(value))
const hydrated = plain(await reader.hydrateInteractionRows([row], pipeline, runQuery))
assert.equal(hydrated.length, 1)
assert.equal(hydrated[0].id, emailId)
assert.equal(hydrated[0].organizationId, primaryId)
assert.deepEqual(hydrated[0].organizationIds, [primaryId, partnerId])
assert.equal(hydrated[0].contacts[1].organizationId, partnerId, 'Supplier contact is not reparented to the primary company')
assert.equal(hydrated[0].contacts[1].organizationName, 'Supplier')
assert.equal(hydrated[0].occurredAt, row.occurred_at)
const providerDate = new Date(row.occurred_at)
const hydratedDate = plain(await reader.hydrateInteractionRows([{ ...row, occurred_at: providerDate }], pipeline, runQuery))
assert.equal(hydratedDate[0].occurredAt, providerDate.toISOString(), 'Actual PostgreSQL Date values retain UTC and milliseconds')
assert.ok(hydratedDate[0].occurredAt.length <= 50, 'Serialized Date fits the CRM save endpoint timestamp bound')
assert.equal(reader.interactionFromRow({ ...row, occurred_at: 'legacy timestamp string' }).occurredAt,
  'legacy timestamp string', 'Legacy string values remain unchanged')
assert.equal(reader.interactionFromRow({ ...row, occurred_at: null }).occurredAt, null)
assert.equal(reader.interactionFromRow({ ...row, metadata: { reviewedGmailRecovery: { targetFingerprint: 'synthetic' } } }, [], companies.slice(0, 1)).companyAssociationsReviewed,
  true, 'A filtered or archived secondary company must not unlock reviewed associations')
assert.equal(interactionCompanyDisplay(hydrated[0]), 'Customer (primary) · Supplier')
for (const companyId of [primaryId, partnerId]) {
  const listed = plain(await reader.listCrmRecordsInPostgres({ pipelineId: pipeline, entity: 'interactions',
    relatedEntity: 'organizations', relatedId: companyId, query: 'Supplier', limit: 10 }))
  assert.deepEqual(listed.map((email) => email.id), [emailId])
  const query = queries.findLast((entry) => entry.sql.includes('SELECT interaction.*'))
  assert.deepEqual(query.values, [pipeline, 'Supplier', false, 10, 'organizations', companyId])
  assert.ok(query.sql.includes('related_company.reference_code ILIKE'))
}
const calls = queries.length
assert.deepEqual(plain(await reader.hydrateInteractionRows([], pipeline, runQuery)), [])
assert.equal(queries.length, calls, 'Empty readers must not run relationship queries')
assert.deepEqual(interactionRelatedCompanies(null), [])
assert.equal(interactionCompanyDisplay({ organizationId: primaryId, organizationName: 'Customer' }), 'Customer')
assert.equal(interactionCompanyDisplay({ ...hydrated[0], organizations: [...hydrated[0].organizations, hydrated[0].organizations[1]] }), 'Customer (primary) · Supplier')
assert.deepEqual(interactionParticipantOptions(hydrated[0], []).map((contact) => contact.id), [id(5), id(6)],
  'Paged contact options retain every persisted shared-email participant')
assert.equal(interactionParticipantOptions(hydrated[0], [{ id: id(6), fullName: 'Updated supplier name' }]).find((contact) => contact.id === id(6)).fullName, 'Updated supplier name')

const component = readFileSync(new URL('../app_src/components/crm/CrmSection.tsx', import.meta.url), 'utf8')
assert.ok(component.includes("['organizations', 'contacts', 'leads', 'campaigns'].includes(editorEntity)"))
assert.ok(component.includes('One email, linked to these companies. Each contact keeps their own company.'))
assert.ok(component.includes("label={sharedEmailAssociations ? 'Primary company' : 'Organization'}"))
assert.ok(component.includes('disabled={!recordEditable || sharedEmailAssociations}'))
assert.ok(component.includes('editorRecord?.companyAssociationsReviewed === true'))
assert.ok(component.includes('interactionParticipantOptions(editorRecord, contacts)'))
assert.ok(component.includes('interactionCompanies.map((company) => <Chip'))
assert.ok(component.includes('Change them through reviewed email recovery; the email content remains editable.'))

// Render the actual editor fields with real React/MUI, using synthetic reader
// output. This is local rendering proof, not signed-in/browser acceptance.
const requireApp = createRequire(new URL('../app_src/package.json', import.meta.url))
const ts = requireApp('typescript')
const { renderToStaticMarkup } = requireApp('react-dom/server')
const ast = ts.createSourceFile('CrmSection.tsx', component, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
let editorFragment
let agentCallback, occurredAtExpression, interactionSaveBlock
function findEditor(node) {
  if (ts.isJsxExpression(node) && node.expression
    && ts.isBinaryExpression(node.expression)
    && node.expression.left.getText(ast) === "editorEntity === 'interactions'"
    && ts.isJsxFragment(node.expression.right)) editorFragment = node.expression.right
  if (ts.isVariableDeclaration(node) && node.name.getText(ast) === 'interactionAgentEmail'
    && node.initializer && ts.isCallExpression(node.initializer)) agentCallback = node.initializer.arguments[0].getText(ast)
  if (ts.isVariableDeclaration(node) && node.name.getText(ast) === 'occurredAt'
    && node.initializer?.getText(ast).includes('sharedEmailAssociations')) occurredAtExpression = node.initializer.getText(ast)
  if (ts.isIfStatement(node) && node.expression.getText(ast) === "editorEntity === 'interactions'"
    && node.thenStatement.getText(ast).includes('savedFields =')) interactionSaveBlock = node.thenStatement.getText(ast)
  ts.forEachChild(node, findEditor)
}
findEditor(ast)
assert.ok(editorFragment, 'The real interaction editor fragment must exist')
assert.ok(agentCallback && occurredAtExpression && interactionSaveBlock, 'Use the actual saved identity and assignment code')
const fieldsJsx = editorFragment.children.filter((node) => {
  if (ts.isJsxExpression(node)) return node.expression?.getText(ast).startsWith('sharedEmailAssociations &&')
  const opening = ts.isJsxElement(node) ? node.openingElement : ts.isJsxSelfClosingElement(node) ? node : null
  if (opening) {
    if (opening.tagName.getText(ast) === 'Autocomplete') return true
    const label = opening.attributes.properties.find((attribute) => ts.isJsxAttribute(attribute) && attribute.name.getText(ast) === 'label')
    return label?.initializer?.getText(ast) === '"Subject"'
      || label?.initializer?.getText(ast) === '"Agent"'
      || label?.initializer?.getText(ast) === '"Date"'
      || label?.initializer?.getText(ast).includes("'Primary company'")
  }
  return false
}).map((node) => node.getText(ast)).join('\n')
const utilities = ['textValue', 'idList', 'recordsForOrganization'].map((name) => {
  const fn = ast.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === name)
  assert.ok(fn, `Real UI utility ${name} must exist`)
  return fn.getText(ast)
}).join('\n')
const jsx = ts.transpileModule(`${utilities}\nglobalThis.interactionAgentEmail = (${agentCallback})();\nglobalThis.element = <>${fieldsJsx}</>`, {
  fileName: 'CrmSection-associations.tsx', compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX,
  },
}).outputText
const mui = requireApp('@mui/material')
const sharedRecord = hydrated[0]
const renderFields = (shared) => {
  const record = shared ? sharedRecord : { ...sharedRecord, organizations: sharedRecord.organizations.slice(0, 1), contacts: sharedRecord.contacts.slice(0, 1) }
  const ids = record.contacts.map((contact) => contact.id)
  const context = {
    ...mui, require: requireApp, exports: {}, recordEditable: true, editorRecord: record,
    fields: { subject: row.subject, organizationId: primaryId, contactIds: ids.join(',') },
    sharedEmailAssociations: shared, interactionCompanies: interactionRelatedCompanies(record),
    // The supplier is deliberately not in the paged global Contact list.
    contacts: [sharedRecord.contacts[0]], interactionEditorContacts: interactionParticipantOptions(record, [sharedRecord.contacts[0]]),
    organizations: companies.map((company) => ({ ...company, id: company.id })),
    pipelineUsers: [],
    setFields: () => assert.fail('Server rendering may not save or change CRM fields'),
  }
  vm.runInNewContext(jsx, context)
  return renderToStaticMarkup(context.element)
}
const sharedHtml = renderFields(true)
assert.ok(sharedHtml.includes('Customer (primary)') || sharedHtml.includes('Customer · Primary'))
assert.ok(sharedHtml.includes('Supplier Person') && sharedHtml.includes('Supplier'))
assert.ok(sharedHtml.includes('Customer Person'))
assert.ok(sharedHtml.includes('Each contact keeps their own company.'))
const inputTags = sharedHtml.match(/<input\b[^>]*>/g) || []
assert.ok(inputTags.some((tag) => tag.includes(row.subject) && !tag.includes('disabled=""')), 'Authored content remains editable')
assert.ok(inputTags.filter((tag) => tag.includes('disabled=""')).length >= 2, 'Primary company and participant inputs are protected')
const singleHtml = renderFields(false)
assert.ok(!singleHtml.includes('One email, linked to these companies.'))
assert.ok(!singleHtml.includes('Supplier Person'))
let dateConversions = 0
const legacyContext = {
  sharedEmailAssociations: true, editorEntity: 'interactions',
  editorRecord: { ...sharedRecord, agentEmail: null, agentName: 'Historical Author', occurredAt: hydratedDate[0].occurredAt },
  fields: { subject: 'Edited subject', agentEmail: '', agentName: 'Historical Author',
    contactIds: `${id(5)},${id(6)}`, occurredAt: '2026-10-27T06:00' },
  pipelineUsers: [{ email: 'new-owner@example.test', displayName: 'Historical Author' }],
  dateTimeSettings: { timeZone: 'America/New_York' },
  zonedDateTimeToIso: () => { dateConversions += 1; return '2026-10-27T10:00:00.000Z' },
}
vm.runInNewContext(ts.transpileModule(`${utilities}
  const interactionAgentEmail = (${agentCallback})();
  const occurredAt = ${occurredAtExpression};
  let savedFields; ${interactionSaveBlock}
  globalThis.saved = savedFields; globalThis.resolvedAgent = interactionAgentEmail;`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText, legacyContext)
assert.equal(legacyContext.resolvedAgent, '', 'A legacy name must not silently resolve to a new active agent')
assert.equal(legacyContext.saved.agentEmail, null)
assert.equal(legacyContext.saved.agentName, 'Historical Author')
assert.equal(legacyContext.saved.occurredAt, row.occurred_at, 'Content edits retain the exact provider timestamp including milliseconds')
assert.equal(legacyContext.saved.occurredAt, providerDate.toISOString(), 'Date-object reader output reaches the real shared-email edit payload unchanged')
assert.equal(dateConversions, 0, 'Read-only shared-email date must not be reformatted through minute-resolution input')
console.log('CRM related companies passed: actual readers/query boundaries and real React/MUI synthetic editor rendering; no live calls')
