'use client'

import { useMemo, useState } from 'react'
import Box from '@mui/material/Box'
import Select from '@mui/material/Select'
import MenuItem from '@mui/material/MenuItem'
import FormControl from '@mui/material/FormControl'
import InputLabel from '@mui/material/InputLabel'
import IconButton from '@mui/material/IconButton'
import Tooltip from '@mui/material/Tooltip'
import Drawer from '@mui/material/Drawer'
import Button from '@mui/material/Button'
import Divider from '@mui/material/Divider'
import Typography from '@mui/material/Typography'
import useMediaQuery from '@mui/material/useMediaQuery'
import CloseRounded from '@mui/icons-material/CloseRounded'
import TuneRounded from '@mui/icons-material/TuneRounded'
import { AVAILABLE_LABELS } from '@/lib/types'

export type BoardFilter = {
  priority: string[]
  status: string[]
  labels: string[]
}

export function emptyFilter(): BoardFilter {
  return { priority: [], status: [], labels: [] }
}

export function isFilterActive(f: BoardFilter) {
  return f.priority.length > 0 || f.status.length > 0 || f.labels.length > 0
}

type Props = {
  filter: BoardFilter
  onChange: (f: BoardFilter) => void
  onClear: () => void
}

const selectSx = {
  fontSize: 13,
  height: 36,
  backgroundColor: '#1A1A23',
  borderRadius: 2,
  color: 'text.primary',
  '& .MuiOutlinedInput-notchedOutline': { borderColor: 'rgba(255,255,255,0.08)' },
  '&:hover .MuiOutlinedInput-notchedOutline': { borderColor: 'rgba(255,255,255,0.2)' },
  '&.Mui-focused .MuiOutlinedInput-notchedOutline': { borderColor: '#A8C7FA' },
  '& .MuiSelect-icon': { color: 'text.disabled', fontSize: 18 },
}

const menuProps = {
  PaperProps: {
    sx: {
      backgroundColor: '#232330',
      border: '1px solid rgba(255,255,255,0.08)',
      borderRadius: 2,
      mt: 0.5,
      '& .MuiMenuItem-root': {
        fontSize: 13,
        py: 1,
        '&:hover': { backgroundColor: 'rgba(255,255,255,0.06)' },
        '&.Mui-selected': { backgroundColor: 'rgba(168,199,250,0.12)', color: '#A8C7FA' },
        '&.Mui-selected:hover': { backgroundColor: 'rgba(168,199,250,0.18)' },
      },
    },
  },
}

const labelSx = {
  fontSize: 12,
  color: 'text.disabled',
  '&.Mui-focused': { color: '#A8C7FA' },
  '&.MuiInputLabel-shrink': { fontSize: 11 },
}

