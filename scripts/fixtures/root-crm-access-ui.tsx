import { createRoot } from 'react-dom/client'
import { useState } from 'react'
import { createTheme, ThemeProvider } from '@mui/material/styles'
import CssBaseline from '@mui/material/CssBaseline'
import RootCrmAccessPanel from '../../app_src/components/settings/RootCrmAccessPanel'

function Fixture(){
 const [busy,setBusy]=useState(false)
 const params=new URLSearchParams(location.search)
 return <ThemeProvider theme={createTheme({palette:{mode:params.get('mode')==='light'?'light':'dark'}})}>
  <CssBaseline/>
  <main style={{maxWidth:900,margin:'0 auto',padding:12}} data-busy={busy}>
   <RootCrmAccessPanel workspaceId={params.get('workspace')||'00000000-0000-4000-8000-000000000001'}
    disabled={busy} onBusyChange={setBusy}/>
  </main>
 </ThemeProvider>
}
createRoot(document.getElementById('root')!).render(<Fixture/>)
