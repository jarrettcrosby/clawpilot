#!/usr/bin/env node
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const catalog = [
  'docs/index.md',
  'docs/modules/application-shell-and-access.md',
  'docs/modules/projects-and-tenancy.md',
  'docs/modules/pipeline-and-sync.md',
  'docs/modules/agents-and-execution.md',
  'docs/modules/knowledge-releases-and-checkpoints.md',
  'docs/operations/clawpilot-environments.md',
  'docs/releases/README.md',
  'docs/brand/clawpilot-identity.md',
]
const requiredFields = ['title', 'status', 'kind', 'tags', 'app_visible']
const forbiddenActiveReferences = [
  '/Desktop/clawd-app-dev',
  '/Desktop/clawd-app/',
  '/.openclaw/workspace/second-brain',
]

function frontmatter(source, path) {
  const match = source.match(/^---\n([\s\S]*?)\n---\n/)
  assert.ok(match, `${path} is missing YAML frontmatter`)
  const values = Object.fromEntries(match[1].split('\n').flatMap((line) => {
    const field = line.match(/^([a-z_]+):\s*(.*)$/)
    return field ? [[field[1], field[2].trim()]] : []
  }))
  const fields = new Set(Object.keys(values))
  for (const field of requiredFields) assert.ok(fields.has(field), `${path} is missing frontmatter field ${field}`)
  assert.equal(values.status, 'active', `${path} must be explicitly active`)
  assert.equal(values.app_visible, 'true', `${path} must be visible in the app`)
}

function relativeLinks(source) {
  return Array.from(source.matchAll(/\[[^\]]+\]\(([^)]+)\)/g), match => match[1])
    .filter(link => !/^(?:https?:|mailto:|#)/i.test(link))
    .map(link => link.split('#')[0])
    .filter(Boolean)
}

for (const relativePath of catalog) {
  const absolutePath = resolve(repo, relativePath)
  assert.ok(existsSync(absolutePath), `catalog document is missing: ${relativePath}`)
  const source = readFileSync(absolutePath, 'utf8')
  frontmatter(source, relativePath)
  for (const forbidden of forbiddenActiveReferences) {
    assert.ok(!source.includes(forbidden), `${relativePath} contains stale runtime reference ${forbidden}`)
  }
  for (const link of relativeLinks(source)) {
    const target = resolve(dirname(absolutePath), link)
    assert.ok(existsSync(target), `${relativePath} links to missing file ${link}`)
  }
}

const index = readFileSync(resolve(repo, 'docs/index.md'), 'utf8')
for (const relativePath of catalog.slice(1)) {
  const target = relativePath.replace(/^docs\//, '')
  assert.ok(index.includes(`](${target})`), `docs/index.md does not link ${relativePath}`)
}

const releases = JSON.parse(readFileSync(resolve(repo, 'docs/releases/catalog.json'), 'utf8'))
const defaultRelease = releases?.releases?.default
assert.equal(releases?.schemaVersion, 1, 'release catalog schemaVersion must be 1')
assert.ok(defaultRelease?.title && defaultRelease?.summary, 'release catalog default entry needs title and summary')
assert.ok(Array.isArray(defaultRelease?.features) && defaultRelease.features.length > 0, 'release catalog needs feature notes')
assert.ok(Array.isArray(defaultRelease?.fixes) && defaultRelease.fixes.length > 0, 'release catalog needs fix notes')
assert.equal(defaultRelease?.oncePerEnvironment, true, 'default release copy must be one-time per environment')

console.log(`PASS verify-doc-catalog (${catalog.length} current documents)`)
