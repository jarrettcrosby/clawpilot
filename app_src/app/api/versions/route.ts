import { NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'
export const revalidate = 0
import { exec } from 'child_process'
import { promisify } from 'util'
import fs from 'fs'
import path from 'path'
import { getErrorMessage } from '@/lib/errorUtils'

const execAsync = promisify(exec)
const REPO = path.resolve(process.cwd(), '..')
const DATA_DIR = REPO.includes('clawd-app-dev') ? 'data-dev' : 'data'
const BACKUP_DIR = path.join(REPO, DATA_DIR, 'backups')

export async function GET() {
  try {
    // Git log
    const { stdout } = await execAsync(
      `git -C ${REPO} log --pretty=format:"%H|%s|%at|%an" -30`
    )
    const commits = stdout.trim().split('\n').filter(Boolean).map(line => {
      const [hash, subject, epoch, author] = line.split('|')
      const ts = parseInt(epoch || '0', 10)
      const isoDate = ts ? new Date(ts * 1000).toISOString() : null
      return { hash, subject, date: isoDate, author, short: hash.slice(0, 7) }
    })

    // Data backups
    let backups: { name: string; timestamp: string }[] = []
    if (fs.existsSync(BACKUP_DIR)) {
      backups = fs.readdirSync(BACKUP_DIR)
        .filter(f => f.endsWith('.json'))
        .sort()
        .reverse()
        .slice(0, 20)
        .map(name => ({
          name,
          timestamp: name.replace('tasks_', '').replace('.json', '').replace('_', ' '),
        }))
    }

    return NextResponse.json({ commits, backups })
  } catch (error: unknown) {
    return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 })
  }
}
