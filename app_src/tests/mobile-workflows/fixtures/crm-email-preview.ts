// Synthetic archived-email fixtures. No private message body or customer data.
export const CRM_EMAIL_PREVIEW_ORIGIN = 'https://email-preview-fixture.invalid'
export const CRM_EMAIL_PREVIEW_HTML = `<div dir="ltr"><div>
<p>Hi Casey,</p><p>Thanks again for meeting today.</p>
<p>Hi Casey,</p><p>Thanks again for meeting today.</p>
<p>The proposal and presentation are linked below for review.</p>
<p><a title="example href='https://wrong.test'" href="https://example.test/presentation.pdf?version=2&amp;review=yes">Presentation — Discussion Draft (PDF)</a></p>
<p><a href="https://example.test/proposal.pdf">Proposal — Discussion Draft (PDF)</a></p>
<table><tr><td><strong>Alex Example</strong><br><span>Operations adviser</span><br>
<a href="mailto:alex@example.test">alex@<wbr>example.test</a><br>
<a href="tel:+15550100100">+1 555 010 0100</a></td>
<td><img src="${CRM_EMAIL_PREVIEW_ORIGIN}/logo.png" alt="Example logo"></td></tr></table>
<img width="0" height="0" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7">
<img width="1" height="1" src="${CRM_EMAIL_PREVIEW_ORIGIN}/tracking.gif" onerror="window.__crmEmailPreviewExecuted=true">
<script>window.__crmEmailPreviewExecuted=true;fetch('${CRM_EMAIL_PREVIEW_ORIGIN}/script')</script>
<iframe src="${CRM_EMAIL_PREVIEW_ORIGIN}/frame">Hidden frame</iframe>
<a href="javascript:window.__crmEmailPreviewExecuted=true">Unsafe action</a>
<a title="example href='https://wrong.test'">Plain reference</a>
<p>%gsltga7654321 %gsltgc7654321</p>
</div></div>`

export const CRM_EMAIL_PREVIEW_REPLY = 'Thanks, Alex.\r\n\r\n\r\n\r\nI will be in touch next week.\r\n\r\n\r\n[cid:image428799.png@SYNTHETIC]\r\n<https://example.test/>\r\n\r\nCasey Example\r\n\r\nPhone: 555-010-0200<tel:>\r\n\r\nFax: 555-010-0300<fax:555-010-0300>'
export const CRM_EMAIL_PREVIEW_NOTE = '<div>This is a literal note, not an email preview.</div>\n\n\nKeep the exact note spacing.'

export const CRM_EMAIL_PREVIEW_RECORDS = [
  { id: '00000000-0000-4000-8000-000000000404', referenceCode: 'gi8642101', subject: 'Synthetic HTML archive', interactionType: 'email', description: CRM_EMAIL_PREVIEW_HTML },
  { id: '00000000-0000-4000-8000-000000000405', referenceCode: 'gi8642102', subject: 'Synthetic plain reply', interactionType: 'email', description: CRM_EMAIL_PREVIEW_REPLY },
  { id: '00000000-0000-4000-8000-000000000406', referenceCode: 'gi8642103', subject: 'Synthetic non-email note', interactionType: 'note', description: CRM_EMAIL_PREVIEW_NOTE },
].map((record) => ({
  ...record,
  shortUrl: null,
  organizationId: '00000000-0000-4000-8000-000000000101',
  organizationName: 'Acceptance Organization',
  contactId: '00000000-0000-4000-8000-000000000102',
  contactIds: ['00000000-0000-4000-8000-000000000102'],
  opportunityId: null,
  leadId: null,
  meetingId: null,
  campaignId: null,
  occurredAt: '2026-09-03T14:00:00.000Z',
  agentEmail: 'operator@example.test',
  agentName: 'Mobile Operator',
  syncStatus: 'synced',
}))
