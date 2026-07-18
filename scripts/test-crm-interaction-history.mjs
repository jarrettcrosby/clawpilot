#!/usr/bin/env node
import assert from 'node:assert/strict'
import { annotateInteractionEventHistory } from '../app_src/lib/crm/interactionHistory.mjs'

const records = annotateInteractionEventHistory([
  {
    id: 'later', interactionType: 'meeting', providerMessageId: 'event-1',
    occurredAt: '2026-07-15T15:04:00.000Z', deliveryStatus: 'scheduled',
  },
  {
    id: 'email', interactionType: 'email', providerMessageId: 'message-1',
    occurredAt: '2026-07-15T14:00:00.000Z', deliveryStatus: 'sent',
  },
  {
    id: 'earlier', interactionType: 'meeting', providerMessageId: 'event-1',
    occurredAt: '2026-07-15T13:14:00.000Z', deliveryStatus: 'scheduled',
  },
  {
    id: 'cancelled', interactionType: 'meeting', providerMessageId: 'event-1',
    occurredAt: '2026-07-15T16:04:00.000Z', deliveryStatus: 'cancelled',
  },
])

assert.equal(records.find((record) => record.id === 'earlier')?.eventAction, 'Created')
assert.equal(records.find((record) => record.id === 'later')?.eventAction, 'Updated')
assert.equal(records.find((record) => record.id === 'cancelled')?.eventAction, 'Cancelled')
assert.equal(records.find((record) => record.id === 'email')?.eventAction, '')
assert.deepEqual(annotateInteractionEventHistory(null), [])

console.log('crm interaction history tests passed')
