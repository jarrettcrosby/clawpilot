import crypto from 'node:crypto'
import {
  type CareerSiteMailConfiguration,
  type NormalizedCareerSiteMailRequest,
} from '@/lib/careerSiteMailContract'
import { matonPlatformMailFetch } from '@/lib/maton'

const GMAIL_DRAFTS_PATH = '/google-mail/gmail/v1/users/me/drafts'
const SENDER_VERIFICATION_TTL_MS = 5 * 60 * 1000
let verifiedCareerSender: { email: string; expiresAt: number } | null = null

export type CareerSiteMailEnvelope = {
  to: string
  subject: string
  text: string
  html: string
}

export class CareerSiteMailProviderError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly ambiguous: boolean,
  ) {
    super(message)
    this.name = 'CareerSiteMailProviderError'
  }
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function label(value: string) {
  return value
    .split('-')
    .map((part) => part ? `${part[0].toUpperCase()}${part.slice(1)}` : '')
    .join(' ')
}

const resumeVariantLabels = {
  executive: 'Executive resume',
  servicenow: 'Enterprise transformation resume',
  odyssey: 'Enterprise AI and logistics resume',
} as const

const documentStyleLabels = {
  ats: 'ATS resume',
  'coffee-between-chapters': 'Coffee Between Chapters edition',
} as const

