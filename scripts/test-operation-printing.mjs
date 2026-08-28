#!/usr/bin/env node
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { existsSync, readFileSync } from 'node:fs'
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

const {
  DEFAULT_PRINT_AGENT_CAPABILITIES,
  hasConnectedLocalPrintAgent,
  LEGACY_BUNDLED_PRINT_AGENT_CAPABILITIES,
  isDocumentMediaCompatible,
  isPrinterCapabilitySetValid,
  printerCanFallbackFor,
  selectPrinterRoute,
} = loadPrinting()

assert.deepEqual(JSON.parse(JSON.stringify(DEFAULT_PRINT_AGENT_CAPABILITIES)), {
  supportedFormats: ['ZPL'],
  supportedMedia: [
    'label_2x1',
    'label_3x1',
    'label_4x2',
    'label_4x6',
    'label_4x8',
  ],
  supportedDocumentTypes: ['shipping_label', 'product_label', 'location_label'],
})
assert.deepEqual(JSON.parse(JSON.stringify(LEGACY_BUNDLED_PRINT_AGENT_CAPABILITIES)), {
  supportedFormats: ['ZPL'],
  supportedMedia: ['label_4x6'],
  supportedDocumentTypes: ['shipping_label'],
})

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
    localPrintAgentGlobalId: 'gpt1000001',
    localPrintAgentName: 'Warehouse print agent',
    localPrintAgentStatus: 'active',
    localPrintAgentLastSeenAt: '2026-07-23T12:00:00.000Z',
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
assert.equal(hasConnectedLocalPrintAgent(primary), true)
assert.equal(selectPrinterRoute([primary], labelRequest)?.printer.globalId, primary.globalId)
assert.equal(selectPrinterRoute([primary], labelRequest)?.usedFallback, false)
const configuredNeverConnected = printer({ localPrintAgentLastSeenAt: null })
assert.equal(hasConnectedLocalPrintAgent(configuredNeverConnected), false)
assert.equal(
  selectPrinterRoute([configuredNeverConnected], { ...labelRequest, durable: true }),
  null,
  'A configured printer must not accept durable work before its agent first connects',
)
assert.equal(
  selectPrinterRoute([configuredNeverConnected], { ...labelRequest, durable: false })?.printer.globalId,
  configuredNeverConnected.globalId,
  'A never-connected agent must not prevent non-durable profile preconfiguration',
)

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
assert.equal(printerCanFallbackFor(
  printer({
    supportedFormats: ['ZPL', 'PDF'],
    supportedMedia: ['label_4x6', 'label_4x8'],
  }),
  fallback,
), false)

