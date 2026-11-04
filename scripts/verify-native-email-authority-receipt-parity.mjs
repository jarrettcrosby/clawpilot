#!/usr/bin/env node
// Read-only cross-language check of actual isolated native authority receipts.
// This is not a live permission change or a simultaneous two-database proof.
import assert from 'node:assert/strict'
import * as crypto from 'node:crypto'
import { lstatSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { isAbsolute, resolve } from 'node:path'

const root = fileURLToPath(new URL('../', import.meta.url))
const require = createRequire(new URL('../app_src/package.json', import.meta.url))
const ts = require('typescript')
const clone = value => JSON.parse(JSON.stringify(value))
function need(value, message) { if (!value) throw new Error(message) }
function load(path, dependencies) {
  const module = { exports: {} }
  const code = ts.transpileModule(readFileSync(resolve(root, path), 'utf8'), { fileName: path,
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText
  new Function('module', 'exports', 'require', code)(module, module.exports, name => {
    assert.ok(Object.hasOwn(dependencies, name), 'Unexpected verifier dependency')
    return dependencies[name]
  })
  return module.exports
}
function main() {
  const match = process.argv.length === 3 && process.argv[2].match(/^--artifact=(.+)$/)
  need(match && isAbsolute(match[1]), 'Explicit absolute native acceptance artifact required')
  const stat = lstatSync(match[1])
  need(stat.isFile() && !stat.isSymbolicLink() && stat.uid === process.getuid() && stat.size < 8 * 1024 * 1024,
    'Bounded owned regular artifact required')
  const artifact = JSON.parse(readFileSync(match[1], 'utf8'))
  need(artifact.version === 1 && artifact.mode === 'remediation-candidate' && artifact.sourceVersion === '8.10.1'
    && artifact.isolatedNetwork === true && artifact.hostPorts === 0, 'Complete isolated native acceptance required')
  for (const path of ['app_src/lib/crm/nativeEmailAuthorityTransition.ts', 'app_src/lib/crm/nativeEmailPublication.ts',
    'app_src/lib/crm/nativeEmailCapabilityContract.ts', 'services/suitecrm/email-audience/NativeEmailAuthorityContract.php',
    'services/suitecrm/email-audience/NativeEmailAuthorityTransition.php', 'services/suitecrm/email-audience/authority-transition-schema.sql']) {
    const absolute = resolve(root, path)
    need(artifact.candidateHashes?.[absolute] === crypto.createHash('sha256').update(readFileSync(absolute)).digest('hex'),
      'Artifact must match current authority candidate')
  }
  const marker = 'CLAWPILOT_NATIVE_AUTHORITY_V2_RECEIPTS='
  need(typeof artifact.output === 'string', 'Native output required')
  const lines = artifact.output.split('\n').filter(line => line.startsWith(marker))
  need(lines.length === 1, 'Exactly one actual authority receipt handoff required')
  const entries = JSON.parse(lines[0].slice(marker.length))
  need(Array.isArray(entries) && entries.length >= 2 && entries.length <= 30, 'Bounded receipt handoff required')
  const publication = load('app_src/lib/crm/nativeEmailPublication.ts', { 'node:crypto': crypto })
  const audience = load('app_src/lib/crm/suiteCrmNativeEmailProjection.ts', { 'node:crypto': crypto })
  const capability = load('app_src/lib/crm/nativeEmailCapabilityContract.ts', {
    'node:crypto': crypto, './nativeEmailPublication': publication,
  })
  const authority = load('app_src/lib/crm/nativeEmailAuthorityTransition.ts', {
    './nativeEmailPublication': publication, './suiteCrmNativeEmailProjection': audience,
    './nativeEmailCapabilityContract': capability,
  })
  let checks = 0, revoked = 0, granted = 0, cancelled = 0, replays = 0, explicitPolicy = false
  const committed = new Map()
  for (const entry of entries) {
    need(entry && typeof entry === 'object' && !Array.isArray(entry)
      && JSON.stringify(Object.keys(entry).sort()) === JSON.stringify(['command', 'receipt']), 'Exact handoff shape required')
    const request = authority.prepareNativeEmailAuthorityCommand(entry.command)
    need(request.command.version === 2, 'Explicit v2 authority evidence required')
    const receipt = authority.verifyNativeEmailAuthorityReceipt(request, entry.receipt); checks++
    if (receipt.replayed) replays++
    if (receipt.state === 'cancelled') cancelled++
    else if (receipt.phase === 'revoke') revoked++
    else granted++
    if (receipt.state === 'committed') {
      const command = request.command
      if (command.bindings.some(pair => pair.before.capability_policy_json !== null)) explicitPolicy = true
      const key = `${command.transitionId}:${command.phase}`
      need(!committed.has(key) || publication.nativeEmailDigest(committed.get(key)) === request.commandHash,
        'Conflicting commands in actual handoff')
      committed.set(key, command)
    }
    const mutations = [
      value => { value.version = 1 },
      value => { value.commandHash = '0'.repeat(64) },
      value => { value.phase = value.phase === 'revoke' ? 'grant' : 'revoke' },
      value => { value.transitionId = '0'.repeat(64) },
    ]
    if (receipt.state === 'committed') mutations.push(
      value => { value.result.generationTo++ },
      value => { value.result.afterBindingsFingerprint = '0'.repeat(64) },
      value => { value.result.beforePolicyFingerprint = '0'.repeat(64) },
      value => { value.result.capabilitiesFingerprint = '0'.repeat(64) },
    )
    for (const mutate of mutations) {
      const changed = clone(entry.receipt); mutate(changed)
      need(JSON.stringify(changed) !== JSON.stringify(entry.receipt), 'Negative control must change evidence')
      let rejected = false
      try { authority.verifyNativeEmailAuthorityReceipt(request, changed) } catch { rejected = true }
      need(rejected, 'Altered native authority evidence accepted'); checks++
    }
  }
  let chained = false
  for (const grant of committed.values()) {
    if (grant.phase !== 'grant') continue
    const revoke = committed.get(`${grant.transitionId}:revoke`)
    if (!revoke) continue
    need(revoke.generationTo === grant.generationFrom && revoke.afterPolicyFingerprint === grant.beforePolicyFingerprint
      && revoke.afterBindingsFingerprint === grant.beforeBindingsFingerprint
      && revoke.desiredAppChangeHash === grant.desiredAppChangeHash
      && publication.nativeEmailDigest(revoke.bindings.map(pair => pair.after))
        === publication.nativeEmailDigest(grant.bindings.map(pair => pair.before))
      && publication.nativeEmailDigest(revoke.capabilities.map(entry => ({ emailId: entry.emailId, globalId: entry.globalId,
        pipelineId: entry.pipelineId, matrix: entry.after })))
        === publication.nativeEmailDigest(grant.capabilities.map(entry => ({ emailId: entry.emailId, globalId: entry.globalId,
          pipelineId: entry.pipelineId, matrix: entry.before }))), 'Actual phase chain differs')
    chained = true; checks++
  }
  need(revoked > 0 && granted > 0 && cancelled > 0 && replays > 0 && explicitPolicy && chained,
    'Actual revoke, grant, cancellation and historical replay proof required')
  console.log(`PASS ${checks} actual native/TypeScript authority receipt checks (${revoked} revoke, ${granted} grant, ${cancelled} cancelled, ${replays} replay); isolated proof only`)
}
try { main() } catch {
  // Never print private native identities, proof material or assertion diffs.
  console.error('FAIL native/TypeScript authority receipt verification; artifact may be incomplete, stale or incompatible')
  process.exitCode = 1
}
