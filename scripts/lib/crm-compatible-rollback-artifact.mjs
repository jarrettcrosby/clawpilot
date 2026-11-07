import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path'

export const ROLLBACK_ARTIFACT_FORMAT = 'clawpilot-crm-compatible-rollback-source-v1'
export const ROLLBACK_ACCEPTANCE_FORMAT = 'clawpilot-crm-rolling-rollback-acceptance-v1'
export const ROLLBACK_BUILD_FORMAT = 'clawpilot-crm-rollback-local-build-v1'
export const LEGACY_WRITER_COMMIT = 'b61192200b6d990adb320fd7f941a619976bc4af'
// A new floor must protect the current authority inventory. Verification of
// already-pinned artifacts below remains independent of this build-time floor.
const CURRENT_ROLLBACK_ATTESTATION = 'clawpilot-production-rebind-target-schema-attestation-v20'
export const RETAINED_V20_LAST_MIGRATION = 'db/migrations/0412_crm_calendar_occurrence_claims.sql'
export const REQUIRED_RETAINED_V20_CHECKS = Object.freeze([
  'full_migration_checksum_ledger', 'reloaded_email_preserves_single_identity_and_links',
  'reloaded_calendar_preserves_single_occurrence', 'retained_native_authority_and_recovery_controls_unchanged',
])
export const REQUIRED_ROLLING_CHECKS = Object.freeze([
  'legacy_scalar_insert_after_migration', 'legacy_scalar_primary_bridge',
  'legacy_shared_interaction_denied', 'legacy_shared_contacts_denied', 'legacy_shared_companies_denied',
  'compatible_shared_content_edit_preserves_identity', 'retained_schema_compatible_rollback_write',
  'private_write_context_not_leaked', 'producer_retains_all_company_relationships',
])
const ROLLBACK_CRM_AUTHORITY_MIGRATIONS = Object.freeze([
  'db/migrations/0375_crm_native_email_publication_admission.sql',
  'db/migrations/0376_crm_native_email_publication_work_context.sql',
  'db/migrations/0377_crm_native_email_authority_transitions.sql',
  'db/migrations/0378_crm_native_email_capability_policies.sql',
  'db/migrations/0379_crm_native_email_app_only_lifecycle.sql',
  'db/migrations/0380_crm_native_email_grant_attempts.sql',
  'db/migrations/0381_crm_native_email_identity_quiescence.sql',
  'db/migrations/0382_crm_native_email_mapped_settings.sql',
  'db/migrations/0383_crm_native_email_user_eligibility.sql',
  'db/migrations/0384_crm_native_email_member_role_changes.sql',
  'db/migrations/0385_crm_employee_identity_retention.sql',
  'db/migrations/0386_crm_native_email_first_access_grants.sql',
  'db/migrations/0387_crm_native_email_shared_app_only_lifecycle.sql',
  'db/migrations/0388_crm_customer_drive_folders.sql',
  'db/migrations/0389_crm_customer_folder_jobs.sql',
  'db/migrations/0390_crm_fractional_customer_folders.sql',
  'db/migrations/0391_crm_native_email_unshared_workspace_enrollment.sql',
  'db/migrations/0392_crm_root_employee_access_registry.sql',
  'db/migrations/0393_crm_root_employee_read_context.sql',
  'db/migrations/0394_crm_native_root_source_fences.sql',
  'db/migrations/0395_crm_native_email_existing_identity_links.sql',
  'db/migrations/0396_crm_root_native_read_receipts.sql',
  'db/migrations/0397_crm_native_root_registry_changes.sql',
  'db/migrations/0398_crm_native_email_initial_enrollment.sql',
  'db/migrations/0399_crm_native_email_initial_replan_lineage.sql',
  'db/migrations/0400_crm_native_email_demo_quarantine.sql',
  'db/migrations/0401_crm_native_root_owner_source_fence.sql',
  'db/migrations/0402_crm_native_unmanaged_app_only_pipelines.sql',
  'db/migrations/0403_fractional_crm_customer_folder_capability.sql',
  'db/migrations/0404_crm_legacy_email_recovery_holds.sql',
  'db/migrations/0405_crm_legacy_email_recovery_settlement.sql',
  'db/migrations/0406_crm_legacy_email_recovery_archive.sql',
  'db/migrations/0407_crm_legacy_email_recovery_stage.sql',
  'db/migrations/0408_crm_legacy_email_recovery_relationship_fence.sql',
  'db/migrations/0409_crm_email_control_side_effect_scope.sql',
  'db/migrations/0410_crm_legacy_email_exact_account_repair.sql',
  'db/migrations/0411_crm_legacy_email_archive_disposition.sql',
  RETAINED_V20_LAST_MIGRATION,
])
export const ROLLBACK_PROTECTED_PATHS = Object.freeze([
  ...ROLLBACK_CRM_AUTHORITY_MIGRATIONS,
  'app_src/app/api/crm/email-recovery/route.ts', 'app_src/app/api/crm/email-review-candidates/route.ts',
  'app_src/app/api/crm/mailbox-identity/route.ts', 'app_src/components/crm/EmailReviewDialog.tsx',
  'app_src/app/api/crm/route.ts', 'app_src/app/api/crm/actions/route.ts',
  'app_src/app/api/crm/integrations/process/route.ts', 'app_src/lib/crm/integrationActions.ts',
  'app_src/app/api/crm/root-access/route.ts', 'app_src/lib/persistence/crmRootEmployeeSettings.ts',
  'app_src/lib/crm/rootEmployeeCrmSettings.ts', 'app_src/lib/crm/nativeEmailRootRegistryRuntime.ts',
  'app_src/lib/crm/nativeEmailAuthorityRuntime.ts', 'app_src/lib/persistence/crmRootEmployeeRegistryPreview.ts',
  'app_src/lib/crm/nativeEmailInitialEnrollment.ts', 'app_src/lib/crm/nativeEmailInitialEnrollmentApproval.ts',
  'app_src/lib/crm/nativeEmailInitialInstallationLineage.ts',
  'app_src/lib/crm/nativeEmailInitialEnrollmentPostgres.ts', 'app_src/lib/crm/nativeEmailInitialEnrollmentCoordinator.ts',
  'app_src/lib/crm/nativeEmailInitialEnrollmentOperator.ts', 'app_src/lib/crm/nativeEmailInitialEnrollmentCliTransport.ts',
  'app_src/lib/crm/nativeEmailInitialStartupOrigin.ts', 'app_src/ops/native-email-initial.ts',
  'app_src/ops/native-email-recovery.ts', 'app_src/lib/persistence/crmLegacyEmailRecoveryStage.ts',
  'app_src/lib/crm/legacyEmailRecoveryReleaseApproval.ts', 'app_src/lib/crm/nativeEmailRecoveryPrivateStage.ts',
  'app_src/lib/crm/nativeEmailRecoveryMaintenanceOperator.ts', 'app_src/lib/crm/nativeEmailRecoveryPrivatePostgres.ts',
  'app_src/lib/crm/nativeEmailRecoveryDispatchPermit.ts', 'app_src/lib/crm/nativeEmailRecoveryReadyProof.ts',
  'app_src/lib/crm/nativeEmailRecoveryStoreBinding.ts', 'app_src/lib/crm/nativeEmailRecoveryPostgresFence.ts',
  'app_src/lib/crm/nativeEmailRecoveryMariaFence.ts', 'app_src/lib/crm/nativeEmailRecoveryCustodyProof.ts',
  'app_src/lib/crm/nativeEmailRecoveryCustodian.ts', 'app_src/lib/crm/nativeEmailRecoveryCustodySocket.ts',
  'app_src/lib/crm/nativeEmailRecoveryDuplexRunner.ts', 'app_src/lib/crm/nativeEmailRecoveryCliTransport.ts',
  'app_src/lib/crm/calendarOccurrenceClaims.ts', 'app_src/lib/crm/fractionalCustomerFolder.ts',
  'app_src/components/settings/RootCrmAccessPanel.tsx', 'app_src/components/settings/UserAccessDialog.tsx',
  'app_src/components/crm/CrmSection.tsx', 'app_src/components/settings/GoogleAuthSettingsPanel.tsx',
  'app_src/lib/browserSameOrigin.ts', 'app_src/lib/requestUser.ts', 'app_src/lib/tenancy.ts',
  'app_src/lib/googleSso.ts', 'app_src/lib/authSessions.ts', 'app_src/lib/globalIds.mjs',
  'app_src/lib/crm/emailAddressHeaders.ts', 'app_src/lib/crm/participantEligibility.ts',
  'app_src/lib/crm/types.ts', 'app_src/lib/crm/emailIngestion.ts',
  'app_src/lib/crm/emailIdentity.ts', 'app_src/lib/crm/emailReconciliation.ts', 'app_src/lib/crm/caseyGmailReview.ts',
  'app_src/lib/persistence/crmEmailIdentity.ts', 'app_src/lib/crm/suiteCrmNativeEmailProjection.ts',
  'app_src/lib/crm/suiteCrmClient.ts', 'app_src/lib/crm/worker.ts', 'app_src/lib/persistence/crm.ts',
  'db/migrations/0374_crm_interaction_organizations.sql',
  'scripts/production-rebind-history-schema-attestation.mjs', 'scripts/predeploy-railway.sh',
  'scripts/start-railway.sh', 'scripts/pipeline-outbox-poller.mjs', 'scripts/lib/pipeline-outbox-poll.mjs',
  'services/suitecrm/bootstrap-global-id.php', 'services/suitecrm/install-email-search.php',
  'services/suitecrm/email-search/EmailSearch.php', 'services/suitecrm/Dockerfile',
  'services/suitecrm/entrypoint.sh', 'services/suitecrm/bootstrap-client.php',
  'services/suitecrm/bootstrap-image-principals.php',
  'services/suitecrm/email-audience/EmailAudience.php', 'services/suitecrm/email-audience/routes.php',
  'services/suitecrm/install-email-audience.php',
  'services/suitecrm/install-native-email-scope.php', 'services/suitecrm/install-native-email-runtime.php',
  'services/suitecrm/install-native-email-initial-state.php', 'services/suitecrm/native-email-initial-cli.php',
  'services/suitecrm/native-email-initial-install-profile.json',
  'services/suitecrm/native-email-initial-artifacts.php', 'services/suitecrm/native-email-enrolled-startup.php',
  'services/suitecrm/native-email-startup-check.php', 'services/suitecrm/native-email-maintenance.py',
  'services/suitecrm/native-email-liveness.json', 'services/suitecrm/apache-site.conf', 'services/suitecrm/apache-ports.conf', 'services/suitecrm/railway.json',
  'services/suitecrm/native-email-scope/Patch.php', 'services/suitecrm/native-email-scope/Scope.php',
  'services/suitecrm/email-audience/NativeEmailTransaction.php', 'services/suitecrm/email-audience/NativeEmailRuntime.php',
  'services/suitecrm/email-audience/NativeEmailProjection.php', 'services/suitecrm/email-audience/NativeEmailPublisher.php',
  'services/suitecrm/email-audience/NativeEmailWriteScope.php', 'services/suitecrm/email-audience/NativeEmailCapabilityContract.php',
  'services/suitecrm/email-audience/NativeEmailAuthorityContract.php', 'services/suitecrm/email-audience/NativeEmailAuthorityDelta.php',
  'services/suitecrm/email-audience/NativeEmailAuthorityProof.php', 'services/suitecrm/email-audience/NativeEmailAuthorityTransition.php',
  'services/suitecrm/email-audience/NativeEmailIdentityLink.php', 'services/suitecrm/email-audience/NativeEmailInitialEnrollment.php',
  'services/suitecrm/email-audience/NativeEmailInitialPolicyDelta.php',
  'services/suitecrm/email-audience/NativeEmailInitialInstallationLineage.php',
  'services/suitecrm/email-audience/NativeEmailStartupOrigin.php',
  'services/suitecrm/native-email-recovery-cli.php',
  'services/suitecrm/email-audience/NativeEmailRecoveryDispatchPermit.php',
  'services/suitecrm/email-audience/NativeEmailRecoveryReadyProof.php',
  'services/suitecrm/email-audience/publication-routes.php', 'services/suitecrm/email-audience/authority-routes.php',
  'services/suitecrm/email-audience/publication-schema.sql', 'services/suitecrm/email-audience/authority-transition-schema.sql',
  'services/suitecrm/email-audience/initial-enrollment-schema.sql',
  'scripts/build-crm-compatible-rollback.mjs', 'scripts/certify-crm-rollback-build.mjs',
  'scripts/build-native-email-initial-operator.mjs', 'scripts/test-native-email-initial-private-operator.mjs',
  'scripts/build-native-email-recovery-operator.mjs', 'scripts/test-native-email-recovery-private-operator.mjs',
  'scripts/lib/crm-compatible-rollback-artifact.mjs', 'scripts/test-crm-rolling-rollback-postgres.mjs',
  'scripts/lib/crm-rollback-retained-v20-fixture.mjs', 'scripts/lib/postgres-test-migrations.mjs',
  'scripts/test-crm-compatible-rollback-artifact.mjs', 'scripts/test-crm-email-routing-postgres.mjs',
  'scripts/test-crm-reviewed-gmail-persistence.mjs', 'scripts/test-production-rebind-history-schema-attestation.mjs',
  'docs/operations/crm-compatible-rollback.md', 'docs/operations/suitecrm.md',
  'package.json', 'app_src/package.json', 'app_src/package-lock.json', 'railway.json',
].sort())

