#!/usr/bin/env node
import { createRequire } from 'node:module'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

const root = process.cwd()
const requireFromApp = createRequire(new URL('../app_src/package.json', import.meta.url))
const { Pool } = requireFromApp('pg')

function fail(message) {
  console.error(`db:import:threads failed: ${message}`)
  process.exit(1)
}

function nowIso() {
  return new Date().toISOString()
}

function rand() {
  return Math.random().toString(36).slice(2, 8)
}

function defaultThreadsPath() {
  const devPath = resolve(root, 'data-dev', 'agents', 'threads.json')
  if (existsSync(devPath)) return devPath
  return resolve(root, 'data', 'agents', 'threads.json')
}

function normalizeThreadStatus(status, fallback = 'active') {
  const safe = String(status || '').trim().toLowerCase()
  return ['active', 'resolving', 'blocked', 'closed'].includes(safe) ? safe : fallback
}

function normalizeMessageRole(role) {
  const safe = String(role || '').trim().toLowerCase()
  return ['agent', 'system', 'tool'].includes(safe) ? safe : 'user'
}

function normalizeMessageStatus(status) {
  const safe = String(status || '').trim().toLowerCase()
  return ['pending', 'failed'].includes(safe) ? safe : 'committed'
}

function normalizeTags(tags) {
  return Array.from(new Set((Array.isArray(tags) ? tags : [])
    .map((tag) => String(tag || '').trim())
    .filter(Boolean))).sort((a, b) => a.localeCompare(b))
}

function toThreadId(agentId, taskId) {
  return `thread_${agentId}_${taskId || 'general'}`
}

function deriveContext(messages) {
  const lastUser = [...messages].reverse().find((message) => message.role === 'user')
  const tokenEstimate = messages.reduce((total, message) => (
    total + Math.max(1, Math.ceil(String(message.text || '').length / 4))
  ), 0)
  return {
    summary: null,
    lastUserMessageId: lastUser?.id || null,
    messageCount: messages.length,
    tokenEstimate,
  }
}

function normalizeThread(thread) {
  const agentId = String(thread?.agentId || 'unknown-agent')
  const taskId = thread?.taskId ? String(thread.taskId) : undefined
  const messages = Array.isArray(thread?.messages)
    ? thread.messages.map((message) => ({
      id: String(message?.id || `${Date.now()}-${rand()}`),
      role: normalizeMessageRole(message?.role),
      text: String(message?.text || ''),
      createdAt: String(message?.createdAt || message?.timestamp || nowIso()),
      taskId: message?.taskId ? String(message.taskId) : taskId,
      status: normalizeMessageStatus(message?.status),
      meta: message?.meta && typeof message.meta === 'object' ? message.meta : undefined,
    }))
    : []
  const createdAt = String(thread?.createdAt || thread?.updatedAt || nowIso())
  const updatedAt = String(thread?.updatedAt || createdAt)
  const lastMessageAt = String(thread?.lastMessageAt || messages[messages.length - 1]?.createdAt || updatedAt)

  return {
    threadId: String(thread?.threadId || toThreadId(agentId, taskId)),
    agentId,
    createdAt,
    updatedAt,
    lastMessageAt,
    taskId,
    status: normalizeThreadStatus(thread?.status),
    tags: normalizeTags(thread?.tags),
    routing: {
      responder: String(thread?.routing?.responder || 'stub'),
      channel: String(thread?.routing?.channel || 'internal'),
      priority: String(thread?.routing?.priority || 'normal'),
    },
    context: thread?.context && typeof thread.context === 'object'
      ? {
        summary: typeof thread.context.summary === 'string' ? thread.context.summary : null,
        lastUserMessageId: typeof thread.context.lastUserMessageId === 'string' ? thread.context.lastUserMessageId : null,
        messageCount: Number.isFinite(thread.context.messageCount) ? Number(thread.context.messageCount) : messages.length,
        tokenEstimate: Number.isFinite(thread.context.tokenEstimate) ? Number(thread.context.tokenEstimate) : deriveContext(messages).tokenEstimate,
      }
      : deriveContext(messages),
    contextSnapshot: thread?.contextSnapshot && typeof thread.contextSnapshot === 'object' ? thread.contextSnapshot : null,
    contextSnapshotUpdatedAt: thread?.contextSnapshotUpdatedAt ? String(thread.contextSnapshotUpdatedAt) : null,
    messages,
  }
}

if (!process.env.DATABASE_URL) {
  fail('DATABASE_URL is required')
}

const sourcePath = process.env.AGENT_THREADS_PATH || defaultThreadsPath()
if (!existsSync(sourcePath)) {
  fail(`threads file not found: ${sourcePath}`)
}

const store = JSON.parse(readFileSync(sourcePath, 'utf-8'))
const threads = (Array.isArray(store?.threads) ? store.threads : []).map(normalizeThread)

const sslMode = String(process.env.PGSSLMODE || process.env.DATABASE_SSL || '').toLowerCase()
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: sslMode === 'require' || sslMode === 'true' ? { rejectUnauthorized: false } : undefined,
})

async function main() {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')

    const threadIds = threads.map((thread) => thread.threadId)
    for (const thread of threads) {
      await client.query(
        `
          INSERT INTO agent_threads (
            thread_id,
            agent_id,
            task_id,
            status,
            tags,
            routing,
            context,
            context_snapshot,
            created_at,
            updated_at,
            last_message_at,
            payload
          )
          VALUES ($1, $2, $3, $4, $5::text[], $6::jsonb, $7::jsonb, $8::jsonb, $9::timestamptz, $10::timestamptz, $11::timestamptz, $12::jsonb)
          ON CONFLICT (thread_id) DO UPDATE SET
            agent_id = EXCLUDED.agent_id,
            task_id = EXCLUDED.task_id,
            status = EXCLUDED.status,
            tags = EXCLUDED.tags,
            routing = EXCLUDED.routing,
            context = EXCLUDED.context,
            context_snapshot = EXCLUDED.context_snapshot,
            updated_at = EXCLUDED.updated_at,
            last_message_at = EXCLUDED.last_message_at,
            payload = EXCLUDED.payload
        `,
        [
          thread.threadId,
          thread.agentId,
          thread.taskId || null,
          thread.status,
          thread.tags,
          JSON.stringify(thread.routing),
          JSON.stringify(thread.context),
          thread.contextSnapshot ? JSON.stringify(thread.contextSnapshot) : null,
          thread.createdAt,
          thread.updatedAt,
          thread.lastMessageAt,
          JSON.stringify(thread),
        ],
      )

      await client.query('DELETE FROM agent_thread_messages WHERE thread_id = $1', [thread.threadId])
      for (const message of thread.messages) {
        await client.query(
          `
            INSERT INTO agent_thread_messages (
              id,
              thread_id,
              role,
              body,
              status,
              created_at,
              payload
            )
            VALUES ($1, $2, $3, $4, $5, $6::timestamptz, $7::jsonb)
          `,
          [
            message.id,
            thread.threadId,
            message.role,
            message.text,
            message.status,
            message.createdAt,
            JSON.stringify(message),
          ],
        )
      }
    }

    if (threadIds.length > 0) {
      await client.query('DELETE FROM agent_threads WHERE NOT (thread_id = ANY($1::text[]))', [threadIds])
    }

    await client.query('COMMIT')
    console.log(JSON.stringify({
      ok: true,
      sourcePath,
      dataDir: dirname(sourcePath),
      threadCount: threads.length,
      messageCount: threads.reduce((total, thread) => total + thread.messages.length, 0),
    }, null, 2))
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
    await pool.end()
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})

