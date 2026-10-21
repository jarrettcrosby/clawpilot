type OpportunityLifecycleInput = {
  status?: unknown
  stage?: unknown
}

function normalized(value: unknown) {
  return String(value ?? '').trim().toLowerCase().replace(/\s+/g, ' ').replace(/\s*\/\s*/g, '/')
}

const WON_STATUSES = new Set(['closed', 'won'])
const LOST_STATUSES = new Set(['lost', 'abandoned'])
const WON_STAGES = new Set(['closed', 'won', 'closed won'])
const LOST_STAGES = new Set(['loss', 'lost', 'abandoned', 'closed lost'])

const OPEN_STAGE_ALIASES = new Map([
  ['identified lead', 'Prospecting'],
  ['prospecting', 'Prospecting'],
  ['qualified lead', 'Qualification'],
  ['qualification', 'Qualification'],
  ['needs analysis', 'Needs Analysis'],
  ['value proposition', 'Value Proposition'],
  ['id. decision makers', 'Id. Decision Makers'],
  ['perception analysis', 'Perception Analysis'],
  ['proposal', 'Proposal/Price Quote'],
  ['proposal/price quote', 'Proposal/Price Quote'],
  ['negotiation', 'Negotiation/Review'],
  ['negotiation/review', 'Negotiation/Review'],
])

/**
 * Native SuiteCRM reports recognize its exact sales-stage keys, not a pipeline's
 * display labels. Project lifecycle outcomes without changing the operator's
 * stage/status or attempting a lossy reverse translation of customized stages.
 */
export function suiteCrmOpportunitySalesStage(input: OpportunityLifecycleInput): string {
  const status = normalized(input.status)
  const stage = normalized(input.stage)
  if (WON_STATUSES.has(status)) return 'Closed Won'
  if (LOST_STATUSES.has(status)) return 'Closed Lost'

  const wonStage = WON_STAGES.has(stage)
  const lostStage = LOST_STAGES.has(stage)
  if (wonStage || lostStage) {
    // A nonterminal lifecycle remains active, including custom statuses. The
    // app surfaces this conflict; never turn an open record into a native win.
    if (status) return 'Prospecting'
    return wonStage ? 'Closed Won' : 'Closed Lost'
  }

  // Demo and Closed Delayed are intentionally not approximated to another
  // phase or an outcome. Unknown custom stages retain their original text.
  return OPEN_STAGE_ALIASES.get(stage) || String(input.stage ?? '').trim()
}
