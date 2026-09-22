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
  resolveQuickBooksTaxClassificationChain,
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
const catalog = parseQuickBooksTaxClassificationPage({ QueryResponse: { TaxClassification: [
  ...rootPage.QueryResponse.TaxClassification,
  ...retailChildren.QueryResponse.TaxClassification,
] } })

assert.equal(parseQuickBooksTaxClassificationPage(rootPage).length, 2)
assert.equal(parseQuickBooksTaxClassificationPage({ QueryResponse: {} }).length, 0)
assert.throws(() => parseQuickBooksTaxClassificationPage({ QueryResponse: { TaxClassification: {} } }), /response is invalid/)
assert.throws(() => parseQuickBooksTaxClassificationPage({ QueryResponse: { TaxClassification: [{ Name: 'Missing ID', Level: '1' }] } }), /record is invalid/)
assert.equal(quickBooksTaxClassificationPath(), '/quickbooks/v3/company/:realmId/taxclassification?level=1&minorversion=75')
assert.equal(quickBooksTaxClassificationPath({ allLevels: true }), '/quickbooks/v3/company/:realmId/taxclassification?minorversion=75')
assert.throws(() => quickBooksTaxClassificationPath({ allLevels: true, parentId: 'V1-00120000' }), /ambiguous/)
assert.equal(
  quickBooksTaxClassificationPath({ parentId: 'A&B', minorVersion: '75' }),
  '/quickbooks/v3/company/:realmId/taxclassification?parentId=A%26B&minorversion=75',
)

assert.equal(catalog.length, 3)
assert.equal(catalog[2].parentId, 'V1-00120000')
assert.equal(taxClassificationAppliesToItem(catalog[2], 'NonInventory'), true)
assert.equal(taxClassificationAppliesToItem(catalog[2], 'Service'), false)
assert.equal(taxClassificationAppliesToItem(catalog[1], 'Service'), true)
const fullCatalog = parseQuickBooksTaxClassificationPage({ QueryResponse: { TaxClassification: [
  ...rootPage.QueryResponse.TaxClassification,
  ...retailChildren.QueryResponse.TaxClassification,
  { Id: 'EUC-FOOD', Name: 'Food', Level: '3', ParentRef: { value: 'EUC-09040101-V1-00120000' }, ApplicableTo: ['NonInventory'] },
  { Id: 'EUC-READY', Name: 'Ready to eat', Level: '4', ParentRef: { value: 'EUC-FOOD' }, ApplicableTo: ['NonInventory'] },
] } })
assert.deepEqual(
  JSON.parse(JSON.stringify(resolveQuickBooksTaxClassificationChain(fullCatalog, 'EUC-READY')?.map((row) => row.id))),
  ['V1-00120000', 'EUC-09040101-V1-00120000', 'EUC-FOOD', 'EUC-READY'],
)
assert.equal(resolveQuickBooksTaxClassificationChain(fullCatalog, 'missing'), null)
assert.equal(resolveQuickBooksTaxClassificationChain([
  ...fullCatalog.slice(0, -1), { ...fullCatalog.at(-1), parentId: 'missing-parent' },
], 'EUC-READY'), null, 'an orphan ParentRef is rejected')
assert.equal(resolveQuickBooksTaxClassificationChain([
  ...fullCatalog.slice(0, -1), { ...fullCatalog.at(-1), parentId: 'V1-00200000' },
], 'EUC-READY'), null, 'a forged parent with an inconsistent level is rejected')
assert.equal(resolveQuickBooksTaxClassificationChain([
  { ...fullCatalog[0], parentId: 'EUC-READY' }, ...fullCatalog.slice(1),
], 'EUC-READY'), null, 'a cycle is rejected')
assert.equal(resolveQuickBooksTaxClassificationChain([
  ...fullCatalog, fullCatalog[0],
], 'EUC-READY'), null, 'duplicate provider IDs are rejected')

console.log('QuickBooks tax classification helper tests passed')
