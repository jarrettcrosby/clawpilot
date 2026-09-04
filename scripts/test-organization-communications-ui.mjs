#!/usr/bin/env node
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = process.cwd()
const read = (path) => readFileSync(resolve(root, path), 'utf8')

const settings = read('app_src/components/settings/MatonIntegrationPanel.tsx')
const crm = read('app_src/components/crm/CrmSection.tsx')
const mobileAcceptance = read('app_src/tests/mobile-workflows/ui-acceptance.spec.ts')

for (const fragment of [
  "const response = await fetch(path, init)",
  "'/api/integrations/communications'",
  '`/api/integrations/communications?app=${encodeURIComponent(app)}`',
  "method: 'PATCH'",
  "action: 'bind'",
  "method: 'DELETE'",
  'Organization communication identities',
  'Personal Maton connections',
  'canManage?: boolean',
  "canManage: typeof result.canManage === 'boolean' ? result.canManage : canManageFallback",
  'communication?.canManage ? (',
  'Organization defaults can only be changed by an organization owner or access administrator.',
  "identityLabel: 'Gmail send-as address'",
  "identityLabel: 'Calendar organizer'",
  'label={`${label} connection`}',
  'label="Organizer calendar"',
  'Gmail send-as applies to email. Calendar invitations use the organizer calendar below.',
  'gmailSendAsIdentities',
  'verificationStatus === \'accepted\'',
  'selectedConnection?.calendars',
  'selectedConnection?.selectionError',
  "? 'Pending'",
  "? 'Failed'",
  "? 'Active'",
  "? 'Disabled'",
  "'Not connected'",
  'Refresh status',
]) {
  assert.ok(settings.includes(fragment), `Organization communication settings UI missing ${fragment}`)
}

assert.ok(
  settings.indexOf('Organization communication identities')
    < settings.indexOf('Personal Maton connections'),
  'Organization bindings must appear separately from personal Maton connections',
)
assert.ok(
  settings.includes("...(app === 'google-mail' ? { gmailSendAsEmail: identityEmail } : {})"),
  'Gmail binding must submit the selected send-as identity',
)
assert.ok(
  settings.includes("...(app === 'google-calendar' ? { calendarId } : {})"),
  'Calendar binding must submit the selected accessible Calendar ID',
)
assert.ok(
  settings.includes('disabled={busy || verifiedSendAs.length === 0}')
    && settings.includes('disabled={busy || calendars.length === 0}'),
  'Gmail and Calendar selectors must be restricted to server-verified options',
)
assert.ok(
  settings.includes('}, undefined, communication?.canManage === true)')
    && settings.includes('}, app, communication?.canManage === true)'),
  'Manager capability must survive successful bind and disconnect responses that omit canManage',
)

for (const fragment of [
  'const MEETING_DURATION_PRESETS = [15, 30, 45, 60, 90] as const',
  "type MeetingMode = 'google_meet' | 'in_person' | 'custom_link'",
  "if (normalized === 'in_person' || normalized === 'custom_link')",
  "new Intl.DateTimeFormat('en-US', { timeZone: timezone })",
  'function meetingEndValue(',
  'duration * 60_000',
  "meetingMode: actionMeetingMode",
  "location: actionMeetingMode === 'in_person'",
  "customJoinUrl: actionMeetingMode === 'custom_link'",
  "fetch('/api/integrations/communications'",
  'meetingCalendarChoices(payload)',
  "const ORGANIZATION_DEFAULT_CALENDAR_KEY = '__organization_default_calendar__'",
  "source: 'organization-default' | 'actor-connection'",
  "providerIdentities.googleCalendarSource !== 'organization'",
  "const ORGANIZATION_DEFAULT_EMAIL_KEY = '__organization_default_email__'",
  'emailSenderChoices(payload)',
  "verificationStatus !== 'accepted'",
  "actionComposer?.type === 'send_email'",
  "|| actionComposer?.type === 'send_campaign'",
  '!emailSendersLoading',
  '&& actionEmailSender',
  'label="Send from"',
  'Linked account ${linkedAccount}',
  'gmailConnectionId: actionEmailSender.connectionId',
  'gmailSendAsEmail: actionEmailSender.senderEmail',
  'label="Sent from"',
  'label="Linked Gmail account"',
  "communicationBindingSource') === 'email-override'",
  'label="Last recorded sender"',
  'Choose an accepted Gmail sender when you send this campaign.',
  'label="Meeting type"',
  'label="Send from calendar"',
  'Invitation organizer: ${editorMeetingCalendar.organizerEmail}',
  '<MenuItem value="google_meet">Google Meet</MenuItem>',
  '<MenuItem value="in_person">In person</MenuItem>',
  '<MenuItem value="custom_link">Custom link</MenuItem>',
  'label="Physical address"',
  'label="Meeting link"',
  'label="Start"',
  'label="Duration"',
  'label="Custom duration (minutes)"',
  'label="Ends"',
  'InputProps={{ readOnly: true }}',
  "if (status === 'sent' || status === 'scheduled') return 'Delivered'",
  "if (status === 'not-configured') return 'Not configured'",
  "return textValue(record, 'calendarDeliveryStatus')",
  "{entity === 'meetings' ? 'SuiteCRM' : 'Sync'}",
  'aria-label="Meeting delivery status"',
  'label="Meeting status"',
  '<MenuItem value="scheduled">Scheduled</MenuItem>',
  "Organizer: {textValue(editorRecord, 'calendarOrganizerEmail')}",
  "Calendar: {textValue(editorRecord, 'calendarId')}",
  'Calendar delivery pending',
]) {
  assert.ok(crm.includes(fragment), `CRM meeting UI missing ${fragment}`)
}

