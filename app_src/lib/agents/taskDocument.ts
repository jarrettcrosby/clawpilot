export type AgentTaskDocumentInput = {
  existingContent?: string | null
  taskId: string
  taskTitle: string
  boardId: string
  agentId: string
  resultId: string
  status: string
  summary: string
  deliverable: string
  changes: string[]
  nextAction: string
  waitingOn: string
  recordedAt: string
  displayTimestamp: string
}

export type AgentTaskDocumentBuild = {
  title: string
  content: string
  appended: boolean
}

const WORK_LOG_HEADING = '## Work log'
const DELIVERABLE_HEADING = '## Working deliverable'

function cleanInline(value: unknown, fallback = 'none') {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim() || fallback
}

function cleanIdentifier(value: unknown) {
  return String(value || '').replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'result'
}

function agentLabel(agentId: string) {
  const labels: Record<string, string> = {
    calendar: 'Calendar',
    clawpilot: 'ClawPilot',
    docs: 'Docs',
    pipeline: 'Pipeline',
    projects: 'Projects',
  }
  return labels[agentId] || cleanInline(agentId, 'Agent')
}

export function agentTaskDocumentTitle(taskTitle: string, agentId: string) {
  const suffixes: Record<string, string> = {
    calendar: 'Calendar Plan',
    clawpilot: 'ClawPilot Plan',
    docs: 'Documentation',
    pipeline: 'Pipeline Analysis',
    projects: 'Projects Research',
  }
  return `${cleanInline(taskTitle, 'Untitled task')} - ${suffixes[agentId] || `${agentLabel(agentId)} Working Document`}`
}

function previousWorkLog(existingContent: string) {
  const headingIndex = existingContent.indexOf(`\n${WORK_LOG_HEADING}\n`)
  if (headingIndex < 0 || !existingContent.includes(`\n${DELIVERABLE_HEADING}\n`)) return ''
  return existingContent.slice(headingIndex + WORK_LOG_HEADING.length + 2).trim()
}

export function buildAgentTaskDocument(input: AgentTaskDocumentInput): AgentTaskDocumentBuild {
  const title = agentTaskDocumentTitle(input.taskTitle, input.agentId)
  const existingContent = String(input.existingContent || '').trim()
  const marker = `<!-- agent-result:${cleanIdentifier(input.resultId)} -->`
  if (existingContent.includes(marker)) {
    return { title, content: existingContent, appended: false }
  }

  const deliverable = String(input.deliverable || '').trim()
  const changes = input.changes.map((change) => cleanInline(change)).filter(Boolean)
  const priorEntries = previousWorkLog(existingContent)
  const entry = [
    marker,
    `- **${cleanInline(input.displayTimestamp, input.recordedAt)}:** ${cleanInline(input.summary, 'Agent update')} `
      + `Status: ${cleanInline(input.status, 'responded')}. `
      + `Changed: ${changes.length > 0 ? changes.join('; ') : 'working document updated'}.`,
  ].join('\n')

  const content = [
    `# ${title}`,
    '',
    `Task: ${cleanInline(input.taskTitle, 'Untitled task')}`,
    `Task ID: ${cleanInline(input.taskId)}`,
    `Board ID: ${cleanInline(input.boardId)}`,
    `Agent: ${agentLabel(input.agentId)}`,
    '',
    '## Current status',
    '',
    `- **Status:** ${cleanInline(input.status, 'responded')}`,
    `- **Summary:** ${cleanInline(input.summary, 'Agent update')}`,
    `- **Next action:** ${cleanInline(input.nextAction)}`,
    `- **Waiting on:** ${cleanInline(input.waitingOn)}`,
    `- **Last updated:** ${cleanInline(input.displayTimestamp, input.recordedAt)}`,
    '',
    DELIVERABLE_HEADING,
    '',
    deliverable || 'No substantive deliverable was recorded.',
    '',
    WORK_LOG_HEADING,
    '',
    entry,
    priorEntries ? `\n\n${priorEntries}` : '',
  ].join('\n').trim()

  return { title, content, appended: true }
}
