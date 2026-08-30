#!/usr/bin/env node

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

const migration = readFileSync('db/migrations/0339_career_site_linkedin_connector.sql', 'utf8')
const persistence = readFileSync('app_src/lib/persistence/careerSiteLinkedIn.ts', 'utf8')
const migrationChecksum = createHash('sha256').update(migration).digest('hex')

assert.ok(
  persistence.includes(`'${migrationChecksum}'`),
  'runtime migration readiness must pin the exact local migration bytes',
)

assert.match(migration, /auth_token_redeemed_at timestamptz/)
assert.match(migration, /auth_token_redeemed_lease_digest text/)
assert.match(migration, /auth_token_redeemed_worker_id text/)
assert.equal(
  migration.match(/last_report_body_digest text/g)?.length,
  2,
  'authentication and scan work must both retain a durable report receipt',
)
assert.equal(
  migration.match(/last_report_lease_digest text/g)?.length,
  2,
  'each durable report receipt must remain bound to its completing lease',
)
assert.match(migration, /lease_expires_at timestamptz/)
assert.match(
  migration,
  /CREATE UNIQUE INDEX idx_career_site_linkedin_scan_active[\s\S]*WHERE status IN \('queued', 'claimed', 'awaiting_auth'\)/,
  'one connection must have at most one active scan',
)
assert.match(
  migration,
  /WHERE status IN \('queued', 'claimed', 'awaiting_user'\)/,
  'awaiting-user work must remain discoverable for recovery',
)
assert.match(
  persistence,
  /status IN \('claimed', 'awaiting_user'\)[\s\S]*lease_expires_at <= now\(\)[\s\S]*attempts < \$1/,
  'a crashed interactive worker must release its expired MFA lease',
)
assert.match(
  persistence,
  /SET status = 'queued', auth_attempt_id = \$2::uuid[\s\S]*WHERE connection_id = \$1::uuid AND status = 'awaiting_auth'/,
  'successful authentication must resume only the same owner connection runs',
)
assert.match(
  persistence,
  /auth_token_redeemed_at IS NULL AND expires_at > now\(\)/,
  'live token redemption must be one-time and atomically fenced',
)
assert.match(
  persistence,
  /classifyCareerSiteLinkedInRedemption\([\s\S]*redemption === 'replay'[\s\S]*redemption === 'first'[\s\S]*redemption === 'adopt'/,
  'only the original lease and worker may idempotently acknowledge a lost redemption response',
)
assert.match(
  persistence,
  /authTokenAdoptionRequired = Boolean\([\s\S]*auth_token_redeemed_at[\s\S]*attempts > 1[\s\S]*auth_token_redeemed_lease_digest[\s\S]*auth_token_redeemed_worker_id/,
  'a recovered claim must explicitly tell the worker when redemption adoption is required',
)
assert.match(
  persistence,
  /SET auth_token_redeemed_lease_digest = \$4,[\s\S]*auth_token_redeemed_worker_id = \$3[\s\S]*attempts > 1 AND auth_token_redeemed_at IS NOT NULL/,
  'adoption must preserve redeemed_at while atomically rebinding the recovered fence',
)
assert.match(
  persistence,
  /auth_token_redeemed_lease_digest !== currentLeaseDigest[\s\S]*auth_token_redeemed_worker_id !== input[.]workerId[\s\S]*CAREER_SITE_LINKEDIN_AUTH_EVIDENCE_REQUIRED/,
  'authentication success must require the current adopted redemption fence',
)
assert.match(
  persistence,
  /status IN \('claimed', 'awaiting_user'\) AND lease_expires_at > now\(\)[\s\S]*FOR UPDATE/,
  'stale leases and terminal authentication attempts must remain rejected before redemption handling',
)
assert.match(
  persistence,
  /hasExactReportReceipt\(auth\.rows\[0\], receipt\)[\s\S]*acknowledgeActiveAuthReportReplay/,
  'an exact active authentication heartbeat retry must renew without replaying its side effects',
)
assert.match(
  persistence,
  /hasExactReportReceipt\(scan\.rows\[0\], receipt\)[\s\S]*acknowledgeActiveScanReportReplay/,
  'an exact active scan heartbeat retry must renew without replaying its side effects',
)
assert.match(
  persistence,
  /status IN \('succeeded', 'failed'\) FOR UPDATE[\s\S]*hasExactReportReceipt\(completedAuth\.rows\[0\], receipt\)/,
  'committed terminal authentication reports must have an exact-response-loss replay path',
)
assert.match(
  persistence,
  /status IN \('queued', 'awaiting_auth', 'succeeded', 'failed'\)[\s\S]*hasExactReportReceipt\(completedScan\.rows\[0\], receipt\)/,
  'committed scan awaiting-auth and terminal reports must have an exact-response-loss replay path',
)
assert.match(
  persistence,
  /CAREER_SITE_LINKEDIN_REPORT_REPLAY_CONFLICT/,
  'changed payloads against a durable completed receipt must fail closed',
)
assert.match(
  persistence,
  /SET status = 'claimed'[\s\S]*last_report_body_digest = NULL[\s\S]*UPDATE career_site_linkedin_scan_runs scan[\s\S]*SET status = 'claimed'[\s\S]*last_report_body_digest = NULL/,
  'a new lease must clear the prior lease report receipt before work resumes',
)
assert.equal(
  persistence.match(/eventType: 'career_site[.]linkedin[.]live_token_redeemed'/g)?.length,
  1,
  'the durable redemption transition must have exactly one audit emission site',
)
assert.equal(
  persistence.match(/eventType: 'career_site[.]linkedin[.]live_token_redemption_adopted'/g)?.length,
  1,
  'the durable adoption transition must have exactly one distinct audit emission site',
)
assert.match(
  persistence,
  /authExpiresAt: new Date\(attempt\.expires_at\)\.toISOString\(\)/,
  'the authentication TTL must be distinct from the renewable worker lease',
)
assert.match(
  persistence,
  /INSERT INTO career_site_linkedin_auth_attempts \([\s\S]*id, request_id[\s\S]*\$1::uuid, \$1::uuid/,
  'the upstream authentication attempt ID must equal the caller request ID',
)
assert.match(
  persistence,
  /active\.rows\[0\]\.filters_hash === hash[\s\S]*CAREER_SITE_LINKEDIN_SCAN_ALREADY_ACTIVE/,
  'equivalent duplicate scans reuse one run and conflicting scans fail closed',
)
assert.doesNotMatch(migration, /password|mfa_code|totp|credential/i)

console.log('Career-site LinkedIn crash recovery and exact-run resume contracts verified')
