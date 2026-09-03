import crypto from 'crypto'
import { matonAuthMailFetch, matonPlatformMailFetch } from '@/lib/maton'
import { appPublicUrl } from '@/lib/publicUrl'
import { isHostedRuntime } from '@/lib/persistence/config'

const GMAIL_SEND_PATH = '/google-mail/gmail/v1/users/me/messages/send'
const GMAIL_PROFILE_PATH = '/google-mail/gmail/v1/users/me/profile'
const SENDER_VERIFICATION_TTL_MS = 5 * 60 * 1000
const verifiedSenders = new Map<string, number>()
const senderVerificationFlights = new Map<string, Promise<void>>()
type MailProfile = 'auth' | 'platform'
type VerifiedMailbox = { email: string; expiresAt: number }
const verifiedMailboxes = new Map<string, VerifiedMailbox>()
const mailboxVerificationFlights = new Map<string, Promise<string>>()
export type SendAuthMagicCodeEmailInput = {
  to: string
  code: string
}

export type SendInvitationEmailInput = {
  to: string
  inviterName: string
  organizationName: string
  welcomeUrl: string
  expiresAt: string
}

export type SendPosAccountingIssueEmailInput = {
  to: string
  recipientName?: string | null
  organizationName: string
  restaurantName: string
  restaurantGuid: string
  businessDate: string
  issues: Array<{ title: string; detail: string }>
}

function assertEmail(value: string): string {
  const email = String(value || '').trim()
  if (!email || /[\r\n]/.test(email) || !/^[\x21-\x7e]+$/.test(email)) {
    throw new Error('A valid ASCII recipient email is required')
  }
  return email
}

export function mailFromAddress(): string {
  const configured = String(process.env.CLAWPILOT_MAIL_FROM || '').trim()
  if (!configured && isHostedRuntime()) throw new Error('CLAWPILOT_MAIL_FROM is required in hosted environments')
  return assertEmail(configured || 'stewards@eigenracing.com').toLowerCase()
}

function authMailFromAddress(): string {
  const connectionId = String(process.env.MATON_AUTH_GMAIL_CONNECTION_ID || '').trim()
  const configuredSender = String(process.env.CLAWPILOT_AUTH_MAIL_FROM || '').trim()
  if (Boolean(connectionId) !== Boolean(configuredSender)) {
    throw new Error('MATON_AUTH_GMAIL_CONNECTION_ID and CLAWPILOT_AUTH_MAIL_FROM must be configured together')
  }
  if (connectionId && connectionId === String(process.env.MATON_GMAIL_CONNECTION_ID || '').trim()) {
    throw new Error('MATON_AUTH_GMAIL_CONNECTION_ID must differ from MATON_GMAIL_CONNECTION_ID')
  }
  return configuredSender ? assertEmail(configuredSender).toLowerCase() : mailFromAddress()
}

function mailConnectionId(profile: MailProfile): string {
  const platformConnectionId = String(process.env.MATON_GMAIL_CONNECTION_ID || '').trim()
  return profile === 'auth'
    ? String(process.env.MATON_AUTH_GMAIL_CONNECTION_ID || '').trim() || platformConnectionId
    : platformConnectionId
}

function mailFetch(profile: MailProfile) {
  return profile === 'auth' ? matonAuthMailFetch : matonPlatformMailFetch
}

function mailProfileLabel(profile: MailProfile): string {
  return profile === 'auth' ? 'Authentication' : 'Platform'
}

