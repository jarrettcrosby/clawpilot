import { NextResponse } from 'next/server'
import path from 'path'

export async function GET() {
  const appDir = process.cwd()
  const repoPath = path.resolve(appDir, '..')
  const port = process.env.PORT || process.env.RUNTIME_PORT || ''
  const inferredLane = port === '4001'
    ? 'stable'
    : port === '4002'
      ? 'dev'
      : (repoPath.includes('clawd-app-dev') ? 'dev' : 'stable')
  const lane = process.env.RUNTIME_LANE || inferredLane
  return NextResponse.json({
    lane,
    shouldShowPromotionReadiness: lane === 'dev',
  })
}
