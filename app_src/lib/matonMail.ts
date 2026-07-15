import crypto from 'crypto'
import { matonPlatformMailFetch } from '@/lib/maton'
import { appPublicUrl } from '@/lib/publicUrl'
import { isHostedRuntime } from '@/lib/persistence/config'

const GMAIL_SEND_PATH = '/google-mail/gmail/v1/users/me/messages/send'
const SENDER_VERIFICATION_TTL_MS = 5 * 60 * 1000
let verifiedSender: { email: string; expiresAt: number } | null = null
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

function buildMessage(input: { to: string; subject: string; text: string; html: string }): string {
  const boundary = `clawpilot-${crypto.randomUUID()}`
  const from = mailFromAddress()
  const subject = cleanHeader(input.subject, 'Email subject')
  return [
    `From: ClawPilot Stewards <${from}>`,
    `Reply-To: ClawPilot Stewards <${from}>`,
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

async function sendMessage(input: { to: string; subject: string; text: string; html: string }) {
  const to = assertEmail(input.to)
  await verifyPlatformSender()
  const raw = base64Url(buildMessage({ ...input, to }))
  const response = await matonPlatformMailFetch(GMAIL_SEND_PATH, {
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

async function verifyPlatformSender() {
  const sender = mailFromAddress()
  if (verifiedSender?.email === sender && verifiedSender.expiresAt > Date.now()) return
  const response = await matonPlatformMailFetch(
    `/google-mail/gmail/v1/users/me/settings/sendAs/${encodeURIComponent(sender)}`,
    { headers: { Accept: 'application/json' } },
  )
  if (!response.ok) throw new Error('ClawPilot mail sender is not available')
  const data = await response.json().catch(() => ({})) as {
    sendAsEmail?: unknown
    verificationStatus?: unknown
  }
  if (
    String(data.sendAsEmail || '').trim().toLowerCase() !== sender
    || String(data.verificationStatus || '').trim().toLowerCase() !== 'accepted'
  ) {
    throw new Error('ClawPilot mail sender is not verified')
  }
  verifiedSender = { email: sender, expiresAt: Date.now() + SENDER_VERIFICATION_TTL_MS }
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
  return sendMessage(authMagicCodeContent(to, code))
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
