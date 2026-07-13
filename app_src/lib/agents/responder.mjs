export class AgentResponder {
  constructor(id = 'stub') {
    this.id = id
  }

  async respond() {
    throw new Error('Not implemented')
  }
}

function trimForReply(text, limit = 120) {
  const clean = String(text || '').trim()
  return clean.length > limit ? `${clean.slice(0, limit - 3)}...` : clean
}

class TemplateResponder extends AgentResponder {
  constructor(id, template) {
    super(id)
    this.template = template
  }

  async respond({ agentId, text, taskId }) {
    return {
      role: 'agent',
      text: this.template({ agentId, text: trimForReply(text), taskId }),
      taskId,
    }
  }
}

const RESPONDERS = {
  stub: new TemplateResponder('stub', ({ agentId, text, taskId }) =>
    `[${agentId}] Acknowledged${taskId ? ` (task: ${taskId})` : ''}. Next action queued for: "${text}"`),
  builder: new TemplateResponder('builder', ({ text, taskId }) =>
    `Builder route engaged${taskId ? ` for ${taskId}` : ''}. I will implement deterministically: scope, patch, verify. Received: "${text}".`),
  docs: new TemplateResponder('docs', ({ text, taskId }) =>
    `Docs route engaged${taskId ? ` for ${taskId}` : ''}. I will produce structure-first updates with explicit acceptance notes. Input: "${text}".`),
  infra: new TemplateResponder('infra', ({ text, taskId }) =>
    `Infra route engaged${taskId ? ` for ${taskId}` : ''}. I will prioritize safety, deterministic rollout, and rollback checkpoints. Request: "${text}".`),
  senior: new TemplateResponder('senior', ({ text, taskId }) =>
    `Senior review route engaged${taskId ? ` for ${taskId}` : ''}. I will validate risks, edge cases, and release quality. Context: "${text}".`),
  projects: new TemplateResponder('projects', ({ text, taskId }) =>
    `Projects route engaged${taskId ? ` for ${taskId}` : ''}. I will sequence execution, unblock dependencies, and keep milestones moving. Input: "${text}".`),
  pipeline: new TemplateResponder('pipeline', ({ text, taskId }) =>
    `Pipeline route engaged${taskId ? ` for ${taskId}` : ''}. I will update pipeline hygiene and follow-ups. Input: "${text}".`),
  calendar: new TemplateResponder('calendar', ({ text, taskId }) =>
    `Calendar route engaged${taskId ? ` for ${taskId}` : ''}. I will manage scheduling and conflicts. Input: "${text}".`),
}

const AGENT_TO_RESPONDER = {
  'builder-agent': 'builder',
  'docs-agent': 'docs',
  'infra-agent': 'infra',
  'senior-agent': 'senior',
  'projects-agent': 'projects',
  'pipeline-agent': 'pipeline',
  'calendar-agent': 'calendar',
  clawpilot: 'stub',
  builder: 'builder',
  docs: 'docs',
  infra: 'infra',
  senior: 'senior',
  projects: 'projects',
  pipeline: 'pipeline',
  calendar: 'calendar',
}

export function resolveResponderId(agentId) {
  return AGENT_TO_RESPONDER[String(agentId || '').trim()] || 'stub'
}

export function createResponder({ agentId } = {}) {
  const id = resolveResponderId(agentId)
  return RESPONDERS[id] || RESPONDERS.stub
}
