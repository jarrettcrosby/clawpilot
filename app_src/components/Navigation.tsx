'use client'
import { Box, Drawer, List, ListItem, ListItemButton, ListItemIcon, ListItemText, Typography, BottomNavigation, BottomNavigationAction, Divider, Avatar, IconButton, Tooltip } from '@mui/material'
import ChevronLeftRounded from '@mui/icons-material/ChevronLeftRounded'
import { BrandIcon, DashboardIcon, DocsIcon, ProjectsIcon, PipelineIcon, AgentsIcon, VersionsIcon } from '@/lib/icons'

const NAV_ITEMS = [
  { id: 'dashboard', label: 'Dashboard', Icon: DashboardIcon, mobileOnly: false },
  { id: 'docs', label: 'Docs', Icon: DocsIcon, mobileOnly: false },
  { id: 'projects', label: 'Projects', Icon: ProjectsIcon, mobileOnly: false },
  { id: 'pipeline', label: 'Pipeline', Icon: PipelineIcon, mobileOnly: false },
  { id: 'agents', label: 'Agents', Icon: AgentsIcon, mobileOnly: false },
  { id: 'versions', label: 'Versions', Icon: VersionsIcon, mobileOnly: false },
]
const MOBILE_NAV_ITEMS = NAV_ITEMS

type NavigationProps = {
  activeSection: string
  onNavigate: (s: string) => void
  collapsed?: boolean
  onToggleCollapse?: () => void
}

export default function Navigation({ activeSection, onNavigate, collapsed, onToggleCollapse }: NavigationProps) {
  const width = collapsed ? 76 : 220
  return (
    <>
      <Drawer
        variant="permanent"
        sx={{
          display: { xs: 'none', md: 'block' },
          width,
          flexShrink: 0,
          '& .MuiDrawer-paper': {
            width,
            backgroundColor: '#12141C',
            borderRight: '1px solid rgba(255,255,255,0.06)',
            display: 'flex',
            flexDirection: 'column',
          },
        }}
        PaperProps={{ sx: { width, backgroundColor: '#12141C', borderRight: '1px solid rgba(255,255,255,0.06)', display: 'flex', flexDirection: 'column' } }}
        open
      >
        <Box px={collapsed ? 1.5 : 3} py={2.5} display="flex" alignItems="center" gap={1.5}>
          <Avatar sx={{ width: 32, height: 32, backgroundColor: '#A8C7FA', color: '#001D36' }}>
            <BrandIcon sx={{ fontSize: 18 }} />
          </Avatar>
          {!collapsed && (
            <Typography fontWeight={700} fontSize="0.95rem" color="text.primary" sx={{ flex: 1 }}>
              ClawPilot
            </Typography>
          )}
          {onToggleCollapse && (
            <Tooltip title={collapsed ? 'Expand sidebar' : 'Minimize sidebar'}>
              <IconButton onClick={onToggleCollapse} sx={{ color: 'rgba(255,255,255,0.45)' }}>
                <ChevronLeftRounded sx={{ transform: collapsed ? 'rotate(180deg)' : 'none' }} />
              </IconButton>
            </Tooltip>
          )}
        </Box>
        <Divider sx={{ borderColor: 'rgba(255,255,255,0.06)', mb: 1 }} />
        <List sx={{ px: 1.5, flex: 1 }}>
          {NAV_ITEMS.map((item) => (
            <ListItem key={item.id} disablePadding>
              <ListItemButton
                selected={activeSection === item.id}
                onClick={() => onNavigate(item.id)}
                sx={{
                  borderRadius: 3,
                  mb: 0.5,
                  px: collapsed ? 1.25 : 2,
                  py: 1.25,
                  justifyContent: collapsed ? 'center' : 'flex-start',
                  minHeight: 48,
                  '&.Mui-selected': {
                    backgroundColor: 'rgba(168,199,250,0.12)',
                    '&:hover': { backgroundColor: 'rgba(168,199,250,0.16)' },
                  },
                  '&:hover': { backgroundColor: 'rgba(255,255,255,0.05)' },
                }}
              >
                <ListItemIcon sx={{ minWidth: collapsed ? 0 : 36, mr: collapsed ? 0 : 0, color: activeSection === item.id ? '#A8C7FA' : 'rgba(255,255,255,0.5)', justifyContent: 'center' }}>
                  <item.Icon sx={{ fontSize: 22 }} />
                </ListItemIcon>
                {!collapsed && (
                  <ListItemText
                    primary={item.label}
                    primaryTypographyProps={{
                      fontSize: '0.875rem',
                      fontWeight: activeSection === item.id ? 600 : 400,
                      color: activeSection === item.id ? '#A8C7FA' : 'text.secondary',
                    }}
                  />
                )}
              </ListItemButton>
            </ListItem>
          ))}
        </List>
      </Drawer>
      <Box sx={{ display: { xs: 'block', md: 'none' } }}>
        <BottomNavigation
          value={activeSection}
          onChange={(_, v) => onNavigate(v)}
          sx={{
            position: 'fixed',
            bottom: 0,
            left: 0,
            right: 0,
            height: 'calc(64px + env(safe-area-inset-bottom))',
            paddingBottom: 'env(safe-area-inset-bottom)',
            backgroundColor: '#12141C',
            borderTop: '1px solid rgba(255,255,255,0.06)',
            zIndex: 1000,
          }}
          showLabels
        >
          {MOBILE_NAV_ITEMS.map((item) => (
            <BottomNavigationAction
              key={item.id}
              value={item.id}
              label={item.label}
              icon={<item.Icon />}
              sx={{
                color: 'rgba(255,255,255,0.4)',
                '&.Mui-selected': { color: '#A8C7FA' },
                minWidth: 0,
                fontSize: '0.7rem',
              }}
            />
          ))}
        </BottomNavigation>
      </Box>
    </>
  )
}