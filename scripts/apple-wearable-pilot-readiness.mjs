#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const project = readFileSync(path.join(repositoryRoot, 'clients/apple/project.yml'), 'utf8')
let localConfig = ''
try {
  localConfig = readFileSync(path.join(repositoryRoot, 'clients/apple/Config/Local.xcconfig'), 'utf8')
} catch {}

function configValue(source, name) {
  const match = source.match(new RegExp(`^\\s*${name}\\s*(?::|=)\\s*["']?([^"'\\n]*)`, 'm'))
  return match?.[1]?.trim() || ''
}

function isConfigured(value) {
  const normalized = String(value || '').trim()
  return normalized.length > 0
    && normalized !== '0'
    && !normalized.includes('not-configured')
    && !normalized.includes('.invalid')
}

const environments = [
  {
    name: 'development',
    file: 'Development.xcconfig',
    secretNames: [
      'CLAWPILOT_META_DEV_APP_ID',
      'CLAWPILOT_META_DEV_CLIENT_TOKEN',
      'CLAWPILOT_GOOGLE_DEV_IOS_CLIENT_ID',
      'CLAWPILOT_GOOGLE_DEV_REVERSED_CLIENT_ID',
      'CLAWPILOT_GOOGLE_SERVER_CLIENT_ID_SHARED',
    ],
  },
  {
    name: 'production',
    file: 'Production.xcconfig',
    secretNames: [
      'CLAWPILOT_META_PRODUCTION_APP_ID',
      'CLAWPILOT_META_PRODUCTION_CLIENT_TOKEN',
      'CLAWPILOT_GOOGLE_PRODUCTION_IOS_CLIENT_ID',
      'CLAWPILOT_GOOGLE_PRODUCTION_REVERSED_CLIENT_ID',
      'CLAWPILOT_GOOGLE_SERVER_CLIENT_ID_SHARED',
    ],
  },
]

const publicNames = [
  'CLAWPILOT_SERVER_ORIGIN',
  'CLAWPILOT_PHONE_BUNDLE_IDENTIFIER',
  'CLAWPILOT_WATCH_BUNDLE_IDENTIFIER',
  'CLAWPILOT_ASSOCIATED_DOMAIN',
  'CLAWPILOT_META_URL_SCHEME',
  'CLAWPILOT_META_APP_LINK_SCHEME',
]

const environmentChecks = environments.map((environment) => {
  const source = readFileSync(
    path.join(repositoryRoot, 'clients/apple/Config', environment.file),
    'utf8',
  )
  const configuration = [
    ...publicNames.map((name) => ({ name, configured: isConfigured(configValue(source, name)) })),
    ...environment.secretNames.map((name) => ({
      name,
      configured: isConfigured(process.env[name] || configValue(localConfig, name)),
    })),
  ]
  return {
    name: environment.name,
    ready: configuration.every((check) => check.configured),
    configuration,
  }
})

let xcode = ''
try { xcode = execFileSync('xcodebuild', ['-version'], { encoding: 'utf8' }).split('\n')[0] }
catch { xcode = 'unavailable' }
const toolchainReady = /^Xcode 26\.6(?:\.|$)/.test(xcode)
const teamConfigured = isConfigured(
  process.env.CLAWPILOT_APPLE_DEVELOPMENT_TEAM
    || configValue(localConfig, 'CLAWPILOT_APPLE_DEVELOPMENT_TEAM')
    || configValue(project, 'CLAWPILOT_APPLE_DEVELOPMENT_TEAM'),
)
const ready = toolchainReady && teamConfigured && environmentChecks.every((environment) => environment.ready)

console.log(JSON.stringify({
  schema: 'clawpilot.apple-wearable-pilot-readiness.v2',
  ready,
  toolchain: { xcode26_6: toolchainReady },
  appleTeamConfigured: teamConfigured,
  environments: environmentChecks,
  secretsPrinted: false,
}, null, 2))
process.exitCode = ready ? 0 : 2
