import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { constants } from 'node:os'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const CUTOVER = 'npm run test:production-cutover'
const CATALOG = 'node scripts/test-production-rebind-history-schema-attestation.mjs'
const PRETEST = 'npm run pretest'
const ROOT_TEST = 'npm run test'
const UNMODELED_LIFECYCLE = [
  'posttest', 'pretest:production-cutover', 'posttest:production-cutover', 'prepretest', 'postpretest',
]
const NPM = /^npm run ([a-z0-9][a-z0-9:_-]{0,127})(?![\s\S])/u
const NODE = /^node (scripts\/[a-z0-9][a-z0-9_-]{0,127}\.mjs)(?![\s\S])/u

function parseChain(scripts, name) {
  const value = scripts[name]
  if (!Object.hasOwn(scripts, name) || typeof value !== 'string' || !value || value.length > 32_768) {
    throw new Error(`Invalid package script: ${name}`)
  }
  const parts = value.split(' && ')
  if (parts.length > 128) throw new Error(`Too many commands in ${name}`)
  return parts.map((part) => {
    const npm = NPM.exec(part)
    const node = NODE.exec(part)
    if (npm && (!Object.hasOwn(scripts, npm[1]) || typeof scripts[npm[1]] !== 'string' || !scripts[npm[1]].trim())) {
      throw new Error(`Missing npm command referenced by ${name}: ${npm[1]}`)
    }
    if (!npm && !node) throw new Error(`Unsupported command syntax in ${name}`)
    return { text: part, argv: npm ? ['npm', 'run', npm[1]] : ['node', node[1]] }
  })
}

/** Keep ordinary npm test authoritative and complete. The CI workflow runs
 * this exact complement only alongside its required full PG16 and PG18 jobs. */
export function planCiAppTests(scripts) {
  if (!scripts || typeof scripts !== 'object' || Array.isArray(scripts)
    || !Object.hasOwn(scripts, 'pretest') || typeof scripts.pretest !== 'string' || !scripts.pretest.trim()) {
    throw new Error('The package must define the pretest lifecycle')
  }
  for (const name of UNMODELED_LIFECYCLE) {
    if (Object.hasOwn(scripts, name)) throw new Error(`Review the CI partition for the new npm lifecycle: ${name}`)
  }
  const test = parseChain(scripts, 'test')
  const cutover = parseChain(scripts, 'test:production-cutover')
  if (test.filter(({ text }) => text === CUTOVER).length !== 1
    || cutover.filter(({ text }) => text === CATALOG).length !== 1
    || test.some(({ text }) => text === CATALOG)
    || cutover.some(({ text }) => text === CUTOVER)
    || [...test, ...cutover].some(({ text }) => text === ROOT_TEST || text === PRETEST)) {
    throw new Error('Expected one top-level production cutover edge and one full catalog matrix inside it')
  }
  const children = cutover.filter(({ text }) => text !== CATALOG).map(({ argv }) => argv)
  return Object.freeze([
    ['npm', 'run', 'pretest'],
    ...test.flatMap(({ text, argv }) => text === CUTOVER ? children : [argv]),
  ].map((argv) => Object.freeze(argv)))
}

async function run() {
  if (process.argv.length !== 2 || process.env.CI !== 'true') {
    throw new Error('This runner requires CI=true and accepts no arguments; use npm test for the full default suite')
  }
  const cwd = fileURLToPath(new URL('../', import.meta.url))
  const { scripts } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  const plan = planCiAppTests(scripts)
  const processGroups = process.platform !== 'win32'
  const forwardedSignals = ['SIGINT', 'SIGTERM', 'SIGHUP']
  let child, receivedSignal, result
  const forward = (signal) => {
    receivedSignal ??= signal
    if (!child?.pid) return
    try {
      if (processGroups) process.kill(-child.pid, signal)
      else child.kill(signal)
    } catch (error) {
      if (error.code !== 'ESRCH') console.error(`Could not forward ${signal}: ${error.message}`)
    }
  }
  const handlers = forwardedSignals.map((signal) => [signal, () => forward(signal)])
  for (const [signal, handler] of handlers) process.on(signal, handler)
  try {
    for (const [command, ...args] of plan) {
      if (receivedSignal) break
      console.log(`CI app tests: ${[command, ...args].join(' ')}`)
      result = await new Promise((resolveChild, rejectChild) => {
        child = spawn(command === 'node' ? process.execPath : command, args, {
          cwd, detached: processGroups, shell: false, stdio: 'inherit',
        })
        child.once('error', rejectChild)
        child.once('close', (code, signal) => resolveChild({ code, signal }))
      })
      child = undefined
      if (result.code !== 0 || result.signal) break
    }
  } finally {
    for (const [signal, handler] of handlers) process.off(signal, handler)
  }
  const signal = receivedSignal || result?.signal
  if (signal) {
    process.exitCode = 128 + (constants.signals[signal] || 1)
    process.kill(process.pid, signal)
  } else if (result?.code !== 0) {
    process.exitCode = result?.code ?? 1
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  run().catch((error) => {
    console.error(`CI app tests: ${error.message}`)
    process.exitCode = 1
  })
}
