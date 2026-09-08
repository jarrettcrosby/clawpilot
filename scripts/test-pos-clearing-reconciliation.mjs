#!/usr/bin/env node
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const requireFromApp = createRequire(new URL('../app_src/package.json', import.meta.url))
const ts = requireFromApp('typescript')

function loadModule(relativePath) {
  const source = readFileSync(resolve(root, relativePath), 'utf8')
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
    fileName: relativePath,
  }).outputText
  const module = { exports: {} }
  vm.runInNewContext(output, {
    console,
    Date,
    Error,
    exports: module.exports,
    module,
  }, { filename: relativePath })
  return module.exports
}

const { reconcilePosClearing } = loadModule(
  'app_src/lib/accounting/posClearingReconciliation.ts',
)

const BASE_SCOPE = Object.freeze({
  organizationId: 'org-suburbia',
  quickBooksCompanyId: 'qbo-suburbia',
  locationId: 'toast-main',
  currencyCode: 'usd',
  clearingAccountId: 'qbo-account-payment-exceptions',
})

function evidence(evidenceId, entityType, documentNumber) {
  return Object.freeze([Object.freeze({
    evidenceId,
    entityType,
    providerTransactionId: `provider-${evidenceId}`,
    documentNumber,
  })])
}

function capture(overrides) {
  const includeExpectedSettlement = overrides.expectedSettlementBusinessDate !== null
  return {
    captureId: overrides.captureId,
    scope: overrides.scope ?? BASE_SCOPE,
    businessDate: overrides.businessDate ?? '2026-07-23',
    ...(includeExpectedSettlement
      ? {
          expectedSettlementBusinessDate:
            overrides.expectedSettlementBusinessDate ?? '2026-07-25',
        }
      : {}),
    amountCents: overrides.amountCents,
    evidence: overrides.evidence ?? evidence(
      `evidence-${overrides.captureId}`,
      'JournalEntry',
      overrides.documentNumber ?? '260723POS',
    ),
  }
}

function release(overrides) {
  return {
    releaseId: overrides.releaseId,
    scope: overrides.scope ?? BASE_SCOPE,
    businessDate: overrides.businessDate ?? '2026-07-25',
    amountCents: overrides.amountCents,
    evidence: overrides.evidence ?? Object.freeze([
      Object.freeze({
        evidenceId: `evidence-${overrides.releaseId}-journal`,
        entityType: 'JournalEntry',
        providerTransactionId: `provider-${overrides.releaseId}-journal`,
        documentNumber: overrides.documentNumber ?? '260725POS',
        lineId: 'clearing-account-debit',
      }),
      Object.freeze({
        evidenceId: `evidence-${overrides.releaseId}-receipt`,
        entityType: 'SalesReceipt',
        providerTransactionId: `provider-${overrides.releaseId}-receipt`,
        documentNumber: overrides.documentNumber ?? '260725POS',
      }),
    ]),
  }
}

function reconcile(overrides = {}) {
  return reconcilePosClearing({
    asOfBusinessDate: overrides.asOfBusinessDate ?? '2026-07-25',
    overdueGraceDays: overrides.overdueGraceDays ?? 3,
    captures: overrides.captures ?? [],
    releases: overrides.releases ?? [],
  })
}

function byId(rows, idField, id) {
  return rows.find((row) => row[idField] === id)
}

