#!/usr/bin/env node

// Build-time only. No provider keys, application .env, AI adapters, or server are
// passed to LikeC4. The only published output is a private, self-contained HTML.
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { copyFile, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const tool = join(root, 'tools/architecture')
const output = join(root, 'app_src/server-assets/architecture')
const sha = (value) => createHash('sha256').update(value).digest('hex')
const sources = ['model.c4', 'likec4.config.json', 'package.json', 'package-lock.json']
const sourceHash = sha(Buffer.concat([
  ...sources.map((name) => Buffer.concat([Buffer.from(name), readFileSync(join(tool, name))])),
  readFileSync(fileURLToPath(import.meta.url)),
]))
const manifestPath = join(output, 'manifest.json')
const htmlPath = join(output, 'viewer.html')
try {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  if (!process.argv.includes('--force') && manifest.sourceHash === sourceHash && manifest.htmlHash === sha(readFileSync(htmlPath))) {
    console.log(`Architecture viewer current (${sourceHash.slice(0, 12)})`)
    process.exit(0)
  }
} catch { /* Missing or stale artifacts must be rebuilt, never served as current. */ }

function run(command, args, cwd, env) {
  const child = spawnSync(command, args, { cwd, env, stdio: 'inherit' })
  if (child.error || child.status !== 0) throw child.error || new Error(`Architecture build command failed (${child.status})`)
}

// Run the same local headroom gate even when invoked via app_src or Vercel.
run(process.execPath, [join(root, 'scripts/local-storage-guard.mjs'), '--preflight'], root, process.env)
const temporary = await mkdtemp(join(tmpdir(), 'clawpilot-architecture-build-'))
try {
  const env = {
    PATH: `${dirname(process.execPath)}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH || ''}`,
    TMPDIR: temporary, CI: '1', NO_COLOR: '1', LANG: 'C.UTF-8',
  }
  // Install only inside this owned temporary workspace. The deployed application
  // gets HTML, not the LikeC4 compiler/dependency tree or optional AI packages.
  const compilerDirectory = join(temporary, 'compiler')
  await mkdir(compilerDirectory)
  for (const name of ['package.json', 'package-lock.json']) await copyFile(join(tool, name), join(compilerDirectory, name))
  run('npm', ['ci', '--include=dev', '--ignore-scripts', '--no-audit', '--no-fund', `--cache=${join(homedir(), '.npm')}`, '--userconfig=/dev/null', `--globalconfig=${join(temporary, 'no-global-npmrc')}`], compilerDirectory, env)
  const workspace = join(temporary, 'model')
  await mkdir(workspace)
  for (const name of ['model.c4', 'likec4.config.json', 'package.json']) await copyFile(join(tool, name), join(workspace, name))
  await symlink(join(compilerDirectory, 'node_modules'), join(workspace, 'node_modules'), 'dir')
  const cli = join(compilerDirectory, 'node_modules/likec4/bin/likec4.mjs')
  run(process.execPath, [cli, 'validate', workspace], workspace, env)
  run(process.execPath, [cli, 'build', workspace, '--output', join(temporary, 'dist'), '--output-single-file', '--base', './', '--use-hash-history'], workspace, env)
  // Vite's single-file plugin leaves the optional favicon as a separate file.
  // The embedded viewer needs no favicon and must not request an asset route.
  const html = (await readFile(join(temporary, 'dist/index.html'), 'utf8'))
    .replace(/<link\b[^>]*rel=["'](?:shortcut )?icon["'][^>]*>/gi, '')
  const markup = html.replace(/(<script\b[^>]*>)[\s\S]*?<\/script\s*>/gi, '$1</script>')
    .replace(/(<style\b[^>]*>)[\s\S]*?<\/style\s*>/gi, '$1</style>')
  if (!html.includes('likec4-root') || /<(?:script|link)\b[^>]*(?:src|href)=["'](?!data:|#)/i.test(markup)) {
    throw new Error('Architecture output is not self-contained')
  }
  const manifest = {
    format: 1, sourceHash, htmlHash: sha(html), bytes: Buffer.byteLength(html),
    toolVersion: JSON.parse(readFileSync(join(tool, 'package.json'), 'utf8')).devDependencies.likec4,
    views: ['index', 'runtimeData', 'commerceAccounting', 'domainsAndEnvironments'],
  }
  await mkdir(output, { recursive: true })
  // Atomic replacement keeps interrupted builds from publishing partial HTML.
  await writeFile(join(output, 'viewer.html.tmp'), html)
  await rename(join(output, 'viewer.html.tmp'), htmlPath)
  await writeFile(join(output, 'manifest.json.tmp'), `${JSON.stringify(manifest, null, 2)}\n`)
  await rename(join(output, 'manifest.json.tmp'), manifestPath)
  console.log(`Private architecture viewer built: ${manifest.bytes} bytes; source ${sourceHash.slice(0, 12)}`)
} finally {
  // Only this freshly allocated build workspace, never repository/runtime data.
  await rm(temporary, { recursive: true, force: true })
}
