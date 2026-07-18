#!/usr/bin/env node
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const migrationPath = path.join(root, 'scripts/migrate-sales-pipeline-to-episcs.mjs')
const migration = fs.readFileSync(migrationPath, 'utf8')

function assertIncludes(fragment, label) {
  assert.ok(migration.includes(fragment), `${label} missing ${fragment}`)
}

for (const [fragment, label] of [
  ["const SOURCE_WORKSPACE_NAME = 'Suburbia Sandwich Co'", 'source workspace guard'],
  ["const TARGET_WORKSPACE_NAME = 'Express Parcel International DBA EPISCS'", 'target workspace guard'],
  ["const SALES_PIPELINE_NAME = 'Sales pipeline'", 'sales pipeline guard'],
  ["const PLACEHOLDER_PIPELINE_NAME = 'My pipeline'", 'placeholder pipeline guard'],
  ["const CONFIRMATION = 'MOVE_SALES_PIPELINE_TO_EPISCS'", 'apply confirmation'],
  ["BEGIN ISOLATION LEVEL SERIALIZABLE", 'serializable transaction'],
  ['pg_advisory_xact_lock', 'migration lock'],
  ["if (args.apply) await client.query('COMMIT')", 'explicit apply commit'],
  ["else await client.query('ROLLBACK')", 'dry-run rollback'],
  ["'already-complete'", 'idempotent completed state'],
  ["finalizeRootContacts: argv.includes('--finalize-root-contacts')", 'guarded root-contact finalization mode'],
]) assertIncludes(fragment, label)

for (const [fragment, label] of [
  ["relationship_type = 'workspace_member'", 'Suburbia child-workspace exclusion'],
  ['assert(dependent === 0', 'workspace-member dependency safeguard'],
  ['assert(row.comment_count === 0', 'non-owner board comment safeguard'],
  ['DELETE FROM pipeline_space_members member', 'unauthorized pipeline access cleanup'],
  ['DELETE FROM pipeline_google_permissions permission', 'unauthorized Google access cleanup'],
  ['DELETE FROM project_board_members member', 'unauthorized board access cleanup'],
  ['__workspace_transfer__', 'unique-key-safe staged swaps'],
  ['swapRootOrganizations(client, context)', 'root account identity exchange'],
  ['migrateDocuments(client, context, nonOwnerBoards)', 'document scope migration'],
  ['migratePreferences(client, context, nonOwnerBoards)', 'workspace preference repair'],
  ['migrateShortLinks(client, context)', 'short-link scope migration'],
  ['migrateAuditScope(client, context', 'audit scope migration'],
]) assertIncludes(fragment, label)

for (const [fragment, label] of [
  ['stageOrganizationRelationships(', 'SuiteCRM account relationship restaging'],
  ['stageRootContacts(', 'SuiteCRM root contact restaging'],
  ["const CONTACT_FINALIZATION_PHASE = 'root-contact-finalization'", 'idempotent root-contact finalization phase'],
  ['stageRootInteractions(', 'SuiteCRM root interaction restaging'],
  ['stageRootMeetings(', 'SuiteCRM root meeting restaging'],
  ["'apply_workbook_branding', 'google_sheets'", 'workbook branding restaging'],
  ['Sales pipeline retains a user without EPISCS access', 'post-migration access assertion'],
  ['CRM records cross pipeline boundaries', 'post-migration relationship assertion'],
  ["eventType: 'crm.pipeline_workspace.migrated_in'", 'migration-in audit'],
  ["eventType: 'crm.pipeline_workspace.migrated_out'", 'migration-out audit'],
]) assertIncludes(fragment, label)

assert.match(
  migration,
  /stageOrganizationRelationships\([\s\S]*?context\.salesPipeline\.id,[\s\S]*?\[context\.salesRoot\.id, \.\.\.customerOrganizationIds\][\s\S]*?context\.targetWorkspace\.id/,
  'Sales accounts must be restaged only for the EPISCS pipeline and workspace',
)
assert.match(
  migration,
  /stageOrganizationRelationships\([\s\S]*?context\.placeholder\.id,[\s\S]*?\[context\.placeholderRoot\.id\][\s\S]*?context\.sourceWorkspace\.id/,
  'The Suburbia placeholder root must be restaged separately in the Suburbia pipeline',
)

assert.match(
  migration,
  /stageRootContacts\(client, context\.placeholder\.id,[\s\S]*?stageRootContacts\(client, context\.salesPipeline\.id/,
  'The migrated EPISCS root contact projection must be staged after the Suburbia placeholder projection',
)

console.log('PASS sales pipeline to EPISCS migration contract')
