#!/usr/bin/env node
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const requireFromApp = createRequire(resolve(repo, 'app_src', 'package.json'))
const matter = requireFromApp('gray-matter')

const requiredCurrentDocuments = [
  'docs/index.md',
  'docs/maps/context-map.md',
  'docs/maps/product-map.md',
  'docs/maps/platform-data-map.md',
  'docs/maps/operations-map.md',
  'docs/maps/evolution-map.md',
  'docs/decisions/index.md',
  'docs/decisions/0001-postgres-and-sheets-authority.md',
  'docs/decisions/0002-organization-rooted-tenancy.md',
  'docs/decisions/0003-crm-global-identity-and-sync.md',
  'docs/decisions/0004-local-first-knowledge-retrieval.md',
  'docs/decisions/0005-multi-workspace-membership.md',
  'docs/modules/application-shell-and-access.md',
  'docs/modules/projects-and-tenancy.md',
  'docs/modules/pipeline-and-sync.md',
  'docs/modules/crm-and-reporting.md',
  'docs/modules/agents-and-execution.md',
  'docs/modules/knowledge-releases-and-checkpoints.md',
  'docs/modules/short-links.md',
  'docs/modules/user-integrations.md',
  'docs/modules/toast-and-accounting.md',
  'docs/modules/quickbooks-accounting.md',
  'docs/operations/clawpilot-environments.md',
  'docs/operations/public-demo-environment.md',
  'docs/operations/agent-security-and-isolation.md',
  'docs/operations/knowledge-vault-organization.md',
  'docs/operations/printing-carrier-billing-and-gl-coding.md',
  'docs/operations/local-print-agent.md',
  'docs/releases/README.md',
  'docs/brand/clawpilot-identity.md',
]
const navigationDocuments = ['docs/README.md', 'docs/index.md']
const requiredFields = ['id', 'title', 'summary', 'status', 'kind', 'area', 'tags', 'app_visible']
const validStatuses = new Set(['draft', 'active', 'superseded', 'historical', 'generated'])
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
  'templates',
])

