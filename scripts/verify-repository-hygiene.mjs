#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { basename, resolve } from 'node:path'

const root = process.cwd()
const MAX_TRACKED_FILE_BYTES = 5 * 1024 * 1024

function fail(messages) {
  console.error('repository hygiene check failed:')
  for (const message of messages) console.error(`- ${message}`)
  process.exit(1)
}

function trackedFiles() {
  const output = execFileSync('git', ['ls-files', '-z'], { cwd: root })
  return output.toString('utf8').split('\0').filter(Boolean)
}

function isEnvironmentFile(path) {
  const name = basename(path)
  if (!name.startsWith('.env')) return false
  return name !== '.env.example' && !/^\.env\..+\.example$/.test(name)
}

function forbiddenReason(path) {
  if (isEnvironmentFile(path)) return 'environment file is not an explicitly named example'
  if (/(^|\/)\.DS_Store$/.test(path)) return 'macOS metadata is generated locally'
  if (/\.log$/i.test(path)) return 'log files are runtime evidence'
  if (/\.tsbuildinfo$/i.test(path)) return 'TypeScript build metadata is generated'
  if (/(^|\/)node_modules\//.test(path)) return 'dependencies must be installed, not committed'
  if (/^(?:\.next|\.vercel|\.railway|coverage|dist|backups)(?:\/|$)/.test(path)) return 'root build or platform state is local-only'
  if (/^app_src\/(?:\.next|test-results|playwright-report|coverage|dist)(?:\/|$)/.test(path)) return 'application test or build output is generated'
  if (/^data(?:-dev)?\//.test(path) && !/^data(?:-dev)?\/README\.md$/.test(path)) {
    return 'runtime data is not portable source code'
  }
  return null
}

const requiredPaths = [
  'README.md',
  'AGENTS.md',
  'CONTRIBUTING.md',
  'package.json',
  'app_src/package.json',
  'app_src/package-lock.json',
  'app_src/vercel.json',
  'railway.json',
  'docs/index.md',
  'docs/README.md',
  'db/README.md',
  'scripts/dev-start.sh',
  'scripts/regression-all.sh',
  'scripts/verify-predeploy.mjs',
  'scripts/verify-repository-hygiene.mjs',
]

const errors = []
for (const path of requiredPaths) {
  if (!existsSync(resolve(root, path))) errors.push(`missing canonical repository entry point: ${path}`)
}

const files = trackedFiles()
for (const path of files) {
  const reason = forbiddenReason(path)
  if (reason) errors.push(`tracked local artifact ${path}: ${reason}`)

  const absolutePath = resolve(root, path)
  if (existsSync(absolutePath) && statSync(absolutePath).isFile() && statSync(absolutePath).size > MAX_TRACKED_FILE_BYTES) {
    errors.push(`tracked file exceeds 5 MiB: ${path}`)
  }
}

const packageJson = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'))
for (const script of ['verify:repo', 'verify:regression', 'verify:predeploy', 'test']) {
  if (!packageJson.scripts?.[script]) errors.push(`package.json is missing the ${script} script`)
}

if (errors.length > 0) fail(errors)

console.log(`OK: ${files.length} tracked files contain no runtime, secret, build, or oversized artifacts`)
console.log(`OK: ${requiredPaths.length} canonical developer entry points are present`)
