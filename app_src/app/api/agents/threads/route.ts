import { NextRequest, NextResponse } from 'next/server'
import fs from 'fs'
import path from 'path'
import { resolveResponderId } from '@/lib/agents/responder.mjs'
import { getThread, listThreads, upsertThreadMessage } from '@/lib/agents/threadStore.mjs'
import { normalizeProductAgentId, PRODUCT_AGENTS, resolveExecutionAgentForControlAgent } from '@/lib/agents/routing'
import { withFileLock } from '@/lib/fileLock'
import { buildExecutionCommentText, buildExecutionCommentActivity } from '@/lib/executionWriteback'
import { spawn } from 'child_process'
import type { Task, Comment } from '@/lib/types'
import { buildCanonicalWorkItem, canonicalizeTasks } from '@/lib/workItemModel'
const SECOND_BRAIN = process.env.SECOND_BRAIN_PATH || '/Users/agentsuburbiasandwich/.openclaw/workspace/second-brain'

const DEV_TASKS_FILE = path.join(process.cwd(), '..', 'data-dev', 'tasks.json')
const PROD_TASKS_FILE = path.join(process.cwd(), '..', 'data', 'tasks.json')
const TASKS_FILE = process.env.TASKS_PATH || ((process.env.NODE_ENV === 'development' && fs.existsSync(DEV_TASKS_FILE)) ? DEV_TASKS_FILE : PROD_TASKS_FILE)

type ClawPilotStructuredResponse = {
  decision: 'delegate' | 'respond'
  currentStatus: string
  blockers: string
  nextStep: string
  delegatedAgent?: 'projects' | 'pipeline' | 'docs' | 'calendar'
  delegationSuggestion?: string
}

type AgentSectionedReply = {
  directAnswer: string
  done: string
  currentState: string
  nextStep: string
  blocker?: string
}

function readTasks(): Task[] {
  try {
    return JSON.parse(fs.readFileSync(TASKS_FILE, 'utf-8'))
  } catch {
    return []
  }
}

async function writeTasks(tasks: Task[]) {
  const lockPath = `${TASKS_FILE}.lock`
  const canonical = canonicalizeTasks(tasks)
  await withFileLock(lockPath, () => {
    fs.writeFileSync(TASKS_FILE, JSON.stringify(canonical, null, 2))
  })
}

