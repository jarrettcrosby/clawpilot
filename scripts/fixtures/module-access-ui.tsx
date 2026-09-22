import { createRoot } from 'react-dom/client'
import { createTheme, ThemeProvider } from '@mui/material/styles'
import CssBaseline from '@mui/material/CssBaseline'
import HomeClient from '../../app_src/app/HomeClient'
import DashboardSection from '../../app_src/components/dashboard/DashboardSection'
import { APP_MODULE_IDS, validatedModuleCapabilities } from '../../app_src/lib/moduleAccess'

const parameters = new URLSearchParams(location.search)
const allowed = (parameters.get('allow') || '').split(',')
const capabilities = validatedModuleCapabilities(Object.fromEntries(APP_MODULE_IDS.map((id) => [id, allowed.includes(id)])))
createRoot(document.getElementById('root')!).render(
  <ThemeProvider theme={createTheme({ palette: { mode: 'dark' } })}>
    <CssBaseline />
    {parameters.has('dashboard')
      ? <DashboardSection moduleCapabilities={capabilities} onNavigate={() => {}} />
      : <HomeClient shortLinksEnabled sessionGuardEnabled />}
  </ThemeProvider>,
)
