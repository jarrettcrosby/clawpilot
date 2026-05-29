'use client'

import { useState } from 'react'
import Box from '@mui/material/Box'
import ListItemButton from '@mui/material/ListItemButton'
import ListItemText from '@mui/material/ListItemText'
import ListItemIcon from '@mui/material/ListItemIcon'
import Typography from '@mui/material/Typography'
import TextField from '@mui/material/TextField'
import InputAdornment from '@mui/material/InputAdornment'
import Collapse from '@mui/material/Collapse'
import SearchRounded from '@mui/icons-material/SearchRounded'
import ExpandLess from '@mui/icons-material/ExpandLess'
import ExpandMore from '@mui/icons-material/ExpandMore'
import ArticleRounded from '@mui/icons-material/ArticleRounded'
import CalendarMonthRounded from '@mui/icons-material/CalendarMonthRounded'
import BusinessCenterRounded from '@mui/icons-material/BusinessCenterRounded'
import StorefrontRounded from '@mui/icons-material/StorefrontRounded'
import RocketLaunchRounded from '@mui/icons-material/RocketLaunchRounded'
import SportsMotorsportsRounded from '@mui/icons-material/SportsMotorsportsRounded'
import LightbulbRounded from '@mui/icons-material/LightbulbRounded'
import GavelRounded from '@mui/icons-material/GavelRounded'
import type { SvgIconComponent } from '@mui/icons-material'

type Doc = { id: string; title: string; date: string; tags: string[]; category: string; slug: string }

const CATEGORIES: { key: string; label: string; Icon: SvgIconComponent }[] = [
  { key: 'governance', label: 'SOP / Governance', Icon: GavelRounded },
  { key: 'daily',      label: 'Daily Journal',   Icon: CalendarMonthRounded },
  { key: 'epi',        label: 'EPI',             Icon: BusinessCenterRounded },
  { key: 'suburbia',   label: 'Suburbia',        Icon: StorefrontRounded },
  { key: 'clawpilot',  label: 'ClawPilot',       Icon: RocketLaunchRounded },
  { key: 'p9ine',      label: 'P9INE',           Icon: SportsMotorsportsRounded },
  { key: 'concepts',   label: 'Concepts',        Icon: LightbulbRounded },
]

type Props = { docs: Doc[]; selectedId: string | null; onSelect: (id: string) => void }

export default function DocSidebar({ docs, selectedId, onSelect }: Props) {
  const [search, setSearch] = useState('')
  const [expanded, setExpanded] = useState<Record<string, boolean>>(
    Object.fromEntries(CATEGORIES.map(c => [c.key, true]))
  )

  const toggle = (key: string) => setExpanded(p => ({ ...p, [key]: !p[key] }))

  const filtered = docs.filter(d => d.title.toLowerCase().includes(search.toLowerCase()))
  const groups = CATEGORIES
    .map(c => ({ ...c, docs: filtered.filter(d => d.category === c.key) }))
    .filter(g => g.docs.length > 0)

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', height: '100%', width: 260, backgroundColor: '#12141C', borderRight: '1px solid rgba(255,255,255,0.06)', flexShrink: 0 }}>
      
      {/* Header */}
      <Box sx={{ px: 2, pt: 2.5, pb: 1.5 }}>
        <Typography variant="overline" sx={{ color: 'text.disabled', fontSize: '0.65rem', letterSpacing: 1.5, display: 'block', mb: 1 }}>
          DOCUMENTS
        </Typography>
        <TextField
          size="small"
          fullWidth
          placeholder="Search..."
          value={search}
          onChange={e => setSearch(e.target.value)}
          InputProps={{
            startAdornment: (
              <InputAdornment position="start">
                <SearchRounded sx={{ fontSize: 18, color: 'text.disabled' }} />
              </InputAdornment>
            ),
          }}
          sx={{
            '& .MuiOutlinedInput-root': {
              borderRadius: 2.5,
              backgroundColor: '#1E2030',
              fontSize: '0.875rem',
              '& fieldset': { borderColor: 'rgba(255,255,255,0.08)' },
              '&:hover fieldset': { borderColor: 'rgba(255,255,255,0.16)' },
              '&.Mui-focused fieldset': { borderColor: '#A8C7FA' },
            },
          }}
        />
      </Box>

      {/* List */}
      <Box sx={{ flex: 1, overflow: 'auto', px: 1.5, pb: 2 }}>
        {groups.map(group => {
          const { Icon } = group
          return (
            <Box key={group.key}>
              <ListItemButton
                onClick={() => toggle(group.key)}
                sx={{ borderRadius: 2, px: 1.5, py: 0.75, mb: 0.25 }}
              >
                <ListItemIcon sx={{ minWidth: 32 }}>
                  <Icon sx={{ fontSize: 18, color: expanded[group.key] ? '#A8C7FA' : 'rgba(255,255,255,0.4)' }} />
                </ListItemIcon>
                <ListItemText
                  primary={group.label}
                  primaryTypographyProps={{ fontSize: '0.8rem', fontWeight: 600, color: 'text.secondary' }}
                />
                {expanded[group.key]
                  ? <ExpandLess sx={{ fontSize: 16, color: 'action.disabled' }} />
                  : <ExpandMore sx={{ fontSize: 16, color: 'action.disabled' }} />}
              </ListItemButton>

              <Collapse in={expanded[group.key]} timeout="auto">
                {group.docs.map(doc => (
                  <ListItemButton
                    key={doc.id}
                    selected={selectedId === doc.id}
                    onClick={() => onSelect(doc.id)}
                    sx={{
                      borderRadius: 2,
                      pl: 5,
                      pr: 1.5,
                      py: 0.75,
                      mb: 0.25,
                      minHeight: 44,
                      '&.Mui-selected': {
                        backgroundColor: 'rgba(168,199,250,0.1)',
                        '&:hover': { backgroundColor: 'rgba(168,199,250,0.15)' },
                      },
                      '&:hover': { backgroundColor: 'rgba(255,255,255,0.04)' },
                    }}
                  >
                    <ListItemIcon sx={{ minWidth: 26 }}>
                      <ArticleRounded sx={{ fontSize: 15, color: selectedId === doc.id ? '#A8C7FA' : 'rgba(255,255,255,0.3)' }} />
                    </ListItemIcon>
                    <ListItemText
                      primary={doc.title}
                      secondary={doc.date}
                      primaryTypographyProps={{
                        fontSize: '0.8rem',
                        noWrap: true,
                        fontWeight: selectedId === doc.id ? 600 : 400,
                        color: selectedId === doc.id ? '#A8C7FA' : 'text.primary',
                      }}
                      secondaryTypographyProps={{ fontSize: '0.7rem', color: 'text.disabled' }}
                    />
                  </ListItemButton>
                ))}
              </Collapse>
            </Box>
          )
        })}
      </Box>
    </Box>
  )
}