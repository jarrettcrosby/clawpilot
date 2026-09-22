import { createRoot } from 'react-dom/client'
import { useState } from 'react'
import { ThemeProvider } from '@mui/material/styles'
import { Box, CssBaseline, Typography } from '@mui/material'
import theme from '../../app_src/lib/theme'
import AppearancePreference from '../../app_src/components/AppearancePreference'
import Navigation from '../../app_src/components/Navigation'
import LoginPage from '../../app_src/app/login/page'
import KanbanBoard from '../../app_src/components/projects/KanbanBoard'
import AgentsSection from '../../app_src/components/agents/AgentsSection'

function Fixture() {
  const [open, setOpen] = useState(false)
  const screen = new URLSearchParams(location.search).get('screen')
  return <ThemeProvider theme={theme} defaultMode="system" modeStorageKey="clawpilot-color-mode" disableTransitionOnChange>
    <CssBaseline enableColorScheme />
    {screen === 'login' ? <LoginPage /> : <Box sx={{ display: 'flex', minHeight: '100dvh', bgcolor: 'background.default' }}>
      <Navigation activeSection="projects" onNavigate={() => {}} mobileOpen={open} onMobileOpen={() => setOpen(true)} onMobileClose={() => setOpen(false)} allowedModuleIds={['dashboard', 'projects', 'crm', 'operations']} />
      <Box component="main" sx={{ p: 2, minWidth: 0, flex: 1, pb: 12 }}>
        <Typography variant="h1" sx={{ mb: 3 }}>Workspace</Typography>
        <Box sx={{ maxWidth: 320, mb: 3 }}><AppearancePreference /></Box>
        {screen === 'agents' ? <AgentsSection /> : <KanbanBoard />}
      </Box>
    </Box>}
  </ThemeProvider>
}
createRoot(document.getElementById('root')!).render(<Fixture />)
