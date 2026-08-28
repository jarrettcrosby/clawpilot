import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { runChatGPTCodexWebResearchResponse } from '../../lib/agents/chatgptResponses.ts'

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

function eventStream(events: Array<Record<string, unknown>>) {
  return `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('')}data: [DONE]\n\n`
}

test('collects web citations emitted on incremental output item events', async () => {
  let requestBody: Record<string, unknown> = {}
  globalThis.fetch = async (_input, init) => {
    requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>
    return new Response(eventStream([
      { type: 'response.created', response: { id: 'response-1' } },
      {
        type: 'response.output_item.done',
        item: {
          type: 'web_search_call',
          action: {
            sources: [
              { url: 'https://jobs.example.com/role-1', title: 'Role one' },
              { url: 'http://jobs.example.com/insecure', title: 'Insecure' },
            ],
          },
        },
      },
      {
        type: 'response.output_item.done',
        item: {
          type: 'message',
          content: [{
            type: 'output_text',
            text: 'Finished',
            annotations: [{
              type: 'url_citation',
              url: 'https://jobs.example.com/role-2',
              title: 'Role two',
            }],
          }],
        },
      },
      { type: 'response.output_text.delta', delta: 'Finished' },
      { type: 'response.completed', response: { output: [] } },
    ]), {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    })
  }

  const result = await runChatGPTCodexWebResearchResponse({
    credential: { accessToken: 'test-token', accountId: 'test-account' },
    model: 'gpt-5.4',
    instructions: 'Research public job sources.',
    prompt: 'Find one role.',
    sessionId: 'career-citation-test',
  })

  assert.equal(result.text, 'Finished')
  assert.deepEqual(result.citations, [
    { url: 'https://jobs.example.com/role-1', title: 'Role one' },
    { url: 'https://jobs.example.com/role-2', title: 'Role two' },
  ])
  assert.deepEqual(requestBody.include, [
    'reasoning.encrypted_content',
    'web_search_call.action.sources',
  ])
})

test('preserves final-only citations and merges response.done metadata without duplicates', async () => {
  globalThis.fetch = async () => new Response(eventStream([
    {
      type: 'response.output_item.done',
      item: {
        type: 'web_search_call',
        action: {
          sources: [
            { url: 'https://jobs.example.com/shared', title: 'Early title' },
            { url: 'https://jobs.example.com/incremental', title: 'Incremental role' },
          ],
        },
      },
    },
    { type: 'response.output_text.delta', delta: 'Finished' },
    {
      type: 'response.done',
      response: {
        output: [{
          type: 'message',
          content: [{
            type: 'output_text',
            text: 'Finished',
            annotations: [
              { type: 'url_citation', url: 'https://jobs.example.com/shared' },
              { type: 'url_citation', url: 'https://jobs.example.com/final', title: 'Final role' },
            ],
          }],
        }],
      },
    },
  ]), {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  })

  const result = await runChatGPTCodexWebResearchResponse({
    credential: { accessToken: 'test-token', accountId: 'test-account' },
    model: 'gpt-5.4',
    instructions: 'Research public job sources.',
    prompt: 'Find one role.',
    sessionId: 'career-citation-merge-test',
  })

  assert.deepEqual(result.citations, [
    { url: 'https://jobs.example.com/shared', title: 'Early title' },
    { url: 'https://jobs.example.com/incremental', title: 'Incremental role' },
    { url: 'https://jobs.example.com/final', title: 'Final role' },
  ])
})

test('retains the first 30 unique citations across streamed events', async () => {
  const sources = Array.from({ length: 31 }, (_, index) => ({
    url: `https://jobs.example.com/role-${index + 1}`,
    title: `Role ${index + 1}`,
  }))
  globalThis.fetch = async () => new Response(eventStream([
    {
      type: 'response.output_item.done',
      item: { type: 'web_search_call', action: { sources: sources.slice(0, 20) } },
    },
    {
      type: 'response.output_item.done',
      item: { type: 'web_search_call', action: { sources: sources.slice(20) } },
    },
    { type: 'response.output_text.delta', delta: 'Finished' },
    { type: 'response.completed', response: { output: [] } },
  ]), {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  })

  const result = await runChatGPTCodexWebResearchResponse({
    credential: { accessToken: 'test-token', accountId: 'test-account' },
    model: 'gpt-5.4',
    instructions: 'Research public job sources.',
    prompt: 'Find roles.',
    sessionId: 'career-citation-cap-test',
  })

  assert.equal(result.citations.length, 30)
  assert.equal(result.citations.at(0)?.url, sources[0]?.url)
  assert.equal(result.citations.at(-1)?.url, sources[29]?.url)
})