export const sha256 = value => createHash('sha256').update(value).digest('hex')
export const canonicalJson = value => JSON.stringify(value, null, 2) + '\n'
export function retainedV20MigrationInventory(sourceTree) {
  const entries = sourceTree.filter(({ path }) => /^db\/migrations\/\d+_.+\.sql$/u.test(path))
    .map(({ path, gitBlob }) => ({ path, gitBlob })).sort((a, b) => a.path < b.path ? -1 : Number(a.path > b.path))
  assert.equal(entries.at(-1)?.path, RETAINED_V20_LAST_MIGRATION,
    'Current floor cannot certify an unexpected final migration')
  assert.ok(entries.every(({ gitBlob }) => /^[a-f0-9]{40}$/u.test(gitBlob)), 'Migration source must bind each committed Git blob')
  assert.equal(new Set(entries.map(entry => entry.path)).size, entries.length, 'Duplicate migration source path')
  return { paths: entries.map(entry => entry.path), migrationCount: entries.length,
    lastMigration: RETAINED_V20_LAST_MIGRATION, sourceInventorySha256: sha256(canonicalJson(entries)) }
}
const git = (repository, args, options = {}) => execFileSync('git', ['-C', repository, ...args], {
  encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: 30_000, stdio: ['ignore', 'pipe', 'pipe'], ...options,
})
const OMITTED_SOURCE_PATHS = Object.freeze(['.env.example', 'data/README.md', 'data-dev/README.md'])

