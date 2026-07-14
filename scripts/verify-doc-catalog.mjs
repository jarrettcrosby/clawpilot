#!/usr/bin/env node
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const requiredCurrentDocuments = [
  'docs/index.md',
  'docs/modules/application-shell-and-access.md',
  'docs/modules/projects-and-tenancy.md',
  'docs/modules/pipeline-and-sync.md',
  'docs/modules/crm-and-reporting.md',
  'docs/modules/agents-and-execution.md',
  'docs/modules/knowledge-releases-and-checkpoints.md',
  'docs/modules/short-links.md',
  'docs/modules/user-integrations.md',
  'docs/operations/clawpilot-environments.md',
  'docs/operations/knowledge-vault-organization.md',
  'docs/releases/README.md',
  'docs/brand/clawpilot-identity.md',
]
const navigationDocuments = ['docs/README.md', 'docs/index.md']
const requiredFields = ['title', 'status', 'kind', 'tags', 'app_visible']
const forbiddenActiveReferences = [
  '/Desktop/clawd-app-dev',
  '/Desktop/clawd-app/',
  '/.openclaw/workspace/second-brain',
]
const allowedCorePlugins = new Set([
  'file-explorer',
  'global-search',
  'switcher',
  'graph',
  'backlink',
  'outgoing-link',
  'tag-pane',
  'properties',
])

function frontmatter(source, path) {
  const match = source.match(/^---\n([\s\S]*?)\n---\n/)
  assert.ok(match, `${path} is missing YAML frontmatter`)
  const values = Object.fromEntries(match[1].split('\n').flatMap((line) => {
    const field = line.match(/^([a-z_]+):\s*(.*)$/)
    return field ? [[field[1], field[2].trim()]] : []
  }))
  return values
}

function relativeLinks(source) {
  return Array.from(source.matchAll(/\[[^\]]+\]\(([^)]+)\)/g), match => match[1])
    .filter(link => !/^(?:https?:|mailto:|obsidian:|#)/i.test(link))
    .map(link => decodeURIComponent(link.split('#')[0].split('?')[0]))
    .filter(Boolean)
}

function markdownFiles(root) {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(root, entry.name)
    if (entry.isDirectory()) return markdownFiles(path)
    return entry.isFile() && entry.name.toLowerCase().endsWith('.md') ? [path] : []
  })
}

function repoPath(absolutePath) {
  return relative(repo, absolutePath).split(sep).join('/')
}

function assertFrontmatter(relativePath, expected = {}) {
  const absolutePath = resolve(repo, relativePath)
  assert.ok(existsSync(absolutePath), `document is missing: ${relativePath}`)
  const source = readFileSync(absolutePath, 'utf8')
  const metadata = frontmatter(source, relativePath)
  const fields = new Set(Object.keys(metadata))
  for (const field of requiredFields) assert.ok(fields.has(field), `${relativePath} is missing frontmatter field ${field}`)
  for (const [field, value] of Object.entries(expected)) {
    assert.equal(metadata[field], value, `${relativePath} must set ${field}: ${value}`)
  }
  return { source, metadata }
}

function assertLinks(relativePath, source) {
  const absolutePath = resolve(repo, relativePath)
  for (const link of relativeLinks(source)) {
    const target = resolve(dirname(absolutePath), link)
    assert.ok(existsSync(target), `${relativePath} links to missing file ${link}`)
  }
}

for (const relativePath of requiredCurrentDocuments) {
  const { source } = assertFrontmatter(relativePath, { status: 'active', app_visible: 'true' })
  for (const forbidden of forbiddenActiveReferences) {
    assert.ok(!source.includes(forbidden), `${relativePath} contains stale runtime reference ${forbidden}`)
  }
  assertLinks(relativePath, source)
}

