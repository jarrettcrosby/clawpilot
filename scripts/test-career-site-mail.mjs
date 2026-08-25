#!/usr/bin/env node

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const read = (path) => readFileSync(resolve(root, path), 'utf8')

const migration = read('db/migrations/0330_career_site_mail_outbox.sql')
const migrationChecksum = createHash('sha256').update(migration).digest('hex')
const contract = read('app_src/lib/careerSiteMailContract.ts')
const delivery = read('app_src/lib/careerSiteMailDelivery.ts')
const persistence = read('app_src/lib/persistence/careerSiteMailOutbox.ts')
const worker = read('app_src/lib/careerSiteMailOutbox.ts')
const route = read('app_src/app/api/career-site/mail/route.ts')
const workerRoute = read('app_src/app/api/career-site/submissions/outbox/process/route.ts')
const healthRoute = read('app_src/app/api/health/route.ts')
const persistenceStatusRoute = read('app_src/app/api/persistence/status/route.ts')
const proxy = read('app_src/proxy.ts')
const runtime = read('scripts/validate-runtime-config.mjs')
const railwayStart = read('scripts/start-railway.sh')
const environment = read('.env.example')
const docs = read('docs/modules/career-site-submissions.md')

assert.match(migration, /CREATE TABLE IF NOT EXISTS career_site_mail_outbox/)
assert.match(migration, /UNIQUE \(source_app, idempotency_key\)/)
assert.match(migration, /source_app = 'jarrett-career-site'/)
assert.match(migration, /FOREIGN KEY \(owner_email, workspace_organization_id\)[\s\S]*REFERENCES app_user_organization_memberships/)
assert.match(migration, /draft_id text/)
assert.match(migration, /provider_message_id text/)
assert.match(migration, /rfc_message_id text NOT NULL/)
assert.match(migration, /status IN \('queued', 'processing', 'succeeded', 'failed', 'dead'\)/)

assert.match(contract, /'contact-notification'/)
assert.match(contract, /'newsletter-request'/)
assert.match(contract, /'resume-approval-request'/)
assert.match(contract, /'approved-resume-link'/)
assert.match(contract, /Unsupported .* field/)
assert.match(contract, /idempotencyKey does not match the message data/)
assert.match(contract, /jarrett\.suburbiasandwichco\.com/)
assert.match(contract, /jarrett-suburbia.*vercel/)
assert.match(contract, /aiapp\.eigenracing\.com/)
assert.match(contract, /CAREER_SITE_MAIL_FROM = 'info@suburbiasandwichco\.com'/)
assert.match(contract, /CAREER_SITE_MAIL_REPLY_TO = 'jarrettcrosby@gmail\.com'/)
assert.match(contract, /CAREER_SITE_MAIL_APPROVAL_TO = 'jarrettcrosby@gmail\.com'/)

assert.match(route, /resolveShortLinkActor\(req\)/)
assert.match(route, /validateShortLinkConfiguration\(\{ requireServiceClient: true \}\)/)
assert.match(route, /!actor\.service/)
assert.match(route, /actor\.sourceApp !== configuration\.sourceApp/)
assert.match(route, /actor\.ownerEmail !== configuration\.ownerEmail/)
assert.match(route, /req\.headers\.get\('idempotency-key'\)/)
assert.match(route, /headerIdempotencyKey !== request\.idempotencyKey/)
assert.match(route, /result\.duplicate \? 200 : 202/)
assert.match(route, /Cache-Control': 'private, no-store, max-age=0'/)

assert.match(persistence, /ON CONFLICT \(source_app, idempotency_key\) DO NOTHING/)
assert.match(persistence, /FOR UPDATE SKIP LOCKED/)
assert.match(persistence, /LIMIT 1/)
assert.match(persistence, /0330_career_site_mail_outbox\.sql/)
assert.match(persistence, new RegExp(migrationChecksum, 'u'))
assert.match(persistence, /career_site\.mail\.queued/)
assert.match(persistence, /out_of_scope_pending/)
assert.match(persistence, /stale_processing/)
assert.match(persistence, /worker_heartbeat/)
assert.doesNotMatch(persistence, /RESEND|Resend/)

assert.match(delivery, /settings\/sendAs/)
assert.match(delivery, /verificationStatus/)
assert.match(delivery, /'accepted'/)
assert.match(delivery, /users\/me\/drafts/)
assert.match(delivery, /rfc822msgid:/)
assert.match(delivery, /Message-ID:/)
assert.match(delivery, /Open secure resume link/)
assert.match(delivery, /requested is ready|you requested is ready/)
assert.match(delivery, /does not subscribe you/)
assert.doesNotMatch(delivery, /approved your request|ClawPilot link|RESEND|Resend|CLAWPILOT_MAIL_FROM/)

assert.match(worker, /findAlreadySent/)
assert.match(worker, /saveCareerSiteMailDraftInPostgres/)
assert.match(worker, /sendCareerSiteMailDraft/)
assert.match(worker, /error\.ambiguous/)
assert.match(worker, /error\.status === 404/)
assert.match(workerRoute, /processCareerSiteMailOutbox/)
assert.match(workerRoute, /recordCareerSiteMailWorkerHeartbeatInPostgres/)
assert.match(workerRoute, /mailDeliveryStatus: mailHealth\.status/)

for (const diagnostic of [healthRoute, persistenceStatusRoute]) {
  assert.match(diagnostic, /readCareerSiteMailOperationalHealthFromPostgres/)
  assert.match(diagnostic, /careerSiteMail/)
}
assert.match(proxy, /\/api\/career-site\/mail/)

for (const source of [runtime, railwayStart, environment, docs]) {
  assert.match(source, /CAREER_SITE_MAIL_FROM/)
  assert.match(source, /CAREER_SITE_MAIL_FROM_NAME/)
  assert.match(source, /CAREER_SITE_MAIL_REPLY_TO/)
  assert.match(source, /CAREER_SITE_MAIL_APPROVAL_TO/)
}
assert.match(docs, /POST https:\/\/aiapp\.eigenracing\.com\/api\/career-site\/mail/)
assert.match(docs, /Idempotency-Key:/)
assert.match(docs, /deterministic RFC Message-ID/)
assert.match(docs, /does not modify or fall back from the global `CLAWPILOT_MAIL_FROM`/)

console.log('Career-site mail contracts verified')
