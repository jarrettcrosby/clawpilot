import fs from 'fs'
import path from 'path'

const LOCK_WAIT_TIMEOUT_MS = 5000
const LOCK_RETRY_MS = 50
const LOCK_STALE_MS = 60000

function cleanUpStaleLock(lockPath: string): void {
  try {
    const stats = fs.statSync(lockPath)
    const ageMs = Date.now() - stats.mtimeMs
    if (ageMs > LOCK_STALE_MS) {
      fs.unlinkSync(lockPath)
    }
  } catch {
    // lock file disappeared or cannot be read; retry acquisition loop
  }
}

export async function withFileLock<T>(lockPath: string, fn: () => T | Promise<T>): Promise<T> {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true })
  const start = Date.now()
  let fd: number | null = null

  while (fd === null) {
    try {
      fd = fs.openSync(lockPath, 'wx')
      fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }))
    } catch {
      cleanUpStaleLock(lockPath)
      if (Date.now() - start > LOCK_WAIT_TIMEOUT_MS) {
        throw new Error(`Lock timeout for ${lockPath}`)
      }
      await new Promise(res => setTimeout(res, LOCK_RETRY_MS))
    }
  }

  try {
    return await fn()
  } finally {
    if (fd !== null) fs.closeSync(fd)
    try {
      fs.unlinkSync(lockPath)
    } catch {}
  }
}