const currentDocuments = markdownFiles(resolve(repo, 'docs'))
  .map((absolutePath) => ({ absolutePath, relativePath: repoPath(absolutePath) }))
  .flatMap(({ absolutePath, relativePath }) => {
    const source = readFileSync(absolutePath, 'utf8')
    const match = source.match(/^---\n([\s\S]*?)\n---\n/)
    if (!match) return []
    const metadata = frontmatter(source, relativePath)
    return metadata.status === 'active' && metadata.app_visible === 'true'
      ? [{ relativePath, source }]
      : []
  })

const requiredSet = new Set(requiredCurrentDocuments)
for (const { relativePath, source } of currentDocuments) {
  assert.ok(requiredSet.has(relativePath), `${relativePath} is active and app-visible but is not in the required current catalog`)
  assertLinks(relativePath, source)
}
assert.equal(currentDocuments.length, requiredCurrentDocuments.length, 'required current catalog and discovered active documents differ')

const { source: vaultMap } = assertFrontmatter('docs/README.md', { status: 'active', app_visible: 'false' })
assertLinks('docs/README.md', vaultMap)
const index = readFileSync(resolve(repo, 'docs/index.md'), 'utf8')
for (const relativePath of requiredCurrentDocuments) {
  const target = relativePath.replace(/^docs\//, '')
  if (relativePath !== 'docs/index.md') {
    assert.ok(index.includes(`](${target})`), `docs/index.md does not link ${relativePath}`)
  }
  assert.ok(vaultMap.includes(`](${target})`), `docs/README.md does not link ${relativePath}`)
}

for (const relativePath of navigationDocuments) {
  const source = readFileSync(resolve(repo, relativePath), 'utf8')
  for (const heading of ['Build And Release Trail', 'Historical Archive']) {
    assert.ok(source.includes(`## ${heading}`), `${relativePath} is missing the ${heading} section`)
  }
}

const obsidianApp = JSON.parse(readFileSync(resolve(repo, '.obsidian/app.json'), 'utf8'))
assert.equal(obsidianApp.alwaysUpdateLinks, true, 'Obsidian must update internal links after note moves')
assert.equal(obsidianApp.newFileFolderPath, 'docs', 'new Obsidian notes must default to docs/')
assert.equal(obsidianApp.useMarkdownLinks, true, 'Obsidian must preserve portable Markdown links')
const corePlugins = JSON.parse(readFileSync(resolve(repo, '.obsidian/core-plugins.json'), 'utf8'))
assert.ok(Array.isArray(corePlugins), 'Obsidian core plugins must be an array')
for (const plugin of corePlugins) assert.ok(allowedCorePlugins.has(plugin), `unexpected Obsidian core plugin: ${plugin}`)
for (const forbiddenPath of [
  '.obsidian/workspace.json',
  '.obsidian/workspace-mobile.json',
  '.obsidian/community-plugins.json',
  '.obsidian/plugins',
]) {
  assert.ok(!existsSync(resolve(repo, forbiddenPath)), `${forbiddenPath} must not be committed`)
}
assert.ok(statSync(resolve(repo, '.obsidian/.gitignore')).isFile(), '.obsidian/.gitignore is required')

const releases = JSON.parse(readFileSync(resolve(repo, 'docs/releases/catalog.json'), 'utf8'))
const defaultRelease = releases?.releases?.default
assert.equal(releases?.schemaVersion, 1, 'release catalog schemaVersion must be 1')
assert.ok(defaultRelease?.title && defaultRelease?.summary, 'release catalog default entry needs title and summary')
assert.ok(Array.isArray(defaultRelease?.features) && defaultRelease.features.length > 0, 'release catalog needs feature notes')
assert.ok(Array.isArray(defaultRelease?.fixes) && defaultRelease.fixes.length > 0, 'release catalog needs fix notes')
assert.equal(defaultRelease?.oncePerEnvironment, true, 'default release copy must be one-time per environment')

console.log(`PASS verify-doc-catalog (${currentDocuments.length} current documents, ${corePlugins.length} portable core plugins)`)
