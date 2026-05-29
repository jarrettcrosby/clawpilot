import type { NextApiRequest, NextApiResponse } from 'next'
import fs from 'fs'
import path from 'path'
import vocab from '@/lib/governance/vocab'
import { ensureNotFrozen } from '@/lib/freeze'
import type { Task } from '@/lib/types'
import { getErrorMessage } from '@/lib/errorUtils'
type ReviewState = {
  items: Record<string, string>
  groups: Record<string, string>
  groupItems: Record<string, Record<string, string>>
  updatedAt: string | null
}

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  try {
    const dataPath = process.env.TASKS_PATH
      ? path.resolve(process.env.TASKS_PATH)
      : path.resolve(process.cwd(), 'data', 'tasks.json')
    if (!fs.existsSync(dataPath)) return res.status(500).json({ error: 'tasks.json missing' })
    const raw = fs.readFileSync(dataPath, 'utf8')
    const tasks: Task[] = JSON.parse(raw)

    const baseDir = process.env.TASKS_PATH
      ? path.dirname(path.resolve(process.env.TASKS_PATH))
      : path.resolve(process.cwd(), 'data')
    const reviewPath = process.env.CONSOLIDATION_PATH
      ? path.resolve(process.env.CONSOLIDATION_PATH)
      : path.join(baseDir, 'consolidation-review.json')

    const decisionStates = ['proposed', 'accepted', 'rejected', 'partially_accepted', 'applied'] as const
    type DecisionState = typeof decisionStates[number]

    function readReviewState() {
      if (!fs.existsSync(reviewPath)) return { items: {}, groups: {}, groupItems: {}, updatedAt: null as string | null }
      const content = fs.readFileSync(reviewPath, 'utf8')
      try {
        const parsed = JSON.parse(content) as Partial<ReviewState>
        return {
          items: parsed.items || {},
          groups: parsed.groups || {},
          groupItems: parsed.groupItems || {},
          updatedAt: parsed.updatedAt || null,
        }
      } catch {
        return { items: {}, groups: {}, groupItems: {}, updatedAt: null }
      }
    }

    function writeReviewState(state: ReviewState) {
      fs.mkdirSync(baseDir, { recursive: true })
      const payload = { ...state, updatedAt: new Date().toISOString() }
      fs.writeFileSync(reviewPath, JSON.stringify(payload, null, 2))
      return payload
    }

    if (req.method === 'POST') {
      const freeze = ensureNotFrozen()
      if (freeze) return res.status(423).json(freeze)
      const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body
      let { scope, action } = body || {}
      const { groupId, itemId } = body || {}
      if (!scope) {
        if (itemId) scope = 'item'
        else if (groupId || Array.isArray(body?.itemIds)) scope = 'group'
      }
      if (!action && body?.decision) action = body.decision

      if (action === 'reset') {
        const cleared = writeReviewState({ items: {}, groups: {}, groupItems: {}, updatedAt: null })
        return res.status(200).json({ ok: true, review: cleared })
      }

      if (!['group', 'item'].includes(scope)) return res.status(400).json({ error: 'Invalid scope' })
      if (!['accept', 'reject'].includes(action)) return res.status(400).json({ error: 'Invalid action' })
      const nextState: DecisionState = action === 'accept' ? 'accepted' : 'rejected'
      const current = readReviewState()

      if (scope === 'item') {
        if (!itemId) return res.status(400).json({ error: 'Missing itemId' })
        current.items[itemId] = nextState
        if (groupId) {
          current.groupItems[groupId] = current.groupItems[groupId] || {}
          current.groupItems[groupId][itemId] = nextState
        }
      }

      if (scope === 'group') {
        if (!groupId) return res.status(400).json({ error: 'Missing groupId' })
        current.groups[groupId] = nextState
        current.groupItems[groupId] = current.groupItems[groupId] || {}
        if (Array.isArray(body.itemIds)) {
          body.itemIds.forEach((id: string) => {
            current.groupItems[groupId][id] = nextState
            current.items[id] = nextState
          })
        }
      }

      const saved = writeReviewState(current)
      return res.status(200).json({ ok: true, review: saved })
    }

    const reviewState = readReviewState()

    // Enhanced consolidation logic using normalized governance metadata
    type ReasonedTask = { id: string; title: string; reason: string; decision?: string }
    type ReasonedChecklist = { parentTitle: string; task: ReasonedTask }
    type ReasonedMerge = { milestone: string; items: ReasonedTask[]; reason: string; decision?: string; groupId?: string }

    const proposals = {
      remain_standalone: [] as ReasonedTask[],
      merge_into_milestone: [] as ReasonedMerge[],
      become_checklist_items: [] as ReasonedChecklist[],
      become_comments: [] as ReasonedTask[],
    }

    const decisionModel = {
      actions: {
        merge_into_milestone: 'Group deliverables into milestone cards',
        remain_standalone: 'Keep as standalone card',
        become_comments: 'Convert to comments on a parent card',
        become_checklist_items: 'Convert to checklist items under a milestone',
      },
      states: decisionStates,
      defaultState: 'proposed',
    }

    function normalizeIntent(v: unknown) {
      return vocab.normalizeIntent(v) || null
    }

    function groupState(groupId: string, itemIds: string[]) {
      const fromGroupItems = reviewState.groupItems?.[groupId] || {}
      const states = itemIds.map(id => fromGroupItems[id] || reviewState.items?.[id] || 'proposed')
      if (states.length === 0) return reviewState.groups?.[groupId] || 'proposed'
      const unique = new Set(states)
      if (unique.size === 1) return states[0]
      if (unique.has('accepted') || unique.has('rejected')) return 'partially_accepted'
      return 'proposed'
    }
    function normalizeEntity(v: unknown) {
      return vocab.normalizeEntity(v) || vocab.ENTITY_TYPES.TASK
    }

    function tagMilestone(t: Task): string | null {
      if (!Array.isArray(t.tags)) return null
      for (const tg of t.tags) {
        if (typeof tg !== 'string') continue
        if (tg.startsWith('milestone:')) return tg.split(':', 2)[1]
        if (tg === vocab.ENTITY_TYPES.MILESTONE || tg === 'phase') return vocab.ENTITY_TYPES.MILESTONE
      }
      return null
    }

    // detect existing milestone-like cards
    const milestoneCandidates: { id: string; title: string }[] = []
    for (const t of tasks) {
      const title = String(t.title || '')
      const tags = Array.isArray(t.tags) ? t.tags.map(String) : []
      if (title.match(/Phase|phase|Phase \d|Milestone|milestone/)) {
        milestoneCandidates.push({ id: t.id, title })
      } else if (tags.includes('phase') || tags.includes(vocab.ENTITY_TYPES.MILESTONE)) {
        milestoneCandidates.push({ id: t.id, title })
      }
    }

    const byMilestone: Record<string, { task: Task; reason: string }[]> = {}
    const byCategory: Record<string, { task: Task; reason: string }[]> = {}

    const remainMap = new Map<string, ReasonedTask>()
    const commentsMap = new Map<string, ReasonedTask>()

    function pushRemain(t: Task, reason: string) {
      if (!remainMap.has(t.id)) remainMap.set(t.id, { id: t.id, title: t.title, reason })
    }
    function pushComment(t: Task, reason: string) {
      if (!commentsMap.has(t.id)) commentsMap.set(t.id, { id: t.id, title: t.title, reason })
    }

    for (const t of tasks) {
      if (t.archived) continue

      const gov = t.governance || {}
      const intent = normalizeIntent(gov.intent || t.governance?.intent || gov?.recommendedAction || null) || vocab.INTENTS.DELIVERABLE
      const entityType = normalizeEntity(t.entityType || gov.entityType || null)
      const workstream = String(t.workstream || t.category || 'uncategorized')
      const hasChecklist = Array.isArray(t.checklist) && t.checklist.length > 0

      const title = String(t.title || '')
      const tags = Array.isArray(t.tags) ? t.tags.map(String) : []
      const isMilestoneLike = title.match(/Phase|phase|Phase \d|Milestone|milestone/) || tags.includes('phase') || tags.includes(vocab.ENTITY_TYPES.MILESTONE)
      if (isMilestoneLike) {
        pushRemain(t, 'Milestone-like card')
        continue
      }

      if (entityType === vocab.ENTITY_TYPES.NOTE || intent === vocab.INTENTS.NOTE) {
        pushComment(t, 'Note intent')
        continue
      }

      if (gov && gov.recommendedAction && String(gov.recommendedAction).startsWith(vocab.RECOMMENDED_ACTIONS.MERGE_MILESTONE_PREFIX) && gov.milestoneName) {
        const m = gov.milestoneName
        byMilestone[m] = byMilestone[m] || []
        byMilestone[m].push({ task: t, reason: 'Governance recommended milestone merge' })
        continue
      }

      if (gov && gov.missingMilestoneFields) {
        pushComment(t, 'Missing milestone fields')
        continue
      }

      const healthScore = typeof gov.healthScore === 'number' ? gov.healthScore : 0.5
      if (healthScore < 0.35) {
        pushComment(t, `Low health score (${healthScore.toFixed(2)})`)
        continue
      }

      if (hasChecklist) {
        const tagM = tagMilestone(t)
        let parentTitle: string | null = null
        if (tagM) parentTitle = tagM
        else {
          const candidate = milestoneCandidates.find(c => c.title.toLowerCase().includes(workstream.toLowerCase()) || c.title.toLowerCase().includes(t.title.split(':')[0].toLowerCase()))
          if (candidate) parentTitle = candidate.title
        }
        if (parentTitle) {
          proposals.become_checklist_items.push({ parentTitle, task: { id: t.id, title: t.title, reason: 'Checklist present + milestone match', decision: reviewState.items?.[t.id] || 'proposed' } })
        } else {
          pushRemain(t, 'Checklist present without clear milestone target')
        }
        continue
      }

      if (intent === vocab.INTENTS.DELIVERABLE && healthScore >= 0.5) {
        const tagM = tagMilestone(t)
        if (tagM) {
          byMilestone[tagM] = byMilestone[tagM] || []
          byMilestone[tagM].push({ task: t, reason: 'Tagged with milestone' })
          continue
        }
        const candidate = milestoneCandidates.find(c => c.title.toLowerCase().includes(workstream.toLowerCase()) || t.title.toLowerCase().startsWith(c.title.split('—')[0].trim().toLowerCase()))
        if (candidate) {
          byMilestone[candidate.title] = byMilestone[candidate.title] || []
          byMilestone[candidate.title].push({ task: t, reason: 'Matches milestone by title/workstream' })
          continue
        }
        byCategory[workstream] = byCategory[workstream] || []
        byCategory[workstream].push({ task: t, reason: 'Workstream grouping' })
        continue
      }

      pushRemain(t, 'Default keep')
    }

    for (const [m, items] of Object.entries(byMilestone)) {
      if (items.length >= 2) {
        const itemIds = items.map(i => i.task.id)
        proposals.merge_into_milestone.push({
          milestone: m,
          reason: 'Grouped by milestone match',
          items: items.map(i => ({ id: i.task.id, title: i.task.title, reason: i.reason, decision: reviewState.items?.[i.task.id] || 'proposed' })),
          decision: groupState(`merge:${m}`, itemIds),
          groupId: `merge:${m}`,
        })
      } else if (items.length === 1) {
        pushRemain(items[0].task, 'Single item in milestone group')
      }
    }

    for (const [c, items] of Object.entries(byCategory)) {
      if (items.length >= 3) {
        const milestone = `Workstream: ${c}`
        const itemIds = items.map(i => i.task.id)
        proposals.merge_into_milestone.push({
          milestone,
          reason: 'Grouped by workstream (>=3 deliverables)',
          items: items.map(i => ({ id: i.task.id, title: i.task.title, reason: i.reason, decision: reviewState.items?.[i.task.id] || 'proposed' })),
          decision: groupState(`merge:${milestone}`, itemIds),
          groupId: `merge:${milestone}`,
        })
      } else {
        for (const it of items) pushRemain(it.task, 'Not enough items for workstream group')
      }
    }

    proposals.remain_standalone = Array.from(remainMap.values()).map(it => ({ ...it, decision: reviewState.items?.[it.id] || 'proposed' }))
    proposals.become_comments = Array.from(commentsMap.values()).map(it => ({ ...it, decision: reviewState.items?.[it.id] || 'proposed' }))

    return res.status(200).json({ proposals, decisionModel, reviewState: reviewState.updatedAt ? { updatedAt: reviewState.updatedAt } : null })
  } catch (error: unknown) {
    return res.status(500).json({ error: getErrorMessage(error) })
  }
}
