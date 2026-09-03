#!/usr/bin/env node

function required(name, minimumLength = 1) {
  const value = String(process.env[name] || '').trim()
  if (value.length < minimumLength) throw new Error(`${name} is not configured`)
  return value
}

function resolveMatonGatewayBaseUrl(value = process.env.MATON_BASE_URL) {
  const configured = String(value || 'https://gateway.maton.ai').trim()
  try {
    const url = new URL(configured)
    const allowedHost = url.hostname === 'gateway.maton.ai' || url.hostname.endsWith('.gateway.maton.ai')
    if (
      url.protocol !== 'https:'
      || !allowedHost
      || url.port
      || url.username
      || url.password
      || (url.pathname !== '/' && url.pathname !== '')
      || url.search
      || url.hash
    ) {
      throw new Error('invalid gateway origin')
    }
    return url.origin
  } catch {
    throw new Error('MATON_BASE_URL is not configured safely')
  }
}

const apiKey = required('MATON_API_KEY', 16)
const platformConnectionId = required('MATON_GMAIL_CONNECTION_ID', 8)
const platformSender = required('CLAWPILOT_MAIL_FROM', 5).toLowerCase()
if (!platformSender.includes('@') || /[\r\n]/.test(platformSender)) throw new Error('CLAWPILOT_MAIL_FROM is invalid')
const senderProfiles = [{ label: 'Platform', sender: platformSender, connectionId: platformConnectionId }]
const authConnectionId = String(process.env.MATON_AUTH_GMAIL_CONNECTION_ID || '').trim()
const authSender = String(process.env.CLAWPILOT_AUTH_MAIL_FROM || '').trim().toLowerCase()
if (Boolean(authConnectionId) !== Boolean(authSender)) {
  throw new Error('MATON_AUTH_GMAIL_CONNECTION_ID and CLAWPILOT_AUTH_MAIL_FROM must be configured together')
}
if (authConnectionId) {
  if (authConnectionId.length < 8 || authConnectionId.length > 512 || !/^[\x21-\x7e]+$/.test(authConnectionId)) {
    throw new Error('MATON_AUTH_GMAIL_CONNECTION_ID is invalid')
  }
  if (authConnectionId === platformConnectionId) {
    throw new Error('MATON_AUTH_GMAIL_CONNECTION_ID must differ from MATON_GMAIL_CONNECTION_ID')
  }
  if (!authSender.includes('@') || /[\r\n]/.test(authSender)) throw new Error('CLAWPILOT_AUTH_MAIL_FROM is invalid')
  senderProfiles.push({ label: 'Authentication', sender: authSender, connectionId: authConnectionId })
}
if (String(process.env.CAREER_SITE_SUBMISSIONS_ENABLED || '0') === '1') {
  const careerSender = required('CAREER_SITE_MAIL_FROM', 5).toLowerCase()
  if (careerSender !== 'info@suburbiasandwichco.com' || /[\r\n]/.test(careerSender)) {
    throw new Error('CAREER_SITE_MAIL_FROM is invalid')
  }
  senderProfiles.push({ label: 'Career site', sender: careerSender, connectionId: platformConnectionId })
}
const base = resolveMatonGatewayBaseUrl()

async function fetchGmailJson(connectionId, pathname, label) {
  const url = `${base}${pathname}`
  let lastError = null
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          Accept: 'application/json',
          'Maton-Connection': connectionId,
        },
        signal: AbortSignal.timeout(10000),
        redirect: 'error',
        cache: 'no-store',
      })
      if (!response.ok) throw new Error(`${label} returned status ${response.status}`)
      return await response.json()
    } catch (error) {
      lastError = error
      if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, attempt * 500))
    }
  }
  throw lastError || new Error(`${label} failed`)
}

async function gmailProfileEmail(connectionId, label) {
  const data = await fetchGmailJson(
    connectionId,
    '/google-mail/gmail/v1/users/me/profile',
    `${label} Gmail profile lookup`,
  )
  const emailAddress = String(data?.emailAddress || '').trim().toLowerCase()
  if (!emailAddress.includes('@') || /[\r\n]/.test(emailAddress)) {
    throw new Error(`${label} Gmail profile is invalid`)
  }
  return emailAddress
}

function gmailDeliveryIdentity(value) {
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

function isSameGmailDeliveryMailbox(left, right) {
  return gmailDeliveryIdentity(left) === gmailDeliveryIdentity(right)
}

async function verifySender(profile) {
  const data = await fetchGmailJson(
    profile.connectionId,
    `/google-mail/gmail/v1/users/me/settings/sendAs/${encodeURIComponent(profile.sender)}`,
    'sender lookup',
  )
  if (String(data?.sendAsEmail || '').trim().toLowerCase() !== profile.sender) {
    throw new Error(`${profile.label} Gmail returned a different sender identity`)
  }
  const verificationStatus = String(data?.verificationStatus || '').trim().toLowerCase()
  if (verificationStatus !== 'accepted' && data?.isPrimary !== true) {
    throw new Error(`${profile.label} Gmail sender identity is not accepted`)
  }
  return {
    isPrimary: data?.isPrimary === true,
    sender: profile.sender,
    verificationStatus: verificationStatus || null,
  }
}

async function verify() {
  if (authConnectionId) {
    const platformProfileEmail = await gmailProfileEmail(platformConnectionId, 'Platform')
    const authProfileEmail = await gmailProfileEmail(authConnectionId, 'Authentication')
    if (isSameGmailDeliveryMailbox(platformProfileEmail, authProfileEmail)) {
      throw new Error('Authentication Gmail account must differ from platform Gmail account')
    }
  }
  const verified = []
  const uniqueProfiles = new Map(
    senderProfiles.map((profile) => [`${profile.connectionId}\n${profile.sender}`, profile]),
  )
  for (const profile of uniqueProfiles.values()) verified.push(await verifySender(profile))
  console.log(JSON.stringify({ ok: true, senders: verified }))
}

verify().catch((error) => {
  console.error(`mail sender verification failed: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
})
