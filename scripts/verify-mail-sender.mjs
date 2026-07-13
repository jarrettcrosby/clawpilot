#!/usr/bin/env node

function required(name, minimumLength = 1) {
  const value = String(process.env[name] || '').trim()
  if (value.length < minimumLength) throw new Error(`${name} is not configured`)
  return value
}

const apiKey = required('MATON_API_KEY', 16)
const connectionId = required('MATON_GMAIL_CONNECTION_ID', 8)
const sender = required('CLAWPILOT_MAIL_FROM', 5).toLowerCase()
if (!sender.includes('@') || /[\r\n]/.test(sender)) throw new Error('CLAWPILOT_MAIL_FROM is invalid')
const base = String(process.env.MATON_BASE_URL || 'https://gateway.maton.ai').replace(/\/$/, '')
const url = `${base}/google-mail/gmail/v1/users/me/settings/sendAs/${encodeURIComponent(sender)}`

async function verify() {
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
      })
      if (!response.ok) throw new Error(`sender lookup returned status ${response.status}`)
      const data = await response.json()
      if (String(data?.sendAsEmail || '').trim().toLowerCase() !== sender) {
        throw new Error('Gmail returned a different sender identity')
      }
      if (String(data?.verificationStatus || '').toLowerCase() !== 'accepted') {
        throw new Error('Gmail sender identity is not accepted')
      }
      console.log(JSON.stringify({ ok: true, sender, verificationStatus: 'accepted' }))
      return
    } catch (error) {
      lastError = error
      if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, attempt * 500))
    }
  }
  throw lastError || new Error('Unable to verify Gmail sender identity')
}

verify().catch((error) => {
  console.error(`mail sender verification failed: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
})
