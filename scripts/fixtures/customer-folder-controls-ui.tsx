import { createRoot } from 'react-dom/client'
import { createTheme, ThemeProvider } from '@mui/material/styles'
import CssBaseline from '@mui/material/CssBaseline'
import Stack from '@mui/material/Stack'
import CustomerFolderAutomation from '../../app_src/components/projects/CustomerFolderAutomation'
import CustomerFolderLinksEditor from '../../app_src/components/projects/CustomerFolderLinksEditor'

const parameters=new URLSearchParams(location.search)
createRoot(document.getElementById('root')!).render(
  <ThemeProvider theme={createTheme({palette:{mode:parameters.has('light')?'light':'dark'}})}>
    <CssBaseline/>
    <Stack spacing={2} sx={{p:2}}>
      <CustomerFolderLinksEditor description="Private customer notes" descriptionHash={'1'.repeat(64)}
        readOnly={parameters.has('viewer')} onSave={async()=>true}/>
      <CustomerFolderAutomation pipelineId="00000000-0000-4000-8000-000000000001"
        accountId="00000000-0000-4000-8000-000000000002" readOnly={parameters.has('viewer')}/>
    </Stack>
  </ThemeProvider>,
)
