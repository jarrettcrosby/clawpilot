#!/usr/bin/env node
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import vm from 'node:vm'

const ts = createRequire(new URL('../app_src/package.json', import.meta.url))('typescript')
const helperSource = readFileSync(new URL('../app_src/lib/crm/suiteCrmOpportunityStage.ts', import.meta.url), 'utf8')
const helperModule = { exports: {} }
const transpile = source => ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText
vm.runInNewContext(transpile(helperSource), { module: helperModule, exports: helperModule.exports })
const { suiteCrmOpportunitySalesStage } = helperModule.exports
const nativeStages = JSON.parse(readFileSync(new URL('./fixtures/suitecrm-8.10.1-sales-stages.json', import.meta.url), 'utf8'))
assert.equal(nativeStages.version, '8.10.1')
assert.match(nativeStages.source, /SuiteCRM-Core\/blob\/v8\.10\.1\/public\/legacy\/include\/language\/en_us\.lang\.php$/)

const cases = [
  ['historical Closed lifecycle + Won board label', { status: 'Closed', stage: 'Won' }, 'Closed Won'],
  ['Closed lifecycle beats active board label', { status: 'Closed', stage: 'Proposal' }, 'Closed Won'],
  ['Won lifecycle beats board label', { status: 'Won', stage: 'Negotiation' }, 'Closed Won'],
  ['lifecycle normalization', { status: '  cLoSeD  ', stage: 'Demo' }, 'Closed Won'],
  ['Lost lifecycle', { status: 'Lost', stage: 'Proposal' }, 'Closed Lost'],
  ['Abandoned lifecycle', { status: 'Abandoned', stage: 'Identified Lead' }, 'Closed Lost'],
  ['lifecycle outcome remains authoritative', { status: 'Lost', stage: 'Won' }, 'Closed Lost'],
  ['explicit Open conflicts with Won', { status: 'Open', stage: 'Won' }, 'Prospecting'],
  ['explicit Open conflicts with native win', { status: 'Open', stage: 'Closed Won' }, 'Prospecting'],
  ['On Hold conflicts with native loss', { status: ' On   Hold ', stage: 'Closed Lost' }, 'Prospecting'],
  ['custom nonterminal lifecycle does not imply a win', { status: 'Awaiting signature', stage: 'Won' }, 'Prospecting'],
  ['legacy native won stage without lifecycle', { stage: 'Closed Won' }, 'Closed Won'],
  ['legacy native lost stage without lifecycle', { stage: 'Closed Lost' }, 'Closed Lost'],
  ['legacy Closed stage without lifecycle', { stage: 'Closed' }, 'Closed Won'],
  ['legacy Loss stage without lifecycle', { stage: 'Loss' }, 'Closed Lost'],
  ['legacy normalized native win', { status: '', stage: ' cLoSeD   WoN ' }, 'Closed Won'],
  ['Identified Lead alias', { status: 'Open', stage: 'Identified Lead' }, 'Prospecting'],
  ['Qualified Lead alias', { status: 'Open', stage: 'Qualified Lead' }, 'Qualification'],
  ['Proposal alias', { status: 'Open', stage: 'Proposal' }, 'Proposal/Price Quote'],
  ['Negotiation alias', { status: 'Open', stage: 'Negotiation' }, 'Negotiation/Review'],
  ['normalized open alias', { status: 'Open', stage: '  qUALIFIED   lEAD  ' }, 'Qualification'],
  ['normalized slash spacing', { status: 'Open', stage: ' Proposal / Price   Quote ' }, 'Proposal/Price Quote'],
  ['Needs Analysis is canonical', { status: 'Open', stage: 'Needs Analysis' }, 'Needs Analysis'],
  ['Demo is not approximated', { status: 'Open', stage: 'Demo' }, 'Demo'],
  ['Closed Delayed is not a closed outcome', { status: 'Open', stage: 'Closed Delayed' }, 'Closed Delayed'],
  ['Closed Delayed without lifecycle is not a win', { stage: 'Closed Delayed' }, 'Closed Delayed'],
  ['custom open stage retained', { status: 'Open', stage: 'Customer Technical Review' }, 'Customer Technical Review'],
  ['custom stage text is not reverse-normalized', { status: 'On Hold', stage: '  Approval  /  Review  ' }, 'Approval  /  Review'],
  ['custom stage cannot select object properties', { status: 'Open', stage: 'constructor' }, 'constructor'],
  ['custom stage cannot select object prototype', { status: 'Open', stage: '__proto__' }, '__proto__'],
  ['empty stage not invented', { status: 'Open', stage: '' }, ''],
]
for (const [label, input, expected] of cases) {
  const snapshot = JSON.stringify(input)
  assert.equal(suiteCrmOpportunitySalesStage(Object.freeze(input)), expected, label)
  assert.equal(JSON.stringify(input), snapshot, `${label}: app fields must not be changed`)
}
for (const stage of nativeStages.values) {
  assert.equal(suiteCrmOpportunitySalesStage({ stage }), stage, `native key ${stage} preserved`)
  assert.ok(nativeStages.values.includes(suiteCrmOpportunitySalesStage({ stage })))
}
for (const [, input] of cases.filter(([, input]) => ['Closed', 'Won', 'Lost', 'Abandoned'].includes(input.status))) {
  assert.ok(nativeStages.values.includes(suiteCrmOpportunitySalesStage(input)), 'lifecycle outcome is a native enum')
}

// Execute the production attribute builder, not a duplicate projection model.
const persistenceSource = readFileSync(new URL('../app_src/lib/persistence/crm.ts', import.meta.url), 'utf8')
const ast = ts.createSourceFile('crm.ts', persistenceSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
const functions = new Map(ast.statements.filter(ts.isFunctionDeclaration).map(node => [node.name?.text, node.getText(ast)]))
const projectionModule = { exports: {} }
const projectionSource = ['clean', 'finite', 'isoDate', 'suiteCrmAttributes'].map(name => {
  assert.ok(functions.has(name), `production ${name} function is present`)
  return functions.get(name)
}).join('\n') + '\nmodule.exports = { suiteCrmAttributes };'
vm.runInNewContext(transpile(projectionSource), {
  module: projectionModule, exports: projectionModule.exports, suiteCrmOpportunitySalesStage,
})
const fields = Object.freeze({
  name: 'Private opportunity projection fixture', organizationSuiteCrmId: 'fixture-account',
  status: 'Closed', stage: 'Won', value: 15000, probability: 100,
  expectedClose: '2026-10-14', source: 'Email', notes: 'Operator workflow labels must remain intact.',
})
const originalFields = JSON.stringify(fields)
const attributes = projectionModule.exports.suiteCrmAttributes({ entity: 'opportunities', fields }, 'gofixture00001')
assert.deepEqual(JSON.parse(JSON.stringify(attributes)), {
  global_id_c: 'gofixture00001', name: fields.name, account_id: 'fixture-account',
  sales_stage: 'Closed Won', amount: 15000, probability: 100, date_closed: '2026-10-14',
  lead_source: 'Email', description: fields.notes,
})
assert.equal(JSON.stringify(fields), originalFields, 'projection never rewrites app stage/status/date/amount')
assert.equal(projectionModule.exports.suiteCrmAttributes({ entity: 'opportunities', fields: { ...fields, expectedClose: null } }, 'gofixture00001').date_closed, null,
  'projection must not invent a historical closing date')

console.log(`SuiteCRM opportunity stages passed: ${cases.length} lifecycle/alias/conflict cases, ${nativeStages.values.length} pinned native enums, and exact production attribute projection without app-field mutation.`)
