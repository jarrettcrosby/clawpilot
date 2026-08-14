'use client'

import { useEffect, useState } from 'react'
import Button from '@mui/material/Button'

import OneOffShipmentDialog, {
  type OneOffShipmentDevelopmentFixture,
} from '@/components/operations/OneOffShipmentDialog'

const warehouseGlobalId = 'gwh9004001'
const inventoryPoolGlobalId = 'gip9004001'
const fixtureUpdatedAt = '2026-08-12T16:00:00.000Z'

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
        canActivate={false}
        developmentFixture={developmentFixture}
      />
    </>
  )
}
