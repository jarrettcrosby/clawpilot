import { createRoot } from 'react-dom/client'
import { createTheme, ThemeProvider } from '@mui/material/styles'
import CssBaseline from '@mui/material/CssBaseline'
import OrganizationWebPreferencesPanel from '../../app_src/components/settings/OrganizationWebPreferencesPanel'

createRoot(document.getElementById('root')!).render(
  <ThemeProvider theme={createTheme({ palette: { mode: 'dark' } })}>
    <CssBaseline />
    <OrganizationWebPreferencesPanel />
  </ThemeProvider>,
)
