import { NextResponse } from 'next/server'
import path from 'path'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { getErrorMessage } from '@/lib/errorUtils'

const execFileAsync = promisify(execFile)

export async function GET() {
  try {
    const appDir = process.cwd()
    const repoPath = path.resolve(appDir, '..')
    const hostedCommit = process.env.RAILWAY_GIT_COMMIT_SHA
      || process.env.VERCEL_GIT_COMMIT_SHA
      || process.env.RELEASE_COMMIT
    const hostedBranch = process.env.RAILWAY_GIT_BRANCH
      || process.env.VERCEL_GIT_COMMIT_REF
      || process.env.RELEASE_BRANCH
    const hostedEnvironment = process.env.RAILWAY_ENVIRONMENT_NAME || process.env.VERCEL_ENV
    const hosted = Boolean(hostedCommit || hostedEnvironment)
    let commit = hostedCommit || ''

    if (!commit && !hosted) {
      const { stdout } = await execFileAsync('git', ['-C', repoPath, 'rev-parse', 'HEAD'])
      commit = stdout.trim()
    }
    if (!commit) {
      return NextResponse.json({ error: 'Hosted build identity is not configured' }, { status: 503 })
    }

    const port = process.env.PORT || process.env.RUNTIME_PORT || 'unknown'
    const inferredLane = hostedEnvironment
      || hostedBranch
      || (port === '4001'
      ? 'stable'
      : port === '4002'
        ? 'dev'
        : 'local')
    const lane = process.env.RUNTIME_LANE || inferredLane

    return NextResponse.json({
      lane,
      port,
      commit,
      branch: hostedBranch || null,
      environment: hostedEnvironment || null,
      provider: process.env.RAILWAY_PROJECT_ID ? 'railway' : process.env.VERCEL ? 'vercel' : 'local',
      service: process.env.RAILWAY_SERVICE_NAME || null,
      ...(hosted ? {} : { repoPath, appDir }),
    })
  } catch (error: unknown) {
    return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 })
  }
}
