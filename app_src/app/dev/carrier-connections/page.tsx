import { notFound } from 'next/navigation'
import CarrierConnectionsPanel from '@/components/settings/CarrierConnectionsPanel'

export const dynamic = 'force-dynamic'

export default function CarrierConnectionsDevelopmentPage() {
  const localFixtureRuntime = process.env.RUNTIME_LANE === 'dev'
    && process.env.APP_AUTH_REQUIRED === '0'
    && !process.env.RAILWAY_PROJECT_ID
    && !process.env.VERCEL
    && process.env.LOCAL_UI_FIXTURES === '1'
  if (!localFixtureRuntime) notFound()

  return (
    <main style={{ minHeight: '100vh', padding: '24px', background: '#101016' }}>
      <div style={{ width: 'min(960px, 100%)', margin: '0 auto' }}>
        <h1 style={{ margin: 0, fontSize: '1.65rem' }}>Carrier connections UI test</h1>
        <p style={{ margin: '8px 0 24px', color: '#b9b9c7' }}>
          Local-only layout fixture. Loading this page never contacts a carrier provider.
        </p>
        <CarrierConnectionsPanel />
      </div>
    </main>
  )
}
