#!/usr/bin/env node
// Read-only verifier for actual isolated PHP publisher output. Never contacts a
// provider or upgrades isolated acceptance into a production/recovery claim.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import * as crypto from 'node:crypto'
import { lstatSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { isAbsolute, resolve } from 'node:path'

const root = fileURLToPath(new URL('../', import.meta.url))
const require = createRequire(new URL('../app_src/package.json', import.meta.url))
const ts = require('typescript')
function load(path, dependencies) {
  const module = { exports: {} }
  const source = readFileSync(resolve(root, path), 'utf8')
  const code = ts.transpileModule(source, { fileName: path, compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true,
  } }).outputText
  new Function('module', 'exports', 'require', code)(module, module.exports, name => {
    assert.ok(Object.hasOwn(dependencies, name), 'Unexpected verifier dependency')
    return dependencies[name]
  })
  return module.exports
}
function need(condition, message) { if (!condition) throw new Error(message) }
const clone = value => JSON.parse(JSON.stringify(value))

async function main() {
  const match = process.argv.length === 3 && process.argv[2].match(/^--artifact=(.+)$/)
  need(match && isAbsolute(match[1]), 'An explicit absolute native acceptance JSON artifact is required')
  const stat = lstatSync(match[1])
  need(stat.isFile() && !stat.isSymbolicLink() && stat.uid === process.getuid() && stat.size < 8 * 1024 * 1024,
    'Artifact must be a bounded regular file owned by the current user')
  const artifact = JSON.parse(readFileSync(match[1], 'utf8'))
  need(artifact.version === 1 && artifact.mode === 'remediation-candidate' && artifact.sourceVersion === '8.10.1'
    && artifact.isolatedNetwork === true && artifact.hostPorts === 0, 'Complete isolated native acceptance required')
  for (const path of ['app_src/lib/crm/nativeEmailPublication.ts', 'app_src/lib/crm/nativeEmailPublicationTransport.ts',
    'services/suitecrm/email-audience/NativeEmailPublisher.php', 'services/suitecrm/email-audience/publication-schema.sql']) {
    const absolute = resolve(root, path)
    need(artifact.candidateHashes?.[absolute] === createHash('sha256').update(readFileSync(absolute)).digest('hex'),
      'Artifact does not match the current publication candidate')
  }
  need(typeof artifact.output === 'string', 'Native output required')
  const marker = 'CLAWPILOT_NATIVE_PUBLICATION_V2_RECEIPTS='
  const lines = artifact.output.split('\n').filter(line => line.startsWith(marker))
  need(lines.length === 1, 'Exactly one actual v2 receipt handoff is required')
  const entries = JSON.parse(lines[0].slice(marker.length))
  need(Array.isArray(entries) && entries.length >= 2 && entries.length <= 25, 'Bounded actual receipt handoff required')
  const protocol = load('app_src/lib/crm/nativeEmailPublication.ts', { 'node:crypto': crypto })
  const transport = load('app_src/lib/crm/nativeEmailPublicationTransport.ts', { './nativeEmailPublication': protocol })
  let committed = 0, cancelled = 0, preparations = 0, editor = false, creates = 0, updates = 0, checks = 0
  for (const entry of entries) {
    need(entry && typeof entry === 'object' && !Array.isArray(entry)
      && Object.keys(entry).every(key => ['input', 'receipt', 'preparation'].includes(key)), 'Invalid native handoff entry')
    const request = protocol.prepareNativeEmailPublication(entry.input)
    need(request.command.version === 2, 'Only v2 receipt proof is admitted in this gate')
    const receipt = transport.verifyNativeEmailPublicationReceipt(request, entry.receipt)
    checks++
    if (receipt.state === 'committed') {
      committed++
      const owner = request.command.projection?.attributes?.assigned_user_id
      if (typeof owner === 'string' && request.command.expectedCapabilities.edit.some(id => id !== owner)) editor = true
      if (request.command.expectedRecordFingerprint === null && request.command.mode === 'publish') creates++
      if (request.command.expectedRecordFingerprint !== null && request.command.mode === 'publish') updates++
      // Cross-language valid output must not make altered authority acceptable.
      for (const mutate of [
        value => { value.version = 1 },
        value => { value.result.version = 1 },
        value => { value.result.capabilityPolicyFingerprint = '0'.repeat(64) },
        value => { value.result.principalSuiteCrmUserIds = [] },
        value => {
          const editors = value.result.expectedCapabilities.edit
          value.result.expectedCapabilities.edit = editors.length ? editors.slice(1) : [request.allowedReaderSuiteCrmUserIds[0]]
        },
        value => { value.commandHash = '0'.repeat(64) },
      ]) {
        const changed = clone(entry.receipt); mutate(changed)
        need(JSON.stringify(changed) !== JSON.stringify(entry.receipt), 'Negative control must change the native evidence')
        let rejected = false
        try { transport.verifyNativeEmailPublicationReceipt(request, changed) } catch { rejected = true }
        need(rejected, 'Altered native permission evidence was accepted'); checks++
      }
    } else cancelled++
    if (entry.preparation) {
      await transport.verifyNativeEmailPreparation(request.command, async () => entry.preparation)
      preparations++; checks++
    }
  }
  need(committed > 0 && cancelled > 0 && editor && creates > 0 && updates > 0 && preparations > 0,
    'Actual create/update, preserved editor, preparation and cancellation proof required')
  console.log(`PASS ${checks} actual native/TypeScript publication receipt checks (${committed} committed, ${cancelled} cancelled, ${preparations} preparations); isolated proof only`)
}

main().catch(() => {
  // Never print private native projections, fixture bodies or assertion diffs.
  console.error('FAIL native/TypeScript publication receipt verification; artifact may be incomplete, stale or incompatible')
  process.exitCode = 1
})
