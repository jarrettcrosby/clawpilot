#!/usr/bin/env node

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const read = (path) => readFileSync(resolve(root, path), 'utf8')

const migration = read('db/migrations/0328_career_site_submissions.sql')
const contract = read('app_src/lib/careerSiteSubmissionContract.ts')
const persistence = read('app_src/lib/persistence/careerSiteSubmissions.ts')
const worker = read('app_src/lib/careerSiteSubmissionOutbox.ts')
const route = read('app_src/app/api/career-site/submissions/route.ts')
const workerRoute = read('app_src/app/api/career-site/submissions/outbox/process/route.ts')
const proxy = read('app_src/proxy.ts')
const poller = read('scripts/pipeline-outbox-poller.mjs')
const runtime = read('scripts/validate-runtime-config.mjs')
const environment = read('.env.example')
const docs = read('docs/modules/career-site-submissions.md')

assert.match(migration, /CREATE TABLE IF NOT EXISTS career_site_submissions/)
assert.match(migration, /CREATE TABLE IF NOT EXISTS career_site_submission_outbox/)
assert.match(migration, /UNIQUE \(source_app, external_submission_id\)/)
assert.match(migration, /source_app = 'jarrett-career-site'/)
assert.match(migration, /FOREIGN KEY \(owner_email, workspace_organization_id\)[\s\S]*REFERENCES app_user_organization_memberships/)
assert.match(migration, /submission_id uuid NOT NULL UNIQUE/)
assert.doesNotMatch(migration.match(/CREATE TABLE IF NOT EXISTS career_site_submission_outbox[\s\S]*$/)?.[0] || '', /payload jsonb/i)

assert.match(contract, /const CAREER_SITE_SOURCE_APP = 'jarrett-career-site'/)
assert.match(contract, /Contact submissions cannot imply résumé or newsletter consent/)
assert.match(contract, /Résumé requests do not create newsletter consent/)
assert.match(contract, /Newsletter submissions require separate explicit consent/)
assert.match(contract, /Unsupported career-site submission field/)
assert.match(contract, /CAREER_SITE_SUBMISSION_SHEET_HEADERS/)
assert.match(contract, /CAREER_SITE_PUBLIC_ORIGIN = 'https:\/\/jarrett\.suburbiasandwichco\.com'/)
assert.match(contract, /'Shortlink Status'/)
assert.match(contract, /input\.formType === 'resume-request' \? 'Pending' : 'Not applicable'/)

assert.match(route, /resolveShortLinkActor\(req\)/)
assert.match(route, /!actor\.service/)
assert.match(route, /actor\.sourceApp !== configuration\.sourceApp/)
assert.match(route, /actor\.ownerEmail !== configuration\.ownerEmail/)
assert.match(route, /MAX_REQUEST_BYTES = 16 \* 1024/)
assert.match(route, /result\.duplicate \? 200 : 201/)

assert.match(persistence, /careerSiteSubmissionPayloadHash/)
assert.match(persistence, /ON CONFLICT \(source_app, external_submission_id\) DO NOTHING/)
assert.match(persistence, /FOR UPDATE SKIP LOCKED/)
assert.match(persistence, /career_site\.submission\.received/)
assert.doesNotMatch(persistence, /turnstile|request_ip|x-forwarded-for|approval.?token|short.?url/i)

assert.match(worker, /resolveGoogleWorkspaceProvisioningRuntime/)
assert.match(worker, /valueInputOption=RAW/)
assert.match(worker, /idempotent: false/)
assert.match(worker, /existingSubmissionIds\.has\(item\.externalSubmissionId\)/)
assert.match(worker, /input\.sheetHeaderRow \+ 1/)
assert.match(worker, /A\$\{input\.sheetHeaderRow\}:S/)
assert.match(worker, /item\.ownerEmail !== configuration\.ownerEmail/)
assert.doesNotMatch(worker, /valueInputOption=USER_ENTERED/)
assert.doesNotMatch(worker, /approval.?token|short.?url|resume.?url/i)

assert.match(workerRoute, /PIPELINE_OUTBOX_WORKER_SECRET/)
assert.match(proxy, /\/api\/career-site\/submissions/)
assert.match(proxy, /\/api\/career-site\/submissions\/outbox\/process/)
assert.match(poller, /CAREER_SITE_SUBMISSIONS_ENABLED/)
assert.match(poller, /career-site-submissions/)

for (const source of [runtime, environment, docs]) {
  assert.match(source, /CAREER_SITE_SUBMISSIONS_ENABLED/)
  assert.match(source, /CAREER_SITE_SUBMISSIONS_OWNER_EMAIL/)
  assert.match(source, /CAREER_SITE_SUBMISSIONS_SHEET_ID/)
  assert.match(source, /CAREER_SITE_SUBMISSIONS_SHEET_TAB/)
  assert.match(source, /CAREER_SITE_SUBMISSIONS_SHEET_HEADER_ROW/)
}
assert.match(runtime, /serviceClientSources\.includes\('jarrett-career-site'\)/)
assert.match(docs, /does not need a Google service-account JSON/)
assert.match(docs, /Do not add approval tokens, résumé URLs, ClawPilot short links, or access-grant data/)
assert.match(docs, /POST https:\/\/aiapp\.eigenracing\.com\/api\/career-site\/submissions/)
assert.match(docs, /x-shortlink-source: jarrett-career-site/)
assert.match(docs, /A new accepted UUID returns `201`; an exact replay returns `200`/)

console.log('Career-site submission contracts verified')
