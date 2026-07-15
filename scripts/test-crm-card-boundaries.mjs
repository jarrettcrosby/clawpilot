import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { decodeHtmlEntities } from '../app_src/lib/htmlEntities.mjs'
import { isCrmBoardCard, normalizeCrmBoardCard } from '../app_src/lib/crm/boardCard.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8')

assert.equal(decodeHtmlEntities('nick&#039;s Organization'), "nick's Organization")
assert.equal(decodeHtmlEntities('Dragan &quot;Gagi&quot; Stamenkovic'), 'Dragan "Gagi" Stamenkovic')
assert.equal(decodeHtmlEntities('Double &amp;#039; encoded'), "Double ' encoded")
assert.equal(decodeHtmlEntities('Decimal &#8217; and hex &#x27;'), "Decimal ’ and hex '")

const projected = normalizeCrmBoardCard({
  id: 'crm-card',
  entityType: 'crm-account',
  crm: { referenceCode: 'ga1910711' },
  category: 'pipeline',
  assignedAgent: 'pipeline',
  assignee: 'pipeline',
  dueDate: '2026-07-31',
  checklist: [{ id: '1', text: 'task work', done: false }],
  execution: { assignedAgent: 'pipeline' },
  workItem: { assignedAgent: 'pipeline' },
})

assert.equal(isCrmBoardCard(projected), true)
assert.equal(projected.category, 'crm')
assert.equal(projected.assignedAgent, undefined)
assert.equal(projected.assignee, undefined)
assert.equal(projected.dueDate, undefined)
assert.equal(projected.execution, undefined)
assert.equal(projected.workItem, undefined)
assert.deepEqual(projected.checklist, [])

const taskRoute = read('app_src/app/api/tasks/route.ts')
assert.match(taskRoute, /includeCrmCards/)
assert.match(taskRoute, /CRM board cards cannot be assigned to agents/)
assert.match(taskRoute, /!crmCard && isActiveColumnStatus/)

const projection = read('app_src/lib/crm/boardProjection.ts')
assert.match(projection, /normalizeCrmBoardCard/)
assert.doesNotMatch(projection, /upsertTaskWithClient/)
assert.match(projection, /card\.payload/)

const migration = read('db/migrations/0036_crm_display_text_and_card_semantics.sql')
assert.match(migration, /WHERE source = 'crm-projection'/)
assert.match(migration, /DELETE FROM agent_assignments/)
assert.match(migration, /DELETE FROM tasks/)

console.log('crm card boundary tests passed')
