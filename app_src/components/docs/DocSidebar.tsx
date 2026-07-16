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
import IconButton from '@mui/material/IconButton'
import Tooltip from '@mui/material/Tooltip'
import SearchRounded from '@mui/icons-material/SearchRounded'
import RefreshRounded from '@mui/icons-material/RefreshRounded'
import AddRounded from '@mui/icons-material/AddRounded'
import ExpandLess from '@mui/icons-material/ExpandLess'
import ExpandMore from '@mui/icons-material/ExpandMore'
import ArticleRounded from '@mui/icons-material/ArticleRounded'
import AssessmentRounded from '@mui/icons-material/AssessmentRounded'
import ViewKanbanRounded from '@mui/icons-material/ViewKanbanRounded'
import TrendingUpRounded from '@mui/icons-material/TrendingUpRounded'
import TravelExploreRounded from '@mui/icons-material/TravelExploreRounded'
import NewReleasesRounded from '@mui/icons-material/NewReleasesRounded'
import AccountTreeRounded from '@mui/icons-material/AccountTreeRounded'
import SettingsRounded from '@mui/icons-material/SettingsRounded'
import IntegrationInstructionsRounded from '@mui/icons-material/IntegrationInstructionsRounded'
import LibraryBooksRounded from '@mui/icons-material/LibraryBooksRounded'
import ArchiveRounded from '@mui/icons-material/ArchiveRounded'
import type { SvgIconComponent } from '@mui/icons-material'

type Doc = { id: string; title: string; date: string; tags: string[]; category: string; slug: string; excerpt?: string }

const CATEGORIES: { key: string; label: string; Icon: SvgIconComponent }[] = [
  { key: 'briefings', label: 'Briefings', Icon: AssessmentRounded },
  { key: 'projects', label: 'Projects', Icon: ViewKanbanRounded },
  { key: 'pipeline', label: 'Pipeline', Icon: TrendingUpRounded },
  { key: 'radar', label: 'AI & Opportunity Radar', Icon: TravelExploreRounded },
  { key: 'releases', label: 'Releases', Icon: NewReleasesRounded },
  { key: 'architecture', label: 'Architecture', Icon: AccountTreeRounded },
  { key: 'operations', label: 'Operations', Icon: SettingsRounded },
  { key: 'integrations', label: 'Integrations', Icon: IntegrationInstructionsRounded },
  { key: 'knowledge', label: 'Knowledge', Icon: LibraryBooksRounded },
  { key: 'archive', label: 'Archive', Icon: ArchiveRounded },
]

type Props = {
  docs: Doc[]
  selectedId: string | null
  onSelect: (id: string) => void
  onRefresh?: () => void
  onCreate?: () => void
  refreshing?: boolean
  search: string
  onSearch: (value: string) => void
}

export default function DocSidebar({ docs, selectedId, onSelect, onRefresh, onCreate, refreshing = false, search, onSearch }: Props) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>(
    Object.fromEntries(CATEGORIES.map(c => [c.key, true]))
  )

  const toggle = (key: string) => setExpanded(p => ({ ...p, [key]: !(p[key] ?? true) }))

  const knownKeys = new Set(CATEGORIES.map(category => category.key))
  const additional = Array.from(new Set(docs.map(doc => doc.category).filter(category => !knownKeys.has(category))))
    .sort()
    .map(key => ({ key, label: key.replace(/(^|[-_])\w/g, value => value.replace(/[-_]/, ' ').toUpperCase()), Icon: ArticleRounded }))
  const groups = [...CATEGORIES, ...additional]
    .map(category => ({ ...category, docs: docs.filter(doc => doc.category === category.key) }))
    .filter(g => g.docs.length > 0)

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', height: '100%', width: '100%', minWidth: 0, backgroundColor: '#12141C', flexShrink: 0 }}>
      
      {/* Header */}
      <Box sx={{ px: 2, pt: 2.5, pb: 1.5 }}>
        <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 1 }}>
          <Typography variant="overline" sx={{ color: 'text.disabled', fontSize: '0.65rem', letterSpacing: 1.5 }}>
            {docs.length} DOCUMENTS
          </Typography>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.25 }}>
            {onCreate && (
              <Tooltip title="New document">
                <span>
                  <IconButton aria-label="New document" size="small" disabled={refreshing} onClick={onCreate} sx={{ color: 'text.secondary' }}>
                    <AddRounded fontSize="small" />
                  </IconButton>
                </span>
              </Tooltip>
            )}
            {onRefresh && (
              <Tooltip title="Refresh document briefs">
                <span>
                  <IconButton aria-label="Refresh document briefs" size="small" disabled={refreshing} onClick={onRefresh} sx={{ color: 'text.secondary' }}>
                    <RefreshRounded fontSize="small" />
                  </IconButton>
                </span>
              </Tooltip>
            )}
          </Box>
        </Box>
        <TextField
          size="small"
          fullWidth
          placeholder="Search..."
          value={search}
          onChange={e => onSearch(e.target.value)}
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
                {(expanded[group.key] ?? true)
                  ? <ExpandLess sx={{ fontSize: 16, color: 'action.disabled' }} />
                  : <ExpandMore sx={{ fontSize: 16, color: 'action.disabled' }} />}
              </ListItemButton>

              <Collapse in={expanded[group.key] ?? true} timeout="auto">
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