assert.ok(
  !crm.includes("return textValue(record, 'calendarDeliveryStatus') || textValue(record, 'status')"),
  'Historical meeting status must never be inferred as Calendar delivery evidence',
)
assert.ok(
  !crm.includes('select label="Calendar status"')
    && !crm.includes('<MenuItem value="scheduled">Delivered</MenuItem>'),
  'General meeting state must not be presented as Calendar delivery evidence',
)
assert.ok(
  crm.includes("setEditorMeetingIdempotencyKey(entity === 'meetings'")
    && crm.includes('...(isMeeting ? { idempotencyKey: editorMeetingIdempotencyKey } : {})')
    && crm.includes("...(isMeeting ? { 'Idempotency-Key': editorMeetingIdempotencyKey } : {})"),
  'Meeting create and edit retries must reuse the editor-scoped request identity in body and header',
)
assert.ok(
  crm.includes('const idempotencyKey = `crm-ui:${type}:${crypto.randomUUID()}`')
    && crm.includes("'Idempotency-Key': actionFields.idempotencyKey")
    && crm.includes('idempotencyKey: actionFields.idempotencyKey'),
  'Action retries must reuse the composer-scoped request identity in body and header',
)
assert.ok(
  crm.includes("actionMeetingCalendar?.source === 'actor-connection'")
    && crm.includes('calendarConnectionId: actionMeetingCalendar.connectionId')
    && crm.includes('calendarId: actionMeetingCalendar.calendarId'),
  'Only a verified actor-owned Calendar choice may send explicit provider override fields',
)
assert.ok(
  crm.includes("actionEmailSender?.source === 'actor-connection'")
    && crm.includes('gmailConnectionId: actionEmailSender.connectionId')
    && crm.includes('gmailSendAsEmail: actionEmailSender.senderEmail'),
  'Only a provider-verified actor-owned Gmail choice may send explicit account-and-alias override fields',
)
assert.ok(
  crm.includes("gmailConnectionId: choice?.source === 'actor-connection' ? choice.connectionId : ''")
    && crm.includes("gmailSendAsEmail: choice?.source === 'actor-connection' ? choice.senderEmail : ''"),
  'Gmail selection must preserve the exact linked account and clear override fields for the opaque organization default',
)
assert.ok(
  crm.includes("if (!senderEmail || (verificationStatus !== 'accepted' && identity.isPrimary !== true)) continue")
    && crm.includes('emailSenderChoiceKey(connectionId, senderEmail)'),
  'The sender chooser must accept provider primaries, exclude non-accepted custom aliases, and key choices by connection plus sender',
)
assert.ok(
  settings.includes("identity.verificationStatus === 'accepted' || identity.isPrimary")
    && settings.includes("identity.verificationStatus !== 'accepted' && !identity.isPrimary")
    && crm.includes('Choose an available verified Gmail sender before sending.'),
  'Settings must accept provider primaries and CRM must request an explicit available choice rather than claim Gmail is disconnected',
)
assert.ok(
  crm.includes("calendarChoiceKey: choice?.key || ''")
    && crm.includes("calendarConnectionId: choice?.source === 'actor-connection' ? choice.connectionId : ''")
    && crm.includes("calendarId: choice?.source === 'actor-connection' ? choice.calendarId : ''"),
  'Calendar selection must update the stable choice key and clear override fields for the opaque default',
)
assert.ok(
  crm.includes("choice.calendarId === organizationDefaultMeetingCalendar.calendarId")
    && crm.includes('organizationDefaultIsActorSelectable')
    && crm.includes('!organizationDefaultIsActorSelectable'),
  'An actor-selectable organization Calendar must not be duplicated as an opaque default',
)
assert.ok(
  crm.includes("source: 'organization-default' | 'actor-connection' | 'unavailable-current'")
    && crm.includes("editorMeetingCalendar.source !== 'unavailable-current'")
    && crm.includes('This calendar is no longer linked. Choose another calendar.'),
  'An unavailable existing Calendar must remain visible and block a silent provider switch',
)

