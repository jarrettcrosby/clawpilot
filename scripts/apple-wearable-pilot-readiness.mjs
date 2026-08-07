#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const required = [
  'CLAWPILOT_SERVER_ORIGIN',
  'CLAWPILOT_PHONE_BUNDLE_IDENTIFIER',
  'CLAWPILOT_WATCH_BUNDLE_IDENTIFIER',
  'CLAWPILOT_ASSOCIATED_DOMAIN',
  'CLAWPILOT_META_URL_SCHEME',
  'CLAWPILOT_META_APP_LINK_SCHEME',
  'CLAWPILOT_META_APP_ID',
  'CLAWPILOT_META_CLIENT_TOKEN',
  'CLAWPILOT_APPLE_DEVELOPMENT_TEAM',
]

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const project = readFileSync(path.join(repositoryRoot, 'clients/apple/project.yml'), 'utf8')
let localConfig = ''
try {
  localConfig = readFileSync(path.join(repositoryRoot, 'clients/apple/Config/Local.xcconfig'), 'utf8')
} catch {}

function projectValue(name) {
  const match = project.match(new RegExp(`^\\s*${name}:\\s*["']?([^"'\\n]*)`, 'm'))
  return match?.[1]?.trim() || ''
}

function localValue(name) {
  const match = localConfig.match(new RegExp(`^\\s*${name}\\s*=\\s*(.+)$`, 'm'))
  return match?.[1]?.trim() || ''
}

function isConfigured(value) {
  const normalized = String(value || '').trim()
  return normalized.length > 0 && normalized !== '0' && !normalized.includes('.invalid')
}

const checks = required.map((name) => {
  const value = process.env[name] || localValue(name) || projectValue(name)
  return { name, configured: isConfigured(value) }
})
let xcode = ''
try { xcode = execFileSync('xcodebuild', ['-version'], { encoding: 'utf8' }).split('\n')[0] }
catch { xcode = 'unavailable' }
const toolchainReady = /^Xcode 26\.6(?:\.|$)/.test(xcode)
const ready = toolchainReady && checks.every((check) => check.configured)

console.log(JSON.stringify({
  schema: 'clawpilot.apple-wearable-pilot-readiness.v1',
  ready,
  toolchain: { xcode26_6: toolchainReady },
  configuration: checks,
  secretsPrinted: false,
}, null, 2))
process.exitCode = ready ? 0 : 2
