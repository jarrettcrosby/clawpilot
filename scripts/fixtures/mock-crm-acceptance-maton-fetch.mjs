const gatewayHost = 'crm-acceptance.gateway.maton.ai'
const expectedKey = 'crm-acceptance-maton-key-0000000000000000'
const expectedConnection = 'crm-acceptance-gmail'
const expectedAccount = 'crm.acceptance@example.test'

const originalFetch = globalThis.fetch.bind(globalThis)

globalThis.fetch = async (input, init = {}) => {
  const request = input instanceof Request ? input : null
  const url = new URL(request?.url || String(input))
  if (url.hostname !== gatewayHost) return originalFetch(input, init)

  const headers = new Headers(request?.headers || init.headers || {})
  if (headers.get('authorization') !== `Bearer ${expectedKey}`) {
    return Response.json({ error: { code: 401, message: 'Unexpected acceptance credential' } }, { status: 401 })
  }
  if (headers.get('maton-connection') !== expectedConnection) {
    return Response.json({ error: { code: 400, message: 'Unexpected acceptance connection' } }, { status: 400 })
  }

  if (url.pathname === '/google-mail/gmail/v1/users/me/profile') {
    return Response.json({ emailAddress: expectedAccount, messagesTotal: 0, threadsTotal: 0 })
  }
  if (url.pathname.startsWith('/google-mail/gmail/v1/users/me/settings/sendAs/')) {
    const sender = decodeURIComponent(url.pathname.split('/').at(-1) || '')
    return Response.json({ sendAsEmail: sender, verificationStatus: 'accepted' })
  }
  if (url.pathname === '/google-mail/gmail/v1/users/me/messages/send') {
    return Response.json({ id: 'acceptance-message-id', threadId: 'acceptance-thread-id' })
  }

  return Response.json({ error: { code: 404, message: 'Unexpected acceptance provider request' } }, { status: 404 })
}