function parseDocument(source, path) {
  const parsed = matter(source)
  assert.ok(source.startsWith('---\n'), `${path} is missing YAML frontmatter`)
  return { source, content: parsed.content, metadata: parsed.data }
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

function assertMetadata(relativePath, metadata) {
  for (const field of requiredFields) {
    assert.ok(Object.hasOwn(metadata, field), `${relativePath} is missing frontmatter field ${field}`)
  }
  assert.match(String(metadata.id), /^cp-[a-z0-9-]+$/, `${relativePath} has an invalid stable id`)
  assert.ok(String(metadata.title || '').trim(), `${relativePath} has an empty title`)
  assert.ok(String(metadata.summary || '').trim().length >= 20, `${relativePath} needs a useful one-line summary`)
  assert.ok(validStatuses.has(String(metadata.status)), `${relativePath} has an invalid status`)
  assert.ok(String(metadata.kind || '').trim(), `${relativePath} has an empty kind`)
  assert.ok(String(metadata.area || '').trim(), `${relativePath} has an empty area`)
  assert.ok(Array.isArray(metadata.tags) && metadata.tags.length > 0, `${relativePath} needs at least one tag`)
  assert.equal(typeof metadata.app_visible, 'boolean', `${relativePath} app_visible must be a boolean`)
}

function assertLinks(relativePath, source) {
  const absolutePath = resolve(repo, relativePath)
  for (const link of relativeLinks(source)) {
    const target = resolve(dirname(absolutePath), link)
    assert.ok(existsSync(target), `${relativePath} links to missing file ${link}`)
  }
}

const vaultDocuments = markdownFiles(resolve(repo, 'docs'))
  .map((absolutePath) => ({ absolutePath, relativePath: repoPath(absolutePath) }))
  .filter(({ relativePath }) => !relativePath.startsWith('docs/templates/'))
  .map(({ absolutePath, relativePath }) => ({
    absolutePath,
    relativePath,
    ...parseDocument(readFileSync(absolutePath, 'utf8'), relativePath),
  }))

const ids = new Map()
for (const document of vaultDocuments) {
  assertMetadata(document.relativePath, document.metadata)
  assertLinks(document.relativePath, document.source)
  const existing = ids.get(document.metadata.id)
  assert.ok(!existing, `${document.relativePath} duplicates id ${document.metadata.id} from ${existing}`)
  ids.set(document.metadata.id, document.relativePath)
}

const currentDocuments = vaultDocuments.filter(({ metadata }) => (
  metadata.status === 'active' && metadata.app_visible === true
))
const requiredSet = new Set(requiredCurrentDocuments)
for (const document of currentDocuments) {
  assert.ok(requiredSet.has(document.relativePath), `${document.relativePath} is active and app-visible but is not in the required current catalog`)
  for (const forbidden of forbiddenActiveReferences) {
    assert.ok(!document.source.includes(forbidden), `${document.relativePath} contains stale runtime reference ${forbidden}`)
  }
}
assert.equal(currentDocuments.length, requiredCurrentDocuments.length, 'required current catalog and discovered active documents differ')
for (const relativePath of requiredCurrentDocuments) {
  assert.ok(currentDocuments.some((document) => document.relativePath === relativePath), `document is missing from current catalog: ${relativePath}`)
}

const vaultMap = vaultDocuments.find((document) => document.relativePath === 'docs/README.md')
assert.ok(vaultMap, 'docs/README.md is missing')
assert.equal(vaultMap.metadata.status, 'active', 'docs/README.md must be active')
assert.equal(vaultMap.metadata.app_visible, false, 'docs/README.md must remain vault-only')
const index = readFileSync(resolve(repo, 'docs/index.md'), 'utf8')
for (const relativePath of requiredCurrentDocuments) {
  const target = relativePath.replace(/^docs\//, '')
  if (relativePath !== 'docs/index.md') {
    assert.ok(index.includes(`](${target})`), `docs/index.md does not link ${relativePath}`)
  }
  assert.ok(vaultMap.source.includes(`](${target})`), `docs/README.md does not link ${relativePath}`)
}

for (const relativePath of navigationDocuments) {
  const source = readFileSync(resolve(repo, relativePath), 'utf8')
  for (const heading of ['Build And Release Trail', 'Historical Archive']) {
    assert.ok(source.includes(`## ${heading}`), `${relativePath} is missing the ${heading} section`)
  }
}

const visibleDocuments = vaultDocuments.filter(({ metadata }) => metadata.app_visible === true)
const visiblePaths = new Set(visibleDocuments.map(({ relativePath }) => relativePath))
const mocPaths = new Set(visibleDocuments
  .filter(({ metadata }) => metadata.kind === 'map-of-content')
  .map(({ relativePath }) => relativePath))
const inbound = new Map(visibleDocuments.map(({ relativePath }) => [relativePath, new Set()]))
for (const source of visibleDocuments) {
  const localTargets = relativeLinks(source.source)
    .map((link) => repoPath(resolve(dirname(source.absolutePath), link)))
    .filter((target) => visiblePaths.has(target))
  for (const target of localTargets) inbound.get(target)?.add(source.relativePath)
  if (source.metadata.kind === 'map-of-content') {
    assert.ok(new Set(localTargets).size >= 3, `${source.relativePath} needs at least three visible knowledge links`)
  }
}
for (const document of visibleDocuments) {
  if (document.relativePath === 'docs/index.md' || document.metadata.kind === 'map-of-content') continue
  const sources = inbound.get(document.relativePath) || new Set()
  assert.ok(sources.size > 0, `${document.relativePath} is orphaned from the visible knowledge graph`)
  assert.ok([...sources].some((source) => mocPaths.has(source)), `${document.relativePath} is not connected from a Map of Content`)
}

const obsidianApp = JSON.parse(readFileSync(resolve(repo, '.obsidian/app.json'), 'utf8'))
assert.equal(obsidianApp.alwaysUpdateLinks, true, 'Obsidian must update internal links after note moves')
assert.equal(obsidianApp.newFileFolderPath, 'docs', 'new Obsidian notes must default to docs/')
assert.equal(obsidianApp.useMarkdownLinks, true, 'Obsidian must preserve portable Markdown links')
const corePlugins = JSON.parse(readFileSync(resolve(repo, '.obsidian/core-plugins.json'), 'utf8'))
assert.ok(Array.isArray(corePlugins), 'Obsidian core plugins must be an array')
for (const plugin of corePlugins) assert.ok(allowedCorePlugins.has(plugin), `unexpected Obsidian core plugin: ${plugin}`)
assert.ok(corePlugins.includes('templates'), 'Obsidian templates must be enabled')
const templates = JSON.parse(readFileSync(resolve(repo, '.obsidian/templates.json'), 'utf8'))
assert.equal(templates.folder, 'docs/templates', 'Obsidian templates must use docs/templates')
for (const template of ['decision-record.md', 'module-contract.md', 'incident.md', 'research-note.md']) {
  assert.ok(existsSync(resolve(repo, 'docs/templates', template)), `missing Obsidian template ${template}`)
}
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

const edgeCount = [...inbound.values()].reduce((count, sources) => count + sources.size, 0)
console.log(`PASS verify-doc-catalog (${currentDocuments.length} current, ${visibleDocuments.length} indexed, ${edgeCount} graph edges, ${corePlugins.length} portable core plugins)`)