{
  const input = {
    asOfBusinessDate: '2026-07-25',
    overdueGraceDays: 3,
    captures: [
      capture({
        captureId: 'capture-2026-07-23-payment-exception',
        businessDate: '2026-07-23',
        amountCents: 4_454,
        documentNumber: '260723POS',
      }),
      capture({
        captureId: 'capture-2026-07-24-payment-exception',
        businessDate: '2026-07-24',
        amountCents: 9_526,
        documentNumber: '260724POS',
      }),
    ],
    releases: [release({
      releaseId: 'release-2026-07-25',
      amountCents: 13_980,
      evidence: Object.freeze([
        Object.freeze({
          evidenceId: 'evidence-release-2026-07-25-journal',
          entityType: 'JournalEntry',
          providerTransactionId: 'qbo-journal-260725POS',
          documentNumber: '260725POS',
          lineId: 'payment-exceptions-debit',
        }),
        Object.freeze({
          evidenceId: 'evidence-release-2026-07-25-receipt',
          entityType: 'SalesReceipt',
          providerTransactionId: 'qbo-receipt-260725POS',
          documentNumber: '260725POS',
        }),
      ]),
    })],
  }
  const before = JSON.stringify(input)
  const result = reconcilePosClearing(input)

  assert.equal(JSON.stringify(input), before, 'reconciliation must not mutate its evidence input')
  assert.equal(result.allocations.length, 2)
  assert.deepEqual(
    Array.from(result.allocations, (allocation) => allocation.amountCents),
    [4_454, 9_526],
  )
  assert.ok(result.captures.every((row) => row.status === 'settled'))
  assert.equal(result.releases[0].status, 'settled')
  assert.equal(result.releases[0].receiptBacked, true)
  assert.equal(result.releases[0].remainingCents, 0)
  assert.equal(result.partitions[0].status, 'settled')
  assert.equal(result.partitions[0].allocatedCents, 13_980)
  assert.equal(result.partitions[0].scope.currencyCode, 'USD')
  assert.deepEqual(
    Array.from(result.releases[0].sourceEvidence, (item) => item.evidenceId),
    [
      'evidence-release-2026-07-25-journal',
      'evidence-release-2026-07-25-receipt',
    ],
  )
  assert.ok(Object.isFrozen(result))
  assert.ok(Object.isFrozen(result.allocations[0].captureEvidence))
  assert.ok(Object.isFrozen(result.releases[0].sourceEvidence[0]))
}

{
  const result = reconcile({
    captures: [capture({ captureId: 'partial-capture', amountCents: 10_000 })],
    releases: [release({ releaseId: 'partial-release', amountCents: 4_000 })],
  })
  assert.equal(result.captures[0].status, 'partially_settled')
  assert.equal(result.captures[0].allocatedCents, 4_000)
  assert.equal(result.captures[0].remainingCents, 6_000)
  assert.equal(result.releases[0].status, 'settled')
  assert.equal(result.partitions[0].status, 'partially_settled')
}

{
  const result = reconcile({
    captures: [capture({ captureId: 'split-capture', amountCents: 10_000 })],
    releases: [
      release({
        releaseId: 'split-release-first',
        businessDate: '2026-07-24',
        amountCents: 4_000,
      }),
      release({
        releaseId: 'split-release-final',
        businessDate: '2026-07-25',
        amountCents: 6_000,
      }),
    ],
  })
  assert.equal(result.captures[0].status, 'settled')
  assert.equal(result.captures[0].allocatedCents, 10_000)
  assert.equal(result.captures[0].remainingCents, 0)
  assert.deepEqual(
    Array.from(result.captures[0].matchedReleaseIds),
    ['split-release-first', 'split-release-final'],
  )
  assert.deepEqual(
    Array.from(result.allocations, ({ releaseId, amountCents }) => [releaseId, amountCents]),
    [
      ['split-release-first', 4_000],
      ['split-release-final', 6_000],
    ],
  )
  assert.ok(result.releases.every((row) => row.status === 'settled'))
}

{
  const input = {
    asOfBusinessDate: '2026-07-26',
    overdueGraceDays: 3,
    captures: [
      capture({
        captureId: 'aggregate-capture-40',
        businessDate: '2026-07-23',
        amountCents: 4_000,
      }),
      capture({
        captureId: 'aggregate-capture-90',
        businessDate: '2026-07-24',
        amountCents: 9_000,
      }),
    ],
    releases: [
      release({
        releaseId: 'aggregate-release-100',
        businessDate: '2026-07-25',
        amountCents: 10_000,
      }),
      release({
        releaseId: 'aggregate-release-30',
        businessDate: '2026-07-26',
        amountCents: 3_000,
      }),
    ],
  }
  const before = JSON.stringify(input)
  const result = reconcilePosClearing(input)

  assert.equal(JSON.stringify(input), before, 'aggregate reconciliation must be immutable')
  assert.equal(result.allocations.length, 0, 'aggregate proof must not invent exact allocations')
  assert.ok(result.captures.every((row) => row.status === 'settled'))
  assert.ok(result.releases.every((row) => row.status === 'settled'))
  assert.ok(result.captures.every((row) => row.remainingCents === 0))
  assert.ok(result.releases.every((row) => row.remainingCents === 0))
  assert.equal(result.partitions[0].status, 'settled')
  assert.equal(result.partitions[0].capturedCents, 13_000)
  assert.equal(result.partitions[0].releasedCents, 13_000)
  assert.equal(result.partitions[0].allocatedCents, 13_000)
  assert.ok(result.captures.every((row) => row.matchedReleaseIds.length === 0))
  assert.ok(result.releases.every((row) => row.matchedCaptureIds.length === 0))
  assert.deepEqual(
    Array.from(byId(
      result.releases,
      'releaseId',
      'aggregate-release-100',
    ).ambiguousCandidateCaptureIds),
    ['aggregate-capture-40', 'aggregate-capture-90'],
  )
  assert.ok(Object.isFrozen(result.captures[0].sourceEvidence))
  assert.ok(Object.isFrozen(result.releases[0].sourceEvidence[0]))
}