export function assertExternalRollbackOutput(repository, path) {
  const target = resolve(realpathSync(dirname(resolve(path))), basename(path))
  const relation = relative(realpathSync(repository), target)
  assert.ok((relation === '..' || relation.startsWith(`..${sep}`)) && !isAbsolute(relation),
    'Generated rollback proof/artifacts must remain outside the repository')
  assert.ok(!existsSync(target), 'Rollback proof/artifact output exists; never overwrite prior evidence')
  return target
}

function checkedPath(path) {
  assert.ok(typeof path === 'string' && path && !isAbsolute(path) && !/[\\\u0000-\u001f\u007f:]/u.test(path)
    && path.split('/').every(part => part && part !== '.' && part !== '..'), 'Unsafe archive source path')
  assert.ok(!/(^|\/)(?:\.git|node_modules|\.next|backups?|logs?|tmp)(?:\/|$)/iu.test(path)
    && !/(^|\/)\.env(?:\.|$)/iu.test(path)
    && !/\.(?:pem|key|p12|pfx|sqlite3?|db|bak|log)$/iu.test(path), `Runtime/secret path cannot enter rollback artifact: ${path}`)
  assert.ok(!/^(?:data|data-dev)\//u.test(path) || path.endsWith('/README.md'), 'Runtime data cannot enter rollback artifact')
  return path
}

export function inspectRollbackSources(readSource) {
  const files = Object.fromEntries(ROLLBACK_PROTECTED_PATHS.map(path => [path, readSource(path)]))
  const migration = files['db/migrations/0374_crm_interaction_organizations.sql']
  const persistence = files['app_src/lib/persistence/crm.ts']
  const attester = files['scripts/production-rebind-history-schema-attestation.mjs']
  for (const fragment of ['crm_interaction_organizations', 'clawpilot.crm_shared_write_v1', 'CREATE TRIGGER']) {
    assert.ok(migration.includes(fragment), `Rollback floor lacks migration protection: ${fragment}`)
  }
  for (const fragment of ['clawpilot.crm_shared_write_v1', 'REVIEWED_GMAIL_RELATIONSHIPS',
    'Reviewed interaction contacts must be preserved', 'Reviewed interaction organizations must be preserved',
    'Reviewed interaction provider identity and parent context must be preserved']) {
    assert.ok(persistence.includes(fragment), `Rollback floor lacks shared-email preservation: ${fragment}`)
  }
  assert.ok(files['app_src/lib/crm/emailIngestion.ts'].includes('expectedTargetFingerprint'), 'Rollback floor lacks reviewed CAS')
  assert.ok(files['app_src/lib/crm/suiteCrmClient.ts'].includes('record.relationships'), 'Rollback floor lacks native relationship publication')
  assert.ok(attester.includes('if (inspection.schemaDigest !== expectedDigest)'), 'Rollback floor must retain strict raw catalog acceptance')
  const format = attester.match(/PRODUCTION_REBIND_HISTORY_SCHEMA_ATTESTATION_FORMAT\s*=\s*'([^']+)'/u)?.[1]
  assert.equal(format, CURRENT_ROLLBACK_ATTESTATION, 'New rollback floors require the exact current catalog attestation')
  const enrolledMigration = attester.match(/filename:\s*'0374_crm_interaction_organizations\.sql',\s*checksum:\s*'([a-f0-9]{64})'/u)?.[1]
  assert.equal(enrolledMigration, sha256(migration), 'Rollback floor must attest its exact migration bytes')
  for(const path of ROLLBACK_CRM_AUTHORITY_MIGRATIONS){
    const filename=path.split('/').at(-1)
    const escaped=filename.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')
    const enrolled=attester.match(new RegExp("filename:\\s*'"+escaped+"',\\s*checksum:\\s*'([a-f0-9]{64})'"))?.[1]
    assert.equal(enrolled,sha256(files[path]),`Rollback floor must retain and attest ${filename}`)
  }
  const rawDigestBlock = attester.match(/const EXPECTED_SCHEMA_DIGEST_BY_POSTGRES_MAJOR = Object\.freeze\(\{([\s\S]*?)\}\)/u)?.[1]
  assert.ok(rawDigestBlock, 'Rollback floor must enroll raw catalog digests')
  const postgresDigests = Object.fromEntries([...rawDigestBlock.matchAll(/(16|18):\s*'([a-f0-9]{64})'/gu)].map(([, major, digest]) => [major, digest]))
  assert.deepEqual(Object.keys(postgresDigests), ['16', '18'])
  assert.ok(Object.values(postgresDigests).every(digest => !/^0+$/u.test(digest)))
  return { migrationSha256: sha256(migration), attestation: { format, postgresDigests },
    protectedFiles: Object.fromEntries(ROLLBACK_PROTECTED_PATHS.map(path => [path, sha256(files[path])])) }
}

