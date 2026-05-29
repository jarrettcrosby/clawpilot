import { NextResponse } from 'next/server'
import { exec } from 'child_process'
import { promisify } from 'util'
import { access } from 'fs/promises'
import { join } from 'path'
import { getErrorMessage } from '@/lib/errorUtils'

const execAsync = promisify(exec)

const REPO_CANDIDATES = [
  process.env.CLAWPILOT_VERSION_REPO,
  '/Users/agentsuburbiasandwich/Desktop/clawd-app-dev',
  '/Users/agentsuburbiasandwich/clawd-app',
].filter((value): value is string => Boolean(value && value.trim()))

async function resolveRepoPath() {
  for (const repo of REPO_CANDIDATES) {
    try {
      await access(join(repo, '.git'))
      return repo
    } catch {
      // try the next candidate
    }
  }

  throw new Error('No git repository available for version endpoint')
}

export async function GET() {
  try {
    const repo = await resolveRepoPath()
    const [{ stdout: head }, { stdout: subject }, { stdout: date }, { stdout: dirty }] = await Promise.all([
      execAsync(`git -C ${repo} rev-parse HEAD`),
      execAsync(`git -C ${repo} log -1 --pretty=format:%s`),
      execAsync(`git -C ${repo} log -1 --pretty=format:%ai`),
      execAsync(`git -C ${repo} status --porcelain | wc -l`),
    ])

    const hash = head.trim()
    const dirtyCount = parseInt(dirty.trim(), 10) || 0

    return NextResponse.json({
      repo,
      hash,
      short: hash.slice(0, 7),
      subject: subject.trim(),
      date: date.trim(),
      dirty: dirtyCount > 0,
      dirtyCount,
    })
  } catch (error: unknown) {
    return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 })
  }
}
