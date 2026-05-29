import fs from 'fs'
import path from 'path'

export type FreezeState = {
  frozen: boolean
  reason?: string | null
  enabledAt?: string | null
  enabledBy?: string | null
}

function resolveRepoRoot() {
  return path.resolve(process.cwd(), '..')
}

function resolveDataDir(repoRoot?: string) {
  const root = repoRoot || resolveRepoRoot()
  if (root.includes('clawd-app-dev')) return path.join(root, 'data-dev')
  return path.join(root, 'data')
}

export function resolveFreezePath() {
  const repoRoot = resolveRepoRoot()
  const dataDir = resolveDataDir(repoRoot)
  return process.env.FREEZE_PATH || path.join(dataDir, 'freeze.json')
}

export function readFreezeState(): FreezeState {
  const freezePath = resolveFreezePath()
  if (!fs.existsSync(freezePath)) return { frozen: false }
  try {
    const raw = JSON.parse(fs.readFileSync(freezePath, 'utf-8'))
    return {
      frozen: Boolean(raw?.frozen),
      reason: raw?.reason ?? null,
      enabledAt: raw?.enabledAt ?? null,
      enabledBy: raw?.enabledBy ?? null,
    }
  } catch {
    return { frozen: false }
  }
}

export function ensureNotFrozen() {
  const state = readFreezeState()
  if (!state.frozen) return null
  const reason = state.reason ? ` (${state.reason})` : ''
  return { error: `Rollout freeze active${reason}. Writes are temporarily disabled.`, state }
}
