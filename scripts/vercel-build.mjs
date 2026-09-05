#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const appRoot = resolve(root, 'app_src')

function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    env: process.env,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} exited with status ${result.status ?? 'unknown'}`)
  }
}

function assertPreviewOnlyDeployment() {
  const environment = String(process.env.VERCEL_ENV || '').trim().toLowerCase()
  if (process.env.VERCEL && environment !== 'preview') {
    throw new Error(
      'ClawPilot application builds accept protected Vercel previews only; production and development deployments are prohibited by the post-cutover contract',
    )
  }
}

try {
  assertPreviewOnlyDeployment()
  run('npm', ['run', 'build'], appRoot)
  console.log('Vercel protected preview build passed; this is compile/UI evidence only and does not prove the legacy Vercel credential retirement is complete')
} catch (error) {
  console.error(`Vercel build failed: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}
