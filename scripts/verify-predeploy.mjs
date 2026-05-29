#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

const root = process.cwd()

function fail(message) {
  console.error(`predeploy check failed: ${message}`)
  process.exit(1)
}

function ok(message) {
  console.log(`OK: ${message}`)
}

function readJson(relativePath) {
  return JSON.parse(readFileSync(resolve(root, relativePath), 'utf8'))
}

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  })

  if (result.status !== 0) {
    fail(`${command} ${args.join(' ')} exited with code ${result.status ?? 'unknown'}`)
  }
}

console.log('Running ClawPilot predeploy verification...')

if (!existsSync(resolve(root, 'package.json'))) {
  fail('missing root package.json')
}

if (!existsSync(resolve(root, 'app_src/package.json'))) {
  fail('missing app_src/package.json')
}

if (!existsSync(resolve(root, 'vercel.json'))) {
  fail('missing vercel.json')
}

if (!existsSync(resolve(root, 'railway.json'))) {
  fail('missing railway.json')
}

const vercel = readJson('vercel.json')
if (String(vercel.installCommand || '') !== 'npm --prefix app_src install') {
  fail('vercel.json installCommand must be "npm --prefix app_src install"')
}

if (String(vercel.buildCommand || '') !== 'npm run build') {
  fail('vercel.json buildCommand must be "npm run build"')
}

if (String(vercel.outputDirectory || '') !== 'app_src/.next') {
  fail('vercel.json outputDirectory must be "app_src/.next"')
}

const railway = readJson('railway.json')
if (String(railway?.deploy?.healthcheckPath || '') !== '/api/health') {
  fail('railway.json deploy.healthcheckPath must be "/api/health"')
}

if (!String(railway?.deploy?.startCommand || '').includes('npm run start:railway')) {
  fail('railway.json deploy.startCommand must use "npm run start:railway"')
}

run('npm', ['run', 'build'])

if (!existsSync(resolve(root, 'app_src/.next/BUILD_ID'))) {
  fail('missing build artifact: app_src/.next/BUILD_ID')
}

ok('predeploy verification passed')
