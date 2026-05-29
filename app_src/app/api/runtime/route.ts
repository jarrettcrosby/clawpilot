import { NextResponse } from 'next/server'
import path from 'path'
import { exec } from 'child_process'
import { promisify } from 'util'
import { getErrorMessage } from '@/lib/errorUtils'

const execAsync = promisify(exec)

export async function GET() {
  try {
    const appDir = process.cwd()
    const repoPath = path.resolve(appDir, '..')
    const [{ stdout: head }] = await Promise.all([
      execAsync(`git -C ${repoPath} rev-parse HEAD`),
    ])

    const hash = head.trim()
    const port = process.env.PORT || process.env.RUNTIME_PORT || 'unknown'
    const inferredLane = port === '4001'
      ? 'stable'
      : port === '4002'
        ? 'dev'
        : (repoPath.includes('clawd-app-dev') ? 'dev' : 'stable')
    const lane = process.env.RUNTIME_LANE || inferredLane

    return NextResponse.json({
      lane,
      port,
      commit: hash,
      repoPath,
      appDir,
    })
  } catch (error: unknown) {
    return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 })
  }
}
