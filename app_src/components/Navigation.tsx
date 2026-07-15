'use client'

import {
  BottomNavigation,
  BottomNavigationAction,
  Box,
  Divider,
  Drawer,
  IconButton,
  List,
  ListItem,
  ListItemButton,
  ListItemIcon,
  ListItemText,
  Tooltip,
  Typography,
} from '@mui/material'
import CloseRounded from '@mui/icons-material/CloseRounded'
import LinkRounded from '@mui/icons-material/LinkRounded'
import MoreHorizRounded from '@mui/icons-material/MoreHorizRounded'
import ContactsRounded from '@mui/icons-material/ContactsRounded'
import BrandMark from '@/components/BrandMark'
import { DashboardIcon, DocsIcon, ProjectsIcon, PipelineIcon, AgentsIcon, VersionsIcon } from '@/lib/icons'

const NAV_ITEMS = [
  { id: 'dashboard', label: 'Dashboard', Icon: DashboardIcon },
  { id: 'docs', label: 'Docs', Icon: DocsIcon },
  { id: 'projects', label: 'Projects', Icon: ProjectsIcon },
  { id: 'pipeline', label: 'Pipeline', Icon: PipelineIcon },
  { id: 'crm', label: 'CRM', Icon: ContactsRounded },
  { id: 'links', label: 'Links', Icon: LinkRounded },
  { id: 'agents', label: 'Agents', Icon: AgentsIcon },
  { id: 'versions', label: 'Versions', Icon: VersionsIcon },
]

const MOBILE_DIRECT_IDS = new Set(['dashboard', 'projects', 'pipeline', 'agents'])
const MOBILE_DIRECT_ITEMS = NAV_ITEMS.filter((item) => MOBILE_DIRECT_IDS.has(item.id))

type NavigationProps = {
  activeSection: string
  onNavigate: (section: string) => void
  collapsed?: boolean
  mobileOpen: boolean
  onMobileOpen: () => void
  onMobileClose: () => void
  showLinks?: boolean
}

type NavigationListProps = {
  activeSection: string
  collapsed?: boolean
  onSelect: (section: string) => void
  surface: 'desktop' | 'mobile'
  showLinks: boolean
}