{
  const result = reconcile({
    asOfBusinessDate: '2026-07-26',
    captures: [
      capture({
        captureId: 'reserved-capture-40',
        businessDate: '2026-07-23',
        amountCents: 4_000,
      }),
      capture({
        captureId: 'reserved-capture-90',
        businessDate: '2026-07-24',
        amountCents: 9_000,
      }),
    ],
    releases: [
      release({
        releaseId: 'ambiguous-release-100',
        businessDate: '2026-07-25',
        amountCents: 10_000,
      }),
      release({
        releaseId: 'later-exact-looking-release-40',
        businessDate: '2026-07-26',
        amountCents: 4_000,
      }),
    ],
  })

  assert.equal(result.allocations.length, 0)
  assert.equal(result.partitions[0].status, 'ambiguous')
  assert.equal(result.partitions[0].allocatedCents, 0)
  assert.ok(result.captures.every((row) => row.status === 'ambiguous'))
  assert.ok(result.captures.every((row) => row.allocatedCents === 0))
  assert.equal(
    byId(result.releases, 'releaseId', 'ambiguous-release-100').status,
    'ambiguous',
  )
  assert.deepEqual(
    Array.from(byId(
      result.releases,
      'releaseId',
      'ambiguous-release-100',
    ).ambiguousCandidateCaptureIds),
    ['reserved-capture-40', 'reserved-capture-90'],
  )
  assert.equal(
    byId(result.releases, 'releaseId', 'later-exact-looking-release-40').status,
    'ambiguous',
    'an earlier ambiguous debit must reserve its eligible captures from later exact matching',
  )
  assert.ok(result.releases.every((row) => row.allocatedCents === 0))
}

{
  const result = reconcile({
    asOfBusinessDate: '2026-07-26',
    captures: [
      capture({
        captureId: 'chronology-capture-before-overdraw',
        businessDate: '2026-07-23',
        amountCents: 4_000,
      }),
      capture({
        captureId: 'chronology-capture-after-overdraw',
        businessDate: '2026-07-25',
        amountCents: 9_000,
      }),
    ],
    releases: [
      release({
        releaseId: 'chronology-overdraw-release',
        businessDate: '2026-07-24',
        amountCents: 10_000,
      }),
      release({
        releaseId: 'chronology-later-release',
        businessDate: '2026-07-26',
        amountCents: 3_000,
      }),
    ],
  })

  assert.notEqual(result.partitions[0].status, 'settled')
  assert.ok(result.releases.some((row) => row.remainingCents > 0))
  assert.ok(result.captures.some((row) => row.remainingCents > 0))
  assert.equal(
    byId(result.releases, 'releaseId', 'chronology-overdraw-release').status,
    'partially_settled',
  )
  assert.equal(
    byId(result.releases, 'releaseId', 'chronology-overdraw-release').remainingCents,
    6_000,
    'a later capture must not cure the unsupported portion of an earlier debit',
  )
}

{
  const result = reconcile({
    asOfBusinessDate: '2026-07-26',
    captures: [
      capture({ captureId: 'cohort-ambiguous-a', amountCents: 5_000 }),
      capture({ captureId: 'cohort-ambiguous-b', amountCents: 5_000 }),
    ],
    releases: [
      release({
        releaseId: 'cohort-ambiguous-release-a',
        businessDate: '2026-07-25',
        amountCents: 5_000,
      }),
      release({
        releaseId: 'cohort-ambiguous-release-b',
        businessDate: '2026-07-26',
        amountCents: 5_000,
      }),
    ],
  })

  assert.equal(result.allocations.length, 0)
  assert.ok(result.captures.every((row) => row.status === 'settled'))
  assert.ok(result.releases.every((row) => row.status === 'settled'))
  assert.deepEqual(
    Array.from(result.releases[0].ambiguousCandidateCaptureIds),
    ['cohort-ambiguous-a', 'cohort-ambiguous-b'],
    'the many-to-many cohort must remain explicit instead of choosing an equal capture',
  )
}

