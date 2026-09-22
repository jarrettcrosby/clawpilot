'use client'

import { MenuItem, TextField } from '@mui/material'
import { useColorScheme } from '@mui/material/styles'

/** Device preference is deliberately local: it is available before sign-in too. */
export default function AppearancePreference() {
  const { mode, setMode } = useColorScheme()
  return (
    <TextField
      select
      fullWidth
      size="small"
      label="Appearance"
      value={mode || 'system'}
      disabled={!mode}
      onChange={(event) => setMode(event.target.value as 'light' | 'dark' | 'system')}
      helperText="Saved automatically for this browser."
    >
      <MenuItem value="system">Use device setting</MenuItem>
      <MenuItem value="light">Light</MenuItem>
      <MenuItem value="dark">Dark</MenuItem>
    </TextField>
  )
}
