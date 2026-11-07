#!/usr/bin/env node
// Sends the reviewed SELECT-only collector to the exact production service.
// SSH uses only remote credentials. The public CA/leaf certificates are read
// through authenticated SSH to the exact Postgres service, never trusted from
// the failing DB connection. No insecure public diagnostic mode exists.
import { execFileSync } from 'node:child_process'
import { lstatSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { isAbsolute, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const DEFAULT_RAILWAY_BINARY='/opt/homebrew/bin/railway'
const RAILWAY_HASH=/^[a-f0-9]{64}(?![\s\S])/u
function readOnlyOptions(args) {
  const options={},seen=new Set()
  for(const argument of args){
    const match=typeof argument==='string'&&/^(--read-only|--railway-binary|--railway-sha256)(?:=(.*))?$/u.exec(argument)
    if(!match||seen.has(match[1])||(match[1]==='--read-only'?match[2]!==undefined:!match[2])) {
      throw new Error('Explicit --read-only and an optional paired --railway-binary=/absolute/file --railway-sha256=SHA256 are required; no apply or insecure public mode exists')
    }
    seen.add(match[1]);options[match[1]]=match[2]
  }
  const explicit=seen.has('--railway-binary')
  if(!seen.has('--read-only')||explicit!==seen.has('--railway-sha256')
    ||(explicit&&(!isAbsolute(options['--railway-binary'])||options['--railway-binary'].length>4096
      ||/\p{Cc}/u.test(options['--railway-binary'])||!RAILWAY_HASH.test(options['--railway-sha256'])))) {
    throw new Error('Explicit --read-only and an optional paired --railway-binary=/absolute/file --railway-sha256=SHA256 are required; no apply or insecure public mode exists')
  }
  return {binary:explicit?options['--railway-binary']:DEFAULT_RAILWAY_BINARY,sha256:explicit?options['--railway-sha256']:null,explicit}
}
function verifiedRailwayBinary(selection) {
  try {
    const binary=realpathSync(selection.binary),stat=lstatSync(binary)
    // Preserve the existing Homebrew symlink default. An explicit reviewed
    // binary cannot be a symlink or contain a symlinked path component.
    if((selection.explicit&&(binary!==selection.binary||lstatSync(selection.binary).isSymbolicLink()))
      ||!stat.isFile()||stat.isSymbolicLink()||(stat.mode&0o022)!==0||(stat.mode&0o111)===0
      ||![0,process.getuid()].includes(stat.uid)||stat.size<=0||stat.size>268435456) {
      throw new Error('READONLY_RAILWAY_BINARY_INVALID')
    }
    const digest=createHash('sha256').update(readFileSync(binary)).digest('hex')
    if(selection.sha256&&digest!==selection.sha256)throw new Error('READONLY_RAILWAY_BINARY_CHANGED')
    return {binary,sha256:digest,explicit:selection.explicit}
  } catch(error) {
    if(error.message==='READONLY_RAILWAY_BINARY_CHANGED')throw error
    throw new Error('READONLY_RAILWAY_BINARY_INVALID')
  }
}
const railwayOptions=readOnlyOptions(process.argv.slice(2))
const {SCOPE,validateReadOnlyPostgresTrust}=createRequire(import.meta.url)('./inspect-bpo-email-recovery-readonly.cjs')
const root = fileURLToPath(new URL('../', import.meta.url))
const collector = readFileSync(new URL('./inspect-bpo-email-recovery-readonly.cjs', import.meta.url), 'utf8').replace(/^#![^\n]*\n/, '')
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'"
const sha = value => createHash('sha256').update(value).digest('hex')
const observedAt = new Date().toISOString()
let result
let stage = 'railway-binary-validation'
let tlsTrust=null
let railwayCli={binary:railwayOptions.binary,sha256:railwayOptions.sha256,
  selection:railwayOptions.explicit?'explicit-hash-pin':'observed-default'}
try {
  const railway=verifiedRailwayBinary(railwayOptions)
  railwayCli={binary:railway.binary,sha256:railway.sha256,selection:railwayOptions.explicit?'explicit-hash-pin':'observed-default'}
  stage='authenticated-postgres-trust'
  verifiedRailwayBinary(railway)
  const pemOutput=execFileSync(railway.binary,[
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
  verifiedRailwayBinary(railway)
  const stdout = execFileSync(railway.binary, [
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
    const trustCode=['READONLY_TLS_TRUST_INVALID','READONLY_TLS_TRUST_CHANGED',
      'READONLY_RAILWAY_BINARY_INVALID','READONLY_RAILWAY_BINARY_CHANGED'].includes(error.message)?error.message:null
    result = { failed: true, errorCode: trustCode || 'READONLY_TRANSPORT_FAILED', stage, exitCode: error.status ?? null,
      diagnostic: trustCode?.startsWith('READONLY_RAILWAY_')?'railway-binary-guard'
        : /timed out/i.test(stderr) ? 'timeout' : /Cannot find module/i.test(stderr) ? 'module-missing'
        : /SyntaxError/.test(stderr) ? 'syntax-error' : /not found/i.test(stderr) ? 'not-found'
          : /unauthorized|not logged in/i.test(stderr) ? 'authentication-unavailable' : 'transport-unclassified',
      stdoutSha256: sha(stdout), stderrSha256: sha(String(error.stderr || '')),
      noRecoveryOrPublicationAttempted: true }
  }
}
const artifact = { observedAt, collectorSha256: sha(collector),railwayCli,tlsTrust, result }
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