{
  const otherLocationScope = { ...BASE_SCOPE, locationId: 'toast-other' }
  const result = reconcile({
    asOfBusinessDate: '2026-07-26',
    captures: [
      capture({ captureId: 'cohort-scope-base', amountCents: 4_000 }),
      capture({
        captureId: 'cohort-scope-other',
        scope: otherLocationScope,
        amountCents: 9_000,
      }),
    ],
    releases: [
      release({
        releaseId: 'cohort-scope-release-a',
        businessDate: '2026-07-25',
        amountCents: 10_000,
      }),
      release({
        releaseId: 'cohort-scope-release-b',
        businessDate: '2026-07-26',
        amountCents: 3_000,
      }),
    ],
  })

  assert.equal(result.allocations.length, 1)
  assert.notEqual(
    result.partitions.find((row) => row.scope.locationId === BASE_SCOPE.locationId).status,
    'settled',
  )
  assert.equal(
    byId(result.captures, 'captureId', 'cohort-scope-other').status,
    'pending',
    'aggregate reconciliation must not cross a location partition',
  )
}

{
  const result = reconcile({
    captures: [capture({ captureId: 'journal-only-capture', amountCents: 4_454 })],
    releases: [release({
      releaseId: 'journal-only-release',
      amountCents: 4_454,
      evidence: evidence('journal-only-debit', 'JournalEntry', '260725POS'),
    })],
  })
  assert.equal(result.releases[0].status, 'settled')
  assert.equal(result.releases[0].receiptBacked, false)
  assert.deepEqual(
    Array.from(result.releases[0].sourceEvidence, (item) => item.evidenceId),
    ['journal-only-debit'],
  )
}

{
  const result = reconcile({
    captures: [capture({ captureId: 'over-release-capture', amountCents: 4_000 })],
    releases: [release({ releaseId: 'over-release', amountCents: 10_000 })],
  })
  assert.equal(result.captures[0].status, 'settled')
  assert.equal(result.captures[0].remainingCents, 0)
  assert.equal(result.releases[0].status, 'partially_settled')
  assert.equal(result.releases[0].allocatedCents, 4_000)
  assert.equal(result.releases[0].remainingCents, 6_000)
  assert.ok(result.captures[0].remainingCents >= 0)
}

{
  const result = reconcile({
    captures: [
      capture({ captureId: 'ambiguous-a', amountCents: 5_000 }),
      capture({ captureId: 'ambiguous-b', amountCents: 5_000 }),
    ],
    releases: [release({ releaseId: 'ambiguous-release', amountCents: 5_000 })],
  })
  assert.equal(result.allocations.length, 0)
  assert.ok(result.captures.every((row) => row.status === 'ambiguous'))
  assert.equal(result.releases[0].status, 'ambiguous')
  assert.deepEqual(
    Array.from(result.releases[0].ambiguousCandidateCaptureIds),
    ['ambiguous-a', 'ambiguous-b'],
  )
}

{
  const result = reconcile({
    asOfBusinessDate: '2026-07-29',
    captures: [
      capture({
        captureId: 'overdue-capture',
        amountCents: 1_000,
        expectedSettlementBusinessDate: '2026-07-25',
      }),
      capture({
        captureId: 'pending-capture',
        amountCents: 2_000,
        expectedSettlementBusinessDate: '2026-07-30',
      }),
    ],
  })
  assert.equal(byId(result.captures, 'captureId', 'overdue-capture').status, 'overdue_unresolved')
  assert.equal(byId(result.captures, 'captureId', 'overdue-capture').dueBusinessDate, '2026-07-28')
  assert.equal(byId(result.captures, 'captureId', 'pending-capture').status, 'pending')
}

