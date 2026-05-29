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
            backgroundColor: '#1A1A23',
            borderRadius: 2,
            fontSize: 14,
            minHeight: 40,
            '& fieldset': { borderColor: 'rgba(255,255,255,0.08)' },
            '&:hover fieldset': { borderColor: 'rgba(255,255,255,0.18)' },
            '&.Mui-focused fieldset': { borderColor: '#A8C7FA' },
          },
          '& input': { color: '#E4E1EC', py: 1 },
        }}
      />
      <Tooltip title={archiveMode ? 'Back to board' : 'View archived cards'}>
        <IconButton
          onClick={onToggleArchive}
          sx={{
            width: 40, height: 40,
            backgroundColor: archiveMode ? 'rgba(168,199,250,0.15)' : '#1A1A23',
            border: '1px solid',
            borderColor: archiveMode ? '#A8C7FA' : 'rgba(255,255,255,0.08)',
            borderRadius: 2,
            color: archiveMode ? '#A8C7FA' : 'text.disabled',
            '&:hover': { backgroundColor: 'rgba(168,199,250,0.1)' },
          }}
        >
          {archiveMode ? <VisibilityRounded sx={{ fontSize: 18 }} /> : <VisibilityOffRounded sx={{ fontSize: 18 }} />}
        </IconButton>
      </Tooltip>
    </Box>
  )
}
