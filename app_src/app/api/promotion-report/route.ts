import { NextResponse } from 'next/server'
import path from 'path'
import { promises as fs } from 'fs'
import { getErrorMessage } from '@/lib/errorUtils'

const PROMO_PREFIX = 'promotion-check-'
const DRY_PREFIX = 'dry-run-'

function parseTimestamp(ts?: string | null) {
  if (!ts) return null
  const match = ts.match(/^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})$/)
  if (!match) return null
  const [, y, m, d, hh, mm, ss] = match
  return `${y}-${m}-${d}T${hh}:${mm}:${ss}`
}

async function findLatestFile(dir: string, prefix: string) {
  const entries = await fs.readdir(dir)
  const candidates = entries.filter(name => name.startsWith(prefix) && name.endsWith('.json'))
  if (!candidates.length) return null
  const stats = await Promise.all(candidates.map(async name => ({
    name,
    stat: await fs.stat(path.join(dir, name)),
  })))
  stats.sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs)
  return path.join(dir, stats[0].name)
}

export async function GET() {
  try {
    const appDir = process.cwd()
    const repoPath = path.resolve(appDir, '..')
    if (!repoPath.includes('clawd-app-dev')) {
      return NextResponse.json({ status: 'disabled', reason: 'not-dev' }, { status: 404 })
    }

    const backupsDir = path.join(repoPath, 'data-dev', 'backups')
    const latestReportPath = await findLatestFile(backupsDir, PROMO_PREFIX)

    if (!latestReportPath) {
      return NextResponse.json({
        status: 'missing',
        timestamp: null,
        timestampIso: null,
        runtime: null,
        alignment: null,
        blockers: ['No promotion readiness report found'],
      })
    }

    const reportRaw = await fs.readFile(latestReportPath, 'utf-8')
    const report = JSON.parse(reportRaw)

    const timestamp = report?.timestamp || null
    const timestampIso = parseTimestamp(timestamp)
    const runtime = report?.runtime || null

    let alignment: { diffs: string[]; missing: string[]; purge: string[] } | null = null
    if (timestamp) {
      const dryPath = path.join(backupsDir, `${DRY_PREFIX}${timestamp}.json`)
      try {
        const dryRaw = await fs.readFile(dryPath, 'utf-8')
        const dry = JSON.parse(dryRaw)
        alignment = {
          diffs: Array.isArray(dry?.diffs) ? dry.diffs : [],
          missing: Array.isArray(dry?.missing) ? dry.missing : [],
          purge: Array.isArray(dry?.purge) ? dry.purge : [],
        }
      } catch {
        alignment = null
      }
    }

    const blockers: string[] = []
    const expectedLane = 'dev'
    const expectedPort = '4002'
    if (!runtime || !runtime.lane || !runtime.port || !runtime.repoPath) {
      blockers.push('Runtime identity missing')
    } else {
      if (runtime.lane !== expectedLane || String(runtime.port) !== expectedPort || runtime.repoPath !== repoPath) {
        blockers.push(`Runtime mismatch (expected ${expectedLane}:${expectedPort} at ${repoPath})`)
      }
    }

    if (alignment) {
      const diffCount = alignment.diffs.length
      const missingCount = alignment.missing.length
      const purgeCount = alignment.purge.length
      if (diffCount || missingCount || purgeCount) {
        blockers.push(`Alignment mismatch (${diffCount} diffs, ${missingCount} missing, ${purgeCount} purge)`)
      }
    }

    const status = report?.status || 'unknown'
    if (status !== 'ready' && blockers.length === 0) {
      blockers.push(`Readiness status: ${status}`)
    }

    return NextResponse.json({
      status,
      timestamp,
      timestampIso,
      runtime,
      alignment,
      blockers,
    })
  } catch (error: unknown) {
    return NextResponse.json({ status: 'error', error: getErrorMessage(error) }, { status: 500 })
  }
}
