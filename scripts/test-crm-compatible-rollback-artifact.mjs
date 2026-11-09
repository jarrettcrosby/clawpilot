#!/usr/bin/env node
// Local synthetic Git repositories only. No builds, providers or databases.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { buildRollbackArtifact, canonicalJson, committedRollbackIdentity, inspectRollbackSources,
  LEGACY_WRITER_COMMIT, REQUIRED_RETAINED_V20_CHECKS, REQUIRED_RETAINED_V21_CHECKS, REQUIRED_RETAINED_V22_CHECKS, REQUIRED_ROLLING_CHECKS, ROLLBACK_ACCEPTANCE_FORMAT, ROLLBACK_BUILD_FORMAT,
  ROLLBACK_PROTECTED_PATHS, retainedV20MigrationInventory, retainedV21MigrationInventory, retainedV22MigrationInventory, rollbackReceiptSource, sha256, validateRollbackReceipts,
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
  const productMigration = 'db/migrations/0373_fractional_crm_product_read.sql'
  const folderMigration = 'db/migrations/0403_fractional_crm_customer_folder_capability.sql'
  const compatibilityPaths = [productMigration, folderMigration]
  const enrollment = paths => paths.map(path => `{filename: '${path.split('/').at(-1)}', checksum: '${sha256(sources[path])}'}`).join(',')
  const oldFolderChecksum = sha256('historical 0403 fixture bytes')
  sources['scripts/production-rebind-history-schema-attestation.mjs'] = `
    const PRODUCTION_REBIND_HISTORY_SCHEMA_ATTESTATION_FORMAT = 'clawpilot-production-rebind-target-schema-attestation-v22';
    const manifest = [${enrollment(ROLLBACK_PROTECTED_PATHS.filter(path=>path.startsWith('db/migrations/')&&!compatibilityPaths.includes(path)))},
      {filename: '0403_fractional_crm_customer_folder_capability.sql', checksum: '${oldFolderChecksum}'}];
    const FRACTIONAL_PRODUCT_COMPATIBILITY_SCHEMA_MIGRATIONS = Object.freeze([${enrollment(compatibilityPaths)}]);
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
  const { migrationCount, lastMigration, sourceInventorySha256 } = retainedV22MigrationInventory(identity.sourceTree)
  const acceptance = { format: ROLLBACK_ACCEPTANCE_FORMAT, status: 'passed', source: rollbackReceiptSource(identity),
    legacyWriterCommit: LEGACY_WRITER_COMMIT, postgresMajor: 16, checks: [...REQUIRED_ROLLING_CHECKS],
    retainedSchema: { migrationCount, lastMigration, sourceInventorySha256,
      schemaDigest: identity.attestation.postgresDigests[16], checks: [...REQUIRED_RETAINED_V22_CHECKS] } }
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
    assert.equal(inspected.attestation.format, 'clawpilot-production-rebind-target-schema-attestation-v22')
    const protectedMigrationNames = Object.keys(inspected.protectedFiles).filter(path => /^db\/migrations\/04(?:0[3-9]|1[0-7])_/u.test(path))
    assert.deepEqual(protectedMigrationNames.map(path => path.slice(14, 18)),
      Array.from({ length: 15 }, (_, offset) => String(403 + offset).padStart(4, '0')))
    assert.equal(inspected.protectedFiles[productMigration], sha256(readFileSync(new URL(`../${productMigration}`, import.meta.url))))
  })
  check('historical or unknown future metadata cannot certify a new floor', () => {
    for (const version of [9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 23]) {
      assert.throws(() => inspectRollbackSources(path => path === 'scripts/production-rebind-history-schema-attestation.mjs'
        ? sources[path].replace('schema-attestation-v22', `schema-attestation-v${version}`) : sources[path]), /exact current catalog/)
    }
  })
  const laterMigrations = ROLLBACK_PROTECTED_PATHS.filter(path => path===productMigration || /^db\/migrations\/(?:0399|04(?:0[0-9]|1[0-7]))_/u.test(path))
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
        ?sources[path].replaceAll(filename,'omitted_fixture.sql'):sources[path]),/retain and attest/)
    }
  })
  check('historical 0403 cannot masquerade as the active v21 capability migration', () => {
    assert.throws(() => inspectRollbackSources(path => path === 'scripts/production-rebind-history-schema-attestation.mjs'
      ? sources[path].replace(`checksum: '${sha256(sources[folderMigration])}'}]);`, `checksum: '${oldFolderChecksum}'}]);`)
      : sources[path]), /both exact active Fractional capability migrations/)
  })
  check('different source or failed proof cannot certify', () => {
    assert.throws(() => validateRollbackReceipts(identity, { ...acceptance, status: 'failed' }, build))
    assert.throws(() => validateRollbackReceipts(identity, { ...acceptance, source: { ...acceptance.source, tree: '0'.repeat(40) } }, build))
    assert.throws(() => validateRollbackReceipts(identity, { ...acceptance, checks: acceptance.checks.slice(1) }, build))
    assert.throws(() => validateRollbackReceipts(identity, acceptance, { ...build, nodeVersion: 'v18.0.0' }))
  })
  check('older narrow receipt, stale migration inventory and incomplete retained checks cannot certify v22', () => {
    const { retainedSchema, ...narrowReceipt } = acceptance
    assert.throws(() => validateRollbackReceipts(identity, narrowReceipt, build), /retained v22 schema transition/)
    for (const override of [{ migrationCount: migrationCount - 1 }, { sourceInventorySha256: '0'.repeat(64) }, { schemaDigest: '9'.repeat(64) },
      { checks: [...REQUIRED_RETAINED_V21_CHECKS] }, { lastMigration: 'db/migrations/0402_stale.sql' }]) {
      assert.throws(() => validateRollbackReceipts(identity, { ...narrowReceipt, retainedSchema: { ...retainedSchema, ...override } }, build),
        /retained v22 schema transition/)
    }
    assert.throws(() => retainedV22MigrationInventory([...identity.sourceTree,
      { path: 'db/migrations/0418_unknown.sql', gitBlob: '1'.repeat(40) }]), /unexpected final migration/)
    assert.throws(() => retainedV22MigrationInventory(identity.sourceTree.filter(({ path }) => !path.startsWith('db/migrations/0415_'))),
      /exact ordered held-original migration suffix/)
    assert.throws(() => retainedV20MigrationInventory(identity.sourceTree), /retained v21 proof/)
  })
  const isHeldMigration = path => /^db\/migrations\/041[3-7]_/u.test(path)
  const preHeldProtected = Object.fromEntries(Object.entries(identity.protectedFiles).filter(([path]) => !isHeldMigration(path)))
  const preHeldSourceTree = identity.sourceTree.filter(({ path }) => !isHeldMigration(path))
  const v21 = { ...identity, protectedFiles: preHeldProtected, sourceTree: preHeldSourceTree,
    attestation: { ...identity.attestation, format: 'clawpilot-production-rebind-target-schema-attestation-v21' } }
  check('historical v21 receipt remains readable but cannot be substituted for v22', () => {
    const source = rollbackReceiptSource(v21)
    const { paths: _paths, ...v21Inventory } = retainedV21MigrationInventory(v21.sourceTree)
    const v21Acceptance = { ...acceptance, source, retainedSchema: { ...v21Inventory,
      schemaDigest: v21.attestation.postgresDigests[16], checks: [...REQUIRED_RETAINED_V21_CHECKS] } }
    assert.doesNotThrow(() => validateRollbackReceipts(v21, v21Acceptance, { ...build, source }))
    assert.throws(() => validateRollbackReceipts({ ...identity, attestation: v21.attestation }, acceptance, build), /different attestation/)
    assert.throws(() => validateRollbackReceipts({ ...v21, attestation: identity.attestation }, v21Acceptance, { ...build, source }), /unexpected final migration/)
  })
  const historicalProtected = { ...preHeldProtected }; delete historicalProtected[productMigration]
  const historicalSourceTree = preHeldSourceTree.filter(({ path }) => path !== productMigration)
  const historicalIdentity = { ...identity, protectedFiles: historicalProtected, sourceTree: historicalSourceTree }
  check('historical v20 receipt remains readable but cannot be substituted for v21', () => {
    const v20 = { ...historicalIdentity, attestation: { ...identity.attestation, format: 'clawpilot-production-rebind-target-schema-attestation-v20' } }
    const source = rollbackReceiptSource(v20)
    const { paths: _paths, ...v20Inventory } = retainedV20MigrationInventory(v20.sourceTree)
    const v20Acceptance = { ...acceptance, source, retainedSchema: { ...v20Inventory,
      schemaDigest: v20.attestation.postgresDigests[16], checks: [...REQUIRED_RETAINED_V20_CHECKS] } }
    assert.doesNotThrow(() => validateRollbackReceipts(v20, v20Acceptance, { ...build, source }))
    assert.throws(() => validateRollbackReceipts({ ...identity, attestation: v20.attestation }, acceptance, build), /different attestation/)
    assert.throws(() => validateRollbackReceipts({ ...v20, attestation: v21.attestation }, v20Acceptance, { ...build, source }), /v21 proof lacks/)
  })
  check('v22 receipt must protect the actual gateway and same-job authority sources', () => {
    for (const omitted of ['app_src/app/api/integrations/fractional-crm/v1/[...path]/route.ts',
      'app_src/lib/fractionalCrmGatewayAuth.ts', 'app_src/lib/persistence/fractionalCrmGateway.ts',
      'app_src/lib/persistence/crmLegacyEmailTerminalHold.ts', 'app_src/lib/persistence/crmHeldOriginalRecoveryStage.ts']) {
      const protectedFiles = { ...identity.protectedFiles }; delete protectedFiles[omitted]
      const incomplete = { ...identity, protectedFiles }, source = rollbackReceiptSource(incomplete)
      assert.throws(() => validateRollbackReceipts(incomplete, { ...acceptance, source }, { ...build, source }), /does not protect/)
    }
  })
  check('historical v18 receipt format remains readable for independently pinned archives', () => {
    const { retainedSchema: _onlyV20, ...historicalAcceptance } = acceptance
    const olderAttestation = { ...identity.attestation, format: 'clawpilot-production-rebind-target-schema-attestation-v18' }
    for (const attestation of [olderAttestation, undefined, { format: 'unknown' }]) {
      assert.throws(() => validateRollbackReceipts({ ...identity, attestation }, historicalAcceptance, build), /different attestation/)
    }
    const sourceTree = historicalSourceTree.filter(({ path }) => !/^db\/migrations\/04(?:0[3-9]|1[0-2])_/u.test(path))
    const historical = { ...historicalIdentity, sourceTree, attestation: olderAttestation }, source = rollbackReceiptSource(historical)
    assert.doesNotThrow(() => validateRollbackReceipts(historical, { ...historicalAcceptance, source }, { ...build, source }))
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
