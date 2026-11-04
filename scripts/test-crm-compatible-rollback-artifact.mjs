#!/usr/bin/env node
// Local synthetic Git repositories only. No builds, providers or databases.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { buildRollbackArtifact, canonicalJson, committedRollbackIdentity, inspectRollbackSources,
  LEGACY_WRITER_COMMIT, REQUIRED_ROLLING_CHECKS, ROLLBACK_ACCEPTANCE_FORMAT, ROLLBACK_BUILD_FORMAT,
  ROLLBACK_PROTECTED_PATHS, rollbackReceiptSource, sha256, validateRollbackReceipts,
  verifyRollbackArtifact } from './lib/crm-compatible-rollback-artifact.mjs'

const temporary = mkdtempSync(join(tmpdir(), 'clawpilot-rollback-artifact-test-'))
const repository = join(temporary, 'repository')
mkdirSync(repository)
const git = args => execFileSync('git', ['-C', repository, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
let checks = 0
const check = (label, fn) => { fn(); checks += 1 }
try {
  git(['init', '--quiet'])
  git(['config', 'user.name', 'Synthetic artifact test'])
  git(['config', 'user.email', 'artifact@example.test'])
  const sources = Object.fromEntries(ROLLBACK_PROTECTED_PATHS.map(path => [path, '// synthetic protected source\n']))
  sources['db/migrations/0374_crm_interaction_organizations.sql'] =
    "-- synthetic crm_interaction_organizations clawpilot.crm_shared_write_v1\nCREATE TRIGGER synthetic;\n"
  sources['app_src/lib/persistence/crm.ts'] = [
    'clawpilot.crm_shared_write_v1', 'REVIEWED_GMAIL_RELATIONSHIPS',
    'Reviewed interaction contacts must be preserved', 'Reviewed interaction organizations must be preserved',
    'Reviewed interaction provider identity and parent context must be preserved',
  ].join('\n')
  sources['app_src/lib/crm/emailIngestion.ts'] = 'expectedTargetFingerprint\n'
  sources['app_src/lib/crm/suiteCrmClient.ts'] = 'record.relationships\n'
  sources['scripts/production-rebind-history-schema-attestation.mjs'] = `
    const PRODUCTION_REBIND_HISTORY_SCHEMA_ATTESTATION_FORMAT = 'clawpilot-production-rebind-target-schema-attestation-v18';
    const manifest = [${ROLLBACK_PROTECTED_PATHS.filter(path=>path.startsWith('db/migrations/')).map(path=>`{filename: '${path.split('/').at(-1)}', checksum: '${sha256(sources[path])}'}`).join(',')}];
    const EXPECTED_SCHEMA_DIGEST_BY_POSTGRES_MAJOR = Object.freeze({16: '${'1'.repeat(64)}', 18: '${'2'.repeat(64)}'});
    if (inspection.schemaDigest !== expectedDigest) throw new Error('strict');
  `
  for (const [path, content] of Object.entries({ ...sources, '.env.example': 'PUBLIC_TEMPLATE_ONLY=1\n',
    'data/README.md': 'No runtime data in source artifact\n', 'data-dev/README.md': 'No runtime data\n' })) {
    mkdirSync(dirname(join(repository, path)), { recursive: true })
    writeFileSync(join(repository, path), content)
  }
  git(['add', '.']); git(['commit', '--quiet', '-m', 'Synthetic compatible floor'])
  const commit = git(['rev-parse', 'HEAD']).trim()
  const identity = committedRollbackIdentity(repository, commit)
  const acceptance = { format: ROLLBACK_ACCEPTANCE_FORMAT, status: 'passed', source: rollbackReceiptSource(identity),
    legacyWriterCommit: LEGACY_WRITER_COMMIT, postgresMajor: 16, checks: [...REQUIRED_ROLLING_CHECKS] }
  const build = { format: ROLLBACK_BUILD_FORMAT, status: 'passed', source: rollbackReceiptSource(identity),
    command: ['npm', 'run', 'build'], nodeVersion: 'v24.19.0', environmentMode: 'isolated-committed-source-no-provider-credentials',
    outputFiles: Object.fromEntries(['app_src/.next/BUILD_ID', 'app_src/.next/build-manifest.json', 'app_src/.next/routes-manifest.json']
      .map(path => [path, '3'.repeat(64)])) }
  const acceptanceFile = join(temporary, 'acceptance.json'), buildFile = join(temporary, 'build.json')
  writeFileSync(acceptanceFile, canonicalJson(acceptance)); writeFileSync(buildFile, canonicalJson(build))
  const create = output => buildRollbackArtifact({ repository, commit, outputDirectory: join(temporary, output), acceptanceFile, buildFile })
  check('exact source/migration/strict attestation descriptors', () => {
    assert.deepEqual(inspectRollbackSources(path => sources[path]).protectedFiles, identity.protectedFiles)
    assert.ok(!identity.sourceTree.some(entry => entry.path.startsWith('data/') || entry.path.startsWith('.env')))
  })
  check('historical v9/v10/v11/v12/v13/v14/v15/v16/v17 metadata cannot certify a current rollback floor',()=>{
    for(const oldVersion of ['v9','v10','v11','v12','v13','v14','v15','v16','v17']) assert.throws(()=>inspectRollbackSources(path=>path==='scripts/production-rebind-history-schema-attestation.mjs'
      ?sources[path].replace('schema-attestation-v18',`schema-attestation-${oldVersion}`):sources[path]))
  })
  check('later authority migration source must match the exact enrolled checksum',()=>{
    for(const filename of ['0399_crm_native_email_initial_replan_lineage.sql','0400_crm_native_email_demo_quarantine.sql','0401_crm_native_root_owner_source_fence.sql','0402_crm_native_unmanaged_app_only_pipelines.sql']){
      assert.throws(()=>inspectRollbackSources(path=>path===`db/migrations/${filename}`
        ?sources[path]+'-- changed fixture migration\n':sources[path]),/retain and attest/)
    }
  })
  check('omitting later authority migration enrollment cannot certify',()=>{
    for(const filename of ['0399_crm_native_email_initial_replan_lineage.sql','0400_crm_native_email_demo_quarantine.sql','0401_crm_native_root_owner_source_fence.sql','0402_crm_native_unmanaged_app_only_pipelines.sql']){
      assert.throws(()=>inspectRollbackSources(path=>path==='scripts/production-rebind-history-schema-attestation.mjs'
        ?sources[path].replace(filename,'omitted_fixture.sql'):sources[path]),/retain and attest/)
    }
  })
  check('different source or failed proof cannot certify', () => {
    assert.throws(() => validateRollbackReceipts(identity, { ...acceptance, status: 'failed' }, build))
    assert.throws(() => validateRollbackReceipts(identity, { ...acceptance, source: { ...acceptance.source, tree: '0'.repeat(40) } }, build))
    assert.throws(() => validateRollbackReceipts(identity, { ...acceptance, checks: acceptance.checks.slice(1) }, build))
    assert.throws(() => validateRollbackReceipts(identity, acceptance, { ...build, nodeVersion: 'v18.0.0' }))
  })
  check('short/implicit commit refused', () => assert.throws(() => committedRollbackIdentity(repository, 'HEAD')))
  check('dirty source refused', () => {
    const path = join(repository, 'uncommitted.txt')
    writeFileSync(path, 'synthetic')
    assert.throws(() => committedRollbackIdentity(repository, commit), /clean committed worktree/)
    rmSync(path)
  })
  const first = create('artifact-one'), second = create('artifact-two')
  check('same commit and receipts yield byte-identical artifact/manifest', () => assert.deepEqual(
    [first.manifestSha256, first.archiveSha256], [second.manifestSha256, second.archiveSha256]))
  check('trusted manifest digest verifies without source checkout', () => {
    assert.equal(verifyRollbackArtifact({ directory: first.directory, expectedManifestSha256: first.manifestSha256 }).commit, commit)
    assert.throws(() => verifyRollbackArtifact({ directory: first.directory, expectedManifestSha256: '0'.repeat(64) }))
  })
  check('prior artifact never overwritten', () => assert.throws(() => create('artifact-one'), /never overwrite/))
  check('tampered archive rejected', () => {
    chmodSync(join(first.directory, 'source.tar'), 0o600)
    appendFileSync(join(first.directory, 'source.tar'), 'tampered')
    assert.throws(() => verifyRollbackArtifact({ directory: first.directory, expectedManifestSha256: first.manifestSha256 }), /archive has changed/)
  })
  check('tampered manifest rejected even with valid archive', () => {
    const path = join(second.directory, 'manifest.json')
    const manifest = JSON.parse(readFileSync(path))
    manifest.commit = '0'.repeat(40)
    chmodSync(path, 0o600); writeFileSync(path, canonicalJson(manifest))
    assert.throws(() => verifyRollbackArtifact({ directory: second.directory, expectedManifestSha256: second.manifestSha256 }), /manifest differs/)
  })
  check('symlink source rejected', () => {
    symlinkSync('/tmp', join(repository, 'unsafe-link'))
    git(['add', 'unsafe-link']); git(['commit', '--quiet', '-m', 'Synthetic unsafe symlink'])
    assert.throws(() => committedRollbackIdentity(repository, git(['rev-parse', 'HEAD']).trim()), /regular files/)
    git(['rm', '--quiet', 'unsafe-link']); git(['commit', '--quiet', '-m', 'Remove synthetic link'])
  })
  check('tracked real env filename rejected', () => {
    writeFileSync(join(repository, '.env.production'), 'SYNTHETIC_ONLY=1\n')
    git(['add', '.env.production']); git(['commit', '--quiet', '-m', 'Synthetic forbidden env path'])
    assert.throws(() => committedRollbackIdentity(repository, git(['rev-parse', 'HEAD']).trim()), /Runtime\/secret path/)
  })
  console.log(`PASS ${checks} compatible rollback artifact checks; synthetic local Git only, no build/runtime certification`)
} finally {
  // Exact newly allocated synthetic fixture/artifact directory only.
  rmSync(temporary, { recursive: true })
}
