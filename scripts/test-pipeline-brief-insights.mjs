#!/usr/bin/env node
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import ts from '../app_src/node_modules/typescript/lib/typescript.js'

const source = readFileSync(resolve(process.cwd(), 'app_src/lib/pipelineBrief.ts'), 'utf8')
const transpiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.ESNext,
    target: ts.ScriptTarget.ES2022,
  },
}).outputText
const moduleUrl = `data:text/javascript;base64,${Buffer.from(transpiled).toString('base64')}`
const { buildPipelineEngagementInsights } = await import(moduleUrl)

const opportunity = (overrides = {}) => ({
  referenceCode: 'go1000001',
  name: 'Example opportunity',
  organization: 'Example Co',
  stage: 'Proposal',
  status: 'Open',
  value: 100_000,
  probability: 50,
  expectedClose: '2026-08-01',
  touches30d: 1,
  touches90d: 2,
  totalTouches: 2,
  inbound30d: 0,
  outbound30d: 1,
  email30d: 1,
  call30d: 0,
  meeting30d: 0,
  lastTouchAt: '2026-07-16T12:00:00.000Z',
  ...overrides,
})

const insights = buildPipelineEngagementInsights([
  opportunity({
    referenceCode: 'go1000002',
    name: 'Untouched overdue deal',
    totalTouches: 0,
    touches30d: 0,
    touches90d: 0,
    lastTouchAt: null,
    expectedClose: '2026-07-01',
  }),
  opportunity({
    referenceCode: 'go1000003',
    name: 'High-touch proposal',
    touches30d: 6,
    touches90d: 8,
    totalTouches: 8,
  }),
  opportunity({
    referenceCode: 'go1000004',
    name: 'Stale qualified deal',
    stage: 'Qualified Lead',
    lastTouchAt: '2026-06-20T12:00:00.000Z',
    expectedClose: '2026-09-01',
  }),
  opportunity({
    referenceCode: 'go1000005',
    name: 'Current qualified deal',
    stage: 'Qualified Lead',
    expectedClose: '2026-07-30',
  }),
], new Date('2026-07-17T12:00:00.000Z'))

assert.equal(insights.untouched, 1)
assert.equal(insights.stale, 1)
assert.equal(insights.overdueCloseDates, 1)
assert.equal(insights.closingWithin30Days, 2)
assert.equal(insights.opportunities[0].referenceCode, 'go1000002')
assert.equal(insights.opportunities.find((item) => item.referenceCode === 'go1000002')?.cadence, 'no-history')
assert.match(
  insights.opportunities.find((item) => item.referenceCode === 'go1000002')?.recommendedAction || '',
  /first opportunity touch/,
)
assert.equal(insights.opportunities.find((item) => item.referenceCode === 'go1000003')?.cadence, 'above-normal')
assert.equal(insights.opportunities.find((item) => item.referenceCode === 'go1000004')?.cadence, 'lagging')
assert.equal(insights.stageBenchmarks.find((item) => item.stage === 'Proposal')?.medianTouches30d, 3)
assert.equal(insights.stageBenchmarks.find((item) => item.stage === 'Qualified Lead')?.medianTouches30d, 1)

console.log('pipeline brief engagement insight tests passed')