assert.ok(
  crm.includes("? !meetingCalendarsLoading\n            && actionMeetingCalendar")
    && crm.includes("actionMeetingCalendar.source !== 'unavailable-current'")
    && crm.includes("actionFields.subject?.trim()"),
  'Meeting delivery must stay disabled until a provider-verified writable Calendar is selected',
)
assert.ok(
  crm.includes("label={`Calendar: ${meetingCalendarStatusLabel(meetingCalendarDeliveryValue(editorRecord))}`}")
    && crm.includes("label={`SuiteCRM: ${suiteCrmSyncStatusLabel(editorRecord.syncStatus)}`}"),
  'Meeting details must render Calendar delivery and SuiteCRM sync independently',
)

for (const fragment of [
  "calendarDeliveryStatus: 'sent'",
  "calendarOrganizerEmail: 'operator@example.test'",
  "calendarConnectionId: 'calendar-personal-connection'",
  "googleCalendarOrganizer: 'calendar@example.test'",
  "googleCalendarConnectionId: 'calendar-org-connection'",
  "googleCalendarId: 'calendar@example.test'",
  "googleCalendarSource: 'organization'",
  "getByRole('combobox', { name: 'Meeting type' })",
  "getByRole('combobox', { name: 'Send from calendar' })",
  "getByRole('combobox', { name: 'Send from' })",
  "stewards@eigenracing\\.com.*jarrettcrosby@gmail\\.com",
  "getByRole('option', { name: /pending@example\\.test/ })).toHaveCount(0)",
  "gmailConnectionId: 'gmail-stewards-connection'",
  "gmailSendAsEmail: 'stewards@eigenracing.com'",
  "expect(explicitEmailRequest?.body.payload).not.toMatchObject",
  "includeOrganizationConnection: false",
  "expect(firstDefaultRequest.body).not.toHaveProperty('calendarConnectionId')",
  "expect(firstDefaultRequest.body).not.toHaveProperty('calendarId')",
  "calendarConnectionId: 'calendar-personal-connection'",
  "calendarId: 'operator@example.test'",
  "expect(explicitCalendarRequest?.body.payload).not.toMatchObject",
  "getByLabel('Physical address')",
  "getByLabel('Meeting link').fill('https://meet.example.test/acceptance')",
  "getByRole('option', { name: '45 minutes' })",
  "getByLabel('Ends')).toHaveValue('2026-07-15T09:45')",
  "name: 'Gmail send-as address'",
  "name: 'Organizer calendar'",
  'getByText(/Invitation organizer: calendar@example\\.test/)',
  "Legacy Meeting Without Delivery Evidence",
  "legacyMeetingRow.getByText('Unknown', { exact: true })",
  "failFirstCalendarAction: true",
  'expect(retriedDefaultRequest.body.idempotencyKey).toBe(firstDefaultRequest.body.idempotencyKey)',
  "failFirstMeetingCreate: true",
  'expect(meetingCreateRequests[1].body.idempotencyKey)',
  "failFirstMeetingUpdate: true",
  'Existing custom meeting keeps its calendar and request identity across retry',
  "expect(meetingUpdateRequests[0].body.idempotencyKey).toMatch(/^crm-ui:meeting:update:/)",
  "calendarConnectionId: 'calendar-personal-connection'",
  "meetingMode: 'custom_link'",
  'Meeting calendar chooser lists each linked calendar once',
  'await expect(options).toHaveCount(2)',
  "mockOrganizationCommunications(page, { canManage: false })",
  "getByRole('combobox', { name: 'Gmail connection' })).toHaveCount(0)",
  "getByRole('combobox', { name: 'Google Calendar connection' })).toHaveCount(0)",
]) {
  assert.ok(mobileAcceptance.includes(fragment), `Rendered meeting acceptance missing ${fragment}`)
}

console.log('Organization communication and meeting UI source checks passed.')
