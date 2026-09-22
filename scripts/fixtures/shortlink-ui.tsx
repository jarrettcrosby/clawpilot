import { createRoot } from 'react-dom/client'
import { createTheme, ThemeProvider } from '@mui/material/styles'
import CssBaseline from '@mui/material/CssBaseline'
import ShortLinksSection from '../../app_src/components/links/ShortLinksSection'

createRoot(document.getElementById('root')!).render(
  <ThemeProvider theme={createTheme({ palette: { mode: new URLSearchParams(window.location.search).get('mode') === 'light' ? 'light' : 'dark' } })}>
    <CssBaseline />
    <ShortLinksSection />
  </ThemeProvider>,
)