async function gmailMailboxEmail(profile: MailProfile): Promise<string> {
  const connectionId = mailConnectionId(profile)
  const cacheKey = `${profile}:${connectionId}`
  const cached = verifiedMailboxes.get(cacheKey)
  if (cached && cached.expiresAt > Date.now()) return cached.email
  const inFlight = mailboxVerificationFlights.get(cacheKey)
  if (inFlight) return inFlight

  const verification = (async () => {
    const response = await mailFetch(profile)(GMAIL_PROFILE_PATH, {
      headers: { Accept: 'application/json' },
    })
    const profileLabel = mailProfileLabel(profile)
    if (!response.ok) throw new Error(`${profileLabel} Gmail profile is not available`)
    const data = await response.json().catch(() => ({})) as { emailAddress?: unknown }
    const email = String(data.emailAddress || '').trim().toLowerCase()
    if (
      !email
      || email.length > 254
      || /[\r\n]/.test(email)
      || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
    ) {
      throw new Error(`${profileLabel} Gmail profile is invalid`)
    }
    verifiedMailboxes.set(cacheKey, {
      email,
      expiresAt: Date.now() + SENDER_VERIFICATION_TTL_MS,
    })
    return email
  })()
  mailboxVerificationFlights.set(cacheKey, verification)
  try {
    return await verification
  } finally {
    if (mailboxVerificationFlights.get(cacheKey) === verification) {
      mailboxVerificationFlights.delete(cacheKey)
    }
  }
}

function gmailDeliveryIdentity(value: string): string {
  const email = String(value || '').trim().toLowerCase()
  const atIndex = email.lastIndexOf('@')
  if (atIndex <= 0 || atIndex === email.length - 1) return email

  const domain = email.slice(atIndex + 1)
  const consumerGmail = domain === 'gmail.com' || domain === 'googlemail.com'
  const normalizedDomain = consumerGmail ? 'gmail.com' : domain
  const local = email.slice(0, atIndex)
  const plusIndex = local.indexOf('+')
  const withoutPlus = plusIndex >= 0 ? local.slice(0, plusIndex) : local
  const normalizedLocal = consumerGmail ? withoutPlus.replace(/\./g, '') : withoutPlus
  return `${normalizedLocal}@${normalizedDomain}`
}

function isSameGmailDeliveryMailbox(left: string, right: string): boolean {
  return gmailDeliveryIdentity(left) === gmailDeliveryIdentity(right)
}

async function authMailProfileForRecipient(recipient: string): Promise<MailProfile> {
  authMailFromAddress()
  const hasDedicatedAuthMail = Boolean(String(process.env.MATON_AUTH_GMAIL_CONNECTION_ID || '').trim())
  if (!hasDedicatedAuthMail) return 'auth'

  const [platformMailbox, authMailbox] = await Promise.all([
    gmailMailboxEmail('platform'),
    gmailMailboxEmail('auth'),
  ])
  if (isSameGmailDeliveryMailbox(platformMailbox, authMailbox)) {
    throw new Error('Authentication Gmail account must differ from platform Gmail account')
  }
  return isSameGmailDeliveryMailbox(recipient, authMailbox) ? 'platform' : 'auth'
}

function assertCode(value: string): string {
  const code = String(value || '')
  if (!/^\d{6}$/.test(code)) throw new Error('A six-digit sign-in code is required')
  return code
}

