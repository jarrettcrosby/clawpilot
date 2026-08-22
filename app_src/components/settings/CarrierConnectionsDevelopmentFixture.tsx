'use client'

import { useState } from 'react'

import CarrierConnectionsPanel from './CarrierConnectionsPanel'

export default function CarrierConnectionsDevelopmentFixture() {
  const [lastNavigation, setLastNavigation] = useState('')

  function navigate(hash: string) {
    window.location.hash = hash
    setLastNavigation(hash)
  }

  return (
    <>
      <CarrierConnectionsPanel onNavigate={navigate} />
      <div
        data-testid="carrier-connections-printing-handoff"
        role="status"
        style={{
          position: 'fixed',
          top: 12,
          right: 12,
          zIndex: 1400,
          padding: '6px 10px',
          borderRadius: 999,
          color: lastNavigation ? '#b7f7c3' : '#d7d7df',
          background: lastNavigation ? '#17351f' : '#282832',
          font: '600 12px/1.2 system-ui, sans-serif',
        }}
      >
        {lastNavigation
          ? `Local fixture handoff: ${lastNavigation}`
          : 'Local fixture handoff: waiting'}
      </div>
    </>
  )
}
