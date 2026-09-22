'use client'

import Box from '@mui/material/Box'
import TextField from '@mui/material/TextField'
import InputAdornment from '@mui/material/InputAdornment'
import IconButton from '@mui/material/IconButton'
import Tooltip from '@mui/material/Tooltip'
import SearchRounded from '@mui/icons-material/SearchRounded'
import VisibilityRounded from '@mui/icons-material/VisibilityRounded'
import VisibilityOffRounded from '@mui/icons-material/VisibilityOffRounded'

type Props = {
  query: string
  onSearch: (q: string) => void
  archiveMode: boolean
  onToggleArchive: () => void
}

export default function SearchBar({ query, onSearch, archiveMode, onToggleArchive }: Props) {
  return (
    <Box sx={{ display: 'flex', gap: 1, alignItems: 'center' }}>
      <TextField
        size="small"
        placeholder="Search cards..."
        value={query}
        onChange={e => onSearch(e.target.value)}
        InputProps={{
          startAdornment: (
            <InputAdornment position="start">
              <SearchRounded sx={{ fontSize: 18, color: 'text.disabled' }} />
            </InputAdornment>
          ),
        }}
        sx={{
          flex: 1,
          '& .MuiOutlinedInput-root': {
            backgroundColor: 'var(--mui-palette-background-paper)',
            borderRadius: 2,
            fontSize: 14,
            minHeight: 40,
            '& fieldset': { borderColor: 'rgba(var(--cp-neutral-rgb),0.08)' },
            '&:hover fieldset': { borderColor: 'rgba(var(--cp-neutral-rgb),0.18)' },
            '&.Mui-focused fieldset': { borderColor: 'var(--mui-palette-primary-main)' },
          },
          '& input': { color: 'var(--mui-palette-text-primary)', py: 1 },
        }}
      />
      <Tooltip title={archiveMode ? 'Back to board' : 'View archived cards'}>
        <IconButton
          aria-label={archiveMode ? 'Back to board' : 'View archived cards'}
          onClick={onToggleArchive}
          sx={{
            width: 40, height: 40,
            backgroundColor: archiveMode ? 'rgba(var(--mui-palette-primary-mainChannel) / 0.15)' : 'var(--mui-palette-background-paper)',
            border: '1px solid',
            borderColor: archiveMode ? 'var(--mui-palette-primary-main)' : 'rgba(var(--cp-neutral-rgb),0.08)',
            borderRadius: 2,
            color: archiveMode ? 'var(--mui-palette-primary-main)' : 'text.disabled',
            '&:hover': { backgroundColor: 'rgba(var(--mui-palette-primary-mainChannel) / 0.1)' },
          }}
        >
          {archiveMode ? <VisibilityRounded sx={{ fontSize: 18 }} /> : <VisibilityOffRounded sx={{ fontSize: 18 }} />}
        </IconButton>
      </Tooltip>
    </Box>
  )
}