const incompatibleFallback = printer({
  id: 'office-id',
  globalId: 'gpr1000003',
  name: 'Office printer',
  code: 'OFFICE-01',
  printerType: 'nonthermal',
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

const packingRequest = {
  warehouseId: 'warehouse-id',
  documentType: 'packing_slip',
  format: 'PDF',
  media: 'letter',
  durable: true,
}
const nonthermal = printer({
  id: 'nonthermal-id',
  globalId: 'gpr1000006',
  name: 'Packing slip printer',
  code: 'OFFICE-02',
  printerType: 'nonthermal',
  supportedFormats: ['PDF', 'PNG'],
  supportedMedia: ['letter', 'a4'],
  supportedDocumentTypes: ['packing_slip'],
  defaultDocumentTypes: ['packing_slip'],
})
assert.equal(
  selectPrinterRoute([nonthermal], packingRequest)?.printer.globalId,
  nonthermal.globalId,
)
assert.equal(
  selectPrinterRoute([
    { ...nonthermal, localPrintAgentGlobalId: null },
  ], packingRequest),
  null,
)
assert.equal(isDocumentMediaCompatible(packingRequest), true)
assert.equal(isDocumentMediaCompatible({
  ...packingRequest,
  media: 'label_4x6',
}), false)
assert.equal(isDocumentMediaCompatible({
  warehouseId: 'warehouse-id',
  documentType: 'product_label',
  format: 'ZPL',
  media: 'label_2x1',
}), true)
assert.equal(isDocumentMediaCompatible({
  warehouseId: 'warehouse-id',
  documentType: 'location_label',
  format: 'PDF',
  media: 'label_3x1',
}), false)
assert.equal(isDocumentMediaCompatible({
  ...labelRequest,
  media: 'label_2x1',
}), false)
assert.equal(isPrinterCapabilitySetValid({
  printerType: 'nonthermal',
  supportedFormats: ['PDF'],
  supportedMedia: ['letter'],
}), true)
assert.equal(isPrinterCapabilitySetValid({
  printerType: 'nonthermal',
  supportedFormats: ['ZPL'],
  supportedMedia: ['letter'],
}), false)
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

const deliveryMigration = read('db/migrations/0094_operations_print_delivery.sql')
for (const fragment of [
  'CREATE TABLE IF NOT EXISTS operations_print_agents',
  'warehouse_id uuid NOT NULL',
  'secret_hash text NOT NULL',
  'credential_version integer NOT NULL',
  'CREATE TABLE IF NOT EXISTS operations_print_artifacts',
  "document_type IN ('shipping_label', 'packing_slip')",
  "media_size IN ('label_4x6', 'label_4x8', 'letter', 'a4')",
  'CREATE TABLE IF NOT EXISTS operations_print_delivery_attempts',
  'current_claim_attempt_id',
  'claim_expires_at',
  'request_fingerprint text NOT NULL',
  'FOR EACH ROW EXECUTE FUNCTION validate_operations_print_delivery_transition',
  'local_agent_acknowledgement',
  'reprint_of_job_id',
  'reprint_reason',
  'reprint_authorized_by',
  'max_attempts',
  'available_at',
  "SET printer_type = 'nonthermal'",
  'SET supports_zpl = false',
  'primary_profile.supported_formats',
  '<@ fallback_profile.supported_formats',
]) assert.ok(
  deliveryMigration.includes(fragment),
  `Print-delivery migration missing ${fragment}`,
)

const physicalOutputMigration = read(
  'db/migrations/0338_operations_print_physical_output_attestation.sql',
)
for (const fragment of [
  'CREATE TABLE IF NOT EXISTS operations_print_physical_output_attestations',
  'delivery_attempt_id uuid NOT NULL',
  'delivery_attempt_sequence_number integer NOT NULL',
  'verified_at timestamptz NOT NULL',
  'verified_by text NOT NULL',
  'reason text NOT NULL',
  'operations_print_physical_output_pkey',
  'operations_print_physical_output_organization_fkey',
  'operations_print_physical_output_sequence_positive',
  'operations_print_physical_output_one_per_job',
  'operations_print_physical_output_idempotency_unique',
  'validate_operations_print_physical_output_attestation',
  "membership.permissions\n         @> '{\"executeWarehouse\":true}'::jsonb",
  'physical output attestation delivery version is not current',
  'protect_operations_print_physical_output_attestation_write',
  'Local print agents never write this table',
]) assert.ok(
  physicalOutputMigration.includes(fragment),
  `Physical-output migration missing ${fragment}`,
)

const physicalOutputHealth = read(
  'app_src/lib/persistence/operationsPrintPhysicalOutputHealth.ts',
)
for (const fragment of [
  '0338_operations_print_physical_output_attestation.sql',
  '2ca77442275e87d8b8ee858f974ecc861fb30b0a523ae89092c1be7ab0e4e1cd',
  'OPERATIONS_PRINT_PHYSICAL_OUTPUT_HEALTH_SQL',
  "(1, 'id', 'uuid', true, 'gen_random_uuid()'::text)",
  "(11, 'request_fingerprint', 'text', true, NULL::text)",
  'operations_print_physical_output_one_per_job',
  'pg_get_constraintdef',
  'pg_get_indexdef',
  'procedure_row.prosrc',
  '3fd4f54c7070a9c1c28082afe360d638621d45b8de7d8acc5db183d45daf30c0',
  'fd15bac1d42a06fa88bae40902eed8c3f6f4ba5756f2fce1d86199c237feed02',
  '747b8c3bd1c8cfeb41a10a068552b5964097a9a54c97e1f25abf8d34ef5fddc7',
  '022c9cb1b8acb275a4ac43a9bb239e4446d8e4d3bc7d047f36b1ee2942e1444a',
  'dcfc0393a532b05606f656ef31ff527ed31981bb314a187e14c2e571336ca787',
]) assert.ok(
  physicalOutputHealth.includes(fragment),
  `Physical-output persistence health missing ${fragment}`,
)

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
  'localPrintAgentId',
  'OPERATIONS_PRINTER_AGENT_REQUIRED',
]) assert.ok(persistence.includes(fragment), `Printer persistence missing ${fragment}`)

