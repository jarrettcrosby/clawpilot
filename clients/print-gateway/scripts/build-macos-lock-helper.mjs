import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync } from 'node:fs'
import path from 'node:path'

if (process.platform !== 'darwin') {
  throw new Error('The macOS lock helper must be built on macOS')
}

const projectDirectory = path.resolve(import.meta.dirname, '..')
const sourcePath = path.join(projectDirectory, 'native', 'macos', 'clawpilot-print-lock.c')
const outputDirectory = path.join(projectDirectory, 'build', 'macos')
const outputPath = path.join(outputDirectory, 'clawpilot-print-lock')
mkdirSync(outputDirectory, { recursive: true })

const result = spawnSync('/usr/bin/xcrun', [
  '--sdk',
  'macosx',
  'clang',
  '-arch',
  'arm64',
  '-arch',
  'x86_64',
  '-mmacosx-version-min=12.0',
  '-std=c11',
  '-O2',
  '-Wall',
  '-Wextra',
  sourcePath,
  '-o',
  outputPath,
], {
  cwd: outputDirectory,
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'pipe'],
})
if (result.error || result.status !== 0) {
  process.stderr.write(`${result.stdout || ''}${result.stderr || ''}`)
  throw result.error || new Error(`clang failed with exit ${result.status}`)
}
chmodSync(outputPath, 0o755)
process.stdout.write(`Built universal macOS endpoint lock helper: ${outputPath}\n`)