export function committedRollbackIdentity(repository, commit) {
  repository = resolve(repository)
  assert.match(commit, /^[a-f0-9]{40}$/u, 'An explicit full local commit SHA is required')
  assert.equal(git(repository, ['rev-parse', '--verify', `${commit}^{commit}`]).trim(), commit)
  assert.equal(git(repository, ['rev-parse', 'HEAD']).trim(), commit, 'Certification requires the checked-out commit')
  assert.equal(git(repository, ['status', '--porcelain', '--untracked-files=normal']).trim(), '', 'Certification requires a clean committed worktree')
  const tree = git(repository, ['rev-parse', `${commit}^{tree}`]).trim()
  const entries = git(repository, ['ls-tree', '-rz', '--full-tree', commit]).split('\0').filter(Boolean).map(entry => {
    const match = entry.match(/^(100644|100755) blob ([a-f0-9]{40})\t(.+)$/u)
    assert.ok(match, 'Rollback source may contain only tracked regular files, not symlinks or submodules')
    if (OMITTED_SOURCE_PATHS.includes(match[3])) return null
    return { path: checkedPath(match[3]), mode: match[1], gitBlob: match[2] }
  }).filter(Boolean)
  const source = inspectRollbackSources(path => git(repository, ['show', `${commit}:${path}`]))
  return { commit, tree, ...source, omittedTrackedPaths: OMITTED_SOURCE_PATHS, sourceTree: entries }
}

