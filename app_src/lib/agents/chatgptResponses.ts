const CODEX_RESPONSES_URL = 'https://chatgpt.com/backend-api/codex/responses'
const MAX_SUCCESS_BYTES = 16 * 1024 * 1024
const MAX_ERROR_BYTES = 32 * 1024

export type ChatGPTCodexCredential = {
  accessToken: string
  accountId: string
}

type CodexEvent = Record<string, unknown>

export type ChatGPTCodexCitation = {
  url: string
  title?: string
}

export type ChatGPTCodexResearchResponse = {
  text: string
  citations: ChatGPTCodexCitation[]
}

export type ChatGPTCodexOutputSchema = {
  name: string
  schema: Record<string, unknown>
}

function extractOutputText(payload: Record<string, unknown>): string {
  if (typeof payload.output_text === 'string') return payload.output_text.trim()
  const output = Array.isArray(payload.output) ? payload.output : []
  const parts: string[] = []
  for (const item of output) {
    if (!item || typeof item !== 'object') continue
    const content = Array.isArray((item as Record<string, unknown>).content)
      ? (item as Record<string, unknown>).content as unknown[]
      : []
    for (const entry of content) {
      if (!entry || typeof entry !== 'object') continue
      const text = (entry as Record<string, unknown>).text
      if (typeof text === 'string' && text.trim()) parts.push(text.trim())
    }
  }
  return parts.join('\n').trim()
}

function extractCitations(payload: Record<string, unknown>): ChatGPTCodexCitation[] {
  const citations = new Map<string, ChatGPTCodexCitation>()
  const output = Array.isArray(payload.output) ? payload.output : []
  for (const item of output) {
    if (!item || typeof item !== 'object') continue
    const record = item as Record<string, unknown>
    const action = record.action && typeof record.action === 'object'
      ? record.action as Record<string, unknown>
      : null
    const sources = Array.isArray(action?.sources) ? action.sources : []
    for (const source of sources) {
      if (!source || typeof source !== 'object') continue
      const sourceRecord = source as Record<string, unknown>
      const url = String(sourceRecord.url || '').trim()
      if (!/^https:\/\//i.test(url)) continue
      citations.set(url, { url, title: String(sourceRecord.title || '').trim() || undefined })
    }

    const content = Array.isArray(record.content) ? record.content : []
    for (const entry of content) {
      if (!entry || typeof entry !== 'object') continue
      const annotations = Array.isArray((entry as Record<string, unknown>).annotations)
        ? (entry as Record<string, unknown>).annotations as unknown[]
        : []
      for (const annotation of annotations) {
        if (!annotation || typeof annotation !== 'object') continue
        const annotationRecord = annotation as Record<string, unknown>
        if (String(annotationRecord.type || '') !== 'url_citation') continue
        const url = String(annotationRecord.url || '').trim()
        if (!/^https:\/\//i.test(url)) continue
        citations.set(url, { url, title: String(annotationRecord.title || '').trim() || undefined })
      }
    }
  }
  return [...citations.values()].slice(0, 30)
}

function errorMessage(payload: Record<string, unknown>, fallback: string): string {
  const error = payload.error
  if (error && typeof error === 'object') {
    const message = (error as Record<string, unknown>).message
    if (typeof message === 'string' && message.trim()) return message.trim()
  }
  const detail = payload.detail
  if (typeof detail === 'string' && detail.trim()) return detail.trim()
  return fallback
}

async function readLimitedText(response: Response, limit: number): Promise<string> {
  if (!response.body) return ''
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let size = 0
  let text = ''
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > limit) throw new Error('ChatGPT response exceeded the allowed size')
      text += decoder.decode(value, { stream: true })
    }
    text += decoder.decode()
    return text
  } finally {
    reader.releaseLock()
  }
}

function parseEvent(chunk: string): CodexEvent | null {
  const data = chunk
    .split(/\r?\n/)
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trim())
    .join('\n')
    .trim()
  if (!data || data === '[DONE]') return null
  try {
    const parsed = JSON.parse(data)
    return parsed && typeof parsed === 'object' ? parsed as CodexEvent : null
  } catch {
    throw new Error('ChatGPT returned an invalid streaming response')
  }
}

function eventFailure(event: CodexEvent): string | null {
  const type = String(event.type || '')
  if (type !== 'response.failed') return null
  const response = event.response && typeof event.response === 'object'
    ? event.response as Record<string, unknown>
    : {}
  return errorMessage(response, 'ChatGPT agent execution failed')
}

