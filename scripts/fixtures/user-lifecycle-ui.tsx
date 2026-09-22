import { createRoot } from 'react-dom/client'
import { createTheme, ThemeProvider } from '@mui/material/styles'
import CssBaseline from '@mui/material/CssBaseline'
import { AppRouterContext } from 'next/dist/shared/lib/app-router-context.shared-runtime'
import LoginEmailPanel from '../../app_src/components/settings/LoginEmailPanel'
import UserAccessDialog from '../../app_src/components/settings/UserAccessDialog'

const router = { replace: (url: string) => { document.body.dataset.navigation = url }, refresh() {}, push() {}, back() {}, forward() {}, prefetch: async () => {} }
createRoot(document.getElementById('root')!).render(
  <AppRouterContext.Provider value={router}>
    <ThemeProvider theme={createTheme({ palette: { mode: 'dark' } })}>
      <CssBaseline />
      {new URLSearchParams(location.search).get('people') ? <UserAccessDialog open initialTab={1} onClose={() => {}} /> : <LoginEmailPanel identityEmail="owner@example.test" />}
    </ThemeProvider>
  </AppRouterContext.Provider>,
)
