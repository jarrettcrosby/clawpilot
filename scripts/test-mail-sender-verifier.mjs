#!/usr/bin/env node

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'

const root = process.cwd()
const verifier = resolve(root, 'scripts/verify-mail-sender.mjs')
const baseEnv = {
  ...process.env,
  MATON_API_KEY: 'test-api-key-that-must-not-leave-the-process',
  MATON_GMAIL_CONNECTION_ID: 'test-gmail-connection',
  CLAWPILOT_MAIL_FROM: 'stewards@eigenracing.com',
  CAREER_SITE_SUBMISSIONS_ENABLED: '0',
}

for (const hostileBase of [
  'https://attacker.example',
  'http://gateway.maton.ai',
  'https://gateway.maton.ai.attacker.example',
  'https://gateway.maton.ai@attacker.example',
  'https://gateway.maton.ai/redirect',
]) {
  const result = spawnSync(process.execPath, [verifier], {
    cwd: root,
    env: { ...baseEnv, MATON_BASE_URL: hostileBase },
    encoding: 'utf8',
    timeout: 5_000,
  })
  assert.equal(result.status, 1, `hostile MATON_BASE_URL must fail closed: ${hostileBase}`)
  assert.match(result.stderr, /MATON_BASE_URL is not configured safely/)
  assert.doesNotMatch(result.stderr, /test-api-key-that-must-not-leave-the-process/)
}

const source = await import('node:fs/promises').then(({ readFile }) => readFile(verifier, 'utf8'))
assert.match(source, /redirect:\s*'error'/)
assert.match(source, /cache:\s*'no-store'/)

console.log('Mail sender verifier Maton origin boundary verified')
