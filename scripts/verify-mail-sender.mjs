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
const connectionId = required('MATON_GMAIL_CONNECTION_ID', 8)
const sender = required('CLAWPILOT_MAIL_FROM', 5).toLowerCase()
if (!sender.includes('@') || /[\r\n]/.test(sender)) throw new Error('CLAWPILOT_MAIL_FROM is invalid')
const senders = [sender]
if (String(process.env.CAREER_SITE_SUBMISSIONS_ENABLED || '0') === '1') {
  const careerSender = required('CAREER_SITE_MAIL_FROM', 5).toLowerCase()
  if (careerSender !== 'info@suburbiasandwichco.com' || /[\r\n]/.test(careerSender)) {
    throw new Error('CAREER_SITE_MAIL_FROM is invalid')
  }
  if (!senders.includes(careerSender)) senders.push(careerSender)
}
const base = resolveMatonGatewayBaseUrl()

async function verifySender(candidate) {
  const url = `${base}/google-mail/gmail/v1/users/me/settings/sendAs/${encodeURIComponent(candidate)}`
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
      if (!response.ok) throw new Error(`sender lookup returned status ${response.status}`)
      const data = await response.json()
      if (String(data?.sendAsEmail || '').trim().toLowerCase() !== candidate) {
        throw new Error('Gmail returned a different sender identity')
      }
      if (String(data?.verificationStatus || '').toLowerCase() !== 'accepted') {
        throw new Error('Gmail sender identity is not accepted')
      }
      return { sender: candidate, verificationStatus: 'accepted' }
    } catch (error) {
      lastError = error
      if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, attempt * 500))
    }
  }
  throw lastError || new Error('Unable to verify Gmail sender identity')
}

async function verify() {
  const verified = []
  for (const candidate of senders) verified.push(await verifySender(candidate))
  console.log(JSON.stringify({ ok: true, senders: verified }))
}

verify().catch((error) => {
  console.error(`mail sender verification failed: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
})
