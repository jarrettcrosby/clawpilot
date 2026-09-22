import { createRoot } from 'react-dom/client'
import Box from '@mui/material/Box'
import CssBaseline from '@mui/material/CssBaseline'
import { ThemeProvider } from '@mui/material/styles'
import DocViewer from '../../app_src/components/docs/DocViewer'
import MeasurementSystemProvider from '../../app_src/components/measurements/MeasurementSystemProvider'
import PipelineCatalogDialog from '../../app_src/components/pipeline/PipelineCatalogDialog'
import theme from '../../app_src/lib/theme'

const params = new URLSearchParams(location.search)
const requestedMode = params.get('mode')
const mode = requestedMode === 'dark' ? 'dark' : 'light'
const view = params.get('view')

const documentFixture = {
  id: 'theme-surface-test',
  title: 'Readable document',
  date: 'September 22, 2026',
  tags: ['theme'],
  category: 'Operations',
  source: 'repository',
  content: `# Readable document

## Section heading

Body copy remains readable in both appearances. [Documentation link](https://example.com/docs)

- Readable list item

| Column | Value |
| --- | --- |
| Entry | Readable table value |
`,
}

function Fixture() {
  return (
    <ThemeProvider
      theme={theme}
      defaultMode={mode}
      modeStorageKey={`clawpilot-theme-surface-${mode}`}
      disableTransitionOnChange
    >
      <CssBaseline enableColorScheme />
      {view === 'pipeline' ? (
        <MeasurementSystemProvider persistenceEnabled={false}>
          <PipelineCatalogDialog open onClose={() => undefined} />
        </MeasurementSystemProvider>
      ) : (
        <Box sx={{ height: '100dvh' }}>
          <DocViewer doc={documentFixture} />
        </Box>
      )}
    </ThemeProvider>
  )
}

createRoot(document.getElementById('root')!).render(<Fixture />)
