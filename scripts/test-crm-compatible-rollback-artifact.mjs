#!/usr/bin/env node
// Local synthetic Git repositories only. No builds, providers or databases.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { buildRollbackArtifact, canonicalJson, committedRollbackIdentity, inspectRollbackSources,
  LEGACY_WRITER_COMMIT, REQUIRED_RETAINED_V20_CHECKS, REQUIRED_ROLLING_CHECKS, ROLLBACK_ACCEPTANCE_FORMAT, ROLLBACK_BUILD_FORMAT,
  ROLLBACK_PROTECTED_PATHS, retainedV20MigrationInventory, rollbackReceiptSource, sha256, validateRollbackReceipts,
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
    const PRODUCTION_REBIND_HISTORY_SCHEMA_ATTESTATION_FORMAT = 'clawpilot-production-rebind-target-schema-attestation-v20';
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
  const { migrationCount, lastMigration, sourceInventorySha256 } = retainedV20MigrationInventory(identity.sourceTree)
  const acceptance = { format: ROLLBACK_ACCEPTANCE_FORMAT, status: 'passed', source: rollbackReceiptSource(identity),
    legacyWriterCommit: LEGACY_WRITER_COMMIT, postgresMajor: 16, checks: [...REQUIRED_ROLLING_CHECKS],
    retainedSchema: { migrationCount, lastMigration, sourceInventorySha256,
      schemaDigest: identity.attestation.postgresDigests[16], checks: [...REQUIRED_RETAINED_V20_CHECKS] } }
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
  check('actual checkout can be inspected with the current floor policy', () => {
    const inspected = inspectRollbackSources(path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8'))
    assert.equal(inspected.attestation.format, 'clawpilot-production-rebind-target-schema-attestation-v20')
    const protectedMigrationNames = Object.keys(inspected.protectedFiles).filter(path => /^db\/migrations\/04(?:0[3-9]|1[0-2])_/u.test(path))
    assert.deepEqual(protectedMigrationNames.map(path => path.slice(14, 18)),
      Array.from({ length: 10 }, (_, offset) => String(403 + offset).padStart(4, '0')))
  })
  check('historical or unknown future metadata cannot certify a new floor', () => {
    for (const version of [9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 21]) {
      assert.throws(() => inspectRollbackSources(path => path === 'scripts/production-rebind-history-schema-attestation.mjs'
        ? sources[path].replace('schema-attestation-v20', `schema-attestation-v${version}`) : sources[path]), /exact current catalog/)
    }
  })
  const laterMigrations = ROLLBACK_PROTECTED_PATHS.filter(path => /^db\/migrations\/(?:0399|04(?:0[0-9]|1[0-2]))_/u.test(path))
  check('later authority migration source must match the exact enrolled checksum',()=>{
    for(const migrationPath of laterMigrations){
      assert.throws(()=>inspectRollbackSources(path=>path===migrationPath
        ?sources[path]+'-- changed fixture migration\n':sources[path]),/retain and attest/)
    }
  })
  check('omitting later authority migration enrollment cannot certify',()=>{
    for(const migrationPath of laterMigrations){
      const filename = migrationPath.split('/').at(-1)
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
  check('older narrow receipt, stale migration inventory and incomplete retained checks cannot certify v20', () => {
    const { retainedSchema, ...narrowReceipt } = acceptance
    assert.throws(() => validateRollbackReceipts(identity, narrowReceipt, build), /retained v20 schema transition/)
    for (const override of [{ migrationCount: migrationCount - 1 }, { sourceInventorySha256: '0'.repeat(64) }, { schemaDigest: '9'.repeat(64) },
      { checks: retainedSchema.checks.slice(1) }, { lastMigration: 'db/migrations/0402_stale.sql' }]) {
      assert.throws(() => validateRollbackReceipts(identity, { ...narrowReceipt, retainedSchema: { ...retainedSchema, ...override } }, build),
        /retained v20 schema transition/)
    }
    assert.throws(() => retainedV20MigrationInventory([...identity.sourceTree,
      { path: 'db/migrations/0413_unknown.sql', gitBlob: '1'.repeat(40) }]), /unexpected final migration/)
  })
  check('historical v18 receipt format remains readable for independently pinned archives', () => {
    const { retainedSchema: _onlyV20, ...historicalAcceptance } = acceptance
    const olderAttestation = { ...identity.attestation, format: 'clawpilot-production-rebind-target-schema-attestation-v18' }
    for (const attestation of [olderAttestation, undefined, { format: 'unknown' }]) {
      assert.throws(() => validateRollbackReceipts({ ...identity, attestation }, historicalAcceptance, build), /different attestation/)
    }
    const sourceTree = identity.sourceTree.filter(({ path }) => !/^db\/migrations\/04(?:0[3-9]|1[0-2])_/u.test(path))
    assert.doesNotThrow(() => validateRollbackReceipts({ ...identity, sourceTree,
      attestation: olderAttestation }, historicalAcceptance, build))
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
