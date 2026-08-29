'use client'

import PipelineDashboard from '@/components/pipeline/PipelineDashboard'
import { usePipelineReport } from '@/components/pipeline/usePipelineReport'

export default function PipelineReportingDevelopmentFixture() {
  const reporting = usePipelineReport({
    enabled: true,
    reportRevision: 'pipeline-reporting-fixture',
    syncRevision: 'pipeline-reporting-fixture',
    syncState: 'ok',
  })

  return (
    <PipelineDashboard
      stages={['Identified Lead', 'Qualified Lead', 'Proposal', 'Closed', 'Loss']}
      totalContacts={0}
      lastSyncedLabel="just now"
      reporting={reporting}
      syncState="ok"
    />
  )
}
