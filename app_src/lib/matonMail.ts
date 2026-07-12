import { matonFetch } from '@/lib/maton'

const GMAIL_SEND_PATH = '/google-mail/gmail/v1/users/me/messages/send'
const MIME_BOUNDARY = 'clawpilot-auth-magic-code'

export type SendAuthMagicCodeEmailInput = {
  to: string
  code: string
}

function requiredConnectionId(): string {
  const connectionId = String(process.env.MATON_GMAIL_CONNECTION_ID || '').trim()
  if (!connectionId || /[\r\n]/.test(connectionId)) {
    throw new Error('MATON_GMAIL_CONNECTION_ID is required')
  }
  return connectionId
}

function assertEmail(value: string): string {
  const email = String(value || '').trim()
  if (!email || /[\r\n]/.test(email) || !/^[\x21-\x7e]+$/.test(email)) {
    throw new Error('A valid ASCII recipient email is required')
  }
  return email
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

function buildMessage(to: string, code: string): string {
  const text = [
    'ClawPilot sign-in',
    '',
    `Your sign-in code is: ${code}`,
    '',
    'This code expires in 15 minutes and can be used once.',
    'If you did not request this code, ignore this email.',
  ].join('\r\n')

  const html = [
    '<!doctype html>',
    '<html><body style="margin:0;padding:24px;background:#0f0f13;color:#e4e1ec;font-family:Arial,sans-serif">',
    '<div style="max-width:520px;margin:0 auto;padding:24px;background:#1a1a23;border:1px solid #343741;border-radius:8px">',
    '<h1 style="margin:0 0 20px;font-size:24px">ClawPilot</h1>',
    '<p style="margin:0 0 12px">Use this code to sign in:</p>',
    `<p style="margin:0 0 20px;font-size:32px;font-weight:700;letter-spacing:8px;color:#a8c7fa">${code}</p>`,
    '<p style="margin:0 0 8px">This code expires in 15 minutes and can be used once.</p>',
    '<p style="margin:0;color:#a9adb8">If you did not request this code, ignore this email.</p>',
    '</div></body></html>',
  ].join('')

  return [
    `To: <${to}>`,
    'Subject: Your ClawPilot sign-in code',
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${MIME_BOUNDARY}"`,
    '',
    `--${MIME_BOUNDARY}`,
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: 7bit',
    '',
    text,
    `--${MIME_BOUNDARY}`,
    'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: 7bit',
    '',
    html,
    `--${MIME_BOUNDARY}--`,
    '',
  ].join('\r\n')
}

export async function sendAuthMagicCodeEmail(
  input: SendAuthMagicCodeEmailInput,
): Promise<{ messageId: string | null }> {
  const connectionId = requiredConnectionId()
  const to = assertEmail(input.to)
  const code = assertCode(input.code)
  const raw = base64Url(buildMessage(to, code))

  const response = await matonFetch(GMAIL_SEND_PATH, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Maton-Connection': connectionId,
    },
    body: JSON.stringify({ raw }),
  })

  if (!response.ok) {
    throw new Error(`Maton Gmail delivery failed with status ${response.status}`)
  }

  const data = await response.json().catch(() => ({})) as {
    id?: unknown
    message?: { id?: unknown }
  }
  const messageId = String(data.id || data.message?.id || '').trim() || null
  return { messageId }
}
