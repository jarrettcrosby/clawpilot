import { notFound } from 'next/navigation'

import PipelineReportingDevelopmentFixture from '@/components/pipeline/PipelineReportingDevelopmentFixture'

export const dynamic = 'force-dynamic'

export default function PipelineReportingDevelopmentPage() {
  const localFixtureRuntime = process.env.RUNTIME_LANE === 'dev'
    && process.env.APP_AUTH_REQUIRED === '0'
    && !process.env.RAILWAY_PROJECT_ID
    && !process.env.VERCEL
    && process.env.LOCAL_UI_FIXTURES === '1'
  if (!localFixtureRuntime) notFound()

  return (
    <main style={{ minHeight: '100vh', padding: '24px', background: '#101016' }}>
      <PipelineReportingDevelopmentFixture />
    </main>
  )
}