{
  const result = reconcile({
    asOfBusinessDate: '2026-09-25',
    captures: [capture({
      captureId: 'expired-window-capture',
      businessDate: '2026-07-23',
      expectedSettlementBusinessDate: '2026-07-25',
      amountCents: 4_454,
    })],
    releases: [release({
      releaseId: 'months-late-identical-release',
      businessDate: '2026-09-25',
      amountCents: 4_454,
    })],
  })
  assert.equal(result.allocations.length, 1)
  assert.equal(result.captures[0].status, 'settled')
  assert.equal(result.captures[0].remainingCents, 0)
  assert.equal(result.captures[0].dueBusinessDate, '2026-07-28')
  assert.equal(result.releases[0].status, 'settled')
  assert.deepEqual(
    Array.from(result.releases[0].matchedCaptureIds),
    ['expired-window-capture'],
  )
}

{
  const result = reconcile({
    asOfBusinessDate: '2026-09-25',
    captures: [capture({
      captureId: 'late-future-order-capture',
      businessDate: '2026-07-23',
      expectedSettlementBusinessDate: null,
      amountCents: 4_454,
    })],
    releases: [release({
      releaseId: 'late-future-order-exact-release',
      businessDate: '2026-09-25',
      amountCents: 4_454,
    })],
  })
  assert.equal(result.allocations.length, 1)
  assert.equal(result.captures[0].status, 'settled')
  assert.equal(result.captures[0].remainingCents, 0)
  assert.equal(result.releases[0].status, 'settled')
  assert.deepEqual(
    Array.from(result.releases[0].matchedCaptureIds),
    ['late-future-order-capture'],
  )
}

{
  const result = reconcile({
    asOfBusinessDate: '2026-09-25',
    captures: [capture({
      captureId: 'aged-capture-without-fulfillment-date',
      businessDate: '2026-07-23',
      expectedSettlementBusinessDate: null,
      amountCents: 4_454,
    })],
  })
  assert.equal(result.captures[0].status, 'pending')
  assert.equal(result.captures[0].remainingCents, 4_454)
}

{
  const result = reconcile({
    asOfBusinessDate: '2026-07-25',
    captures: [capture({
      captureId: 'future-capture',
      businessDate: '2026-07-25',
      expectedSettlementBusinessDate: '2026-07-28',
      amountCents: 4_454,
    })],
    releases: [release({
      releaseId: 'release-before-capture',
      businessDate: '2026-07-24',
      amountCents: 4_454,
    })],
  })
  assert.equal(result.allocations.length, 0)
  assert.equal(result.captures[0].status, 'pending')
  assert.equal(result.releases[0].status, 'overdue_unresolved')
}

{
  const result = reconcile({
    asOfBusinessDate: '2026-07-26',
    captures: [capture({
      captureId: 'undated-future-settlement',
      businessDate: '2026-07-23',
      expectedSettlementBusinessDate: null,
      amountCents: 1_000,
    })],
  })
  assert.equal(result.captures[0].dueBusinessDate, null)
  assert.equal(result.captures[0].status, 'pending')
}

{
  const otherOrgScope = { ...BASE_SCOPE, organizationId: 'org-other' }
  const otherCompanyScope = { ...BASE_SCOPE, quickBooksCompanyId: 'qbo-other' }
  const otherLocationScope = { ...BASE_SCOPE, locationId: 'toast-other' }
  const otherCurrencyScope = { ...BASE_SCOPE, currencyCode: 'CAD' }
  const otherAccountScope = { ...BASE_SCOPE, clearingAccountId: 'qbo-account-other' }
  const result = reconcile({
    captures: [
      capture({ captureId: 'scope-base', amountCents: 1_000 }),
      capture({ captureId: 'scope-org', amountCents: 1_000, scope: otherOrgScope }),
      capture({ captureId: 'scope-company', amountCents: 1_000, scope: otherCompanyScope }),
      capture({ captureId: 'scope-location', amountCents: 1_000, scope: otherLocationScope }),
      capture({ captureId: 'scope-currency', amountCents: 1_000, scope: otherCurrencyScope }),
      capture({ captureId: 'scope-account', amountCents: 1_000, scope: otherAccountScope }),
    ],
    releases: [release({ releaseId: 'scope-release', amountCents: 1_000 })],
  })
  assert.equal(byId(result.captures, 'captureId', 'scope-base').status, 'settled')
  assert.ok(
    result.captures
      .filter((row) => row.captureId !== 'scope-base')
      .every((row) => row.status === 'pending'),
    'no allocation may cross organization, company, location, currency, or clearing-account scope',
  )
  assert.equal(result.partitions.length, 6)
}

