#!/usr/bin/env node
import { promises as fs } from 'node:fs'

function argument(name) {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : null
}

const marker = argument('--marker')
const holdMs = Number(argument('--hold-ms') || 0)
const crash = process.argv.includes('--crash')
if (!marker || !Number.isSafeInteger(holdMs) || holdMs < 0 || holdMs > 5_000) {
  process.exit(64)
}

const startedAt = Date.now()
await fs.writeFile(marker, `${process.pid}\n`, { flag: 'wx' })
if (crash) {
  process.stdout.write(`${JSON.stringify({ startedAt, crashed: true })}\n`)
  process.exit(23)
}
await new Promise((resolvePromise) => setTimeout(resolvePromise, holdMs))
process.stdout.write(`${JSON.stringify({ startedAt, endedAt: Date.now() })}\n`)
