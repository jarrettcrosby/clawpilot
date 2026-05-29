import type { NextApiRequest, NextApiResponse } from 'next'
import fs from 'fs'
import path from 'path'
import { getErrorMessage } from '@/lib/errorUtils'

type EventPayload = {
  kind: 'milestone.created' | 'milestone.completed' | 'decision.logged' | 'milestone.create'
  milestone?: {
    id: string
    title: string
    description?: string
    workstream?: string
    owner?: string
    status?: string
    dueDate?: string
  }
  decision?: {
    id: string
    title: string
    summary: string
    author?: string
    date?: string
    workstream?: string
  }
}

// Managed section markers (idempotent patching)
const SECTIONS = ['overview', 'architecture', 'active-milestones', 'decision-history', 'agent-responsibilities', 'roadmap']

function ensureWorkstreamPath(root: string, ws: string) {
  const dir = path.join(root, 'workstreams')
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `${ws}.md`)
  if (!fs.existsSync(file)) {
    const base = `# ${ws}\n\n` + SECTIONS.map(s => `## ${capitalize(s.replace(/-/g,' '))}\n\n<!-- MANAGED:${s} -->\n\n<!-- /MANAGED:${s} -->\n\n`).join('')
    fs.writeFileSync(file, base, 'utf8')
  }
  return file
}

function capitalize(s: string) { return s.charAt(0).toUpperCase() + s.slice(1) }

function replaceManagedSection(content: string, section: string, newBody: string) {
  const open = `<!-- MANAGED:${section} -->`
  const close = `<!-- /MANAGED:${section} -->`
  const re = new RegExp(`${open}[\s\S]*?${close}`, 'm')
  const replacement = `${open}\n${newBody}\n${close}`
  if (re.test(content)) return content.replace(re, replacement)
  // fallback: append at end
  return content + '\n' + replacement
}

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  try {
    if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' })
    const body: EventPayload = req.body
    const docsRoot = path.resolve(process.cwd(), 'docs')
    if (!fs.existsSync(docsRoot)) fs.mkdirSync(docsRoot, { recursive: true })

    // accept legacy alias
    const kind = body.kind === 'milestone.create' ? 'milestone.created' : body.kind

    if (kind === 'milestone.created' || kind === 'milestone.completed') {
      const m = body.milestone
      if (!m || !m.workstream) return res.status(400).json({ error: 'missing milestone or workstream' })
      const ws = m.workstream
      const file = ensureWorkstreamPath(docsRoot, ws)
      let content = fs.readFileSync(file, 'utf8')

      // Update active-milestones section (idempotent list keyed by id)
      const active = extractActiveMilestones(content)
      if (kind === 'milestone.created') {
        active[m.id] = { id: m.id, title: m.title, owner: m.owner || '', status: m.status || 'open', description: m.description || '', dueDate: m.dueDate || '' }
      } else if (kind === 'milestone.completed') {
        if (active[m.id]) active[m.id].status = 'completed'
      }
      const activeBody = Object.values(active).map(a => `- [${a.status === 'completed' ? 'x' : ' '}] **${a.title}** (${a.id}) — ${a.owner || 'unassigned'}\n  - ${a.description || ''}\n  - Due: ${a.dueDate || 'n/a'}`).join('\n')
      content = replaceManagedSection(content, 'active-milestones', activeBody)

      // On completed, also append a short entry to decision-history if description mentions an architectural decision (heuristic)
      if (kind === 'milestone.completed' && m.description && m.description.toLowerCase().includes('decision')) {
        const entry = `- ${new Date().toISOString()} — Milestone **${m.title}** (${m.id}) completed. Note: ${m.description}`
        const cur = extractSection(content, 'decision-history')
        const newDecisionBody = (cur ? cur + '\n' : '') + entry
        content = replaceManagedSection(content, 'decision-history', newDecisionBody)
      }

      fs.writeFileSync(file, content, 'utf8')
      return res.status(200).json({ ok: true, file })
    }

    if (kind === 'decision.logged') {
      const d = body.decision
      if (!d || !d.workstream) return res.status(400).json({ error: 'missing decision or workstream' })
      const ws = d.workstream
      const file = ensureWorkstreamPath(docsRoot, ws)
      let content = fs.readFileSync(file, 'utf8')

      const entry = `- ${d.date || new Date().toISOString()} — **${d.title}** by ${d.author || 'unknown'}\n  \n  ${d.summary}\n`
      const cur = extractSection(content, 'decision-history')
      const newDecisionBody = (cur ? cur + '\n' : '') + entry
      content = replaceManagedSection(content, 'decision-history', newDecisionBody)

      fs.writeFileSync(file, content, 'utf8')
      return res.status(200).json({ ok: true, file })
    }

    return res.status(400).json({ error: 'unknown event kind' })
  } catch (error: unknown) {
    return res.status(500).json({ error: getErrorMessage(error) })
  }
}

function extractSection(content: string, section: string) {
  const open = `<!-- MANAGED:${section} -->`
  const close = `<!-- /MANAGED:${section} -->`
  const re = new RegExp(`${open}([\s\S]*?)${close}`, 'm')
  const m = content.match(re)
  if (!m) return ''
  return m[1].trim()
}

function extractActiveMilestones(content: string) {
  const body = extractSection(content, 'active-milestones')
  const lines = body.split(/\r?\n/).map(s => s.trim()).filter(Boolean)
  const map: Record<string, { id: string; title: string; owner?: string; status?: string; description?: string; dueDate?: string }> = {}
  for (const line of lines) {
    // naive parse: look for "**Title** (id)"
    const m = line.match(/\*\*(.*?)\*\* \(([^)]+)\)/)
    if (m) {
      const title = m[1]
      const id = m[2]
      map[id] = { id, title }
    }
  }
  return map
}
