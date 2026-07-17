#!/usr/bin/env node

import crypto from 'node:crypto'
import process from 'node:process'
import pg from '../app_src/node_modules/pg/lib/index.js'

const { Pool } = pg

function argument(name) {
  const index = process.argv.indexOf(name)
  return index >= 0 ? String(process.argv[index + 1] || '').trim() : ''
}

function safeSlug(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 180) || 'document'
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex')
}

function excerptFor(content) {
  return content
    .replace(/^#+\s+/gm, '')
    .replace(/[`*_>[\]#|]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 180)
}

function extractDeliverable(text) {
  const normalized = String(text || '').trim()
  const marker = normalized.match(/(?:^|\n)Deliverable:\s*\n/i)
  if (!marker || marker.index === undefined) return normalized.length >= 600 ? normalized : ''
  const start = marker.index + marker[0].length
  const tail = normalized.slice(start)
  const boundaries = ['Changed:', 'Evidence:', 'Remaining:', 'Waiting on:', 'Learned:']
    .map((label) => tail.search(new RegExp(`\\n${label.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&')}\\s*`, 'i')))
    .filter((index) => index >= 0)
  return tail.slice(0, boundaries.length ? Math.min(...boundaries) : undefined).trim()
}

const taskId = argument('--task-id')
const apply = process.argv.includes('--apply')
if (!taskId) {
  console.error('Usage: node scripts/backfill-project-agent-documents.mjs --task-id <task-id> [--apply]')
  process.exit(1)
}

const connectionString = process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL
if (!connectionString) {
  console.error('DATABASE_URL or DATABASE_PUBLIC_URL is required')
  process.exit(1)
}

const pool = new Pool({
  connectionString,
  ssl: /railway\.app|proxy\.rlwy\.net/i.test(connectionString) ? { rejectUnauthorized: false } : undefined,
})

const client = await pool.connect()
try {
  await client.query('BEGIN')
  const taskResult = await client.query(
    `SELECT task.id, task.board_id::text, task.title, task.payload, board.owner_email
     FROM tasks task
     JOIN project_boards board ON board.id = task.board_id
     WHERE task.id = $1
     LIMIT 1
     FOR UPDATE OF task`,
    [taskId],
  )
  const task = taskResult.rows[0]
  if (!task) throw new Error('Task was not found')
  const payload = task.payload && typeof task.payload === 'object' ? task.payload : {}
  const comments = Array.isArray(payload.comments) ? payload.comments : []
  const seen = new Set()
  const sections = []
  for (const comment of comments) {
    if (String(comment?.author || '').toLowerCase() !== 'projects') continue
    if (/Updated document:/i.test(String(comment?.text || ''))) continue
    const deliverable = extractDeliverable(comment?.text)
    const contentHash = sha256(deliverable)
    if (!deliverable || seen.has(contentHash)) continue
    seen.add(contentHash)
    const recordedAt = Number.isFinite(Date.parse(String(comment?.createdAt || comment?.timestamp || '')))
      ? new Date(String(comment.createdAt || comment.timestamp)).toISOString()
      : new Date().toISOString()
    sections.push({ id: String(comment?.id || contentHash.slice(0, 12)), recordedAt, deliverable })
  }
  if (sections.length === 0) throw new Error('Task has no substantive Projects agent output to backfill')

  const title = `${String(task.title || 'Project task').trim()} - Projects Research`
  const sourceKey = `agent-task:${task.id}:projects`
  const slug = [
    'agent',
    safeSlug(task.title).slice(0, 100),
    sha256(`${task.id}:projects`).slice(0, 10),
    'projects',
  ].join('-')
  const existing = await client.query(
    `SELECT id::text, content FROM app_documents
     WHERE owner_email = $1 AND source_key = $2
     LIMIT 1`,
    [task.owner_email, sourceKey],
  )
  let content = String(existing.rows[0]?.content || '').trim()
  if (!content) {
    content = [
      `# ${title}`,
      '',
      `Task: ${task.title}`,
      `Task ID: ${task.id}`,
      `Board ID: ${task.board_id}`,
      'Agent: Projects',
      '',
      'This document consolidates substantive Projects agent research previously posted as card comments.',
    ].join('\n')
  }
  let appended = 0
  for (const section of sections) {
    const marker = `<!-- historical-agent-comment:${section.id} -->`
    if (content.includes(marker)) continue
    content += [
      '',
      '---',
      '',
      `## Research run - ${section.recordedAt}`,
      marker,
      '',
      section.deliverable,
    ].join('\n')
    appended += 1
  }

  const linkCommentId = 'agent-document-backfill-projects'
  const hasLinkComment = comments.some((comment) => (
    String(comment?.id || '') === linkCommentId || String(comment?.text || '').includes(`/?doc=${slug}#docs`)
  ))
  console.log(JSON.stringify({
    apply,
    taskId: task.id,
    title,
    slug,
    substantiveRuns: sections.length,
    appendedRuns: appended,
    linkCommentRequired: !hasLinkComment,
  }, null, 2))

  if (!apply) {
    await client.query('ROLLBACK')
    process.exitCode = 2
  } else {
    const contentHash = sha256(content.trim())
    const documentResult = await client.query(
      `INSERT INTO app_documents (
         owner_email, source_key, source, kind, status, title, slug, category,
         content, excerpt, tags, content_hash, board_id, generated_at, created_at, updated_at
       ) VALUES (
         $1, $2, 'agent', 'agent-task-deliverable', 'active', $3, $4, 'projects',
         $5, $6, $7::text[], $8, $9::uuid, now(), now(), now()
       )
       ON CONFLICT (owner_email, source_key) DO UPDATE SET
         source = EXCLUDED.source,
         kind = EXCLUDED.kind,
         status = EXCLUDED.status,
         title = EXCLUDED.title,
         slug = EXCLUDED.slug,
         category = EXCLUDED.category,
         content = EXCLUDED.content,
         excerpt = EXCLUDED.excerpt,
         tags = EXCLUDED.tags,
         content_hash = EXCLUDED.content_hash,
         board_id = EXCLUDED.board_id,
         generated_at = EXCLUDED.generated_at,
         updated_at = now()
       RETURNING id::text`,
      [
        task.owner_email,
        sourceKey,
        title,
        slug,
        content.trim(),
        excerptFor(content),
        ['agent', 'task-linked', 'projects', `task:${task.id}`],
        contentHash,
        task.board_id,
      ],
    )
    const documentId = documentResult.rows[0].id
    await client.query(
      `INSERT INTO document_embedding_jobs (document_id, owner_email, content_hash)
       VALUES ($1::uuid, $2, $3)
       ON CONFLICT (document_id) DO UPDATE SET
         owner_email = EXCLUDED.owner_email,
         content_hash = EXCLUDED.content_hash,
         status = 'pending',
         attempts = 0,
         available_at = now(),
         locked_at = NULL,
         last_error = NULL,
         updated_at = now()`,
      [documentId, task.owner_email, contentHash],
    )
    if (!hasLinkComment) {
      const now = new Date().toISOString()
      payload.comments = [...comments, {
        id: linkCommentId,
        text: `Agent: projects\nStatus: responded\n\nUpdated document: [${title}](/?doc=${slug}#docs)\nSummary: Consolidated prior Projects research into this task document.\nRemaining: Continue the remaining research and design checklist in the linked document.\nWaiting on: none`,
        author: 'projects',
        createdAt: now,
        timestamp: now,
      }]
      payload.activity = [...(Array.isArray(payload.activity) ? payload.activity : []), {
        type: 'comment',
        actor: 'projects',
        taskId: task.id,
        taskTitle: task.title,
        commentId: linkCommentId,
        message: 'Projects research was consolidated into a task-linked document.',
        timestamp: now,
      }]
      payload.updatedAt = now
      payload.boardId = task.board_id
      const payloadHash = sha256(JSON.stringify(payload))
      await client.query(
        `UPDATE tasks SET payload = $2::jsonb, payload_hash = $3, updated_at = $4::timestamptz
         WHERE id = $1`,
        [task.id, JSON.stringify(payload), payloadHash, now],
      )
    }
    await client.query(
      `INSERT INTO audit_events (
         actor, event_type, aggregate_type, aggregate_id, payload, event_key, created_at
       ) VALUES ($1, 'agent.task_document.backfilled', 'project_task', $2, $3::jsonb, $4, now())
       ON CONFLICT (event_key) WHERE event_key IS NOT NULL DO NOTHING`,
      [
        task.owner_email,
        task.id,
        JSON.stringify({ boardId: task.board_id, taskId: task.id, documentId, documentSlug: slug, substantiveRuns: sections.length }),
        `agent-task-document-backfill:${task.id}:projects`,
      ],
    )
    await client.query('COMMIT')
  }
} catch (error) {
  await client.query('ROLLBACK').catch(() => undefined)
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
} finally {
  client.release()
  await pool.end()
}
