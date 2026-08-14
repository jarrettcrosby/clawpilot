'use client'

import { useEffect, useState } from 'react'

import CommerceOrderRevisionManagerPanel, {
  type CommerceOrderRevisionManagerFixture,
} from '@/components/operations/CommerceOrderRevisionManagerPanel'

const capturedAt = '2026-08-12T16:00:00.000Z'

function fixture(input: {
  orderGlobalId: string
  provider: 'shopify' | 'faire'
  orderRowVersion: number
  orderStatus: string
  readSuffix: string
  materialState: 'current' | 'review_required' | 'provider_cancelled' | 'provider_fulfilled'
  changed: boolean
  applyEligible: boolean
  applyBlockedCode: string | null
  cancellationEligible?: boolean
  exceptionGlobalId?: string | null
}): CommerceOrderRevisionManagerFixture {
  return {
    eligible: true,
    provider: input.provider,
    orderGlobalId: input.orderGlobalId,
    orderRowVersion: input.orderRowVersion,
    orderStatus: input.orderStatus,
    state: {
      observationGlobalId: `gcor${input.readSuffix}`,
      readGlobalId: `gcrr${input.readSuffix}`,
      sourceHash: input.readSuffix.repeat(10).slice(0, 64),
      revisionHash: input.readSuffix.split('').reverse().join('').repeat(10).slice(0, 64),
      materialState: input.materialState,
      capturedAt,
      fresh: true,
      changed: input.changed,
      applyEligible: input.applyEligible,
      applyBlockedCode: input.applyBlockedCode,
      cancellationEligible: input.cancellationEligible === true,
      providerReads: 2,
      providerWrites: 0,
      applicationGlobalId: null,
      exceptionGlobalId: input.exceptionGlobalId ?? null,
    },
  }
}

const scenarios = [
  {
    title: 'Shopify matches',
    value: fixture({
      orderGlobalId: 'gor9000001',
      provider: 'shopify',
      orderRowVersion: 4,
      orderStatus: 'imported',
      readSuffix: '9000001',
      materialState: 'current',
      changed: false,
      applyEligible: false,
      applyBlockedCode: 'COMMERCE_ORDER_REVISION_NOT_APPLICABLE',
    }),
  },
  {
    title: 'Shopify update available',
    value: fixture({
      orderGlobalId: 'gor9000002',
      provider: 'shopify',
      orderRowVersion: 7,
      orderStatus: 'imported',
      readSuffix: '9000002',
      materialState: 'review_required',
      changed: true,
      applyEligible: true,
      applyBlockedCode: null,
      exceptionGlobalId: 'gex9000002',
    }),
  },
  {
    title: 'Started Shopify order',
    value: fixture({
      orderGlobalId: 'gor9000003',
      provider: 'shopify',
      orderRowVersion: 11,
      orderStatus: 'released',
      readSuffix: '9000003',
      materialState: 'review_required',
      changed: true,
      applyEligible: false,
      applyBlockedCode: 'COMMERCE_ORDER_REVISION_ORDER_STARTED',
      exceptionGlobalId: 'gex9000003',
    }),
  },
  {
    title: 'Faire update blocked',
    value: fixture({
      orderGlobalId: 'gor9000004',
      provider: 'faire',
      orderRowVersion: 3,
      orderStatus: 'imported',
      readSuffix: '9000004',
      materialState: 'review_required',
      changed: true,
      applyEligible: false,
      applyBlockedCode: 'FAIRE_ORDER_REVISION_LINE_QUANTITY_INCOMPLETE',
      exceptionGlobalId: 'gex9000004',
    }),
  },
  {
    title: 'Shopify cancellation',
    value: fixture({
      orderGlobalId: 'gor9000005',
      provider: 'shopify',
      orderRowVersion: 5,
      orderStatus: 'imported',
      readSuffix: '9000005',
      materialState: 'provider_cancelled',
      changed: true,
      applyEligible: false,
      applyBlockedCode: 'COMMERCE_ORDER_REVISION_NOT_APPLICABLE',
      cancellationEligible: true,
      exceptionGlobalId: 'gex9000005',
    }),
  },
  {
    title: 'Started cancellation',
    value: fixture({
      orderGlobalId: 'gor9000006',
      provider: 'shopify',
      orderRowVersion: 12,
      orderStatus: 'planned',
      readSuffix: '9000006',
      materialState: 'provider_cancelled',
      changed: true,
      applyEligible: false,
      applyBlockedCode: 'COMMERCE_ORDER_REVISION_ORDER_STARTED',
      exceptionGlobalId: 'gex9000006',
    }),
  },
  {
    title: 'Shopify fulfilled',
    value: fixture({
      orderGlobalId: 'gor9000007',
      provider: 'shopify',
      orderRowVersion: 8,
      orderStatus: 'released',
      readSuffix: '9000007',
      materialState: 'provider_fulfilled',
      changed: true,
      applyEligible: false,
      applyBlockedCode: 'COMMERCE_ORDER_REVISION_NOT_APPLICABLE',
      exceptionGlobalId: 'gex9000007',
    }),
  },
] as const

export default function CommerceOrderRevisionDevelopmentFixture() {
  const [unexpectedFetchCount, setUnexpectedFetchCount] = useState(0)
  const [reviewedExceptionGlobalId, setReviewedExceptionGlobalId] = useState('')

  useEffect(() => {
    const originalFetch = window.fetch
    window.fetch = async (...argumentsList) => {
      setUnexpectedFetchCount((count) => count + 1)
      throw new Error(`Development fixture blocked an unexpected request to ${String(argumentsList[0])}`)
    }
    return () => {
      window.fetch = originalFetch
    }
  }, [])

  return (
    <>
      <p
        role="status"
        style={{ color: unexpectedFetchCount === 0 ? '#81c784' : '#ef9a9a' }}
      >
        Network requests: {unexpectedFetchCount}
      </p>
      <p role="status">
        Recovery selection: {reviewedExceptionGlobalId || 'none'}
      </p>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 460px), 1fr))', gap: '16px' }}>
        {scenarios.map((scenario) => (
        <section
          key={scenario.value.orderGlobalId}
          style={{
            minWidth: 0,
            padding: '20px',
            border: '1px solid rgba(255,255,255,0.14)',
            borderRadius: '10px',
            background: '#17171f',
          }}
        >
          <h2 style={{ margin: 0, fontSize: '1.05rem' }}>{scenario.title}</h2>
          <div style={{ marginTop: '14px' }}>
            <CommerceOrderRevisionManagerPanel
              orderGlobalId={scenario.value.orderGlobalId}
              provider={scenario.value.provider}
              orderRowVersion={scenario.value.orderRowVersion}
              orderStatus={scenario.value.orderStatus}
              canManage
              canExecute
              developmentFixture={scenario.value}
              onOrderChanged={() => undefined}
              onReviewRecovery={setReviewedExceptionGlobalId}
            />
          </div>
        </section>
        ))}
      </div>
    </>
  )
}
