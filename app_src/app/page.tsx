import HomeClient from './HomeClient'
import UserDateTimeProvider from '@/components/timezone/UserDateTimeProvider'
import { getStorageDriver } from '@/lib/persistence/config'

export const dynamic = 'force-dynamic'
export const revalidate = 0

export default function Page() {
  const sessionGuardEnabled = process.env.APP_AUTH_REQUIRED === '1' || Boolean(
    process.env.RAILWAY_ENVIRONMENT_NAME
    || process.env.RAILWAY_ENVIRONMENT_ID
    || process.env.RAILWAY_PROJECT_ID
    || process.env.RAILWAY_ENVIRONMENT
    || process.env.VERCEL,
  )

  return (
    <UserDateTimeProvider>
      <HomeClient
        shortLinksEnabled={getStorageDriver() === 'postgres'}
        sessionGuardEnabled={sessionGuardEnabled}
      />
    </UserDateTimeProvider>
  )
}