export function writeRollbackSourceArchive(repository, commit, archivePath) {
  assert.ok(!existsSync(archivePath), 'Source archive already exists')
  git(repository, ['archive', '--format=tar', '--prefix=source/', `--output=${archivePath}`, commit,
    '--', '.', ':(exclude).env.example', ':(exclude)data', ':(exclude)data-dev'])
}

export function validateRollbackReceipts(identity, acceptance, build) {
  assert.equal(acceptance?.format, ROLLBACK_ACCEPTANCE_FORMAT)
  assert.equal(build?.format, ROLLBACK_BUILD_FORMAT)
  for (const receipt of [acceptance, build]) {
    assert.equal(receipt.status, 'passed', 'Only completed local proof can certify an artifact')
    assert.deepEqual(receipt.source, { commit: identity.commit, tree: identity.tree,
      migrationSha256: identity.migrationSha256, protectedFiles: identity.protectedFiles }, 'Proof source differs from artifact source')
  }
  assert.equal(acceptance.legacyWriterCommit, LEGACY_WRITER_COMMIT)
  assert.ok([16, 18].includes(acceptance.postgresMajor))
  assert.deepEqual([...acceptance.checks].sort(), [...REQUIRED_ROLLING_CHECKS].sort())
  const containsRetainedV20 = identity.sourceTree?.some(({ path }) => path === RETAINED_V20_LAST_MIGRATION)
  if (containsRetainedV20 || identity.attestation?.format === CURRENT_ROLLBACK_ATTESTATION) {
    assert.equal(identity.attestation?.format, CURRENT_ROLLBACK_ATTESTATION,
      'The retained v20 migration cannot be verified under a different attestation')
    const { migrationCount, lastMigration, sourceInventorySha256 } = retainedV20MigrationInventory(identity.sourceTree)
    const schemaDigest = identity.attestation.postgresDigests[acceptance.postgresMajor]
    assert.match(schemaDigest, /^[a-f0-9]{64}$/u, 'Current floor lacks the catalog digest for the measured PostgreSQL major')
    assert.deepEqual(acceptance.retainedSchema, { migrationCount, lastMigration, sourceInventorySha256,
      schemaDigest, checks: [...REQUIRED_RETAINED_V20_CHECKS] }, 'New rollback floors require the exact retained v20 schema transition receipt')
  }
  assert.deepEqual(build.command, ['npm', 'run', 'build'])
  assert.match(build.nodeVersion, /^v24\./u, 'Rollback certification requires the supported Node 24 build')
  assert.equal(build.environmentMode, 'isolated-committed-source-no-provider-credentials')
  assert.deepEqual(Object.keys(build.outputFiles || {}).sort(), [
    'app_src/.next/BUILD_ID', 'app_src/.next/build-manifest.json', 'app_src/.next/routes-manifest.json',
  ].sort(), 'A build exit without the expected compiled output evidence is not certification')
  for (const [path, digest] of Object.entries(build.outputFiles)) {
    assert.ok(path.startsWith('app_src/.next/'), 'Build evidence must identify local Next output')
    assert.match(digest, /^[a-f0-9]{64}$/u)
  }
}

