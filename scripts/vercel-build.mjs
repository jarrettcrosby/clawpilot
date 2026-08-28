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

function managedDeployment() {
  const environment = String(process.env.VERCEL_ENV || '').trim().toLowerCase()
  const branch = String(process.env.VERCEL_GIT_COMMIT_REF || '').trim()
  if (environment === 'production') {
    if (branch !== 'main') {
      throw new Error('Vercel production deployments must originate from main with Git metadata present')
    }
    return true
  }
  return environment === 'preview' && branch === 'dev'
}

try {
  run('npm', ['run', 'build'], appRoot)

  if (!managedDeployment()) {
    console.log('Vercel managed mail gate skipped for an unmanaged preview or local build')
    process.exit(0)
  }

  run(process.execPath, [resolve(root, 'scripts', 'verify-mail-sender.mjs')], root)
  console.log('Vercel managed build and mail gates passed; database migrations are owned by the Railway deployment path')
} catch (error) {
  console.error(`Vercel build failed: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}