function NavigationList({ activeSection, collapsed = false, onSelect, surface, showLinks }: NavigationListProps) {
  const items = showLinks ? NAV_ITEMS : NAV_ITEMS.filter((item) => item.id !== 'links')
  return (
    <List sx={{ px: collapsed ? 1.25 : 1.5, py: 1, flex: 1 }}>
      {items.map((item) => (
        <Tooltip
          key={item.id}
          title={collapsed ? item.label : ''}
          placement="right"
          disableHoverListener={!collapsed}
        >
          <ListItem disablePadding>
            <ListItemButton
              data-testid={`nav-${surface}-${item.id}`}
              aria-label={item.label}
              aria-current={activeSection === item.id ? 'page' : undefined}
              selected={activeSection === item.id}
              onClick={() => onSelect(item.id)}
              sx={{
                borderRadius: 1,
                mb: 0.5,
                px: collapsed ? 1 : 2,
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
              <ListItemIcon
                sx={{
                  minWidth: collapsed ? 0 : 36,
                  color: activeSection === item.id ? '#A8C7FA' : 'rgba(255,255,255,0.5)',
                  justifyContent: 'center',
                }}
              >
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
        </Tooltip>
      ))}
    </List>
  )
}

export default function Navigation({
  activeSection,
  onNavigate,
  collapsed = false,
  mobileOpen,
  onMobileOpen,
  onMobileClose,
  showLinks = true,
}: NavigationProps) {
  const desktopWidth = collapsed ? 76 : 220

  const navigateFromMobile = (section: string) => {
    onNavigate(section)
    onMobileClose()
  }

  return (
    <>
      <Drawer
        data-testid="desktop-navigation"
        variant="permanent"
        open
        sx={{
          display: { xs: 'none', md: 'flex' },
          width: desktopWidth,
          flex: `0 0 ${desktopWidth}px`,
          height: '100dvh',
          overflow: 'hidden',
          transition: (theme) => theme.transitions.create(['width', 'flex-basis'], {
            duration: theme.transitions.duration.shorter,
          }),
        }}
        PaperProps={{
          id: 'desktop-navigation-drawer',
          'data-testid': 'desktop-navigation-paper',
          sx: {
            position: 'relative',
            width: desktopWidth,
            height: '100%',
            overflowX: 'hidden',
            backgroundColor: '#12141C',
            borderRight: '1px solid rgba(255,255,255,0.06)',
            display: 'flex',
            flexDirection: 'column',
            boxSizing: 'border-box',
            transition: (theme) => theme.transitions.create('width', {
              duration: theme.transitions.duration.shorter,
            }),
          },
        }}
      >
        <Box component="nav" aria-label="Primary navigation" display="flex" flexDirection="column" height="100%">
          <Box
            px={collapsed ? 2.75 : 2.5}
            minHeight={72}
            display="flex"
            alignItems="center"
            justifyContent={collapsed ? 'center' : 'flex-start'}
            gap={1.5}
          >
            <BrandMark size={32} />
            {!collapsed && (
              <Typography fontWeight={700} fontSize="0.95rem" color="text.primary" noWrap>
                ClawPilot
              </Typography>
            )}
          </Box>
          <Divider sx={{ borderColor: 'rgba(255,255,255,0.06)' }} />
          <NavigationList
            activeSection={activeSection}
            collapsed={collapsed}
            onSelect={onNavigate}
            surface="desktop"
            showLinks={showLinks}
          />
        </Box>
      </Drawer>

      <Drawer
        data-testid="mobile-navigation"
        anchor="left"
        variant="temporary"
        open={mobileOpen}
        onClose={onMobileClose}
        ModalProps={{ keepMounted: true }}
        sx={{
          display: { xs: 'block', md: 'none' },
          '& .MuiDrawer-paper': {
            width: 'min(320px, 86vw)',
            maxWidth: '100vw',
            overflowX: 'hidden',
            backgroundColor: '#12141C',
            borderRight: '1px solid rgba(255,255,255,0.08)',
            boxSizing: 'border-box',
          },
        }}
        PaperProps={{
          id: 'mobile-navigation-drawer',
          'data-testid': 'mobile-navigation-drawer',
        }}
      >
        <Box component="nav" aria-label="Mobile navigation" display="flex" flexDirection="column" height="100%">
          <Box
            sx={{
              minHeight: 'calc(env(safe-area-inset-top) + 64px)',
              pt: 'env(safe-area-inset-top)',
              px: 2,
              display: 'flex',
              alignItems: 'center',
              gap: 1.25,
            }}
          >
            <BrandMark size={32} />
            <Typography fontWeight={700} fontSize="0.95rem" color="text.primary" sx={{ flex: 1 }}>
              ClawPilot
            </Typography>
            <IconButton
              data-testid="mobile-navigation-close"
              aria-label="Close navigation menu"
              onClick={onMobileClose}
              sx={{ color: 'text.secondary' }}
            >
              <CloseRounded />
            </IconButton>
          </Box>
          <Divider sx={{ borderColor: 'rgba(255,255,255,0.06)' }} />
          <NavigationList
            activeSection={activeSection}
            onSelect={navigateFromMobile}
            surface="mobile"
            showLinks={showLinks}
          />
        </Box>
      </Drawer>

      <BottomNavigation
        data-testid="mobile-bottom-navigation"
        aria-label="Primary mobile destinations"
        value={mobileOpen || !MOBILE_DIRECT_IDS.has(activeSection) ? 'more' : activeSection}
        onChange={(_, value: string) => {
          if (value === 'more') onMobileOpen()
          else navigateFromMobile(value)
        }}
        showLabels
        sx={{
          display: { xs: 'flex', md: 'none' },
          position: 'fixed',
          bottom: 0,
          left: 0,
          right: 0,
          width: '100%',
          maxWidth: '100vw',
          height: 'calc(var(--mobile-navigation-height, 64px) + env(safe-area-inset-bottom))',
          paddingBottom: 'env(safe-area-inset-bottom)',
          backgroundColor: '#12141C',
          borderTop: '1px solid rgba(255,255,255,0.06)',
          zIndex: 1100,
          '@media (orientation: landscape) and (max-height: 500px) and (max-width: 899.95px)': {
            '& .MuiBottomNavigationAction-root': { py: 0.25 },
            '& .MuiSvgIcon-root': { fontSize: 19 },
          },
        }}
      >
        {MOBILE_DIRECT_ITEMS.map((item) => (
          <BottomNavigationAction
            key={item.id}
            data-testid={`nav-bottom-${item.id}`}
            value={item.id}
            label={item.label}
            aria-label={item.label}
            icon={<item.Icon />}
            sx={{
              color: 'rgba(255,255,255,0.4)',
              '&.Mui-selected': { color: '#A8C7FA' },
              minWidth: 0,
              maxWidth: 'none',
              flex: '1 1 0',
              px: 0.25,
              '& .MuiSvgIcon-root': { fontSize: 21 },
              '& .MuiBottomNavigationAction-label': {
                fontSize: '0.6rem',
                letterSpacing: 0,
                whiteSpace: 'nowrap',
              },
              '& .MuiBottomNavigationAction-label.Mui-selected': { fontSize: '0.6rem' },
            }}
          />
        ))}
        <BottomNavigationAction
          data-testid="nav-bottom-more"
          value="more"
          label="More"
          aria-label="More navigation destinations"
          aria-haspopup="dialog"
          aria-expanded={mobileOpen}
          aria-controls="mobile-navigation-drawer"
          icon={<MoreHorizRounded />}
          sx={{
            color: 'rgba(255,255,255,0.4)',
            '&.Mui-selected': { color: '#A8C7FA' },
            minWidth: 0,
            maxWidth: 'none',
            flex: '1 1 0',
            px: 0.25,
            '& .MuiSvgIcon-root': { fontSize: 21 },
            '& .MuiBottomNavigationAction-label': {
              fontSize: '0.6rem',
              letterSpacing: 0,
              whiteSpace: 'nowrap',
            },
            '& .MuiBottomNavigationAction-label.Mui-selected': { fontSize: '0.6rem' },
          }}
        />
      </BottomNavigation>
    </>
  )
}
