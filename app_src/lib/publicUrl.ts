import { isHostedRuntime } from '@/lib/persistence/config'

export function appPublicUrl(): string {
  const configured = String(process.env.CLAWPILOT_PUBLIC_URL || '').trim()
  if (!configured && isHostedRuntime()) throw new Error('CLAWPILOT_PUBLIC_URL is required in hosted environments')
  const url = new URL(configured || 'http://localhost:4002')
  if (url.protocol !== 'https:' && url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') {
    throw new Error('CLAWPILOT_PUBLIC_URL must use HTTPS')
  }
  return url.origin
}
