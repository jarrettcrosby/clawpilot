#!/usr/bin/env node
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const requireFromApp = createRequire(new URL('../app_src/package.json', import.meta.url))
const ts = requireFromApp('typescript')
const sourcePath = fileURLToPath(new URL('../app_src/lib/integrations/quickBooksTaxClassifications.ts', import.meta.url))
const source = readFileSync(sourcePath, 'utf8')
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  fileName: sourcePath,
}).outputText
const module = { exports: {} }
vm.runInNewContext(compiled, { module, exports: module.exports, URLSearchParams, Set, Number, Error }, { filename: sourcePath })
const {
  parseQuickBooksTaxClassificationPage,
  quickBooksTaxClassificationPath,
  readQuickBooksTaxClassifications,
  taxClassificationAppliesToItem,
} = module.exports

const rootPage = {
  QueryResponse: {
    TaxClassification: [
      { Id: 'V1-00120000', Code: 'V1-00120000', Name: 'Retail', Level: '1', ApplicableTo: ['Inventory', 'NonInventory', 'Service'] },
      { Id: 'V1-00200000', Name: 'Sales of Software', Level: '1', ApplicableTo: 'Service' },
    ],
  },
}
const retailChildren = {
  QueryResponse: {
    TaxClassification: [{
      Id: 'EUC-09040101-V1-00120000', Code: 'EUC-09040101',
      Name: 'School and educational instructional materials',
      Description: 'School supplies - Educational instructional materials',
      Level: '2', ParentRef: { value: 'V1-00120000', name: 'Retail' },
      ApplicableTo: ['Inventory', 'NonInventory'],
    }],
  },
}

assert.equal(parseQuickBooksTaxClassificationPage(rootPage).length, 2)
assert.equal(parseQuickBooksTaxClassificationPage({ QueryResponse: {} }).length, 0)
assert.throws(() => parseQuickBooksTaxClassificationPage({ QueryResponse: { TaxClassification: {} } }), /response is invalid/)
assert.throws(() => parseQuickBooksTaxClassificationPage({ QueryResponse: { TaxClassification: [{ Name: 'Missing ID', Level: '1' }] } }), /record is invalid/)
assert.equal(quickBooksTaxClassificationPath(), '/quickbooks/v3/company/:realmId/taxclassification?level=1&minorversion=75')
assert.equal(
  quickBooksTaxClassificationPath({ parentId: 'A&B', minorVersion: '75' }),
  '/quickbooks/v3/company/:realmId/taxclassification?parentId=A%26B&minorversion=75',
)

const requested = []
const catalog = await readQuickBooksTaxClassifications(async (path) => {
  requested.push(path)
  if (path.includes('level=1')) return rootPage
  if (path.includes('parentId=V1-00120000')) return retailChildren
  return { QueryResponse: {} }
})
assert.equal(catalog.length, 3)
assert.equal(requested.length, 3, 'only the two documented levels are read')
assert.equal(catalog[2].parentId, 'V1-00120000')
assert.equal(taxClassificationAppliesToItem(catalog[2], 'NonInventory'), true)
assert.equal(taxClassificationAppliesToItem(catalog[2], 'Service'), false)
assert.equal(taxClassificationAppliesToItem(catalog[1], 'Service'), true)
await assert.rejects(
  () => readQuickBooksTaxClassifications(async () => rootPage, { maxRecords: 1 }),
  /exceeded the supported size/,
)
await assert.rejects(
  () => readQuickBooksTaxClassifications(async (path) => path.includes('level=1')
    ? rootPage
    : { QueryResponse: { TaxClassification: [{ ...retailChildren.QueryResponse.TaxClassification[0], ParentRef: { value: 'wrong' } }] } }),
  /parent is inconsistent/,
)

console.log('QuickBooks tax classification helper tests passed')
