import { NextResponse } from 'next/server'
import fs from 'fs'
import path from 'path'

const REPO_ROOT = path.resolve(process.cwd(), '..')

const DOCS = [
  {
    id: 'development-contract',
    title: 'Development Contract',
    file: 'docs/operations/development-contract.md',
  },
  {
    id: 'system-operating-model',
    title: 'System Operating Model',
    file: 'docs/architecture/system-operating-model.md',
  },
  {
    id: 'promotion-workflow',
    title: 'Promotion Workflow',
    file: 'docs/operations/promotion.md',
  },
  {
    id: 'dev-prod-alignment-workflow',
    title: 'Dev/Prod Alignment Workflow',
    file: 'docs/operations/promotion.md',
    section: 'Dev/Prod Alignment Workflow',
  },
  {
    id: 'governance-rules',
    title: 'Governance Rules',
    file: 'docs/architecture/system-operating-model.md',
    section: 'Governance Rules',
  },
  {
    id: 'agent-routing-model',
    title: 'Agent Routing Model',
    file: 'docs/architecture/system-operating-model.md',
    section: 'Agent Routing Model',
  },
]

function extractSection(content: string, heading: string) {
  const lines = content.split('\n')
  const startIdx = lines.findIndex(l => l.trim().toLowerCase() === `## ${heading}`.toLowerCase())
  if (startIdx === -1) return ''
  const after = lines.slice(startIdx + 1)
  const endIdx = after.findIndex(l => l.startsWith('## '))
  const body = endIdx === -1 ? after : after.slice(0, endIdx)
  return body.join('\n').trim()
}

export async function GET() {
  try {
    const docs = DOCS.map((doc) => {
      const fullPath = path.join(REPO_ROOT, doc.file)
      const content = fs.existsSync(fullPath) ? fs.readFileSync(fullPath, 'utf-8') : ''
      const body = doc.section ? extractSection(content, doc.section) : content
      return {
        id: doc.id,
        title: doc.title,
        date: '',
        tags: [],
        category: 'governance',
        slug: doc.id,
        content: body || `Missing section: ${doc.section || doc.file}`,
      }
    })

    return NextResponse.json(docs)
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 })
  }
}
