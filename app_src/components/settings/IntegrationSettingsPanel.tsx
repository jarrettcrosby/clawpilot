'use client'

import { useState } from 'react'
import Box from '@mui/material/Box'
import Tab from '@mui/material/Tab'
import Tabs from '@mui/material/Tabs'
import CloudRounded from '@mui/icons-material/CloudRounded'
import HubRounded from '@mui/icons-material/HubRounded'
import ManageSearchRounded from '@mui/icons-material/ManageSearchRounded'
import EmbeddingSettingsPanel from './EmbeddingSettingsPanel'
import GoogleWorkspaceIntegrationPanel from './GoogleWorkspaceIntegrationPanel'
import MatonIntegrationPanel from './MatonIntegrationPanel'

export default function IntegrationSettingsPanel({ isOwner }: { isOwner: boolean }) {
  const [activeIntegration, setActiveIntegration] = useState(0)

  if (!isOwner) {
    return (
      <Box role="tabpanel" id="settings-panel-3" aria-labelledby="settings-tab-3">
        <MatonIntegrationPanel isOwner={false} embedded />
      </Box>
    )
  }

  return (
    <Box
      role="tabpanel"
      id="settings-panel-3"
      aria-labelledby="settings-tab-3"
    >
      <Tabs
        value={activeIntegration}
        onChange={(_, value: number) => setActiveIntegration(value)}
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
        <Tab
          icon={<CloudRounded sx={{ fontSize: 18 }} />}
          iconPosition="start"
          label="Google Workspace"
          id="integration-tab-0"
          aria-controls="integration-panel-0"
        />
        <Tab
          icon={<HubRounded sx={{ fontSize: 18 }} />}
          iconPosition="start"
          label="Maton"
          id="integration-tab-1"
          aria-controls="integration-panel-1"
        />
        <Tab
          icon={<ManageSearchRounded sx={{ fontSize: 18 }} />}
          iconPosition="start"
          label="Knowledge"
          id="integration-tab-2"
          aria-controls="integration-panel-2"
        />
      </Tabs>

      {activeIntegration === 0 ? (
        <Box role="tabpanel" id="integration-panel-0" aria-labelledby="integration-tab-0">
          <GoogleWorkspaceIntegrationPanel />
        </Box>
      ) : null}
      {activeIntegration === 1 ? (
        <Box role="tabpanel" id="integration-panel-1" aria-labelledby="integration-tab-1">
          <MatonIntegrationPanel isOwner embedded />
        </Box>
      ) : null}
      {activeIntegration === 2 ? (
        <Box role="tabpanel" id="integration-panel-2" aria-labelledby="integration-tab-2">
          <EmbeddingSettingsPanel />
        </Box>
      ) : null}
    </Box>
  )
}
