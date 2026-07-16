import { NextResponse } from 'next/server'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { access } from 'fs/promises'
import { join } from 'path'
import { getErrorMessage } from '@/lib/errorUtils'

const execFileAsync = promisify(execFile)

const REPO_CANDIDATES = [
  process.env.CLAWPILOT_VERSION_REPO,
  process.env.CLAWPILOT_REPO_ROOT,
  join(process.cwd(), '..'),
  '/Users/agentsuburbiasandwich/Desktop/clawpilot',
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
    const hostedHash = process.env.RAILWAY_GIT_COMMIT_SHA
      || process.env.VERCEL_GIT_COMMIT_SHA
      || process.env.RELEASE_COMMIT
    if (hostedHash) {
      return NextResponse.json({
        hash: hostedHash,
        short: hostedHash.slice(0, 7),
        subject: process.env.RAILWAY_GIT_COMMIT_MESSAGE || process.env.RELEASE_TITLE || 'Deployed build',
        date: '',
        dirty: false,
        dirtyCount: 0,
      })
    }

    const repo = await resolveRepoPath()
    const [{ stdout: head }, { stdout: subject }, { stdout: date }, { stdout: dirty }] = await Promise.all([
      execFileAsync('git', ['-C', repo, 'rev-parse', 'HEAD']),
      execFileAsync('git', ['-C', repo, 'log', '-1', '--pretty=format:%s']),
      execFileAsync('git', ['-C', repo, 'log', '-1', '--pretty=format:%ai']),
      execFileAsync('git', ['-C', repo, 'status', '--porcelain']),
    ])

    const hash = head.trim()
    const dirtyCount = dirty.split('\n').filter((line) => line.trim()).length

    return NextResponse.json({
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
