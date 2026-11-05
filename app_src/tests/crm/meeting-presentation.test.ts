import assert from 'node:assert/strict'
import test from 'node:test'
import { meetingCalendarPresentation, meetingDisplayRows } from '../../lib/crm/meetingPresentation.ts'

const imported = {
  id: 'occurrence-1', pipelineId: 'pipeline-1', provider: 'google-calendar', status: 'scheduled',
  calendarImported: true, calendarOwnerEmail: 'owner@example.test', calendarConnectionId: 'connection-1',
  calendarId: 'calendar-1', externalEventId: 'event-1', recurringEventId: 'series-1',
  startsAt: '2026-10-29T18:00:00Z',
}
const now = Date.parse('2026-10-29T12:00:00Z')

test('import provenance is not an outgoing invitation-delivery receipt', () => {
  assert.deepEqual(meetingCalendarPresentation(imported), { label: 'Imported from Google Calendar', color: 'default' })
  assert.equal(meetingCalendarPresentation({ ...imported, calendarImported: false }).label, 'Not verified')
  for (const key of ['provider', 'externalEventId', 'calendarId']) {
    assert.equal(meetingCalendarPresentation({ ...imported, [key]: '' }).label, 'Not verified', key)
  }
  assert.equal(meetingCalendarPresentation({ status: 'scheduled' }).label, 'Not verified')
  assert.equal(meetingCalendarPresentation({ status: 'planned' }).label, 'Not sent')
  assert.equal(meetingCalendarPresentation({ ...imported, calendarDeliveryStatus: 'sent' }).label, 'Delivered')
})

test('failure, cancellation and pending delivery remain visible on imported meetings', () => {
  for (const [calendarDeliveryStatus, label] of [
    ['failed', 'Failed'], ['queued', 'Pending'], ['not-configured', 'Not configured'], ['cancelled', 'Cancelled'],
  ]) assert.equal(meetingCalendarPresentation({ ...imported, calendarDeliveryStatus }).label, label)
  assert.equal(meetingCalendarPresentation({ ...imported, status: 'cancelled', calendarDeliveryStatus: 'sent' }).label, 'Cancelled')
  assert.equal(meetingCalendarPresentation({ ...imported, status: 'completed' }).label, 'Completed')
})

test('recurring grouping shows the next loaded occurrence without changing records or hiding access to all', () => {
  const records = [
    { ...imported, id: 'future', externalEventId: 'future', startsAt: '2026-11-05T19:00:00Z' },
    imported,
    { ...imported, id: 'past', externalEventId: 'past', startsAt: '2026-10-22T18:00:00Z' },
  ]
  const before = JSON.stringify(records)
  assert.deepEqual(meetingDisplayRows(records, true, now), [{ record: imported, occurrenceCount: 3 }])
  assert.deepEqual(meetingDisplayRows(records, false, now), records.map(record => ({ record, occurrenceCount: 1 })))
  assert.equal(JSON.stringify(records), before)
  assert.equal(meetingDisplayRows(records, true, Date.parse('2026-12-01'))[0].record.id, 'future')
})

test('same recurring ID across owners, connections, calendars or pipelines never collapses', () => {
  for (const key of ['pipelineId', 'calendarOwnerEmail', 'calendarConnectionId', 'calendarId', 'recurringEventId']) {
    for (const value of ['', 'another']) {
      const rows = meetingDisplayRows([imported, { ...imported, id: 'other', [key]: value }], true, now)
      assert.equal(rows.length, 2, `${key}: ${value}`)
    }
  }
})

test('invalid, unverified, cancelled and failed occurrences stay separate and actionable', () => {
  for (const update of [
    { calendarImported: false }, { externalEventId: '' }, { provider: 'other' }, { startsAt: 'invalid' },
    { status: 'cancelled' }, { calendarDeliveryStatus: 'failed' }, { calendarDeliveryStatus: 'queued' },
    { calendarDeliveryStatus: 'not-configured' },
  ]) assert.equal(meetingDisplayRows([imported, { ...imported, id: 'other', ...update }], true, now).length, 2)
  assert.deepEqual(meetingDisplayRows([], true, now), [])
})