const delivery = read('app_src/lib/persistence/operationPrintDelivery.ts')
for (const fragment of [
  'createOperationsPrintAgentCredential',
  'hashOperationsPrintAgentSecret',
  'operationsPrintDeliveryFingerprint',
  'authenticateOperationsPrintAgentInPostgres',
  'crypto.timingSafeEqual',
  'FOR UPDATE OF job SKIP LOCKED',
  'acknowledgeOperationsPrintJobInPostgres',
  'failOperationsPrintJobInPostgres',
  'retryOperationsPrintJobInPostgres',
  'cancelOperationsPrintJobInPostgres',
  'reprintOperationsPrintJobInPostgres',
  'attestOperationsPrintJobPhysicalOutputInPostgres',
  'upgradeOperationsPrintAgentToBundledCapabilitiesInPostgres',
  'LEGACY_BUNDLED_PRINT_AGENT_CAPABILITIES',
  'operations:print-attempt:',
  'OPERATIONS_PRINT_REPRINT_LABEL_INACTIVE',
  'OPERATIONS_PRINT_RETRY_OUTCOME_UNCERTAIN',
  'isUncertainLocalAgentOutcome',
  'scheduleRetry',
  'reprint_of_job_id',
  "'operations.print_job.reprinted'",
  "'operations.print_job.physical_output_verified'",
  'expectedDeliveryAttemptSequenceNumber',
  'OPERATIONS_PRINT_PHYSICAL_OUTPUT_VERSION_CHANGED',
  'OPERATIONS_PRINT_PHYSICAL_OUTPUT_ALREADY_VERIFIED',
  'physicalOutputVerified: false',
  'OPERATIONS_PRINT_AGENT_NEVER_CONNECTED',
  'A compatible printer is configured, but its local print agent has never connected',
]) assert.ok(delivery.includes(fragment), `Print delivery persistence missing ${fragment}`)

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
  'localPrintAgentGlobalId',
  'isPrinterCapabilitySetValid',
]) assert.ok(route.includes(fragment), `Printer route missing ${fragment}`)

const agentRoute = read('app_src/app/api/operations/print-agent/jobs/route.ts')
for (const fragment of [
  'authenticateOperationsPrintAgentInPostgres',
  "command.action === 'claim'",
  "command.action === 'acknowledge'",
  'failOperationsPrintJobInPostgres',
  'leaseSeconds',
  'Idempotency-Key',
  'Cache-Control',
]) assert.ok(agentRoute.includes(fragment), `Local print-agent route missing ${fragment}`)
assert.ok(
  !agentRoute.includes('attest-physical-output'),
  'The local print-agent protocol must never expose operator physical-output attestation',
)

const jobRoute = read('app_src/app/api/operations/print-jobs/route.ts')
for (const fragment of [
  "command.action === 'retry-job'",
  "command.action === 'cancel-job'",
  "command.action === 'reprint-job'",
  "command.action === 'attest-physical-output'",
  'expectedDeliveryAttemptId',
  'expectedDeliveryAttemptSequenceNumber',
  'capabilities.canExecute',
  'requirePhysicalOutputBrowserSession',
  'requireRequestSession(req)',
  'session.authenticatedUser !== session.effectiveUser',
  'session.authenticatedUser !== actor.email',
  'OPERATIONS_PRINT_PHYSICAL_OUTPUT_BROWSER_SESSION_REQUIRED',
  'OPERATIONS_PRINT_PHYSICAL_OUTPUT_SAME_ORIGIN_REQUIRED',
  'physicalOutputReason(command.value.reason)',
  'OPERATIONS_PRINT_PHYSICAL_OUTPUT_REASON_INVALID',
  'canManage || !capabilities.canExecute',
  'Idempotency-Key',
]) assert.ok(jobRoute.includes(fragment), `Print-job route missing ${fragment}`)

