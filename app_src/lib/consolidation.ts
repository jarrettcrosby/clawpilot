export type ReviewDecision = 'proposed' | 'accepted' | 'rejected' | 'partially_accepted' | 'applied'

export type ConsolidationItem = {
  id: string
  title: string
  reason: string
  decision?: ReviewDecision
}

export type ConsolidationChecklistProposal = {
  task: ConsolidationItem
  parentTitle: string
}

export type ConsolidationMilestoneGroup = {
  milestone: string
  reason: string
  groupId: string
  decision?: ReviewDecision
  items: ConsolidationItem[]
}

export type ConsolidationReviewPayload = {
  scope?: 'group' | 'item'
  action: 'accept' | 'reject' | 'reset'
  groupId?: string
  itemId?: string
  itemIds?: string[]
}

export type ConsolidationResponse = {
  error?: string
  decisionModel?: {
    states?: string[]
  }
  reviewState?: {
    updatedAt?: string
  }
  proposals?: {
    merge_into_milestone: ConsolidationMilestoneGroup[]
    remain_standalone: ConsolidationItem[]
    become_comments: ConsolidationItem[]
    become_checklist_items: ConsolidationChecklistProposal[]
  }
}