{
  const result = reconcile({
    captures: [
      capture({ captureId: 'sum-a', amountCents: 4_454 }),
      capture({ captureId: 'sum-b', amountCents: 9_526 }),
      capture({ captureId: 'sum-c', amountCents: 13_980 }),
    ],
    releases: [release({ releaseId: 'sum-release', amountCents: 13_980 })],
  })
  assert.equal(result.releases[0].status, 'ambiguous')
  assert.equal(result.allocations.length, 0)
}

{
  const result = reconcile({
    captures: [
      capture({ captureId: 'target-ambiguous-a', amountCents: 5_000 }),
      capture({ captureId: 'target-ambiguous-b', amountCents: 5_000 }),
      capture({
        captureId: 'later-exact-looking-capture',
        businessDate: '2026-07-25',
        amountCents: 5_000,
      }),
    ],
    releases: [
      release({
        releaseId: 'first-ambiguous-release',
        businessDate: '2026-07-24',
        amountCents: 5_000,
      }),
      release({
        releaseId: 'later-exact-looking-release',
        businessDate: '2026-07-25',
        amountCents: 5_000,
      }),
    ],
  })
  assert.equal(byId(result.releases, 'releaseId', 'first-ambiguous-release').status, 'ambiguous')
  assert.deepEqual(
    Array.from(byId(
      result.releases,
      'releaseId',
      'first-ambiguous-release',
    ).ambiguousCandidateCaptureIds),
    ['target-ambiguous-a', 'target-ambiguous-b'],
  )
  assert.deepEqual(
    Array.from(byId(
      result.releases,
      'releaseId',
      'later-exact-looking-release',
    ).ambiguousCandidateCaptureIds),
    ['target-ambiguous-a', 'target-ambiguous-b', 'later-exact-looking-capture'],
    'a later exact-looking capture must join the unresolved account cohort instead of matching',
  )
  assert.ok(
    result.captures.every((row) => row.status === 'ambiguous'),
    'the unresolved account cohort must reserve every open capture',
  )
  assert.ok(result.releases.every((row) => row.status === 'ambiguous'))
  assert.equal(result.allocations.length, 0)
}

{
  const captures = Array.from({ length: 33 }, (_, index) => capture({
    captureId: `bounded-${String(index).padStart(2, '0')}`,
    amountCents: index + 1,
  }))
  const result = reconcile({
    captures,
    releases: [release({ releaseId: 'bounded-release', amountCents: 561 })],
  })
  assert.equal(result.releases[0].status, 'settled')
  assert.equal(result.allocations.length, 0)
  assert.equal(result.releases[0].ambiguousCandidateCaptureIds.length, 33)
  assert.ok(
    result.captures.every((row) => row.status === 'settled'),
    'a bounded aggregate cohort may settle when its chronological account balance reaches zero',
  )
  assert.ok(result.captures.every((row) => row.matchedReleaseIds.length === 0))
  assert.equal(result.partitions[0].allocatedCents, 561)
}

assert.throws(
  () => reconcile({
    captures: [capture({ captureId: 'receipt-only-capture', amountCents: 1_000 })],
    releases: [release({
      releaseId: 'receipt-only-release',
      amountCents: 1_000,
      evidence: evidence('receipt-without-journal', 'SalesReceipt', '260725POS'),
    })],
  }),
  /must include the clearing debit JournalEntry/,
)

assert.throws(
  () => reconcile({
    captures: [capture({ captureId: 'fractional', amountCents: 44.54 })],
  }),
  /positive integer number of cents/,
)

assert.throws(
  () => reconcile({
    captures: [
      capture({
        captureId: 'duplicate-evidence-a',
        amountCents: 1_000,
        evidence: evidence('duplicate-evidence', 'JournalEntry', 'A'),
      }),
      capture({
        captureId: 'duplicate-evidence-b',
        amountCents: 1_000,
        evidence: evidence('duplicate-evidence', 'JournalEntry', 'B'),
      }),
    ],
  }),
  /Duplicate evidenceId/,
)

console.log('POS clearing reconciliation tests passed')
