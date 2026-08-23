'use client'

import { useEffect, useState } from 'react'
import Button from '@mui/material/Button'

import OneOffShipmentDialog, {
  type OneOffShipmentDevelopmentFixture,
} from '@/components/operations/OneOffShipmentDialog'
import type {
  OneOffCarrierProvider,
  OneOffShipmentCreateResult,
  OneOffShipmentQuote,
  OneOffShipmentQuoteInput,
} from '@/lib/operations/oneOffShipments'

const warehouseGlobalId = 'gwh9004001'
const inventoryPoolGlobalId = 'gip9004001'
const fixtureUpdatedAt = '2026-08-12T16:00:00.000Z'
const fixtureQuoteGlobalId = 'goq9004001'

const fixtureCarrierFacts: Record<OneOffCarrierProvider, {
  providerLabel: 'UPS' | 'FedEx' | 'Worldwide Express'
  serviceCode: string
  serviceName: string
  providerPackageCode: string
  amountMinor: number
  transitDays: number
}> = {
  ups_rest: {
    providerLabel: 'UPS',
    serviceCode: '03',
    serviceName: 'UPS Ground',
    providerPackageCode: '02',
    amountMinor: 1295,
    transitDays: 3,
  },
  fedex_rest: {
    providerLabel: 'FedEx',
    serviceCode: 'FEDEX_GROUND',
    serviceName: 'FedEx Ground',
    providerPackageCode: 'YOUR_PACKAGING',
    amountMinor: 1385,
    transitDays: 4,
  },
  wwex_speedship: {
    providerLabel: 'Worldwide Express',
    serviceCode: 'GROUND',
    serviceName: 'Worldwide Express Ground',
    providerPackageCode: 'CUSTOM',
    amountMinor: 1495,
    transitDays: 5,
  },
}

function localFixtureQuote(input: OneOffShipmentQuoteInput): OneOffShipmentQuote {
  const environment = input.executionMode === 'live' ? 'production' : 'sandbox'
  const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString()
  const requiredCarrierSelections = input.selectedCarriers.map((selection, index) => ({
    ...selection,
    selectionKey: `local-fixture-selection-${index + 1}`,
    credentialVersion: 1,
    packageCodes: input.packages.map((shipmentPackage) => ({
      packageKey: shipmentPackage.packageKey,
      catalogEntryId: shipmentPackage.packageProfile.catalogEntryId,
      catalogVersion: shipmentPackage.packageProfile.contractVersion,
      providerPackageCode: fixtureCarrierFacts[selection.provider].providerPackageCode,
    })),
  }))
  return {
    globalId: fixtureQuoteGlobalId,
    referenceNumber: input.referenceNumber,
    status: 'succeeded',
    environment,
    executionMode: input.executionMode,
    requiredCarrierProviders: [...new Set(input.selectedCarriers.map(({ provider }) => provider))],
    requiredCarrierSelections,
    carrierSelectionResults: Object.fromEntries(requiredCarrierSelections.map((selection) => [
      selection.selectionKey,
      { status: 'succeeded', eligibleOfferCount: 1, errorCode: null },
    ])),
    expiresAt,
    offers: requiredCarrierSelections.map((selection, index) => {
      const facts = fixtureCarrierFacts[selection.provider]
      return {
        globalId: `gof900400${index + 1}`,
        provider: selection.provider,
        providerLabel: facts.providerLabel,
        executionCapability: selection.provider === 'wwex_speedship'
          ? 'rate_only'
          : 'direct_purchase_later',
        environment,
        serviceCode: facts.serviceCode,
        serviceName: facts.serviceName,
        amountMinor: facts.amountMinor,
        currency: input.currency,
        transitDays: facts.transitDays,
        estimatedDeliveryAt: null,
        rateEvidenceGlobalId: `gre900400${index + 1}`,
        integrationAccountGlobalId: selection.integrationAccountGlobalId,
        carrierAccountGlobalId: selection.carrierAccountGlobalId,
        credentialVersion: selection.credentialVersion,
      }
    }),
    effects: {
      carrierRateReads: 0,
      inventoryWrites: 0,
      shipmentWrites: 0,
      labelCalls: 0,
      postagePurchases: 0,
    },
  }
}

function localFixtureCreateResult(selectedOfferGlobalId: string): OneOffShipmentCreateResult {
  return {
    orderGlobalId: 'gor9004001',
    orderStatus: 'planned',
    rowVersion: 1,
    fulfillmentPlanGlobalId: 'gfp9004001',
    quoteGlobalId: fixtureQuoteGlobalId,
    selectedOfferGlobalId,
    createdProductGlobalIds: [],
    adHocItemGlobalIds: ['gai9004001'],
    receiptGlobalId: null,
    packageCount: 1,
    replayed: false,
  }
}

