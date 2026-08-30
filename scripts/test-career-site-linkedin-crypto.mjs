#!/usr/bin/env node

import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import vm from 'node:vm'

const root = process.cwd()
const requireFromApp = createRequire(new URL('../app_src/package.json', import.meta.url))
const ts = requireFromApp('typescript')

function loadCrypto() {
  const path = 'app_src/lib/careerSiteLinkedInCrypto.ts'
  const output = ts.transpileModule(readFileSync(resolve(root, path), 'utf8'), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
    fileName: path,
  }).outputText
  const module = { exports: {} }
  vm.runInNewContext(output, {
    Buffer,
    Error,
    JSON,
    Map,
    Number,
    Object,
    console,
    exports: module.exports,
    module,
    process,
    require(specifier) {
      if (specifier === 'node:crypto') return requireFromApp('node:crypto')
      if (specifier === '@/lib/careerSiteLinkedInContract') {
        return { CAREER_SITE_LINKEDIN_MAX_SESSION_BYTES: 4 * 1024 * 1024 }
      }
      throw new Error(`Unexpected LinkedIn crypto test import: ${specifier}`)
    },
  }, { filename: path })
  return module.exports
}

const previous = {
  active: process.env.CAREER_LINKEDIN_SESSION_ACTIVE_KEY_ID,
  keys: process.env.CAREER_LINKEDIN_SESSION_ENCRYPTION_KEYS,
  fingerprint: process.env.CAREER_LINKEDIN_SESSION_FINGERPRINT_KEY,
}
try {
  process.env.CAREER_LINKEDIN_SESSION_ACTIVE_KEY_ID = 'linkedin-session-v1'
  process.env.CAREER_LINKEDIN_SESSION_ENCRYPTION_KEYS = JSON.stringify({
    'linkedin-session-v1': Buffer.alloc(32, 17).toString('base64'),
  })
  process.env.CAREER_LINKEDIN_SESSION_FINGERPRINT_KEY = Buffer.alloc(32, 43).toString('base64')
  const sessionCrypto = loadCrypto()
  const identity = {
    sourceApp: 'jarrett-career-agents',
    ownerEmail: 'jarrett@suburbiasandwichco.com',
    organizationId: '405bb919-0364-4a88-8a62-b4c9da42cd8f',
    generation: 1,
  }
  const session = Buffer.from(JSON.stringify({
    cookies: [{ name: 'li_at', value: 'opaque-test-session-value' }],
    origins: [],
  }), 'utf8')
  const encrypted = sessionCrypto.encryptCareerSiteLinkedInSession(session, identity)
  assert.equal(encrypted.encryptionVersion, 1)
  assert.equal(encrypted.iv.byteLength, 12)
  assert.equal(encrypted.tag.byteLength, 16)
  assert.equal(encrypted.ciphertext.includes(Buffer.from('opaque-test-session-value')), false)
  assert.equal(
    sessionCrypto.decryptCareerSiteLinkedInSession(encrypted, identity).toString('utf8'),
    session.toString('utf8'),
  )
  for (const changed of [
    { sourceApp: 'other-source' },
    { ownerEmail: 'other@example.com' },
    { organizationId: '11111111-1111-4111-8111-111111111111' },
    { generation: 2 },
  ]) {
    assert.throws(
      () => sessionCrypto.decryptCareerSiteLinkedInSession(encrypted, { ...identity, ...changed }),
      /could not be decrypted/,
    )
  }
  const leaseId = '5393ac34-ab46-49fc-96b5-1f7603f77ff1'
  const leaseToken = '16ec95e8-3e32-4e7e-b019-84e9794797c9'
  const envelope = sessionCrypto.encryptCareerSiteLinkedInWorkerEnvelope({
    session,
    leaseId,
    leaseToken,
    ownerId: identity.ownerEmail,
  })
  assert.equal(
    sessionCrypto.decryptCareerSiteLinkedInWorkerEnvelope({
      envelope,
      leaseId,
      leaseToken,
      ownerId: identity.ownerEmail,
    }).toString('utf8'),
    session.toString('utf8'),
  )
  assert.throws(() => sessionCrypto.decryptCareerSiteLinkedInWorkerEnvelope({
    envelope,
    leaseId: 'fc064a86-4ac2-44ff-871d-4d56d724b2cb',
    leaseToken,
    ownerId: identity.ownerEmail,
  }), /could not be decrypted/)
  console.log('Career-site LinkedIn session encryption and identity binding verified')
} finally {
  const restore = (name, value) => {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  restore('CAREER_LINKEDIN_SESSION_ACTIVE_KEY_ID', previous.active)
  restore('CAREER_LINKEDIN_SESSION_ENCRYPTION_KEYS', previous.keys)
  restore('CAREER_LINKEDIN_SESSION_FINGERPRINT_KEY', previous.fingerprint)
}