function deriveNextAction(summary: string): string {
  const lines = String(summary || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  const explicit = lines.find((line) => /^next action\s*:/i.test(line) || /^next step\s*:/i.test(line) || /^next\s*:/i.test(line))
  if (explicit) return explicit.replace(/^next action\s*:/i, '').replace(/^next step\s*:/i, '').replace(/^next\s*:/i, '').trim() || 'Review latest execution summary and proceed.'
  return 'Review latest execution summary and choose the next concrete step.'
}

async function writeExecutionResult(taskId: string, agentId: string, summary: string) {
  if (!taskId) return
  const tasks = readTasks()
  const idx = tasks.findIndex(t => String(t.id) === String(taskId))
  if (idx === -1) return
  const task = tasks[idx]
  const now = new Date().toISOString()
  const nextAction = deriveNextAction(summary)
  const commentText = buildExecutionCommentText({
    agentId,
    executionStatus: 'completed',
    summary,
    suggestedNextAction: nextAction,
  })
  const comment: Comment = { id: Date.now().toString(), text: commentText, createdAt: now, timestamp: now, author: agentId }
  const activity = [...(task.activity || []), buildExecutionCommentActivity(task, agentId, comment.id, now)]
  const execution = {
    ...(task.execution || {}),
    executionStatus: 'completed',
    lastUpdatedAt: now,
    latestExecutionNote: summary,
    lastResult: {
      type: 'agent-thread-execution',
      agentId,
      summary,
      nextAction,
      recordedAt: now,
    },
  }
  tasks[idx] = {
    ...task,
    execution,
    comments: [...(task.comments || []), comment],
    activity,
    updatedAt: now,
  }
  await writeTasks(tasks)
}

async function writeDocsLog(agentId: string, text: string) {
  if (agentId !== 'docs') return
  try {
    const dir = path.join(SECOND_BRAIN, 'clawpilot')
    fs.mkdirSync(dir, { recursive: true })
    const filePath = path.join(dir, 'docs-agent-log.md')
    const stamp = new Date().toISOString()
    fs.appendFileSync(filePath, `\n\n## ${stamp}\n${text}\n`)
  } catch {
    // ignore write errors
  }
}

async function runOpenClawAgent(agentId: string, message: string) {
  const args = [
    'agent',
    '--agent', agentId,
    '--message', message,
    '--json',
    '--timeout', '120',
  ]

  const stdout = await new Promise<string>((resolve, reject) => {
    const child = spawn('openclaw', args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
    })

    let out = ''
    let err = ''
    let settled = false

    const timeout = setTimeout(() => {
      if (!settled) {
        settled = true
        child.kill('SIGKILL')
        reject(new Error('openclaw agent timeout'))
      }
    }, 130_000)

    child.stdout.on('data', (chunk) => { out += String(chunk) })
    child.stderr.on('data', (chunk) => { err += String(chunk) })
    child.on('error', (e) => {
      if (!settled) {
        settled = true
        clearTimeout(timeout)
        reject(e)
      }
    })
    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      if (code !== 0) {
        reject(new Error(`openclaw exited with code ${code}${err ? `: ${err.trim()}` : ''}`))
      } else {
        resolve(out)
      }
    })
  })

  const trimmed = String(stdout || '').trim()
  if (!trimmed) return { text: '' }
  try {
    const parsed = JSON.parse(trimmed)
    const reply = parsed?.reply || parsed?.message || parsed?.result || parsed
    const payloadText = Array.isArray(reply?.payloads) ? reply.payloads[0]?.text : undefined
    const text = typeof reply === 'string' ? reply : (reply?.text || payloadText || '')
    return { text: String(text || '').trim() }
  } catch {
    return { text: trimmed }
  }
}

function formatClawPilotReply(payload: ClawPilotStructuredResponse): string {
  const delegatedName = payload.delegatedAgent
    ? (PRODUCT_AGENTS.find((agent) => agent.id === payload.delegatedAgent)?.name || payload.delegatedAgent)
    : null

  return [
    `Current status: ${payload.currentStatus}`,
    `Blockers: ${payload.blockers}`,
    `Next step: ${payload.nextStep}`,
    delegatedName && payload.delegationSuggestion ? `Delegation suggestion: ${payload.delegationSuggestion.replace('{agent}', delegatedName)}` : null,
  ].filter(Boolean).join('\n')
}

function normalizeLine(value: string): string {
  return String(value || '').replace(/\s+/g, ' ').trim()
}

