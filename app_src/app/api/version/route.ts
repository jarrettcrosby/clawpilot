import { NextResponse } from 'next/server'
import { exec } from 'child_process'
import { promisify } from 'util'

const execAsync = promisify(exec)
const REPO = '/Users/agentsuburbiasandwich/clawd-app'

export async function GET() {
  try {
    const [{ stdout: head }, { stdout: subject }, { stdout: date }, { stdout: dirty }] = await Promise.all([
      execAsync(`git -C ${REPO} rev-parse HEAD`),
      execAsync(`git -C ${REPO} log -1 --pretty=format:%s`),
      execAsync(`git -C ${REPO} log -1 --pretty=format:%ai`),
      execAsync(`git -C ${REPO} status --porcelain | wc -l`),
    ])

    const hash = head.trim()
    const dirtyCount = parseInt(dirty.trim(), 10) || 0

    return NextResponse.json({
      hash,
      short: hash.slice(0, 7),
      subject: subject.trim(),
      date: date.trim(),
      dirty: dirtyCount > 0,
      dirtyCount,
    })
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 })
  }
}
