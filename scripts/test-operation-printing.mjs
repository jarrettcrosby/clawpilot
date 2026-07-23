#!/usr/bin/env node
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import vm from 'node:vm'

const root = process.cwd()
const nodeRequire = createRequire(import.meta.url)
const requireFromApp = createRequire(new URL('../app_src/package.json', import.meta.url))
const ts = requireFromApp('typescript')

function read(path) {
  return readFileSync(resolve(root, path), 'utf8')
}

function loadPrinting() {
  const path = 'app_src/lib/operations/printing.ts'
  const output = ts.transpileModule(read(path), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
    fileName: path,
  }).outputText
  const module = { exports: {} }
  vm.runInNewContext(output, {
    Array,
    Error,
    Map,
    Set,
    console,
    exports: module.exports,
    module,
    require: nodeRequire,
  }, { filename: path })
  return module.exports
}

const { selectPrinterRoute } = loadPrinting()

function printer(overrides = {}) {
  return {
    id: 'printer-id',
    globalId: 'gpr1000001',
    warehouseId: 'warehouse-id',
    warehouseGlobalId: 'gwh1000001',
    warehouseName: 'Delaware fulfillment center',
    code: 'PACK-01',
    name: 'Pack station thermal printer',
    stationType: 'pack',
    printerType: 'thermal',
    connectionMode: 'local_agent',
    supportedFormats: ['ZPL'],
    supportedMedia: ['label_4x6'],
    supportedDocumentTypes: ['shipping_label'],
    defaultDocumentTypes: ['shipping_label'],
    fallbackPrinterGlobalId: null,
    fallbackPrinterName: null,
    priority: 10,
    status: 'online',
    rowVersion: 1,
    lastSeenAt: null,
    updatedAt: '2026-07-23T12:00:00.000Z',
    ...overrides,
  }
}

const labelRequest = {
  warehouseId: 'warehouse-id',
  documentType: 'shipping_label',
  format: 'ZPL',
  media: 'label_4x6',
}

const primary = printer()
assert.equal(selectPrinterRoute([primary], labelRequest)?.printer.globalId, primary.globalId)
assert.equal(selectPrinterRoute([primary], labelRequest)?.usedFallback, false)

const fallback = printer({
  id: 'fallback-id',
  globalId: 'gpr1000002',
  name: 'Shipping fallback printer',
  code: 'SHIP-02',
  defaultDocumentTypes: [],
  priority: 20,
})
const offlinePrimary = printer({
  status: 'offline',
  fallbackPrinterGlobalId: fallback.globalId,
  fallbackPrinterName: fallback.name,
})
const fallbackSelection = selectPrinterRoute([offlinePrimary, fallback], labelRequest)
assert.equal(fallbackSelection?.printer.globalId, fallback.globalId)
assert.equal(fallbackSelection?.usedFallback, true)
assert.match(fallbackSelection?.reason || '', /offline/)

const incompatibleFallback = printer({
  id: 'office-id',
  globalId: 'gpr1000003',
  name: 'Office printer',
  code: 'OFFICE-01',
  printerType: 'office',
  supportedFormats: ['PDF'],
  supportedMedia: ['letter'],
  supportedDocumentTypes: ['packing_slip'],
  defaultDocumentTypes: [],
  priority: 1,
})
const compatibleCandidate = printer({
  id: 'candidate-id',
  globalId: 'gpr1000004',
  name: 'Compatible shipping printer',
  code: 'SHIP-04',
  defaultDocumentTypes: [],
  priority: 30,
})
const compatibilitySelection = selectPrinterRoute([
  printer({
    status: 'offline',
    fallbackPrinterGlobalId: incompatibleFallback.globalId,
  }),
  incompatibleFallback,
  compatibleCandidate,
], labelRequest)
assert.equal(compatibilitySelection?.printer.globalId, compatibleCandidate.globalId)
assert.equal(compatibilitySelection?.usedFallback, false)

assert.equal(selectPrinterRoute([
  printer({ status: 'disabled' }),
  printer({
    globalId: 'gpr1000005',
    status: 'offline',
    defaultDocumentTypes: [],
  }),
], labelRequest), null)

const migration = read('db/migrations/0091_operations_printer_configuration.sql')
for (const fragment of [
  'printer_type text NOT NULL',
  'connection_mode text NOT NULL',
  'supported_formats text[] NOT NULL',
  'supported_media text[] NOT NULL',
  'supported_document_types text[] NOT NULL',
  'default_document_types text[] NOT NULL',
  'fallback_printer_id uuid',
  'operations_printers_fallback_fkey',
  'operations_printers_defaults_supported',
  'enforce_operations_printer_warehouse',
  'operations printer warehouse is immutable',
  'operations printer fallback must belong to the same warehouse',
  'idx_operations_printers_routing',
  'browser printing remains best effort',
]) assert.ok(migration.includes(fragment), `Printer migration missing ${fragment}`)

const persistence = read('app_src/lib/persistence/operationPrinting.ts')
for (const fragment of [
  'readOperationsPrinterWorkspaceFromPostgres',
  'saveOperationsPrinterInPostgres',
  'acquireTransactionAdvisoryLock',
  'expectedRowVersion',
  'OPERATIONS_PRINTER_WAREHOUSE_IMMUTABLE',
  'Fallback printer must belong to the same warehouse',
  'removeConflictingDefaults',
  "'operations.printer.created'",
  "'operations.printer.updated'",
]) assert.ok(persistence.includes(fragment), `Printer persistence missing ${fragment}`)

const route = read('app_src/app/api/operations/printers/route.ts')
for (const fragment of [
  'requireRequestUser',
  'activeOperationsOrganizationId',
  'operationsCapabilities',
  'OPERATIONS_POSTGRES_REQUIRED',
  'Cache-Control',
  'private, no-store',
  'MAX_REQUEST_BYTES',
  'expectedRowVersion',
]) assert.ok(route.includes(fragment), `Printer route missing ${fragment}`)

const panel = read('app_src/components/operations/PrinterConfigurationPanel.tsx')
for (const fragment of [
  "thermal: 'Thermal'",
  "office: 'Office'",
  '4 x 6 label',
  'Packing slip',
  'Fallback printer',
  'Local print agent',
  'Browser download',
  'Create a new profile to move a physical printer to another warehouse.',
  'reliable printing requires an enrolled local agent',
]) assert.ok(panel.includes(fragment), `Printer UI missing ${fragment}`)

const operations = read('app_src/components/operations/OperationsSection.tsx')
assert.ok(operations.includes('value="printing"'), 'Operations navigation must expose Printing')
assert.ok(operations.includes('<PrinterConfigurationPanel />'), 'Operations must render printer configuration')

console.log('Operations printer routing and configuration checks passed.')
