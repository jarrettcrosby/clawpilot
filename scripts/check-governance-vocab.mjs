#!/usr/bin/env node
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const vocabPath = resolve(process.cwd(), 'app_src/lib/governance/vocab.ts')
const source = readFileSync(vocabPath, 'utf8')

const requiredSnippets = [
  "'task': INTENTS.DELIVERABLE",
  "'todo': INTENTS.DELIVERABLE",
  "'research': INTENTS.RESEARCH",
  "'note': INTENTS.NOTE",
  "'decision': INTENTS.DECISION",
  "'task': ENTITY_TYPES.TASK",
  "'note': ENTITY_TYPES.NOTE",
  "'milestone': ENTITY_TYPES.MILESTONE",
]

const missing = requiredSnippets.filter((snippet) => !source.includes(snippet))

if (missing.length > 0) {
  console.error('governance vocab check failed: missing required mappings')
  for (const item of missing) console.error(`- ${item}`)
  process.exit(1)
}

console.log('governance vocab check: OK')
