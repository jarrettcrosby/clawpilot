#!/usr/bin/env node

import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import vm from 'node:vm'

const root = process.cwd()
const requireFromApp = createRequire(new URL('../app_src/package.json', import.meta.url))
const ts = requireFromApp('typescript')
const calls = []
let sentLookupMessages = [{ id: 'sent_message_001' }]
let draftLookupDrafts = [{ id: 'draft_001', message: { id: 'draft_message_001' } }]
let draftCreateFailure = null

function response(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function loadDelivery() {
  const path = 'app_src/lib/careerSiteMailDelivery.ts'
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
    Date,
    Error,
    Intl,
    JSON,
    Object,
    Response,
    URLSearchParams,
    console,
    exports: module.exports,
    module,
    process,
    require(specifier) {
      if (specifier === 'node:crypto') return requireFromApp('node:crypto')
      if (specifier === '@/lib/careerSiteMailContract') return {}
      if (specifier === '@/lib/maton') {
        return {
          async matonPlatformMailFetch(pathname, init = {}) {
            calls.push({ pathname, init })
            if (pathname.includes('/settings/sendAs/')) {
              return response({
                sendAsEmail: 'info@suburbiasandwichco.com',
                verificationStatus: 'accepted',
              })
            }
            if (pathname.startsWith('/google-mail/gmail/v1/users/me/drafts?')) {
              return response({ drafts: draftLookupDrafts })
            }
            if (pathname === '/google-mail/gmail/v1/users/me/drafts') {
              if (draftCreateFailure) throw draftCreateFailure
              return response({ id: 'draft_001', message: { id: 'draft_message_001' } })
            }
            if (pathname === '/google-mail/gmail/v1/users/me/drafts/send') {
              return response({ id: 'sent_message_001' })
            }
            if (pathname.startsWith('/google-mail/gmail/v1/users/me/messages?')) {
              return response({ messages: sentLookupMessages })
            }
            throw new Error(`Unexpected Maton path: ${pathname}`)
          },
        }
      }
      throw new Error(`Unexpected delivery test import: ${specifier}`)
    },
  }, { filename: path })
  return module.exports
}

const delivery = loadDelivery()
const configuration = {
  enabled: true,
  sourceApp: 'jarrett-career-site',
  ownerEmail: 'jarrett@suburbiasandwichco.com',
  organizationId: '405bb919-0364-4a88-8a62-b4c9da42cd8f',
  from: 'info@suburbiasandwichco.com',
  fromName: 'Jarrett Crosby',
  replyTo: 'jarrettcrosby@gmail.com',
  approvalTo: 'jarrettcrosby@gmail.com',
  shortLinkOrigin: 'https://eigenracing.com',
  approvalOrigins: ['https://jarrett.suburbiasandwichco.com'],
}
const requestId = '0b43bb55-f85e-4492-ab4a-7f22582137e5'
const request = {
  messageType: 'approved-resume-link',
  idempotencyKey: `resume-approved/${requestId}`,
  data: {
    requestId,
    name: 'Morgan <Hiring Manager>',
    email: 'morgan@example.com',
    shortUrl: 'https://eigenracing.com/s/jc-e932dd582ff22890',
    variant: 'executive',
    documentStyle: 'ats',
    accessMode: 'view-only',
    expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
  },
}

const envelope = delivery.careerSiteMailEnvelope(request, configuration)
assert.equal(envelope.to, 'morgan@example.com')
assert.match(envelope.text, /you requested is ready/)
assert.match(envelope.text, /secure resume link/)
assert.match(envelope.text, /does not subscribe you/)
assert.doesNotMatch(envelope.text, /approved|review|ClawPilot/i)
assert.match(envelope.html, /Morgan &lt;Hiring Manager&gt;/)
assert.doesNotMatch(envelope.html, /approved|review|ClawPilot/i)

const rfcMessageId = delivery.careerSiteRfcMessageId(request.idempotencyKey)
assert.match(rfcMessageId, /^career-site-[0-9a-f]{40}@suburbiasandwichco\.com$/)
const draft = await delivery.createCareerSiteMailDraft({
  configuration,
  request,
  rfcMessageId,
})
assert.equal(draft.draftId, 'draft_001')
assert.equal(draft.draftMessageId, 'draft_message_001')
assert.match(calls[0].pathname, /settings\/sendAs\/info%40suburbiasandwichco\.com$/)
const draftCall = calls.find((call) => call.pathname.endsWith('/drafts'))
const draftBody = JSON.parse(draftCall.init.body)
const raw = Buffer.from(
  draftBody.message.raw.replace(/-/g, '+').replace(/_/g, '/'),
  'base64',
).toString('utf8')
assert.match(raw, /^From: Jarrett Crosby <info@suburbiasandwichco\.com>/m)
assert.match(raw, /^Reply-To: Jarrett Crosby <jarrettcrosby@gmail\.com>/m)
assert.match(raw, /^To: <morgan@example\.com>/m)
assert.match(raw, new RegExp(`^Message-ID: <${rfcMessageId}>$`, 'm'))
assert.doesNotMatch(raw, /stewards@eigenracing\.com/)

const recoveredDraft = await delivery.findCareerSiteMailDraft(rfcMessageId)
assert.equal(recoveredDraft.draftId, 'draft_001')
assert.equal(recoveredDraft.draftMessageId, 'draft_message_001')
const draftLookup = calls.find((call) => call.pathname.includes('/drafts?'))
const draftLookupQuery = new URL(`https://test.invalid${draftLookup.pathname}`).searchParams.get('q')
assert.match(draftLookupQuery, /in:drafts rfc822msgid:career-site-/)
draftLookupDrafts = [
  { id: 'draft_001', message: { id: 'draft_message_001' } },
  { id: 'draft_002', message: { id: 'draft_message_002' } },
]
await assert.rejects(
  delivery.findCareerSiteMailDraft(rfcMessageId),
  (error) => error?.name === 'CareerSiteMailProviderError'
    && error?.status === 409
    && /Multiple drafts matched/.test(error?.message || ''),
)
draftCreateFailure = new Error('simulated response loss after Gmail created the draft')
await assert.rejects(
  delivery.createCareerSiteMailDraft({ configuration, request, rfcMessageId }),
  (error) => error?.name === 'CareerSiteMailProviderError'
    && error?.ambiguous === true
    && !String(error?.message || '').includes('simulated response loss'),
)
draftCreateFailure = null

const found = await delivery.findSentCareerSiteMail(rfcMessageId)
assert.equal(found, 'sent_message_001')
const lookup = calls.find((call) => call.pathname.includes('/messages?'))
const lookupQuery = new URL(`https://test.invalid${lookup.pathname}`).searchParams.get('q')
assert.match(lookupQuery, /in:sent rfc822msgid:career-site-/)
sentLookupMessages = [{ id: 'sent_message_001' }, { id: 'sent_message_002' }]
await assert.rejects(
  delivery.findSentCareerSiteMail(rfcMessageId),
  (error) => error?.name === 'CareerSiteMailProviderError'
    && error?.status === 409
    && error?.ambiguous === false
    && /Multiple sent messages matched/.test(error?.message || ''),
)
assert.equal(await delivery.sendCareerSiteMailDraft(draft.draftId), 'sent_message_001')
const sendCall = calls.find((call) => call.pathname.endsWith('/drafts/send'))
assert.deepEqual(JSON.parse(sendCall.init.body), { id: 'draft_001' })

console.log('Career-site Google Mail delivery verified')