export function careerSiteMailEnvelope(
  request: NormalizedCareerSiteMailRequest,
  configuration: CareerSiteMailConfiguration,
): CareerSiteMailEnvelope {
  if (!configuration.enabled || !configuration.approvalTo) {
    throw new Error('Career-site mail is not configured')
  }

  if (request.messageType === 'contact-notification') {
    const organization = request.data.organization || 'Not provided'
    const interest = label(request.data.interest)
    const text = [
      'New Jarrett Crosby website inquiry',
      '',
      `Name: ${request.data.name}`,
      `Email: ${request.data.email}`,
      `Organization: ${organization}`,
      `Interest: ${interest}`,
      '',
      request.data.message,
    ].join('\r\n')
    const html = [
      '<!doctype html><html><body style="margin:0;padding:24px;background:#f4f0e8;color:#17211d;font-family:Arial,sans-serif">',
      '<div style="max-width:600px;margin:0 auto;padding:28px;background:#ffffff;border:1px solid #d7d0c2;border-radius:8px">',
      '<h1 style="margin:0 0 18px;font-size:24px">New website inquiry</h1>',
      `<p style="line-height:1.6"><strong>Name:</strong> ${escapeHtml(request.data.name)}<br>`,
      `<strong>Email:</strong> ${escapeHtml(request.data.email)}<br>`,
      `<strong>Organization:</strong> ${escapeHtml(organization)}<br>`,
      `<strong>Interest:</strong> ${escapeHtml(interest)}</p>`,
      `<p style="white-space:pre-wrap;line-height:1.6">${escapeHtml(request.data.message)}</p>`,
      '</div></body></html>',
    ].join('')
    return {
      to: configuration.approvalTo,
      subject: `Website inquiry: ${interest}`,
      text,
      html,
    }
  }

  if (request.messageType === 'newsletter-request') {
    const text = [
      'Coffee Between Chapters newsletter request',
      '',
      `${request.data.email} explicitly requested vlog updates.`,
      '',
      'This is a separate consent-bearing request for manual enrollment. No automatic enrollment occurred.',
    ].join('\r\n')
    const html = [
      '<!doctype html><html><body style="margin:0;padding:24px;background:#f4f0e8;color:#17211d;font-family:Arial,sans-serif">',
      '<div style="max-width:600px;margin:0 auto;padding:28px;background:#ffffff;border:1px solid #d7d0c2;border-radius:8px">',
      '<h1 style="margin:0 0 18px;font-size:24px">Newsletter request</h1>',
      `<p style="line-height:1.6"><strong>${escapeHtml(request.data.email)}</strong> explicitly requested Coffee Between Chapters vlog updates.</p>`,
      '<p style="line-height:1.6">This is a separate consent-bearing request for manual enrollment. No automatic enrollment occurred.</p>',
      '</div></body></html>',
    ].join('')
    return {
      to: configuration.approvalTo,
      subject: 'Coffee Between Chapters newsletter request',
      text,
      html,
    }
  }

  if (request.messageType === 'resume-approval-request') {
    const organization = request.data.organization || 'Not provided'
    const context = request.data.context || 'Not provided'
    const variant = resumeVariantLabels[request.data.variant]
    const signals = [
      request.data.networkInterest ? 'Wants to connect professionally' : null,
      request.data.roleFit ? 'Knows of a potentially fitting role' : null,
    ].filter(Boolean)
    const signalText = signals.length ? signals.join('; ') : 'No optional signal selected'
    const text = [
      'Review resume request',
      '',
      `Name: ${request.data.name}`,
      `Email: ${request.data.email}`,
      `Organization: ${organization}`,
      `Requested: ${variant}`,
      `Signals: ${signalText}`,
      `Note: ${context}`,
      '',
      'Review the request, choose the ATS or Coffee Between Chapters edition, choose view-only or view-and-download, and explicitly confirm the secure resume link:',
      request.data.approvalUrl,
      '',
      'Opening this URL does not send a resume. The review page requires a separate confirmation.',
    ].join('\r\n')
    const html = [
      '<!doctype html><html><body style="margin:0;padding:24px;background:#f4f0e8;color:#17211d;font-family:Arial,sans-serif">',
      '<div style="max-width:620px;margin:0 auto;padding:28px;background:#ffffff;border:1px solid #d7d0c2;border-radius:8px">',
      '<h1 style="margin:0 0 18px;font-size:24px">Review resume request</h1>',
      `<p style="line-height:1.6"><strong>Name:</strong> ${escapeHtml(request.data.name)}<br>`,
      `<strong>Email:</strong> ${escapeHtml(request.data.email)}<br>`,
      `<strong>Organization:</strong> ${escapeHtml(organization)}<br>`,
      `<strong>Requested:</strong> ${escapeHtml(variant)}<br>`,
      `<strong>Signals:</strong> ${escapeHtml(signalText)}</p>`,
      `<p style="white-space:pre-wrap;line-height:1.6"><strong>Note:</strong><br>${escapeHtml(context)}</p>`,
      `<p style="margin:22px 0"><a href="${escapeHtml(request.data.approvalUrl)}" style="display:inline-block;padding:12px 18px;border-radius:6px;background:#bf3f2f;color:#ffffff;text-decoration:none;font-weight:700">Review resume request</a></p>`,
      '<p style="color:#5e625f;line-height:1.6">Choose the edition and access mode on the review page. Opening the page does not send a resume; confirmation requires a separate action.</p>',
      '</div></body></html>',
    ].join('')
    return {
      to: configuration.approvalTo,
      subject: `Review resume request - ${variant}`,
      text,
      html,
    }
  }

  const variant = resumeVariantLabels[request.data.variant]
  const documentStyle = documentStyleLabels[request.data.documentStyle]
  const accessMode = request.data.accessMode === 'view+download'
    ? 'viewing and PDF download'
    : 'browser viewing only'
  const expiry = new Date(request.data.expiresAt).toLocaleString('en-US', {
    timeZone: 'America/New_York',
    timeZoneName: 'short',
  })
  const text = [
    `Hi ${request.data.name},`,
    '',
    `The ${variant.toLowerCase()} you requested is ready.`,
    '',
    `Edition: ${documentStyle}`,
    `Open your secure resume link: ${request.data.shortUrl}`,
    '',
    `Access mode: ${accessMode}`,
    `Expires: ${expiry}`,
    '',
    'This transactional message does not subscribe you to marketing or Coffee Between Chapters updates.',
  ].join('\r\n')
  const html = [
    '<!doctype html><html><body style="margin:0;padding:24px;background:#f4f0e8;color:#17211d;font-family:Arial,sans-serif">',
    '<div style="max-width:600px;margin:0 auto;padding:28px;background:#ffffff;border:1px solid #d7d0c2;border-radius:8px">',
    `<p style="line-height:1.6">Hi ${escapeHtml(request.data.name)},</p>`,
    `<p style="line-height:1.6">The ${escapeHtml(variant.toLowerCase())} you requested is ready.</p>`,
    `<p style="line-height:1.6"><strong>Edition:</strong> ${escapeHtml(documentStyle)}</p>`,
    `<p style="margin:22px 0"><a href="${escapeHtml(request.data.shortUrl)}" style="display:inline-block;padding:12px 18px;border-radius:6px;background:#bf3f2f;color:#ffffff;text-decoration:none;font-weight:700">Open secure resume link</a></p>`,
    `<p style="line-height:1.6"><strong>Access mode:</strong> ${escapeHtml(accessMode)}<br><strong>Expires:</strong> ${escapeHtml(expiry)}</p>`,
    '<p style="color:#5e625f;line-height:1.6">This transactional message does not subscribe you to marketing or Coffee Between Chapters updates.</p>',
    '</div></body></html>',
  ].join('')
  return {
    to: request.data.email,
    subject: 'Jarrett Crosby - requested resume',
    text,
    html,
  }
}

