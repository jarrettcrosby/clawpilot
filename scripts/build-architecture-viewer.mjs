#!/usr/bin/env node
// Deterministic, offline build: no npm tool install, provider keys, or AI runtime.
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { layouts } from '../tools/architecture/layouts.mjs'
import { renderArchitecture, validateDiagrams } from '../tools/architecture/renderer.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const tool = join(root, 'tools/architecture')
const output = join(root, 'app_src/server-assets/architecture')
const sha = (value) => createHash('sha256').update(value).digest('hex')
const sources = ['catalog.json', 'layouts.mjs', 'renderer.mjs', 'viewer.html', 'viewer.js', 'NOTICE.md', 'LICENSE.diagram-design']
const sourceHash = sha(Buffer.concat([
  ...sources.map((name) => Buffer.concat([Buffer.from(name), readFileSync(join(tool, name))])),
  readFileSync(fileURLToPath(import.meta.url)),
]))
const catalog = JSON.parse(readFileSync(join(tool, 'catalog.json'), 'utf8'))
validateDiagrams(catalog, layouts, root)
const manifestPath = join(output, 'manifest.json')
const htmlPath = join(output, 'viewer.html')
try {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  if (!process.argv.includes('--force') && manifest.format === 2 && manifest.sourceHash === sourceHash && manifest.htmlHash === sha(readFileSync(htmlPath))) {
    console.log(`Diagram Design viewer current (${sourceHash.slice(0, 12)})`)
    process.exit(0)
  }
} catch { /* Missing or stale output is rebuilt. */ }
const preflight = spawnSync(process.execPath, [join(root, 'scripts/local-storage-guard.mjs'), '--preflight'], { cwd: root, stdio: 'inherit' })
if (preflight.error || preflight.status !== 0) throw preflight.error || new Error('Architecture disk preflight failed')
const html = renderArchitecture(catalog, layouts, readFileSync(join(tool, 'viewer.html'), 'utf8'), readFileSync(join(tool, 'viewer.js'), 'utf8'))
if (!html.includes('diagram-design-root') || /<(?:script|link|img|iframe)\b[^>]*(?:src|href)=/i.test(html) || /@import\b|url\(\s*["']?(?:https?:|\/\/)/i.test(html)) throw new Error('Architecture output must remain self-contained')
const manifest = {
  format: 2, sourceHash, htmlHash: sha(html), bytes: Buffer.byteLength(html),
  renderer: 'Diagram Design', toolVersion: '2.6.68',
  upstreamCommit: 'f4547ee95f88e5b28a52517feff6b6c11cc657f9',
  views: catalog.map((entry) => entry.id),
}
await mkdir(output, { recursive: true })
await writeFile(join(output, 'viewer.html.tmp'), html)
await rename(join(output, 'viewer.html.tmp'), htmlPath)
await writeFile(join(output, 'manifest.json.tmp'), `${JSON.stringify(manifest, null, 2)}\n`)
await rename(join(output, 'manifest.json.tmp'), manifestPath)
console.log(`Private Diagram Design viewer built: ${manifest.bytes} bytes; ${manifest.views.length} views; source ${sourceHash.slice(0, 12)}`)