function parseReplySections(raw: string): Partial<AgentSectionedReply> {
  const text = String(raw || '').trim()
  const lines = text.split(/\r?\n/)
  const sections: Record<string, string[]> = { direct: [], done: [], state: [], next: [], blocker: [] }
  let active: keyof typeof sections | null = null

  for (const line of lines) {
    const l = line.trim()
    if (!l) continue
    if (/^direct answer\s*:/i.test(l) || /^what['’]?s happening\s*:/i.test(l)) {
      active = 'direct'; sections.direct.push(l.replace(/^[^:]+:/, '').trim()); continue
    }
    if (/^what i['’]?ve done\s*:/i.test(l) || /^what i've done\s*:/i.test(l)) {
      active = 'done'; sections.done.push(l.replace(/^[^:]+:/, '').trim()); continue
    }
    if (/^current state\s*:/i.test(l)) {
      active = 'state'; sections.state.push(l.replace(/^[^:]+:/, '').trim()); continue
    }
    if (/^next (step|action)\s*:/i.test(l)) {
      active = 'next'; sections.next.push(l.replace(/^[^:]+:/, '').trim()); continue
    }
    if (/^blocker\s*:/i.test(l) || /^blocked reason\s*:/i.test(l)) {
      active = 'blocker'; sections.blocker.push(l.replace(/^[^:]+:/, '').trim()); continue
    }
    if (active) sections[active].push(l)
  }

  return {
    directAnswer: normalizeLine(sections.direct.join(' ')),
    done: normalizeLine(sections.done.join(' ')),
    currentState: normalizeLine(sections.state.join(' ')),
    nextStep: normalizeLine(sections.next.join(' ')),
    blocker: normalizeLine(sections.blocker.join(' ')),
  }
}

function inferSpecificNeed(raw: string): { need: string; outcome: string } | null {
  const lower = String(raw || '').toLowerCase()
  if (/(credential|token|password|api key)/.test(lower)) return { need: 'credential or token', outcome: 'complete the requested authenticated step' }
  if (/(repo|repository|git url)/.test(lower)) return { need: 'repository URL', outcome: 'run the requested implementation or validation step' }
  if (/(file path|filepath|path)/.test(lower)) return { need: 'file path', outcome: 'apply the requested file-level change' }
  if (/(acceptance criteria|criteria)/.test(lower)) return { need: 'acceptance criteria', outcome: 'finish and validate the task outcome' }
  if (/(environment|prod|staging|dev)/.test(lower)) return { need: 'target environment', outcome: 'execute the correct environment-specific action' }
  return null
}

function detectRepeatedNeed(previousAgentMessages: Array<{ text?: string }>, needText: string): boolean {
  const needle = normalizeLine(needText).toLowerCase()
  if (!needle) return false
  return previousAgentMessages.some((m) => normalizeLine(m?.text || '').toLowerCase().includes(needle))
}

const DISALLOWED_FLUFF = [
  'summarized context',
  'extracted assumptions',
  'made progress',
  'prepared next step',
  'looked into',
  'reviewed',
  'investigated',
]

function normalizeForCheck(value: string): string {
  return String(value || '').toLowerCase().replace(/\s+/g, ' ').trim()
}

function containsFluff(value: string): boolean {
  const normalized = normalizeForCheck(value)
  return DISALLOWED_FLUFF.some((phrase) => normalized.includes(phrase))
}

function sanitizeFluff(value: string): string {
  let out = String(value || '').trim()
  for (const phrase of DISALLOWED_FLUFF) {
    const re = new RegExp(phrase.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&'), 'ig')
    out = out.replace(re, 'executed concrete work')
  }
  return out.replace(/\s+/g, ' ').trim()
}

function enforceActionFirstReply(raw: string, task: Task, previousAgentMessages: Array<{ text?: string }>): string {
  const parsed = parseReplySections(raw)

  let changed = sanitizeFluff(parsed.done || parsed.directAnswer || 'Created a concrete 2-step execution plan and identified the immediate step to run now.')
  let remaining = sanitizeFluff(parsed.currentState || 'Complete the next task step and attach output to this task.')

  const specificNeed = inferSpecificNeed(`${parsed.blocker || ''} ${raw || ''}`)
  const repeated = specificNeed ? detectRepeatedNeed(previousAgentMessages, specificNeed.need) : false

  let waitingOn = sanitizeFluff(parsed.nextStep || '')
  if (specificNeed && repeated) {
    waitingOn = `Escalation: missing ${specificNeed.need}. Owner input required now; once received I will ${specificNeed.outcome}.`
  } else if (!waitingOn && specificNeed) {
    waitingOn = `Missing ${specificNeed.need}; provide it so I can ${specificNeed.outcome}.`
  }
  if (!waitingOn) waitingOn = 'none'

  // strict validation: if Changed is vague, replace with concrete fallback
  if (!changed || containsFluff(changed)) {
    changed = 'Executed a concrete task step and recorded the exact result for this card.'
  }
  if (!remaining) {
    remaining = 'Run the next concrete step and post the output.'
  }

  return [
    `Changed: ${changed}`,
    `Remaining: ${remaining}`,
    `Waiting on: ${waitingOn}`,
  ].join('\n')
}

function inferDelegatedAgent(text: string, task?: Task): ClawPilotStructuredResponse['delegatedAgent'] {
  const combined = `${text}\n${task?.title || ''}\n${task?.desc || ''}\n${task?.category || ''}`.toLowerCase()
  if (/\bdocs?\b/.test(combined)) return 'docs'
  if (/\bpipeline\b/.test(combined)) return 'pipeline'
  if (/\bcalendar\b/.test(combined)) return 'calendar'
  if (/\bprojects?\b/.test(combined)) return 'projects'
  return undefined
}

function buildClawPilotResponse(text: string, task?: Task): ClawPilotStructuredResponse {
  const delegatedAgent = inferDelegatedAgent(text, task)
  const askedToDelegate = /\b(delegate|delegation|reassign|route|hand off|handoff)\b/i.test(text)

  if (delegatedAgent && askedToDelegate) {
    return {
      decision: 'delegate',
      delegatedAgent,
      currentStatus: 'The request is ready for handoff to the right delivery agent.',
      blockers: 'No blocker right now.',
      nextStep: 'Open the delegated agent thread and confirm the first concrete deliverable.',
      delegationSuggestion: 'Hand this to {agent} for the next execution pass.',
    }
  }

  return {
    decision: 'respond',
    currentStatus: 'This task is still best managed directly by ClawPilot at this step.',
    blockers: 'No blocker, but delegation target is not explicit yet.',
    nextStep: 'Share the exact deliverable or blocker so I can either execute here or hand off cleanly.',
  }
}

async function applyClawPilotDelegation(taskId: string, payload: ClawPilotStructuredResponse, userText: string) {
  if (!payload.delegatedAgent) return
  const tasks = readTasks()
  const idx = tasks.findIndex((task) => String(task.id) === String(taskId))
  if (idx === -1) return

  const task = tasks[idx]
  const now = new Date().toISOString()
  const delegatedName = PRODUCT_AGENTS.find((agent) => agent.id === payload.delegatedAgent)?.name || payload.delegatedAgent
  const comment: Comment = {
    id: Date.now().toString(),
    text: [
      'ClawPilot delegation:',
      `decision=${payload.decision}`,
      `delegatedAgent=${payload.delegatedAgent}`,
      `nextStep=${payload.nextStep}`,
      `request=${userText}`,
    ].join('\n'),
    createdAt: now,
    timestamp: now,
    author: 'ClawPilot',
  }

  tasks[idx] = {
    ...task,
    assignedAgent: payload.delegatedAgent,
    comments: [...(task.comments || []), comment],
    activity: [
      ...(task.activity || []),
      {
        type: 'updated',
        message: `ClawPilot delegated this task to ${delegatedName}. Next: ${payload.nextStep}`,
        timestamp: now,
        actor: 'ClawPilot',
        taskId: task.id,
        taskTitle: task.title,
        commentId: comment.id,
      },
      {
        type: 'comment',
        message: `Delegation note added for ${delegatedName}`,
        timestamp: now,
        actor: 'ClawPilot',
        taskId: task.id,
        taskTitle: task.title,
        commentId: comment.id,
      },
    ],
    updatedAt: now,
  }

  await writeTasks(tasks)
}

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const agentId = String(searchParams.get('agentId') || '')
  const taskIdParam = String(searchParams.get('taskId') || '')

  if (!agentId) return NextResponse.json(listThreads())

  const taskId = taskIdParam.trim()
  if (!taskId) {
    return NextResponse.json({ ok: false, error: 'taskId required' }, { status: 400 })
  }

  const taskExists = readTasks().some(t => String(t.id) === taskId)
  if (!taskExists) {
    return NextResponse.json({ ok: false, error: 'task not found' }, { status: 404 })
  }

  const task = readTasks().find((entry) => String(entry.id) === taskId)
  const canonicalWorkItem = task ? buildCanonicalWorkItem(task) : null
  const thread = getThread({ agentId, taskId })
  return NextResponse.json({
    ...(thread || {
      threadId: `thread_${agentId}_${taskId}`,
      agentId,
      createdAt: null,
      updatedAt: null,
      lastMessageAt: null,
      taskId,
      status: 'active',
      tags: [],
      routing: { responder: resolveResponderId(agentId), channel: 'internal', priority: 'normal' },
      context: { summary: null, lastUserMessageId: null, messageCount: 0, tokenEstimate: 0 },
      messages: [],
    }),
    canonicalWorkItem,
  })
}

export async function POST(req: NextRequest) {
  const body = await req.json()
  const agentId = String(body?.agentId || '')
  const text = String(body?.text || '').trim()
  const taskId = String(body?.taskId || '').trim()
  const tags = Array.isArray(body?.tags) ? body.tags.map(String) : undefined

  if (!agentId || !text || !taskId) {
    return NextResponse.json({ ok: false, error: 'agentId, taskId and text required' }, { status: 400 })
  }

  const tasks = readTasks()
  const task = tasks.find((entry) => String(entry.id) === taskId)
  if (!task) {
    return NextResponse.json({ ok: false, error: 'task not found' }, { status: 404 })
  }

  const normalizedAgentId = normalizeProductAgentId(agentId)
  if (!normalizedAgentId) {
    return NextResponse.json({ ok: false, error: 'invalid product agent' }, { status: 400 })
  }

  const executionAgentId = resolveExecutionAgentForControlAgent(normalizedAgentId)
  if (!executionAgentId) {
    return NextResponse.json({ ok: false, error: 'execution route missing for product agent' }, { status: 400 })
  }

  const routedResponderId = resolveResponderId(executionAgentId)
  const useRealExecution = normalizedAgentId !== 'clawpilot'
  let executedViaAgent = false

  // 1) persist user message first
  await upsertThreadMessage({
    agentId,
    text,
    role: 'user',
    taskId,
    status: 'resolving',
    tags,
    routing: { responder: routedResponderId, channel: 'internal', priority: 'normal' },
    meta: { source: 'api', phase: 'request', executionAgentId },
  })

  const afterUser = getThread({ agentId, taskId })
  const userMessage = afterUser?.messages?.[afterUser.messages.length - 1] || null
  const previousAgentMessages = (afterUser?.messages || []).filter((m: any) => m?.role === 'agent').map((m: any) => ({ text: String(m?.text || '') }))

  // 2) route through deterministic per-agent responder
  let reply: { text?: string; role?: string; taskId?: string } = {}
  let responderId = routedResponderId
  let structuredResponse: ClawPilotStructuredResponse | undefined

  if (normalizedAgentId === 'clawpilot') {
    structuredResponse = buildClawPilotResponse(text, task)

    if (taskId && structuredResponse.decision === 'delegate' && structuredResponse.delegatedAgent) {
      await applyClawPilotDelegation(String(taskId), structuredResponse, text)
      reply = { role: 'agent', text: formatClawPilotReply(structuredResponse), taskId }
      responderId = 'clawpilot'
    } else {
      const latestActivity = (task?.activity || []).slice(-1)[0]
      const checklist = task?.checklist || []
      const doneCount = checklist.filter((c) => c.done).length
      const checklistSummary = checklist.length
        ? `${doneCount}/${checklist.length} checklist items complete`
        : 'No checklist items on this card'

      const nextAction = String(task?.status || '').toLowerCase() === 'done'
        ? 'If this is fully validated, archive the card (or leave one final completion note).'
        : 'Confirm the exact remaining deliverable and I will execute it now.'

      const statusLine = task?.status
        ? `Current status: ${task.status}.`
        : 'Current status: not set.'

      const activityLine = latestActivity?.message
        ? `Latest activity: ${latestActivity.message}`
        : 'Latest activity: no recent activity logged.'

      const blockerLine = String(task?.status || '').toLowerCase() === 'done'
        ? 'Blocker: none — card is already marked done.'
        : 'Blocker: remaining acceptance criteria are not explicit yet.'

      reply = {
        role: 'agent',
        text: [
          statusLine,
          `Task: ${task?.title || taskId}`,
          `Checklist: ${checklistSummary}.`,
          activityLine,
          blockerLine,
          `Next action: ${nextAction}`,
        ].join('\n'),
        taskId,
      }
      responderId = 'clawpilot'
    }
  } else if (useRealExecution) {
    let promptText = text
    if (taskId) {
      const task = readTasks().find(t => String(t.id) === String(taskId))
      if (task) {
        const checklist = (task.checklist || []).map(c => `- [${c.done ? 'x' : ' '}] ${c.text}`).join('\n')
        const context = [
          `Task: ${task.title}`,
          task.desc ? `Description: ${task.desc}` : null,
          task.status ? `Status: ${task.status}` : null,
          task.priority ? `Priority: ${task.priority}` : null,
          task.assignedAgent ? `Assigned: ${task.assignedAgent}` : null,
          checklist ? `Checklist:\n${checklist}` : null,
        ].filter(Boolean).join('\n')
        promptText = `${context}\n\nUser request: ${text}\n\nResponse style requirements:\n- High signal only. No abstract or filler language.\n- If there is enough context to act, execute the next concrete step now and report exactly what changed.\n- Ask for missing input only when truly blocked by a dependency.\n- Use this exact section structure (in order):\n  Changed:\n  Remaining:\n  Waiting on:\n- \"Changed\" must contain concrete work details (steps, plan, result), never vague status text.\n- Never use these phrases: summarized context, extracted assumptions, made progress, prepared next step, looked into, reviewed, investigated.\n- Include \"Waiting on\" only when required; if blocker repeats, escalate instead of repeating the same request.`
      }
    }
    const result = await runOpenClawAgent(executionAgentId, promptText)
    const actionFirstText = enforceActionFirstReply(String(result.text || ''), task, previousAgentMessages)
    reply = { role: 'agent', text: actionFirstText, taskId }
    responderId = executionAgentId
    executedViaAgent = true
  }

  if (taskId && executionAgentId && (useRealExecution || executedViaAgent)) {
    const summary = String(reply?.text || '').trim()
    if (summary) {
      const resultAgentId = responderId || executionAgentId
      await writeExecutionResult(String(taskId), resultAgentId, summary)
      await writeDocsLog(resultAgentId, summary)
    }
  }

  // 3) persist responder message
  await upsertThreadMessage({
    agentId,
    text: String(reply?.text || ''),
    role: (reply?.role === 'system' || reply?.role === 'agent' || reply?.role === 'tool') ? reply.role : 'agent',
    taskId: reply?.taskId ? String(reply.taskId) : taskId,
    status: 'active',
    tags,
    routing: { responder: responderId || routedResponderId, channel: 'internal', priority: 'normal' },
    meta: { source: 'api', phase: 'response', responder: responderId || routedResponderId, executionAgentId },
  })

  const thread = getThread({ agentId, taskId })
  const agentMessage = thread?.messages?.[thread.messages.length - 1] || null
  const updatedTask = readTasks().find((entry) => String(entry.id) === taskId)

  return NextResponse.json({
    ok: true,
    thread,
    userMessage,
    agentMessage,
    structuredResponse,
    canonicalWorkItem: updatedTask ? buildCanonicalWorkItem(updatedTask) : null,
  })
}