export const rollbackReceiptSource = identity => ({ commit: identity.commit, tree: identity.tree,
  migrationSha256: identity.migrationSha256, protectedFiles: identity.protectedFiles })

export function buildRollbackArtifact({ repository, commit, outputDirectory, acceptanceFile, buildFile }) {
  repository = resolve(repository)
  outputDirectory = assertExternalRollbackOutput(repository, outputDirectory)
  const identity = committedRollbackIdentity(repository, commit)
  const acceptanceBytes = readFileSync(acceptanceFile)
  const buildBytes = readFileSync(buildFile)
  const acceptance = JSON.parse(acceptanceBytes), build = JSON.parse(buildBytes)
  assert.equal(acceptanceBytes.toString('utf8'), canonicalJson(acceptance), 'Acceptance receipt must use canonical serialization')
  assert.equal(buildBytes.toString('utf8'), canonicalJson(build), 'Build receipt must use canonical serialization')
  validateRollbackReceipts(identity, acceptance, build)
  mkdirSync(outputDirectory, { mode: 0o700 })
  const archivePath = resolve(outputDirectory, 'source.tar')
  writeRollbackSourceArchive(repository, commit, archivePath)
  const manifest = { format: ROLLBACK_ARTIFACT_FORMAT, ...identity,
    archive: { filename: 'source.tar', sha256: sha256(readFileSync(archivePath)) },
    certification: { boundary: 'Synthetic local PostgreSQL transition and local Node 24 build only; not production/native delivery or permission proof',
      acceptanceSha256: sha256(acceptanceBytes), buildSha256: sha256(buildBytes), acceptance, build },
    compatibility: { requiresMigration: '0374_crm_interaction_organizations.sql', retainsSchemaOnRollback: true,
      legacyWritableRollbackSupported: false, productionUseRequiresSeparateApproval: true,
      requiresSeparateCanaryBaselineAcceptance: true, doesNotUndoFeaturesOrData: true } }
  const manifestBytes = canonicalJson(manifest)
  writeFileSync(resolve(outputDirectory, 'manifest.json'), manifestBytes, { flag: 'wx', mode: 0o444 })
  chmodSync(archivePath, 0o444)
  const manifestSha256 = sha256(manifestBytes)
  verifyRollbackArtifact({ directory: outputDirectory, expectedManifestSha256: manifestSha256 })
  return { directory: outputDirectory, manifestSha256, commit, archiveSha256: manifest.archive.sha256 }
}

