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
  MATON_AUTH_GMAIL_CONNECTION_ID: '',
  CLAWPILOT_AUTH_MAIL_FROM: '',
  CAREER_SITE_SUBMISSIONS_ENABLED: '0',
}
const fetchTrapImport = `data:text/javascript,${encodeURIComponent(`
  globalThis.fetch = async () => { throw new Error('FETCH_MUST_NOT_RUN'); };
`)}`

function runWithFetchTrap(overrides) {
  return spawnSync(process.execPath, ['--import', fetchTrapImport, verifier], {
    cwd: root,
    env: { ...baseEnv, ...overrides },
    encoding: 'utf8',
    timeout: 5_000,
  })
}

for (const partialOverride of [
  { MATON_AUTH_GMAIL_CONNECTION_ID: 'auth-gmail-connection' },
  { CLAWPILOT_AUTH_MAIL_FROM: 'jarrettcrosby@gmail.com' },
]) {
  const result = runWithFetchTrap(partialOverride)
  assert.equal(result.status, 1)
  assert.match(result.stderr, /MATON_AUTH_GMAIL_CONNECTION_ID and CLAWPILOT_AUTH_MAIL_FROM must be configured together/)
  assert.doesNotMatch(result.stderr, /FETCH_MUST_NOT_RUN/)
}

const reusedConnection = runWithFetchTrap({
  MATON_AUTH_GMAIL_CONNECTION_ID: baseEnv.MATON_GMAIL_CONNECTION_ID,
  CLAWPILOT_AUTH_MAIL_FROM: 'jarrettcrosby@gmail.com',
})
assert.equal(reusedConnection.status, 1)
assert.match(reusedConnection.stderr, /MATON_AUTH_GMAIL_CONNECTION_ID must differ from MATON_GMAIL_CONNECTION_ID/)
assert.doesNotMatch(reusedConnection.stderr, /FETCH_MUST_NOT_RUN/)

const reusedSender = runWithFetchTrap({
  MATON_AUTH_GMAIL_CONNECTION_ID: 'auth-gmail-connection',
  CLAWPILOT_AUTH_MAIL_FROM: ' STEWARDS@EIGENRACING.COM ',
})
assert.equal(reusedSender.status, 1)
assert.match(reusedSender.stderr, /CLAWPILOT_AUTH_MAIL_FROM must differ from CLAWPILOT_MAIL_FROM/)
assert.doesNotMatch(reusedSender.stderr, /FETCH_MUST_NOT_RUN/)

function runWithMockProfiles({ sameProfile }) {
  const mockSource = `
    globalThis.fetch = async (url, init) => {
      const connectionId = init.headers['Maton-Connection'];
      const isPlatform = connectionId === 'test-gmail-connection';
      const isAuth = connectionId === 'auth-gmail-connection';
      if (!isPlatform && !isAuth) return new Response('{}', { status: 403 });
      if (String(url).endsWith('/users/me/profile')) {
        return Response.json({
          emailAddress: isPlatform || ${sameProfile ? 'true' : 'false'}
            ? 'workspace@example.com'
            : 'jarrettcrosby@gmail.com',
        });
      }
      const sender = decodeURIComponent(String(url).split('/').at(-1));
      const expected = isPlatform ? 'stewards@eigenracing.com' : 'jarrettcrosby@gmail.com';
      if (sender !== expected) return new Response('{}', { status: 403 });
      return Response.json({ sendAsEmail: sender, verificationStatus: 'accepted' });
    };
  `
  return spawnSync(
    process.execPath,
    ['--import', `data:text/javascript,${encodeURIComponent(mockSource)}`, verifier],
    {
      cwd: root,
      env: {
        ...baseEnv,
        MATON_BASE_URL: 'https://gateway.maton.ai',
        MATON_AUTH_GMAIL_CONNECTION_ID: 'auth-gmail-connection',
        CLAWPILOT_AUTH_MAIL_FROM: 'jarrettcrosby@gmail.com',
      },
      encoding: 'utf8',
      timeout: 5_000,
    },
  )
}

const distinctProfiles = runWithMockProfiles({ sameProfile: false })
assert.equal(distinctProfiles.status, 0, distinctProfiles.stderr)
assert.match(distinctProfiles.stdout, /jarrettcrosby@gmail\.com/)

const duplicateProfiles = runWithMockProfiles({ sameProfile: true })
assert.equal(duplicateProfiles.status, 1)
assert.match(duplicateProfiles.stderr, /Authentication Gmail account must differ from platform Gmail account/)
assert.doesNotMatch(duplicateProfiles.stderr, /test-api-key-that-must-not-leave-the-process/)

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
assert.match(source, /'Maton-Connection': connectionId/)
assert.match(source, /\/google-mail\/gmail\/v1\/users\/me\/profile/)
assert.match(source, /Authentication Gmail account must differ from platform Gmail account/)
assert.match(source, /MATON_AUTH_GMAIL_CONNECTION_ID/)
assert.match(source, /CLAWPILOT_AUTH_MAIL_FROM/)
assert.match(source, /CLAWPILOT_AUTH_MAIL_FROM must differ from CLAWPILOT_MAIL_FROM/)

console.log('Mail sender verifier Maton origin boundary verified')
