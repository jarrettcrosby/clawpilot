import HomeClient from './HomeClient'
import { getStorageDriver } from '@/lib/persistence/config'

export const dynamic = 'force-dynamic'
export const revalidate = 0

export default function Page() {
  return <HomeClient shortLinksEnabled={getStorageDriver() === 'postgres'} />
}
