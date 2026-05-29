'use client'

import { useEffect, useState } from 'react'
import Box from '@mui/material/Box'
import List from '@mui/material/List'
import ListItemButton from '@mui/material/ListItemButton'
import ListItemIcon from '@mui/material/ListItemIcon'
import ListItemText from '@mui/material/ListItemText'
import Typography from '@mui/material/Typography'
import Divider from '@mui/material/Divider'
import ArticleRounded from '@mui/icons-material/ArticleRounded'
import DocViewer from '@/components/docs/DocViewer'

type Doc = {
  id: string
  title: string
  date: string
  tags: string[]
  category: string
  slug: string
  content: string
}

const ITEMS = [
  { id: 'development-contract', label: 'Development Contract' },
  { id: 'system-operating-model', label: 'System Operating Model' },
  { id: 'promotion-workflow', label: 'Promotion Workflow' },
  { id: 'dev-prod-alignment-workflow', label: 'Dev/Prod Alignment Workflow' },
  { id: 'governance-rules', label: 'Governance Rules' },
  { id: 'agent-routing-model', label: 'Agent Routing Model' },
]

export default function GovernanceSection() {
  const [docs, setDocs] = useState<Doc[]>([])
  const [selectedId, setSelectedId] = useState<string>(ITEMS[0].id)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    fetch('/api/governance')
      .then(r => r.json())
      .then((data: Doc[]) => {
        setDocs(Array.isArray(data) ? data : [])
        setLoading(false)
      })
  }, [])

  const selected = docs.find(d => d.id === selectedId) || null

  return (
    <Box sx={{ display: 'flex', height: '100%', overflow: 'hidden', backgroundColor: '#0F0F13' }}>
      <Box sx={{ width: 280, flexShrink: 0, backgroundColor: '#1A1A23', borderRight: '1px solid #232330', height: '100%', display: { xs: 'none', md: 'flex' }, flexDirection: 'column' }}>
        <Box sx={{ px: 2.5, pt: 2.5, pb: 1.5 }}>
          <Typography variant="overline" sx={{ color: 'text.disabled', fontSize: '0.65rem', letterSpacing: 1.5, display: 'block', mb: 1 }}>
            GOVERNANCE / SOP
          </Typography>
        </Box>
        <Divider sx={{ borderColor: 'rgba(255,255,255,0.06)' }} />
        <List sx={{ px: 1.5, py: 1.5 }}>
          {ITEMS.map(item => (
            <ListItemButton
              key={item.id}
              selected={selectedId === item.id}
              onClick={() => setSelectedId(item.id)}
              sx={{ borderRadius: 2, mb: 0.5, px: 1.5, py: 1 }}
            >
              <ListItemIcon sx={{ minWidth: 28 }}>
                <ArticleRounded sx={{ fontSize: 16, color: selectedId === item.id ? '#A8C7FA' : 'rgba(255,255,255,0.4)' }} />
              </ListItemIcon>
              <ListItemText
                primary={item.label}
                primaryTypographyProps={{ fontSize: '0.82rem', fontWeight: selectedId === item.id ? 600 : 400, color: selectedId === item.id ? '#A8C7FA' : 'text.secondary' }}
              />
            </ListItemButton>
          ))}
        </List>
      </Box>

      <Box sx={{ flex: 1, minWidth: 0, overflow: 'hidden', height: '100%', backgroundColor: '#0F0F13' }}>
        <DocViewer doc={selected} loading={loading} />
      </Box>
    </Box>
  )
}
