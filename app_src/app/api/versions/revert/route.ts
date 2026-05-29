import { NextResponse } from 'next/server'
import { exec } from 'child_process'
import { promisify } from 'util'
import { getErrorMessage } from '@/lib/errorUtils'
import path from 'path'

const execAsync = promisify(exec)
const REPO = path.resolve(process.cwd(), '..')
const DATA_DIR = REPO.includes('clawd-app-dev') ? 'data-dev' : 'data'

export async function POST(req: Request) {
  try {
    const { hash, backup } = await req.json()

    if (backup) {
      // Restore data backup
      const src = path.join(REPO, DATA_DIR, 'backups', backup)
      const dest = path.join(REPO, DATA_DIR, 'tasks.json')
      await execAsync(`cp "${src}" "${dest}"`)
      return NextResponse.json({ ok: true, message: `Restored data backup: ${backup}` })
    }

    if (hash) {
      // Hard reset to the selected commit (true "go back to this version")
      // Safety: keep a local backup branch pointing to current HEAD.
      await execAsync(`git -C ${REPO} branch clawpilot-backup-$(date +%Y%m%d-%H%M%S) HEAD`)
      await execAsync(`git -C ${REPO} reset --hard ${hash}`)

      // Rebuild + restart (production mode)
      await execAsync(`cd ${REPO}/app_src && npm install --silent`)
      await execAsync(`cd ${REPO}/app_src && npm run build`)
      // Stop anything serving port 4001 (dev or prod)
      await execAsync(`pkill -f "next dev -p 4001" || true`)
      await execAsync(`pkill -f "npm start -- --port 4001" || true`)
      await execAsync(`pkill -f "npm start --port 4001" || true`)
      await execAsync(`cd ${REPO}/app_src && nohup npm start -- --port 4001 > /tmp/clawd-app.log 2>&1 &`)

      return NextResponse.json({ ok: true, message: `Reset to ${hash.slice(0, 7)} and redeployed` })
    }

    return NextResponse.json({ error: 'Provide hash or backup' }, { status: 400 })
  } catch (error: unknown) {
    return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 })
  }
}
