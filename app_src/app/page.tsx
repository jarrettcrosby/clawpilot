import HomeClient from './HomeClient'
import MeasurementSystemProvider from '@/components/measurements/MeasurementSystemProvider'
import UserDateTimeProvider from '@/components/timezone/UserDateTimeProvider'
import { getStorageDriver } from '@/lib/persistence/config'

export const dynamic = 'force-dynamic'
export const revalidate = 0

export default function Page() {
  const postgresStorageEnabled = getStorageDriver() === 'postgres'
  const sessionGuardEnabled = process.env.APP_AUTH_REQUIRED === '1' || Boolean(
    process.env.RAILWAY_ENVIRONMENT_NAME
    || process.env.RAILWAY_ENVIRONMENT_ID
    || process.env.RAILWAY_PROJECT_ID
    || process.env.RAILWAY_ENVIRONMENT
    || process.env.VERCEL,
  )

  return (
    <UserDateTimeProvider>
      <MeasurementSystemProvider persistenceEnabled={postgresStorageEnabled}>
        <HomeClient
          shortLinksEnabled={postgresStorageEnabled}
          sessionGuardEnabled={sessionGuardEnabled}
        />
      </MeasurementSystemProvider>
    </UserDateTimeProvider>
  )
}
