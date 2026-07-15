import HomeClient from './HomeClient'
import UserDateTimeProvider from '@/components/timezone/UserDateTimeProvider'
import { getStorageDriver } from '@/lib/persistence/config'

export const dynamic = 'force-dynamic'
export const revalidate = 0

export default function Page() {
  return (
    <UserDateTimeProvider>
      <HomeClient shortLinksEnabled={getStorageDriver() === 'postgres'} />
    </UserDateTimeProvider>
  )
}
