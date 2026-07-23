'use client'

import { useState } from 'react'
import Box from '@mui/material/Box'
import Tab from '@mui/material/Tab'
import Tabs from '@mui/material/Tabs'
import CloudRounded from '@mui/icons-material/CloudRounded'
import AccountBalanceRounded from '@mui/icons-material/AccountBalanceRounded'
import HubRounded from '@mui/icons-material/HubRounded'
import LocalShippingRounded from '@mui/icons-material/LocalShippingRounded'
import ManageSearchRounded from '@mui/icons-material/ManageSearchRounded'
import RestaurantRounded from '@mui/icons-material/RestaurantRounded'
import CarrierIntegrationPanel from './CarrierIntegrationPanel'
import EmbeddingSettingsPanel from './EmbeddingSettingsPanel'
import GoogleWorkspaceIntegrationPanel from './GoogleWorkspaceIntegrationPanel'
import MatonIntegrationPanel from './MatonIntegrationPanel'
import QuickBooksIntegrationPanel from './QuickBooksIntegrationPanel'
import ToastIntegrationPanel from './ToastIntegrationPanel'

type IntegrationKey = 'google' | 'maton' | 'quickbooks' | 'toast' | 'shipping' | 'knowledge'

export default function IntegrationSettingsPanel({
  isOwner,
  canManageOrganizationIntegrations,
  canManageOperationsIntegrations,
}: {
  isOwner: boolean
  canManageOrganizationIntegrations: boolean
  canManageOperationsIntegrations: boolean
}) {
  const [activeIntegration, setActiveIntegration] = useState<IntegrationKey>(
    isOwner || canManageOrganizationIntegrations ? (isOwner ? 'google' : 'maton') : 'shipping',
  )

  if (!canManageOrganizationIntegrations && !canManageOperationsIntegrations) {
    return (
      <Box role="tabpanel" id="settings-panel-3" aria-labelledby="settings-tab-3">
        <MatonIntegrationPanel isOwner={false} embedded />
      </Box>
    )
  }

  const integrations = isOwner
    ? [
        { key: 'google' as const, label: 'Google Workspace', icon: <CloudRounded sx={{ fontSize: 18 }} /> },
        { key: 'maton' as const, label: 'Maton', icon: <HubRounded sx={{ fontSize: 18 }} /> },
        { key: 'quickbooks' as const, label: 'QuickBooks', icon: <AccountBalanceRounded sx={{ fontSize: 18 }} /> },
        { key: 'toast' as const, label: 'Toast', icon: <RestaurantRounded sx={{ fontSize: 18 }} /> },
        { key: 'shipping' as const, label: 'Shipping', icon: <LocalShippingRounded sx={{ fontSize: 18 }} /> },
        { key: 'knowledge' as const, label: 'Knowledge', icon: <ManageSearchRounded sx={{ fontSize: 18 }} /> },
      ]
    : [
        ...(canManageOrganizationIntegrations ? [
          { key: 'maton' as const, label: 'Maton', icon: <HubRounded sx={{ fontSize: 18 }} /> },
          { key: 'quickbooks' as const, label: 'QuickBooks', icon: <AccountBalanceRounded sx={{ fontSize: 18 }} /> },
          { key: 'toast' as const, label: 'Toast', icon: <RestaurantRounded sx={{ fontSize: 18 }} /> },
        ] : []),
        ...(canManageOperationsIntegrations ? [
          { key: 'shipping' as const, label: 'Shipping', icon: <LocalShippingRounded sx={{ fontSize: 18 }} /> },
        ] : []),
      ]

  return (
    <Box
      role="tabpanel"
      id="settings-panel-3"
      aria-labelledby="settings-tab-3"
    >
      <Tabs
        value={activeIntegration}
        onChange={(_, value: IntegrationKey) => setActiveIntegration(value)}
        variant="scrollable"
        scrollButtons="auto"
        aria-label="Integration settings"
        sx={{
          minHeight: 42,
          mb: 3,
          borderBottom: '1px solid rgba(255,255,255,0.08)',
          '& .MuiTab-root': { minHeight: 42, px: 1.5 },
        }}
      >
        {integrations.map((integration) => (
          <Tab
            key={integration.key}
            value={integration.key}
            icon={integration.icon}
            iconPosition="start"
            label={integration.label}
            id={`integration-tab-${integration.key}`}
            aria-controls={`integration-panel-${integration.key}`}
          />
        ))}
      </Tabs>

      {activeIntegration === 'google' && isOwner ? (
        <Box role="tabpanel" id="integration-panel-google" aria-labelledby="integration-tab-google">
          <GoogleWorkspaceIntegrationPanel />
        </Box>
      ) : null}
      {activeIntegration === 'maton' ? (
        <Box role="tabpanel" id="integration-panel-maton" aria-labelledby="integration-tab-maton">
          <MatonIntegrationPanel isOwner={isOwner} embedded />
        </Box>
      ) : null}
      {activeIntegration === 'toast' ? (
        <Box role="tabpanel" id="integration-panel-toast" aria-labelledby="integration-tab-toast">
          <ToastIntegrationPanel />
        </Box>
      ) : null}
      {activeIntegration === 'quickbooks' ? (
        <Box role="tabpanel" id="integration-panel-quickbooks" aria-labelledby="integration-tab-quickbooks">
          <QuickBooksIntegrationPanel />
        </Box>
      ) : null}
      {activeIntegration === 'shipping' ? (
        <Box role="tabpanel" id="integration-panel-shipping" aria-labelledby="integration-tab-shipping">
          <CarrierIntegrationPanel />
        </Box>
      ) : null}
      {activeIntegration === 'knowledge' && isOwner ? (
        <Box role="tabpanel" id="integration-panel-knowledge" aria-labelledby="integration-tab-knowledge">
          <EmbeddingSettingsPanel />
        </Box>
      ) : null}
    </Box>
  )
}