function FilterControls({ filter, onChange, onClear }: Props) {
  const active = isFilterActive(filter)
  const isXs = useMediaQuery('(max-width:600px)')

  const formatSelected = (selected: string[], labels: Record<string, string>) => {
    if (!selected || selected.length === 0) return ''
    const named = selected.map(v => labels[v] || v)
    if (named.length <= 2) return named.join(', ')
    return `${named.slice(0, 2).join(', ')} +${named.length - 2}`
  }

  return (
    <Box sx={{
      display: 'flex', gap: 1, alignItems: 'center', overflowX: isXs ? 'auto' : 'visible', pb: isXs ? 0.5 : 0,
      WebkitOverflowScrolling: 'touch',
      '&::-webkit-scrollbar': { height: 4 },
      '&::-webkit-scrollbar-thumb': { backgroundColor: 'rgba(255,255,255,0.18)', borderRadius: 2 },
      scrollbarWidth: isXs ? 'thin' : 'auto',
    }}>
      {/* Priority */}
      <FormControl size="small" sx={{ flex: { xs: '0 0 auto', sm: '1 1 0' }, minWidth: { xs: 160, sm: 180 } }}>
        <InputLabel sx={labelSx}>Priority</InputLabel>
        <Select
          multiple
          value={filter.priority}
          label="Priority"
          onChange={e => onChange({ ...filter, priority: typeof e.target.value === 'string' ? [e.target.value] : (e.target.value as string[]) })}
          sx={selectSx}
          MenuProps={menuProps}
          renderValue={(selected) => formatSelected((selected as string[]), { high: 'High', medium: 'Medium', low: 'Low' })}
        >
          {[
            { value: 'high', label: 'High', color: '#EF5350' },
            { value: 'medium', label: 'Medium', color: '#FFA726' },
            { value: 'low', label: 'Low', color: '#66BB6A' },
          ].map(p => (
            <MenuItem key={p.value} value={p.value}>
              <Box component="span" sx={{ display: 'inline-block', width: 8, height: 8, borderRadius: '50%', backgroundColor: p.color, mr: 1, flexShrink: 0 }} />
              {p.label}
            </MenuItem>
          ))}
        </Select>
      </FormControl>

      {/* Status */}
      <FormControl size="small" sx={{ flex: { xs: '0 0 auto', sm: '1 1 0' }, minWidth: { xs: 160, sm: 180 } }}>
        <InputLabel sx={labelSx}>Status</InputLabel>
        <Select
          multiple
          value={filter.status}
          label="Status"
          onChange={e => onChange({ ...filter, status: typeof e.target.value === 'string' ? [e.target.value] : (e.target.value as string[]) })}
          sx={selectSx}
          MenuProps={menuProps}
          renderValue={(selected) => {
            const labels: Record<string, string> = { 'in-progress': 'In Progress', todo: 'To Do', review: 'Review', backlog: 'Backlog', done: 'Done', active: 'Active' }
            return formatSelected((selected as string[]), labels)
          }}
        >
          {[
            { value: 'active', label: 'Active (all)', color: '#FFA726' },
            { value: 'in-progress', label: 'In Progress', color: '#A8C7FA' },
            { value: 'todo', label: 'To Do', color: '#CFC6EA' },
            { value: 'review', label: 'Review', color: '#AB47BC' },
            { value: 'backlog', label: 'Backlog', color: '#546E7A' },
            { value: 'done', label: 'Done', color: '#66BB6A' },
          ].map(s => (
            <MenuItem key={s.value} value={s.value}>
              <Box component="span" sx={{ display: 'inline-block', width: 8, height: 8, borderRadius: '50%', backgroundColor: s.color, mr: 1, flexShrink: 0 }} />
              {s.label}
            </MenuItem>
          ))}
        </Select>
      </FormControl>

      {/* Label */}
      <FormControl size="small" sx={{ flex: { xs: '0 0 auto', sm: '1 1 0' }, minWidth: { xs: 160, sm: 180 } }}>
        <InputLabel sx={labelSx}>Label</InputLabel>
        <Select
          multiple
          value={filter.labels}
          label="Label"
          onChange={e => onChange({ ...filter, labels: typeof e.target.value === 'string' ? [e.target.value] : (e.target.value as string[]) })}
          sx={selectSx}
          MenuProps={menuProps}
          renderValue={(selected) => {
            const labels = Object.fromEntries(AVAILABLE_LABELS.map(l => [l.id, l.label]))
            return formatSelected((selected as string[]), labels)
          }}
        >
          {AVAILABLE_LABELS.map(l => (
            <MenuItem key={l.id} value={l.id}>
              <Box component="span" sx={{ display: 'inline-block', width: 8, height: 8, borderRadius: '50%', backgroundColor: l.color, mr: 1, flexShrink: 0 }} />
              {l.label}
            </MenuItem>
          ))}
        </Select>
      </FormControl>

      {active && (
        <Tooltip title="Clear filters (Esc)">
          <IconButton
            onClick={onClear}
            size="small"
            sx={{
              width: 36,
              height: 36,
              flexShrink: 0,
              backgroundColor: '#1A1A23',
              border: '1px solid rgba(255,255,255,0.08)',
              borderRadius: 2,
              color: 'text.disabled',
              '&:hover': { backgroundColor: 'rgba(239,83,80,0.1)', borderColor: '#EF5350', color: '#EF5350' },
            }}
          >
            <CloseRounded sx={{ fontSize: 16 }} />
          </IconButton>
        </Tooltip>
      )}
    </Box>
  )
}

export default function FilterBar({ filter, onChange, onClear }: Props) {
  const smallHeight = useMediaQuery('(max-height: 520px)')
  const [open, setOpen] = useState(false)
  const active = isFilterActive(filter)

  const activeCount = useMemo(() => filter.priority.length + filter.status.length + filter.labels.length, [filter])

  // In landscape (short viewport), collapse filters into a bottom-sheet to preserve vertical space.
  if (smallHeight) {
    return (
      <Box sx={{ mt: 0 }}>
        <Button
          onClick={() => setOpen(true)}
          startIcon={<TuneRounded />}
          variant={active ? 'contained' : 'outlined'}
          sx={{
            borderRadius: 3,
            height: 40,
            px: 2,
            backgroundColor: active ? 'rgba(168,199,250,0.14)' : 'transparent',
            borderColor: 'rgba(255,255,255,0.12)',
            color: active ? '#A8C7FA' : 'text.secondary',
            '&:hover': {
              backgroundColor: active ? 'rgba(168,199,250,0.18)' : 'rgba(255,255,255,0.06)',
              borderColor: 'rgba(255,255,255,0.22)',
            },
          }}
        >
          Filters{activeCount > 0 ? ` · ${activeCount}` : ''}
        </Button>

        <Drawer
          anchor="bottom"
          open={open}
          onClose={() => setOpen(false)}
          PaperProps={{
            sx: {
              backgroundColor: '#12141C',
              borderTopLeftRadius: 20,
              borderTopRightRadius: 20,
              borderTop: '1px solid rgba(255,255,255,0.08)',
              pb: 'env(safe-area-inset-bottom)',
            },
          }}
        >
          <Box sx={{ px: 2, pt: 1.5, pb: 1 }}>
            <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <Typography fontWeight={700} color="text.primary">Filters</Typography>
              <IconButton onClick={() => setOpen(false)} sx={{ color: 'text.secondary' }}>
                <CloseRounded />
              </IconButton>
            </Box>
            <Divider sx={{ borderColor: 'rgba(255,255,255,0.06)', mt: 1.25 }} />
          </Box>

          <Box sx={{ px: 2, pb: 2 }}>
            <FilterControls filter={filter} onChange={onChange} onClear={onClear} />
          </Box>
        </Drawer>
      </Box>
    )
  }

  return (
    <Box sx={{ display: 'flex', gap: 1, alignItems: 'center', mt: 1.5 }}>
      <FilterControls filter={filter} onChange={onChange} onClear={onClear} />
    </Box>
  )
}