function base64Lines(value: string) {
  return Buffer.from(value, 'utf8').toString('base64').match(/.{1,76}/g)?.join('\r\n') || ''
}

function base64Url(value: string) {
  return Buffer.from(value, 'utf8')
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
}

function cleanHeader(value: string, labelValue: string) {
  const normalized = String(value || '').trim()
  if (!normalized || /[\r\n]/.test(normalized) || !/^[\x20-\x7e]+$/.test(normalized)) {
    throw new Error(`${labelValue} is invalid`)
  }
  return normalized
}

function buildRawMessage(input: {
  configuration: CareerSiteMailConfiguration
  envelope: CareerSiteMailEnvelope
  rfcMessageId: string
}) {
  if (
    !input.configuration.enabled
    || !input.configuration.from
    || !input.configuration.fromName
    || !input.configuration.replyTo
  ) {
    throw new Error('Career-site mail is not configured')
  }
  const boundary = `career-site-${crypto.randomUUID()}`
  const subject = cleanHeader(input.envelope.subject, 'Subject')
  const to = cleanHeader(input.envelope.to, 'Recipient')
  const fromName = cleanHeader(input.configuration.fromName, 'Sender name')
  const from = cleanHeader(input.configuration.from, 'Sender')
  const replyTo = cleanHeader(input.configuration.replyTo, 'Reply-To')
  const rfcMessageId = cleanHeader(input.rfcMessageId, 'Message-ID')
  return [
    `From: ${fromName} <${from}>`,
    `Reply-To: ${fromName} <${replyTo}>`,
    `To: <${to}>`,
    `Subject: ${subject}`,
    `Message-ID: <${rfcMessageId}>`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    base64Lines(input.envelope.text),
    `--${boundary}`,
    'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    base64Lines(input.envelope.html),
    `--${boundary}--`,
    '',
  ].join('\r\n')
}

function providerId(value: unknown, labelValue: string) {
  const normalized = typeof value === 'string' ? value.trim() : ''
  if (!normalized || normalized.length > 512 || !/^[A-Za-z0-9_-]+$/.test(normalized)) {
    throw new CareerSiteMailProviderError(`${labelValue} was invalid`, null, false)
  }
  return normalized
}

export function careerSiteRfcMessageId(idempotencyKey: string) {
  const digest = crypto.createHash('sha256').update(idempotencyKey, 'utf8').digest('hex')
  return `career-site-${digest.slice(0, 40)}@suburbiasandwichco.com`
}

export async function verifyCareerSiteMailSender(configuration: CareerSiteMailConfiguration) {
  if (!configuration.enabled || !configuration.from) throw new Error('Career-site mail is not configured')
  if (verifiedCareerSender?.email === configuration.from && verifiedCareerSender.expiresAt > Date.now()) return
  const response = await matonPlatformMailFetch(
    `/google-mail/gmail/v1/users/me/settings/sendAs/${encodeURIComponent(configuration.from)}`,
    { headers: { Accept: 'application/json' } },
  )
  if (!response.ok) {
    throw new CareerSiteMailProviderError('Career-site sender alias is not available', response.status, false)
  }
  const data = await response.json().catch(() => ({})) as {
    sendAsEmail?: unknown
    verificationStatus?: unknown
  }
  if (
    String(data.sendAsEmail || '').trim().toLowerCase() !== configuration.from
    || String(data.verificationStatus || '').trim().toLowerCase() !== 'accepted'
  ) {
    throw new CareerSiteMailProviderError('Career-site sender alias is not verified', response.status, false)
  }
  verifiedCareerSender = {
    email: configuration.from,
    expiresAt: Date.now() + SENDER_VERIFICATION_TTL_MS,
  }
}

