import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import vm from 'node:vm'

const requireApp = createRequire(new URL('../../app_src/package.json', import.meta.url))
const ts = requireApp('typescript')

// Actual production reader declarations, not a second implementation of SQL.
export function loadInteractionCompanyReader(runQuery) {
  const filename = 'app_src/lib/persistence/crm.ts'
  const source = readFileSync(new URL(`../../${filename}`, import.meta.url), 'utf8')
  const ast = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true)
  const names = ['clean', 'nullable', 'activeCrmRecordSql', 'interactionFromRow',
    'hydrateInteractionRows', 'hydrateInteractionRowsWithPool', 'listCrmRecordsInPostgres']
  const declarations = names.map((name) => {
    const node = ast.statements.find((entry) => ts.isFunctionDeclaration(entry) && entry.name?.text === name && entry.body)
    assert.ok(node, `Production reader ${name} must exist`)
    return node.getText(ast).replace(/^export\s+/u, '')
  }).join('\n')
  const compiled = ts.transpileModule(declarations, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText
  const context = { query: runQuery, crmReferenceShortUrl: () => null }
  vm.runInNewContext(`${compiled}\nglobalThis.reader = { interactionFromRow, hydrateInteractionRows, listCrmRecordsInPostgres }`, context, { filename })
  return context.reader
}
