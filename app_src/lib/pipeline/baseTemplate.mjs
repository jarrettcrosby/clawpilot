export const BASE_PIPELINE_WORKFLOW = Object.freeze({
  stage: Object.freeze([
    'Identified Lead',
    'Qualified Lead',
    'Needs Analysis',
    'Demo',
    'Proposal',
    'Negotiation',
    'Loss',
    'Won',
  ]),
  priority: Object.freeze(['A+', 'A', 'B', 'C', 'D']),
  status: Object.freeze(['Open', 'On Hold', 'Won', 'Lost', 'Abandoned']),
  source: Object.freeze(['Inbound', 'Outbound', 'Referral', 'Website', 'Partner']),
  loss_reason: Object.freeze(['No Decision', 'Budget', 'Competition', 'Not a Fit']),
})

function options(values) {
  return values.map((value, index) => ({
    value,
    label: value,
    active: true,
    sort_order: index,
  }))
}

export function createBasePipelineDropdownCatalog(now = new Date()) {
  return {
    syncedAt: new Date(now).toISOString(),
    source: 'app',
    dropdowns: {
      stage: options(BASE_PIPELINE_WORKFLOW.stage),
      priority: options(BASE_PIPELINE_WORKFLOW.priority),
      status: options(BASE_PIPELINE_WORKFLOW.status),
      source: options(BASE_PIPELINE_WORKFLOW.source),
      loss_reason: options(BASE_PIPELINE_WORKFLOW.loss_reason),
      product: [],
    },
  }
}
