import { NextResponse } from 'next/server'
import path from 'path'
import { promises as fs } from 'fs'

const PROMO_PREFIX = 'promotion-check-'
const DRY_PREFIX = 'dry-run-'
const PROMO_DRY_PREFIX = 'promotion-dry-run-'

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

async function loadJson(filePath: string) {
  const raw = await fs.readFile(filePath, 'utf-8')
  return JSON.parse(raw)
}

export async function GET() {
  try {
    const appDir = process.cwd()
    const repoPath = path.resolve(appDir, '..')
    const dataDir = repoPath.includes('clawd-app-dev') ? 'data-dev' : 'data'
    const backupsDir = path.join(repoPath, dataDir, 'backups')
    const dirOk = await fs.stat(backupsDir).then(() => true).catch(() => false)
    if (!dirOk) {
      return NextResponse.json({
        status: 'ok',
        promotionCheck: {
          status: 'missing',
          timestamp: null,
          timestampIso: null,
          runtime: null,
          blockers: ['No promotion readiness report found'],
        },
        promotionDryRun: {
          status: 'missing',
          timestamp: null,
          timestampIso: null,
          runtime: null,
          blockers: ['No promotion dry-run report found'],
          alignmentReport: null,
          promotionCheckReport: null,
          verifyStatus: null,
        },
        alignmentDryRun: {
          status: 'missing',
          timestamp: null,
          timestampIso: null,
          diffs: [],
          missing: [],
          purge: [],
        },
      })
    }

    const promoPath = await findLatestFile(backupsDir, PROMO_PREFIX)
    const alignPath = await findLatestFile(backupsDir, DRY_PREFIX)
    const promoDryPath = await findLatestFile(backupsDir, PROMO_DRY_PREFIX)

    const promotionCheck = promoPath
      ? (() => {
          const report = loadJson(promoPath)
          return report.then(data => ({
            status: data?.status || 'unknown',
            timestamp: data?.timestamp || null,
            timestampIso: parseTimestamp(data?.timestamp || null),
            runtime: data?.runtime || null,
            blockers: data?.status === 'ready' ? [] : [`Readiness status: ${data?.status || 'unknown'}`],
          }))
        })()
      : Promise.resolve({
          status: 'missing',
          timestamp: null,
          timestampIso: null,
          runtime: null,
          blockers: ['No promotion readiness report found'],
        })

    const alignmentDryRun = alignPath
      ? (() => {
          const report = loadJson(alignPath)
          return report.then(data => {
            const diffs = Array.isArray(data?.diffs) ? data.diffs : []
            const missing = Array.isArray(data?.missing) ? data.missing : []
            const purge = Array.isArray(data?.purge) ? data.purge : []
            const status = diffs.length || missing.length || purge.length ? 'mismatch' : 'aligned'
            return {
              status,
              timestamp: data?.timestamp || null,
              timestampIso: parseTimestamp(data?.timestamp || null),
              diffs,
              missing,
              purge,
            }
          })
        })()
      : Promise.resolve({
          status: 'missing',
          timestamp: null,
          timestampIso: null,
          diffs: [],
          missing: [],
          purge: [],
        })

    const promotionDryRun = promoDryPath
      ? (() => {
          const report = loadJson(promoDryPath)
          return report.then(data => ({
            status: data?.status || 'unknown',
            timestamp: data?.timestamp || null,
            timestampIso: parseTimestamp(data?.timestamp || null),
            runtime: data?.runtime || null,
            blockers: Array.isArray(data?.blockers) ? data.blockers : [],
            alignmentReport: data?.alignmentReport || null,
            promotionCheckReport: data?.promotionCheckReport || null,
            verifyStatus: data?.verifyStatus || null,
          }))
        })()
      : Promise.resolve({
          status: 'missing',
          timestamp: null,
          timestampIso: null,
          runtime: null,
          blockers: ['No promotion dry-run report found'],
          alignmentReport: null,
          promotionCheckReport: null,
          verifyStatus: null,
        })

    const [promo, alignment, promoDry] = await Promise.all([promotionCheck, alignmentDryRun, promotionDryRun])

    return NextResponse.json({
      status: 'ok',
      promotionCheck: promo,
      promotionDryRun: promoDry,
      alignmentDryRun: alignment,
    })
  } catch (e: any) {
    return NextResponse.json({ status: 'error', error: e.message }, { status: 500 })
  }
}