function localFixtureJson(payload: object, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function localFixtureRequestUrl(input: RequestInfo | URL) {
  if (typeof input === 'string') return input
  if (input instanceof URL) return input.toString()
  return input.url
}

function localFixtureRequestMethod(input: RequestInfo | URL, init?: RequestInit) {
  return (init?.method || (input instanceof Request ? input.method : 'GET')).toUpperCase()
}

function localFixtureRequestBody(init?: RequestInit) {
  if (typeof init?.body !== 'string') return null
  try {
    return JSON.parse(init.body) as Record<string, unknown>
  } catch {
    return null
  }
}

const developmentFixture: OneOffShipmentDevelopmentFixture = {
  initialStep: 1,
  workspace: {
    environment: 'sandbox',
    executionModes: [
      {
        mode: 'test',
        environment: 'sandbox',
        enabled: true,
        blockers: [],
      },
      {
        mode: 'live',
        environment: 'production',
        enabled: false,
        blockers: ['Local fixture has no production carrier accounts.'],
      },
    ],
    customers: [{ globalId: 'gcu9004001', name: 'AG Alchemy Test Customer' }],
    warehouses: [{
      globalId: warehouseGlobalId,
      name: 'AG Alchemy Mock Warehouse',
      address: {
        name: 'AG Alchemy',
        line1: '100 Mock Warehouse Way',
        line2: null,
        city: 'Charlotte',
        region: 'NC',
        postalCode: '28202',
        country: 'US',
      },
      inventoryPools: [{ globalId: inventoryPoolGlobalId, name: 'Available inventory' }],
      receivingLocations: [{ globalId: 'grl9004001', code: 'A-01-01' }],
    }],
    products: [{
      globalId: 'gpr9004001',
      name: 'AG Alchemy Mock Product',
      sku: 'AG-MOCK-001',
      unitPriceMinor: 2499,
      defaultPackage: {
        rowVersion: 1,
        unitsPerPackage: 1,
        dimensionsMm: { length: 250, width: 180, height: 100 },
        weightGrams: 900,
      },
      availability: [{
        warehouseGlobalId,
        inventoryPoolGlobalId,
        availableQuantity: 24,
      }],
    }],
    carriers: [
      {
        provider: 'ups_rest',
        providerLabel: 'UPS',
        environment: 'sandbox',
        integrationAccountGlobalId: 'gica9004001',
        carrierAccountGlobalId: 'gcca9004001',
        displayName: 'AG Alchemy UPS Sandbox',
        senderOriginWarehouseGlobalId: null,
      },
      {
        provider: 'fedex_rest',
        providerLabel: 'FedEx',
        environment: 'sandbox',
        integrationAccountGlobalId: 'gica9004002',
        carrierAccountGlobalId: 'gcca9004002',
        displayName: 'AG Alchemy FedEx Sandbox',
        senderOriginWarehouseGlobalId: null,
      },
      {
        provider: 'wwex_speedship',
        providerLabel: 'Worldwide Express',
        environment: 'sandbox',
        integrationAccountGlobalId: 'gica9004003',
        carrierAccountGlobalId: null,
        displayName: 'AG Alchemy Worldwide Express Sandbox',
        senderOriginWarehouseGlobalId: null,
      },
    ],
  },
  packagingMaterials: [
    {
      id: 'fixture-material-1',
      globalId: 'gmat9004001',
      code: 'AG-MEDIUM-CARTON',
      name: 'AG medium carton',
      materialType: 'carton',
      innerDimensionsMm: { length: 300, width: 220, height: 160 },
      ratedOuterDimensionsMm: { length: 310, width: 230, height: 170 },
      ratedOuterDimensionEvidenceType: 'measured',
      ratedOuterDimensionEvidenceReference: 'Mock warehouse measurement',
      ratedOuterDimensionConfirmedAt: fixtureUpdatedAt,
      ratedOuterDimensionConfirmedBy: 'local-fixture',
      dimensionBasis: 'inner',
      dimensionEvidenceType: 'measured',
      dimensionEvidenceReference: 'Mock warehouse measurement',
      dimensionConfirmedAt: fixtureUpdatedAt,
      dimensionConfirmedBy: 'local-fixture',
      tareWeightGrams: 180,
      maxWeightGrams: 12000,
      unitCostMinor: 65,
      currency: 'USD',
      status: 'active',
      source: 'customer_supplied',
      rowVersion: 1,
      updatedAt: fixtureUpdatedAt,
      stock: [{
        id: 'fixture-stock-1',
        globalId: 'gmst9004001',
        warehouseId: 'fixture-warehouse-1',
        warehouseGlobalId,
        warehouseName: 'AG Alchemy Mock Warehouse',
        warehouseStatus: 'active',
        isAvailable: true,
        onHandQuantity: 50,
        reorderPointQuantity: 10,
        reorderToQuantity: 50,
        reorderRecommendedQuantity: 0,
        rowVersion: 1,
        updatedAt: fixtureUpdatedAt,
      }],
      readiness: { eligibleForCartonization: true, missing: [] },
    },
    {
      id: 'fixture-material-2',
      globalId: 'gmat9004002',
      code: 'AG-PADDED-MAILER',
      name: 'AG padded mailer',
      materialType: 'padded_mailer',
      innerDimensionsMm: { length: 300, width: 220, height: 35 },
      ratedOuterDimensionsMm: { length: 315, width: 235, height: 40 },
      ratedOuterDimensionEvidenceType: 'measured',
      ratedOuterDimensionEvidenceReference: 'Mock warehouse measurement',
      ratedOuterDimensionConfirmedAt: fixtureUpdatedAt,
      ratedOuterDimensionConfirmedBy: 'local-fixture',
      dimensionBasis: 'inner',
      dimensionEvidenceType: 'measured',
      dimensionEvidenceReference: 'Mock warehouse measurement',
      dimensionConfirmedAt: fixtureUpdatedAt,
      dimensionConfirmedBy: 'local-fixture',
      tareWeightGrams: 35,
      maxWeightGrams: 2000,
      unitCostMinor: 28,
      currency: 'USD',
      status: 'active',
      source: 'customer_supplied',
      rowVersion: 1,
      updatedAt: fixtureUpdatedAt,
      stock: [{
        id: 'fixture-stock-2',
        globalId: 'gmst9004002',
        warehouseId: 'fixture-warehouse-1',
        warehouseGlobalId,
        warehouseName: 'AG Alchemy Mock Warehouse',
        warehouseStatus: 'active',
        isAvailable: true,
        onHandQuantity: 80,
        reorderPointQuantity: 15,
        reorderToQuantity: 80,
        reorderRecommendedQuantity: 0,
        rowVersion: 1,
        updatedAt: fixtureUpdatedAt,
      }],
      readiness: { eligibleForCartonization: true, missing: [] },
    },
  ],
}

export default function ShippingWorkflowDevelopmentFixture() {
  const [open, setOpen] = useState(true)
  const [unexpectedFetchCount, setUnexpectedFetchCount] = useState(0)

  useEffect(() => {
    const originalFetch = window.fetch
    window.fetch = async (...argumentsList) => {
      const [input, init] = argumentsList
      const url = new URL(localFixtureRequestUrl(input), window.location.origin)
      const body = localFixtureRequestBody(init)
      if (
        url.origin === window.location.origin
        && url.pathname === '/api/operations/one-off-shipments'
        && !url.search
        && localFixtureRequestMethod(input, init) === 'POST'
        && body?.action === 'quote'
        && body.quote
        && typeof body.quote === 'object'
      ) {
        return localFixtureJson({
          ok: true,
          quote: localFixtureQuote(body.quote as OneOffShipmentQuoteInput),
        })
      }
      if (
        url.origin === window.location.origin
        && url.pathname === '/api/operations/one-off-shipments'
        && !url.search
        && localFixtureRequestMethod(input, init) === 'POST'
        && body?.action === 'create-and-plan'
        && body.quoteGlobalId === fixtureQuoteGlobalId
        && typeof body.selectedOfferGlobalId === 'string'
      ) {
        return localFixtureJson({
          ok: true,
          result: localFixtureCreateResult(body.selectedOfferGlobalId),
        })
      }
      setUnexpectedFetchCount((count) => count + 1)
      throw new Error(`Local Shipping fixture blocked an unexpected request to ${String(argumentsList[0])}`)
    }
    return () => {
      window.fetch = originalFetch
    }
  }, [])

  return (
    <>
      <div
        role="status"
        style={{
          position: 'fixed',
          top: 12,
          right: 12,
          zIndex: 1400,
          padding: '6px 10px',
          borderRadius: 999,
          color: unexpectedFetchCount === 0 ? '#b7f7c3' : '#ffcdd2',
          background: unexpectedFetchCount === 0 ? '#17351f' : '#4a1818',
          font: '600 12px/1.2 system-ui, sans-serif',
        }}
      >
        Local fixture · Network requests: {unexpectedFetchCount}
      </div>
      {!open && (
        <Button variant="contained" onClick={() => setOpen(true)}>
          Open Shipping workflow
        </Button>
      )}
      <OneOffShipmentDialog
        open={open}
        onClose={() => setOpen(false)}
        onCreated={() => undefined}
        developmentFixture={developmentFixture}
      />
    </>
  )
}
