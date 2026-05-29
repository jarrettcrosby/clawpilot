export type ChecklistItem = {
  id: string
  text: string
  status: 'todo' | 'in-progress' | 'done'
  assignee?: string
  agentId?: string
  dueDate?: string
  // activity hooks (optional) — consumers may push activity objects here
  activity?: Array<{ type: string; actor?: string; timestamp?: string; note?: string }>
}

// JSON schema form (for use by validators/tests)
export const checklistItemSchema = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    text: { type: 'string' },
    status: { type: 'string', enum: ['todo', 'in-progress', 'done'] },
    assignee: { type: 'string' },
    agentId: { type: 'string' },
    dueDate: { type: 'string', format: 'date-time' },
    activity: { type: 'array', items: { type: 'object' } },
  },
  required: ['id', 'text', 'status'],
  additionalProperties: true
}