export function verifyRollbackArtifact({ directory, expectedManifestSha256 }) {
  assert.match(expectedManifestSha256, /^[a-f0-9]{64}$/u, 'Verification requires the independently retained manifest SHA-256')
  const manifestPath = resolve(directory, 'manifest.json'), archivePath = resolve(directory, 'source.tar')
  for (const path of [manifestPath, archivePath]) assert.ok(lstatSync(path).isFile() && !lstatSync(path).isSymbolicLink(), 'Artifact files must be regular files')
  const bytes = readFileSync(manifestPath)
  assert.equal(sha256(bytes), expectedManifestSha256, 'Rollback manifest differs from the approved build receipt')
  const manifest = JSON.parse(bytes)
  assert.equal(manifest.format, ROLLBACK_ARTIFACT_FORMAT)
  assert.equal(manifest.archive.filename, 'source.tar')
  assert.equal(sha256(readFileSync(archivePath)), manifest.archive.sha256, 'Rollback archive has changed')
  validateRollbackReceipts(manifest, manifest.certification.acceptance, manifest.certification.build)
  assert.equal(sha256(canonicalJson(manifest.certification.acceptance)), manifest.certification.acceptanceSha256)
  assert.equal(sha256(canonicalJson(manifest.certification.build)), manifest.certification.buildSha256)
  const listed = execFileSync('tar', ['-tf', archivePath], { encoding: 'utf8', timeout: 30_000, maxBuffer: 8 * 1024 * 1024 })
    .split('\n').filter(Boolean).filter(path => !path.endsWith('/')).map(path => {
      assert.ok(path.startsWith('source/'), 'Archive entry escapes source prefix')
      return checkedPath(path.slice('source/'.length))
    }).sort()
  assert.deepEqual(listed, manifest.sourceTree.map(entry => checkedPath(entry.path)).sort(), 'Archive must contain exactly the committed source files')
  return manifest
}
