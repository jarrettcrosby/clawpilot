/**
 * @param {unknown} value
 * @returns {boolean}
 */
export function isCrmBoardCard(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = /** @type {Record<string, unknown>} */ (value)
  return Boolean(record.crm)
    || record.entityType === 'crm-account'
    || record.entityType === 'crm-contact'
}

/**
 * CRM board cards share the board payload shape, but never participate in task
 * ownership, agent dispatch, due-date, checklist, or next-action workflows.
 *
 * @param {Record<string, any>} value
 * @returns {Record<string, any>}
 */
export function normalizeCrmBoardCard(value) {
  if (!isCrmBoardCard(value)) return value
  const card = { ...value }
  delete card.assignedAgent
  delete card.assignee
  delete card.dueDate
  delete card.execution
  delete card.workItem
  delete card.workstream
  delete card.outcomeStatement
  return {
    ...card,
    category: 'crm',
    checklist: [],
  }
}