export async function createCareerSiteMailDraft(input: {
  configuration: CareerSiteMailConfiguration
  request: NormalizedCareerSiteMailRequest
  rfcMessageId: string
}) {
  await verifyCareerSiteMailSender(input.configuration)
  const envelope = careerSiteMailEnvelope(input.request, input.configuration)
  const raw = base64Url(buildRawMessage({
    configuration: input.configuration,
    envelope,
    rfcMessageId: input.rfcMessageId,
  }))
  let response: Response
  try {
    response = await matonPlatformMailFetch(GMAIL_DRAFTS_PATH, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: { raw } }),
    })
  } catch {
    throw new CareerSiteMailProviderError(
      'Career-site email draft creation status is ambiguous',
      null,
      true,
    )
  }
  if (!response.ok) {
    throw new CareerSiteMailProviderError(
      'Career-site email draft was rejected',
      response.status,
      response.status >= 500,
    )
  }
  const data = await response.json().catch(() => ({})) as { id?: unknown; message?: { id?: unknown } }
  try {
    return {
      draftId: providerId(data.id, 'Gmail draft ID'),
      draftMessageId: data.message?.id ? providerId(data.message.id, 'Gmail draft message ID') : null,
    }
  } catch {
    throw new CareerSiteMailProviderError(
      'Career-site email draft creation status is ambiguous',
      response.status,
      true,
    )
  }
}

export async function findCareerSiteMailDraft(rfcMessageId: string) {
  const query = new URLSearchParams({
    q: `in:drafts rfc822msgid:${rfcMessageId}`,
    maxResults: '2',
  })
  const response = await matonPlatformMailFetch(
    `${GMAIL_DRAFTS_PATH}?${query.toString()}`,
    { headers: { Accept: 'application/json' } },
  )
  if (!response.ok) {
    throw new CareerSiteMailProviderError('Career-site draft lookup failed', response.status, false)
  }
  const data = await response.json().catch(() => ({})) as {
    drafts?: Array<{ id?: unknown; message?: { id?: unknown } }>
  }
  const drafts = Array.isArray(data.drafts) ? data.drafts : []
  if (drafts.length > 1) {
    throw new CareerSiteMailProviderError(
      'Multiple drafts matched the career-site Message-ID',
      409,
      false,
    )
  }
  const draft = drafts[0]
  if (!draft) return null
  return {
    draftId: providerId(draft.id, 'Gmail draft ID'),
    draftMessageId: draft.message?.id
      ? providerId(draft.message.id, 'Gmail draft message ID')
      : null,
  }
}

export async function findSentCareerSiteMail(rfcMessageId: string) {
  const query = new URLSearchParams({
    q: `in:sent rfc822msgid:${rfcMessageId}`,
    maxResults: '2',
  })
  const response = await matonPlatformMailFetch(
    `/google-mail/gmail/v1/users/me/messages?${query.toString()}`,
    { headers: { Accept: 'application/json' } },
  )
  if (!response.ok) {
    throw new CareerSiteMailProviderError('Career-site sent-mail lookup failed', response.status, false)
  }
  const data = await response.json().catch(() => ({})) as {
    messages?: Array<{ id?: unknown }>
  }
  const messages = Array.isArray(data.messages) ? data.messages : []
  if (messages.length > 1) {
    throw new CareerSiteMailProviderError(
      'Multiple sent messages matched the career-site Message-ID',
      409,
      false,
    )
  }
  const id = messages[0]?.id
  return id ? providerId(id, 'Gmail sent message ID') : null
}

export async function sendCareerSiteMailDraft(draftId: string) {
  let response: Response
  try {
    response = await matonPlatformMailFetch(`${GMAIL_DRAFTS_PATH}/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: providerId(draftId, 'Gmail draft ID') }),
    })
  } catch {
    throw new CareerSiteMailProviderError('Career-site email delivery status is ambiguous', null, true)
  }
  if (!response.ok) {
    throw new CareerSiteMailProviderError(
      response.status === 404
        ? 'Career-site email draft was already consumed or is unavailable'
        : 'Career-site email delivery was rejected',
      response.status,
      response.status >= 500,
    )
  }
  const data = await response.json().catch(() => ({})) as { id?: unknown; message?: { id?: unknown } }
  return providerId(data.id || data.message?.id, 'Gmail sent message ID')
}