async function readCodexStream(response: Response): Promise<ChatGPTCodexResearchResponse> {
  if (!response.body) throw new Error('ChatGPT returned an empty response stream')
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let text = ''
  let completedText = ''
  const citations = new Map<string, ChatGPTCodexCitation>()
  let total = 0

  function mergeCitations(payload: Record<string, unknown>) {
    for (const citation of extractCitations(payload)) {
      const existing = citations.get(citation.url)
      if (existing) {
        citations.set(citation.url, {
          url: citation.url,
          title: citation.title || existing.title,
        })
      } else if (citations.size < 30) {
        citations.set(citation.url, citation)
      }
    }
  }

  function consume(chunk: string) {
    const event = parseEvent(chunk)
    if (!event) return
    const failure = eventFailure(event)
    if (failure) throw new Error(failure)
    if (event.type === 'response.output_text.delta' && typeof event.delta === 'string') {
      text += event.delta
    }
    const item = event.item && typeof event.item === 'object'
      ? event.item as Record<string, unknown>
      : null
    if (item) mergeCitations({ output: [item] })
    if (event.type === 'response.completed' || event.type === 'response.done') {
      const responsePayload = event.response && typeof event.response === 'object'
        ? event.response as Record<string, unknown>
        : null
      const completed = responsePayload ? extractOutputText(responsePayload) : ''
      if (completed) completedText = completed
      if (responsePayload) mergeCitations(responsePayload)
    }
  }

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > MAX_SUCCESS_BYTES) throw new Error('ChatGPT response exceeded the allowed size')
      buffer += decoder.decode(value, { stream: true })
      let boundary = buffer.search(/\r?\n\r?\n/)
      while (boundary >= 0) {
        const match = buffer.slice(boundary).match(/^(?:\r?\n){2}/)?.[0] || '\n\n'
        consume(buffer.slice(0, boundary))
        buffer = buffer.slice(boundary + match.length)
        boundary = buffer.search(/\r?\n\r?\n/)
      }
    }
    buffer += decoder.decode()
    if (buffer.trim()) consume(buffer)
  } finally {
    reader.releaseLock()
  }

  const result = text.trim() || completedText.trim()
  if (!result) throw new Error('ChatGPT returned an empty agent response')
  return { text: result, citations: [...citations.values()] }
}

async function runChatGPTCodexRequest(input: {
  credential: ChatGPTCodexCredential
  model: string
  instructions: string
  prompt: string
  sessionId: string
  signal?: AbortSignal
  webSearch?: boolean
  outputSchema?: ChatGPTCodexOutputSchema
}): Promise<ChatGPTCodexResearchResponse> {
  const response = await fetch(CODEX_RESPONSES_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${input.credential.accessToken}`,
      'chatgpt-account-id': input.credential.accountId,
      originator: 'clawpilot',
      'User-Agent': 'clawpilot',
      'OpenAI-Beta': 'responses=experimental',
      Accept: 'text/event-stream',
      'Content-Type': 'application/json',
      'session_id': input.sessionId,
      'x-client-request-id': input.sessionId,
    },
    body: JSON.stringify({
      model: input.model,
      instructions: input.instructions,
      input: [{ role: 'user', content: [{ type: 'input_text', text: input.prompt }] }],
      text: input.outputSchema
        ? {
            verbosity: 'low',
            format: {
              type: 'json_schema',
              name: input.outputSchema.name,
              strict: true,
              schema: input.outputSchema.schema,
            },
          }
        : { verbosity: 'low' },
      ...(input.webSearch ? {
        tools: [{ type: 'web_search', search_context_size: 'medium' }],
        tool_choice: 'required',
      } : {}),
      include: input.webSearch
        ? ['reasoning.encrypted_content', 'web_search_call.action.sources']
        : ['reasoning.encrypted_content'],
      prompt_cache_key: input.sessionId,
      store: false,
      stream: true,
    }),
    signal: input.signal,
  })

  if (!response.ok) {
    const raw = await readLimitedText(response, MAX_ERROR_BYTES).catch(() => '')
    let payload: Record<string, unknown> = {}
    try {
      const parsed = JSON.parse(raw)
      if (parsed && typeof parsed === 'object') payload = parsed as Record<string, unknown>
    } catch {
      // Keep the public error generic when the upstream body is not JSON.
    }
    const error = new Error(errorMessage(payload, `ChatGPT request failed with status ${response.status}`)) as Error & { status?: number }
    error.status = response.status
    throw error
  }

  return readCodexStream(response)
}

export async function runChatGPTCodexResponse(input: {
  credential: ChatGPTCodexCredential
  model: string
  instructions: string
  prompt: string
  sessionId: string
  signal?: AbortSignal
}): Promise<string> {
  return (await runChatGPTCodexRequest(input)).text
}

export async function runChatGPTCodexWebResearchResponse(input: {
  credential: ChatGPTCodexCredential
  model: string
  instructions: string
  prompt: string
  sessionId: string
  signal?: AbortSignal
}): Promise<ChatGPTCodexResearchResponse> {
  return runChatGPTCodexRequest({ ...input, webSearch: true })
}

export async function runChatGPTCodexStructuredResponse(input: {
  credential: ChatGPTCodexCredential
  model: string
  instructions: string
  prompt: string
  sessionId: string
  outputSchema: ChatGPTCodexOutputSchema
  signal?: AbortSignal
  webSearch?: boolean
}): Promise<ChatGPTCodexResearchResponse> {
  return runChatGPTCodexRequest(input)
}
