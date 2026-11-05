#!/usr/bin/env node
// Sends the reviewed SELECT-only collector to the exact production service.
// SSH uses only remote credentials. The public CA/leaf certificates are read
// through authenticated SSH to the exact Postgres service, never trusted from
// the failing DB connection. No insecure public diagnostic mode exists.
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

if (process.argv.length !== 3 || process.argv[2] !== '--read-only') {
  throw new Error('Explicit --read-only is required; no apply or insecure public mode exists')
}
const {SCOPE,validateReadOnlyPostgresTrust}=createRequire(import.meta.url)('./inspect-bpo-email-recovery-readonly.cjs')
const root = fileURLToPath(new URL('../', import.meta.url))
const collector = readFileSync(new URL('./inspect-bpo-email-recovery-readonly.cjs', import.meta.url), 'utf8').replace(/^#![^\n]*\n/, '')
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'"
const sha = value => createHash('sha256').update(value).digest('hex')
const observedAt = new Date().toISOString()
let result
let stage = 'authenticated-postgres-trust'
let tlsTrust=null
try {
  const pemOutput=execFileSync('/opt/homebrew/bin/railway',[
    'ssh','-p',SCOPE.projectId,'-e',SCOPE.environmentId,'-s','Postgres','--',
    'sh -lc '+quote('openssl x509 -in /var/lib/postgresql/data/certs/root.crt -outform PEM && openssl x509 -in /var/lib/postgresql/data/certs/server.crt -outform PEM'),
  ],{cwd:root,encoding:'utf8',timeout:45000,maxBuffer:33000,stdio:['ignore','pipe','pipe']})
  const pems=pemOutput.match(/-----BEGIN CERTIFICATE-----\r?\n[A-Za-z0-9+/=\r\n]+-----END CERTIFICATE-----/g)
  if(pems?.length!==2)throw new Error('READONLY_TLS_TRUST_INVALID')
  const bundle={version:1,projectId:SCOPE.projectId,environmentId:SCOPE.environmentId,service:'Postgres',caPem:pems[0],leafPem:pems[1]}
  const trust=validateReadOnlyPostgresTrust(bundle)
  tlsTrust={leafFingerprint256:trust.leafFingerprint256,rootFingerprint256:trust.rootFingerprint256,
    serverName:trust.serverName,source:'authenticated-exact-service-ssh'}
  stage='ssh-collector'
  const stdout = execFileSync('/opt/homebrew/bin/railway', [
    'ssh', '-p', 'b5169ebd-8166-4b96-9a81-7cc8adaa9270',
    '-e', '058ce52f-1d3b-44bb-afe2-0df2bf24efb9', '-s', 'clawpilot', '--',
    'CLAWPILOT_BPO_READONLY_TLS_TRUST='+quote(JSON.stringify(bundle))+' node -e ' + quote(collector) + ' -- --read-only',
  ], { cwd: root, encoding: 'utf8', timeout: 45000, maxBuffer: 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'] })
  // Railway may prefix SSH-key selection; the collector emits one JSON object.
  result = JSON.parse(stdout.slice(stdout.indexOf('{'), stdout.lastIndexOf('}') + 1))
} catch (error) {
  // A failed collector still emits its sanitized JSON. Never echo transport
  // stderr, which is outside our output/secret-redaction contract.
  const stdout = String(error.stdout || '')
  try {
    const parsed = JSON.parse(stdout.slice(stdout.indexOf('{'), stdout.lastIndexOf('}') + 1))
    if (!parsed.failed || parsed.kind !== 'bpo-exact-email-recovery-readonly-v1') throw new Error('Unexpected result')
    result = parsed
  } catch {
    const stderr = String(error.stderr || '')
    const trustCode=['READONLY_TLS_TRUST_INVALID','READONLY_TLS_TRUST_CHANGED'].includes(error.message)?error.message:null
    result = { failed: true, errorCode: trustCode || 'READONLY_TRANSPORT_FAILED', stage, exitCode: error.status ?? null,
      diagnostic: /timed out/i.test(stderr) ? 'timeout' : /Cannot find module/i.test(stderr) ? 'module-missing'
        : /SyntaxError/.test(stderr) ? 'syntax-error' : /not found/i.test(stderr) ? 'not-found'
          : /unauthorized|not logged in/i.test(stderr) ? 'authentication-unavailable' : 'transport-unclassified',
      stdoutSha256: sha(stdout), stderrSha256: sha(String(error.stderr || '')),
      noRecoveryOrPublicationAttempted: true }
  }
}
const artifact = { observedAt, collectorSha256: sha(collector),tlsTrust, result }
const bytes = JSON.stringify(artifact, null, 2) + '\n'
const path = resolve('/Users/agentsuburbiasandwich/.codex/artifacts/clawpilot-crm-native-policy-2026-10-28',
  `bpo-exact-recovery-${observedAt.replace(/[-:.]/g, '')}-${randomUUID().slice(0, 8)}.json`)
writeFileSync(path, bytes, { flag: 'wx', mode: 0o600 })
console.log(JSON.stringify({ path, sha256: sha(bytes), failed: result.failed || false,
  errorCode: result.errorCode || null, databaseCode: result.databaseCode || null,
  inspectionStage: result.inspectionStage || null, runtimeCode: result.runtimeCode || null,
  readOnly: result.readOnly || null, rolledBack: result.rolledBack || null,
  holds: result.holds || [], messages: result.messages?.map(message => ({
    messageId: message.messageId, participantCount: message.participantEmails.length,
    contactCount: message.contactCandidates.length, holds: message.holds,
  })) || [], existingInteractions: result.interactions?.length ?? null,
  dryRunDraftAvailable: !!result.previewRequestDraft }))
if (result.failed) process.exitCode = 1
