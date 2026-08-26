#!/usr/bin/env node

import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import vm from 'node:vm'

const root = process.cwd()
const requireFromApp = createRequire(new URL('../app_src/package.json', import.meta.url))
const ts = requireFromApp('typescript')
const submissionId = '11111111-1111-4111-8111-111111111111'
const sheetId = 'private-sheet-id'
const headers = Array.from({ length: 19 }, (_, index) => `Header ${index + 1}`)
const canonicalRow = Array.from({ length: 19 }, (_, index) => (
  index === 0 ? submissionId : `Value ${index + 1}`
))
const configuration = {
  enabled: true,
  sourceApp: 'jarrett-career-site',
  ownerEmail: 'jarrett@suburbiasandwichco.com',
  organizationId: '405bb919-0364-4a88-8a62-b4c9da42cd8f',
  sheetId,
  sheetTab: 'Submissions',
  sheetHeaderRow: 4,
}

class CareerSiteSubmissionConfigurationError extends Error {}
class CareerSiteSubmissionSheetBoundaryError extends Error {}
class GoogleWorkspaceRequestError extends Error {}
class GoogleWorkspaceClientError extends Error {}

function loadWorker(options) {
  const path = 'app_src/lib/careerSiteSubmissionOutbox.ts'
  const output = ts.transpileModule(readFileSync(resolve(root, path), 'utf8'), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
    fileName: path,
  }).outputText
  const module = { exports: {} }
  const state = { complete: 0, fail: 0, puts: 0, claims: 0 }
  const item = {
    id: '22222222-2222-4222-8222-222222222222',
    submissionId: '33333333-3333-4333-8333-333333333333',
    externalSubmissionId: submissionId,
    sourceApp: configuration.sourceApp,
    ownerEmail: configuration.ownerEmail,
    formType: 'contact',
    requesterName: 'Test Recruiter',
    requesterEmail: 'recruiter@example.com',
    requesterOrganization: null,
    interest: 'leadership',
    message: 'A valid message for worker recovery testing.',
    networkInterest: false,
    roleFit: false,
    newsletterConsent: false,
    resumeVariant: null,
    sourceUrl: null,
    createdAt: '2026-08-25T12:00:00.000Z',
    attempts: 2,
    lockToken: 'worker-lock',
  }
  const permissions = [
    { id: 'owner', type: 'user', role: 'owner', emailAddress: configuration.ownerEmail },
    { id: 'service', type: 'user', role: 'writer', emailAddress: 'service@project.iam.gserviceaccount.com' },
  ]
  const runtime = { serviceAccountEmail: 'service@project.iam.gserviceaccount.com' }
  const googleDriveJson = async (_runtime, pathname) => {
    if (pathname.includes('/permissions?')) return { permissions }
    return {
      id: sheetId,
      mimeType: 'application/vnd.google-apps.spreadsheet',
      trashed: false,
      writersCanShare: false,
      capabilities: { canEdit: true },
      owners: [{ emailAddress: configuration.ownerEmail }],
    }
  }
  const googleSheetsJson = async (_runtime, pathname, init = {}) => {
    if (init.method === 'PUT') {
      state.puts += 1
      return {}
    }
    if (!pathname.includes('/values/')) {
      return { spreadsheetId: sheetId, sheets: [{ properties: { title: 'Submissions' } }] }
    }
    const decoded = decodeURIComponent(pathname)
    if (decoded.includes('!A4:S4')) return { values: [headers] }
    if (decoded.includes('!A5:A50005')) {
      return { values: options.duplicate ? [[submissionId], [submissionId]] : [[submissionId]] }
    }
    if (decoded.includes('!A5:S5')) {
      return { values: [options.mismatch ? [submissionId, 'Wrong requester data'] : canonicalRow] }
    }
    throw new Error(`Unexpected Sheets path: ${decoded}`)
  }
  vm.runInNewContext(output, {
    Buffer,
    Date,
    Error,
    JSON,
    Math,
    Number,
    Object,
    Promise,
    Set,
    Map,
    String,
    URLSearchParams,
    console,
    exports: module.exports,
    module,
    process,
    require(specifier) {
      if (specifier === '@/lib/careerSiteSubmissionContract') {
        return {
          CAREER_SITE_SUBMISSION_SHEET_HEADERS: headers,
          CareerSiteSubmissionConfigurationError,
          CareerSiteSubmissionSheetBoundaryError,
          assertPrivateCareerSiteSheetBoundary() {},
          careerSiteSubmissionSheetRow: () => canonicalRow,
          resolveCareerSiteSubmissionConfiguration: () => configuration,
        }
      }
      if (specifier === '@/lib/integrations/googleWorkspace') {
        return {
          GoogleWorkspaceRequestError,
          resolveGoogleWorkspacePrivateFileRuntime: async () => runtime,
        }
      }
      if (specifier === '@/lib/integrations/googleWorkspaceClient') {
        return { GoogleWorkspaceClientError, googleDriveJson, googleSheetsJson }
      }
      if (specifier === '@/lib/persistence/careerSiteSubmissions') {
        return {
          async claimCareerSiteSubmissionOutboxInPostgres() {
            state.claims += 1
            return [item]
          },
          async completeCareerSiteSubmissionOutboxInPostgres() { state.complete += 1 },
          async failCareerSiteSubmissionOutboxInPostgres() {
            state.fail += 1
            return 'failed'
          },
          async renewCareerSiteSubmissionOutboxLeaseInPostgres() {},
          async withCareerSiteSubmissionSheetLock(_id, callback) {
            return { acquired: true, value: await callback() }
          },
        }
      }
      throw new Error(`Unexpected submission worker test import: ${specifier}`)
    },
  }, { filename: path })
  return { worker: module.exports, state }
}

const replay = loadWorker({ mismatch: false, duplicate: false })
const replayResult = await replay.worker.processCareerSiteSubmissionOutbox()
assert.equal(replayResult.succeeded, 1)
assert.equal(replay.state.complete, 1)
assert.equal(replay.state.fail, 0)
assert.equal(replay.state.puts, 0, 'crash-after-append recovery must not append a duplicate row')

const mismatch = loadWorker({ mismatch: true, duplicate: false })
const mismatchResult = await mismatch.worker.processCareerSiteSubmissionOutbox()
assert.equal(mismatchResult.failed, 1)
assert.equal(mismatch.state.complete, 0)
assert.equal(mismatch.state.fail, 1)
assert.equal(mismatch.state.puts, 0)

const duplicate = loadWorker({ mismatch: false, duplicate: true })
const duplicateResult = await duplicate.worker.processCareerSiteSubmissionOutbox()
assert.equal(duplicateResult.failed, 1)
assert.equal(duplicate.state.complete, 0)
assert.equal(duplicate.state.fail, 1)

console.log('Career-site Sheet crash replay, mismatch, and duplicate-ID recovery verified')