function base64Url(value: string): string {
  return Buffer.from(value, 'utf8')
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function cleanHeader(value: string, field: string): string {
  const normalized = String(value || '').trim()
  if (!normalized || /[\r\n]/.test(normalized)) throw new Error(`${field} is required`)
  return normalized
}

function buildMessage(input: { from: string; to: string; subject: string; text: string; html: string }): string {
  const boundary = `clawpilot-${crypto.randomUUID()}`
  const subject = cleanHeader(input.subject, 'Email subject')
  return [
    `From: ClawPilot Stewards <${input.from}>`,
    `Reply-To: ClawPilot Stewards <${input.from}>`,
    `To: <${input.to}>`,
    `Subject: ${subject}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: 7bit',
    '',
    input.text,
    `--${boundary}`,
    'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: 7bit',
    '',
    input.html,
    `--${boundary}--`,
    '',
  ].join('\r\n')
}

async function sendMessage(
  input: { to: string; subject: string; text: string; html: string },
  profile: MailProfile = 'platform',
) {
  const to = assertEmail(input.to)
  const from = profile === 'auth' ? authMailFromAddress() : mailFromAddress()
  await verifySender(profile, from)
  const raw = base64Url(buildMessage({ ...input, from, to }))
  const response = await mailFetch(profile)(GMAIL_SEND_PATH, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ raw }),
  })

  if (!response.ok) throw new Error(`Maton Gmail delivery failed with status ${response.status}`)
  const data = await response.json().catch(() => ({})) as {
    id?: unknown
    message?: { id?: unknown }
  }
  return { messageId: String(data.id || data.message?.id || '').trim() || null }
}

async function verifySender(profile: MailProfile, sender: string) {
  const connectionId = mailConnectionId(profile)
  const cacheKey = `${profile}:${connectionId}:${sender}`
  if ((verifiedSenders.get(cacheKey) || 0) > Date.now()) return
  const inFlight = senderVerificationFlights.get(cacheKey)
  if (inFlight) return inFlight

  const verification = (async () => {
    const response = await mailFetch(profile)(
      `/google-mail/gmail/v1/users/me/settings/sendAs/${encodeURIComponent(sender)}`,
      { headers: { Accept: 'application/json' } },
    )
    const profileLabel = mailProfileLabel(profile)
    if (!response.ok) throw new Error(`${profileLabel} mail sender is not available`)
    const data = await response.json().catch(() => ({})) as {
      isPrimary?: unknown
      sendAsEmail?: unknown
      verificationStatus?: unknown
    }
    const verificationStatus = String(data.verificationStatus || '').trim().toLowerCase()
    if (
      String(data.sendAsEmail || '').trim().toLowerCase() !== sender
      || (verificationStatus !== 'accepted' && data.isPrimary !== true)
    ) {
      throw new Error(`${profileLabel} mail sender is not verified`)
    }
    verifiedSenders.set(cacheKey, Date.now() + SENDER_VERIFICATION_TTL_MS)
  })()
  senderVerificationFlights.set(cacheKey, verification)
  try {
    await verification
  } finally {
    if (senderVerificationFlights.get(cacheKey) === verification) {
      senderVerificationFlights.delete(cacheKey)
    }
  }
}

function authMagicCodeContent(to: string, code: string) {
  const text = [
    'ClawPilot sign-in',
    '',
    `Your sign-in code is: ${code}`,
    '',
    'This code expires in 15 minutes and can be used once.',
    'If you did not request this code, ignore this email.',
  ].join('\r\n')

  const logoUrl = `${appPublicUrl()}/brand/email/clawpilot-mark-email.png`
  const html = [
    '<!doctype html>',
    '<html><body style="margin:0;padding:24px;background:#0f0f13;color:#e4e1ec;font-family:Arial,sans-serif">',
    '<div style="max-width:520px;margin:0 auto;padding:24px;background:#1a1a23;border:1px solid #343741;border-radius:8px">',
    `<img src="${escapeHtml(logoUrl)}" width="48" height="48" alt="" style="display:block;margin:0 0 16px">`,
    '<h1 style="margin:0 0 20px;font-size:24px">ClawPilot sign-in</h1>',
    '<p style="margin:0 0 12px">Use this code to sign in:</p>',
    `<p style="margin:0 0 20px;font-size:32px;font-weight:700;letter-spacing:8px;color:#a8c7fa">${code}</p>`,
    '<p style="margin:0 0 8px">This code expires in 15 minutes and can be used once.</p>',
    '<p style="margin:0;color:#a9adb8">If you did not request this code, ignore this email.</p>',
    '</div></body></html>',
  ].join('')
  return { to, subject: 'Your ClawPilot sign-in code', text, html }
}

export async function sendAuthMagicCodeEmail(
  input: SendAuthMagicCodeEmailInput,
): Promise<{ messageId: string | null }> {
  const to = assertEmail(input.to)
  const code = assertCode(input.code)
  return sendMessage(authMagicCodeContent(to, code), await authMailProfileForRecipient(to))
}

export async function sendInvitationEmail(input: SendInvitationEmailInput): Promise<{ messageId: string | null }> {
  const to = assertEmail(input.to)
  const inviterName = String(input.inviterName || 'A ClawPilot administrator').trim().slice(0, 100)
  const organizationName = String(input.organizationName || 'your organization').trim().slice(0, 200)
  const welcomeUrl = new URL(input.welcomeUrl)
  if (welcomeUrl.protocol !== 'https:' && welcomeUrl.hostname !== 'localhost') {
    throw new Error('Invitation URL must use HTTPS')
  }
  const expiresAt = new Date(input.expiresAt)
  if (!Number.isFinite(expiresAt.getTime())) throw new Error('Invitation expiry is invalid')
  const expiryLabel = expiresAt.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' })
  const text = [
    'Welcome to ClawPilot',
    '',
    `${inviterName} invited you to join ${organizationName} in ClawPilot, a private workspace for project boards, pipeline tracking, documents, and task-linked AI agents.`,
    '',
    `Accept your invitation: ${welcomeUrl.toString()}`,
    '',
    'After you accept, ClawPilot will email a six-digit, one-time sign-in code. You do not need to create a password.',
    `This welcome link expires on ${expiryLabel}.`,
    '',
    'If you were not expecting this invitation, you can ignore this email.',
  ].join('\r\n')
  const logoUrl = `${appPublicUrl()}/brand/email/clawpilot-mark-email.png`
  const html = [
    '<!doctype html>',
    '<html><body style="margin:0;padding:24px;background:#0f0f13;color:#e4e1ec;font-family:Arial,sans-serif">',
    '<div style="max-width:560px;margin:0 auto;padding:28px;background:#1a1a23;border:1px solid #343741;border-radius:8px">',
    `<img src="${escapeHtml(logoUrl)}" width="56" height="56" alt="" style="display:block;margin:0 0 18px">`,
    '<h1 style="margin:0 0 12px;font-size:26px;line-height:1.2">Welcome to ClawPilot</h1>',
    `<p style="margin:0 0 18px;line-height:1.6;color:#c7c9d1">${escapeHtml(inviterName)} invited you to join <strong>${escapeHtml(organizationName)}</strong> in a private workspace for project boards, pipeline tracking, documents, and task-linked AI agents.</p>`,
    `<p style="margin:0 0 22px"><a href="${escapeHtml(welcomeUrl.toString())}" style="display:inline-block;padding:12px 18px;border-radius:6px;background:#7eabff;color:#061a2f;text-decoration:none;font-weight:700">Accept invitation</a></p>`,
    '<p style="margin:0 0 8px;line-height:1.6">After you accept, ClawPilot will email a six-digit, one-time sign-in code. You do not need to create a password.</p>',
    `<p style="margin:0 0 8px;color:#a9adb8;line-height:1.6">This welcome link expires on ${escapeHtml(expiryLabel)}.</p>`,
    '<p style="margin:18px 0 0;color:#7f8490;font-size:13px;line-height:1.5">If you were not expecting this invitation, you can ignore this email.</p>',
    '</div></body></html>',
  ].join('')
  return sendMessage({ to, subject: `${inviterName} invited you to ClawPilot`, text, html })
}

export async function sendPosAccountingIssueEmail(
  input: SendPosAccountingIssueEmailInput,
): Promise<{ messageId: string | null }> {
  const to = assertEmail(input.to)
  const recipientName = String(input.recipientName || '').replace(/[\r\n]/g, ' ').trim().slice(0, 100)
  const organizationName = cleanHeader(String(input.organizationName || '').slice(0, 200), 'Organization name')
  const restaurantName = cleanHeader(String(input.restaurantName || '').slice(0, 200), 'Restaurant name')
  const restaurantGuid = String(input.restaurantGuid || '').trim().toLowerCase()
  const businessDate = String(input.businessDate || '').trim()
  if (!/^[0-9a-f-]{36}$/.test(restaurantGuid)) throw new Error('Restaurant location is invalid')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(businessDate)) throw new Error('Business date is invalid')
  const issues = input.issues.slice(0, 25).map((issue) => ({
    title: String(issue.title || 'Accounting item').replace(/[\r\n]/g, ' ').trim().slice(0, 240),
    detail: String(issue.detail || 'Review this accounting item in ClawPilot').replace(/[\r\n]/g, ' ').trim().slice(0, 600),
  }))
  if (!issues.length) throw new Error('At least one accounting issue is required')

  const actionUrl = new URL(appPublicUrl())
  actionUrl.searchParams.set('posView', 'accounting')
  actionUrl.searchParams.set('date', businessDate)
  actionUrl.searchParams.set('location', restaurantGuid)
  actionUrl.hash = 'pos'
  const dateLabel = new Intl.DateTimeFormat('en-US', {
    month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC',
  }).format(new Date(`${businessDate}T12:00:00.000Z`))
  const greeting = recipientName ? `Hi ${recipientName},` : 'Hello,'
  const issueLines = issues.map((issue) => `- ${issue.title}: ${issue.detail}`)
  const text = [
    `ClawPilot accounting action required for ${restaurantName}`,
    '',
    greeting,
    '',
    `${issues.length} accounting ${issues.length === 1 ? 'item requires' : 'items require'} review for ${dateLabel}.`,
    '',
    ...issueLines,
    '',
    `Review POS accounting: ${actionUrl.toString()}`,
    '',
    `Organization: ${organizationName}`,
    'Once the underlying issue is corrected, ClawPilot will re-evaluate the business date automatically.',
  ].join('\r\n')
  const logoUrl = `${appPublicUrl()}/brand/email/clawpilot-mark-email.png`
  const issueHtml = issues.map((issue) => (
    `<li style="margin:0 0 12px"><strong>${escapeHtml(issue.title)}</strong><br><span style="color:#b9bdc8;line-height:1.5">${escapeHtml(issue.detail)}</span></li>`
  )).join('')
  const html = [
    '<!doctype html>',
    '<html><body style="margin:0;padding:24px;background:#0f0f13;color:#e4e1ec;font-family:Arial,sans-serif">',
    '<div style="max-width:600px;margin:0 auto;background:#1a1a23;border:1px solid #343741;border-radius:8px;overflow:hidden">',
    '<div style="padding:24px 28px 20px;border-bottom:3px solid #f2b76d">',
    `<img src="${escapeHtml(logoUrl)}" width="52" height="52" alt="" style="display:block;margin:0 0 16px">`,
    '<p style="margin:0 0 8px;color:#f2b76d;font-size:12px;font-weight:700;text-transform:uppercase">Accounting action required</p>',
    `<h1 style="margin:0;font-size:25px;line-height:1.25">${escapeHtml(restaurantName)}</h1>`,
    `<p style="margin:8px 0 0;color:#b9bdc8">${escapeHtml(dateLabel)} · ${escapeHtml(organizationName)}</p>`,
    '</div>',
    '<div style="padding:24px 28px 28px">',
    `<p style="margin:0 0 16px;line-height:1.6">${escapeHtml(greeting)}</p>`,
    `<p style="margin:0 0 18px;line-height:1.6">${issues.length} accounting ${issues.length === 1 ? 'item requires' : 'items require'} review before this business date can be posted.</p>`,
    `<ul style="margin:0 0 22px;padding-left:20px">${issueHtml}</ul>`,
    `<p style="margin:0 0 22px"><a href="${escapeHtml(actionUrl.toString())}" style="display:inline-block;padding:12px 18px;border-radius:6px;background:#a8c7fa;color:#071728;text-decoration:none;font-weight:700">Review POS accounting</a></p>`,
    '<p style="margin:0;color:#8f94a1;font-size:13px;line-height:1.5">After the underlying issue is corrected, ClawPilot will re-evaluate the business date automatically. Repeated checks do not create duplicate alerts unless the issue changes or recurs.</p>',
    '</div></div></body></html>',
  ].join('')
  return sendMessage({
    to,
    subject: `Action required: ${restaurantName} accounting for ${businessDate}`,
    text,
    html,
  })
}