const panel = read('app_src/components/operations/PrinterConfigurationPanel.tsx')
assert.ok(
  panel.includes("agent.status === 'active').length"),
  'Printing must count only active local agents in the primary Agents tab badge',
)
assert.ok(
  panel.includes("agents?.agents.filter((agent) => agent.status === 'active') || []")
    && panel.includes('activeAgents.map((agent) => ('),
  'Printing must keep revoked enrollment audit rows out of the operational agent list',
)
assert.ok(
  !panel.includes('retained below as audit history and cannot claim print jobs'),
  'Printing must not keep showing retired-agent warnings after cutover',
)
for (const fragment of [
  "thermal: 'Thermal'",
  "nonthermal: 'Nonthermal'",
  '4 x 6 label',
  'Packing slip',
  'Approved fallback',
  'Background LAN print agent',
  'Web app download / manual print',
  'Create a new profile to move a physical printer to another warehouse.',
  'One-time pairing code',
  'Authorize reprint',
  'Authorize new print',
  'Required duplicate-risk authorization reason',
  '/api/operations/print-agent/releases',
  'Download for macOS',
  'Download for Windows',
  'The computer must stay on, signed in',
  'private network IPv4 address and raw port 9100',
  'Cancel print job',
  'Retry print job',
  'does not prove physical output',
  'Confirm paper output',
  'operator attestation',
  'canVerifyPhysicalOutput',
  'physicalOutputAttestation',
  'Print job details',
  'Agent heartbeat',
  'Agent never connected',
  'Agent connected',
  'Configured',
  'No device delivery yet',
  'Last device delivery',
  'Package dimensions',
  'Document integrity',
  'Delivery history',
  'const BUNDLED_AGENT_FORMATS = DEFAULT_PRINT_AGENT_CAPABILITIES.supportedFormats',
  'const BUNDLED_AGENT_MEDIA = DEFAULT_PRINT_AGENT_CAPABILITIES.supportedMedia',
  'const BUNDLED_AGENT_DOCUMENT_TYPES = DEFAULT_PRINT_AGENT_CAPABILITIES.supportedDocumentTypes',
  'const BUNDLED_PRINTER_DEFAULT_MEDIA = LEGACY_BUNDLED_AGENT_MEDIA',
  'function agentSupportsPrinter(',
  'hasConnectedLocalPrintAgent(printer)',
  'containsAll(agent.supportedFormats, printer.supportedFormats)',
  'containsAll(agent.supportedMedia, printer.supportedMedia)',
  'containsAll(agent.supportedDocumentTypes, printer.supportedDocumentTypes)',
  'options={printerFormatOptions}',
  'options={printerMediaOptions}',
  'options={printerDocumentOptions}',
  'Bundled Zebra runtime: raw UTF-8 ZPL only',
  'Use bundled Zebra defaults',
  'Bundled Zebra raw ZPL',
  'Custom capability agent',
  'This assignment is incompatible.',
  'Only agents whose declared capabilities cover this printer are available.',
  'Enable bundled barcode printing',
  'Legacy bundled shipping only',
  'All five Zebra barcode-label sizes are included in the bundled runtime.',
  'retain the 4 x 6 carrier-label preset; select only the label sizes physically',
  'loaded and calibrated.',
  'Zebra private network IP and raw port 9100',
  'This form defines routing',
  'Print delivery method',
  'Choose one: web app download/manual print or a durable background LAN agent.',
  'System service printing is not implemented.',
]) assert.ok(panel.includes(fragment), `Printer UI missing ${fragment}`)
assert.ok(
  !panel.includes("supportedFormats: ['ZPL', 'PDF']"),
  'Bundled local-agent printer defaults must not claim PDF support',
)
assert.ok(
  panel.includes("onClick={() => setPrinterForm(editForm(printer))}"),
  'Existing printer profiles must remain editable',
)

const printAgentsRoute = read('app_src/app/api/operations/print-agents/route.ts')
for (const fragment of [
  "'upgrade-bundled-capabilities'",
  'upgradeOperationsPrintAgentToBundledCapabilitiesInPostgres',
  'idempotencyKey(req)',
]) assert.ok(
  printAgentsRoute.includes(fragment),
  `Print-agent management route missing ${fragment}`,
)

const operations = read('app_src/components/operations/OperationsSection.tsx')
assert.ok(operations.includes('value="printing"'), 'Operations navigation must expose Printing')
assert.ok(operations.includes('<PrinterConfigurationPanel />'), 'Operations must render printer configuration')
for (const fragment of [
  'data-testid="order-shipping-labels"',
  "action: 'enqueue-label'",
  "action: 'reprint-job'",
  "action: 'attest-physical-output'",
  'order-label-print-history',
  'Original',
  'Reprint',
  'Confirm physical paper output',
  'expectedDeliveryAttemptId',
  'expectedDeliveryAttemptSequenceNumber',
  'Reprint shipping label',
  'Reprints reuse this stored label document and never purchase new postage.',
  'the original carrier-label document was not imported into ClawPilot',
]) assert.ok(
  operations.includes(fragment),
  `Order workflow label printing is missing ${fragment}`,
)
const operationsPersistence = read('app_src/lib/persistence/operations.ts')
for (const fragment of [
  'labelPrintJobResult',
  'label.global_id AS source_label_global_id',
  'original.global_id AS reprint_of_job_global_id',
  'operations_print_physical_output_attestations physical_output',
  'physicalOutputAttestation: item.physical_output_verified_at',
  'labelPrintJobs: labelPrintJobResult.rows.map',
]) assert.ok(
  operationsPersistence.includes(fragment),
  `Order label print-job projection is missing ${fragment}`,
)
assert.equal(
  existsSync(resolve(root, 'app_src/lib/persistence/operationsPrintDelivery.ts')),
  false,
  'Plural print-delivery persistence must not coexist with the canonical module',
)
assert.equal(
  existsSync(resolve(root, 'app_src/app/api/operations/print-delivery/route.ts')),
  false,
  'Aggregate print-delivery route must not coexist with the canonical split protocol',
)

console.log('Operations printing configuration and delivery checks passed.')
