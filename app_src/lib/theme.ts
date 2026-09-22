import { createTheme } from '@mui/material/styles'

declare module '@mui/material/styles' {
  interface Palette {
    surface: string
    surfaceVariant: string
    outline: string
  }
  interface PaletteOptions {
    surface?: string
    surfaceVariant?: string
    outline?: string
  }
}

const theme = createTheme({
  cssVariables: { colorSchemeSelector: 'class' },
  colorSchemes: {
    light: { palette: {
      mode: 'light',
      primary: { main: '#245CA6', contrastText: '#FFFFFF' },
      secondary: { main: '#665183', contrastText: '#FFFFFF' },
      background: { default: '#F6F7FB', paper: '#FFFFFF' },
      surface: '#FFFFFF',
      surfaceVariant: '#EBEEF5',
      error: { main: '#BA1A1A' },
      success: { main: '#28733B' },
      warning: { main: '#8A5100' },
      info: { main: '#086B91' },
      text: { primary: '#20232B', secondary: '#505866' },
      outline: '#737D8D',
    } },
    dark: { palette: {
    mode: 'dark',
    primary: { main: '#A8C7FA', contrastText: '#001D36' },
    secondary: { main: '#CFC6EA', contrastText: '#332D41' },
    background: { default: '#0F0F13', paper: '#1A1A23' },
    surface: '#1A1A23',
    surfaceVariant: '#232330',
    error: { main: '#FFB4AB' },
    text: { primary: '#E4E1EC', secondary: '#CAC4D0' },
    outline: '#46464F',
    } },
  },
  shape: { borderRadius: 16 },
  typography: {
    fontFamily: '-apple-system, BlinkMacSystemFont, "Inter", "SF Pro Display", sans-serif',
    h1: { fontSize: '2rem', fontWeight: 700 },
    h2: { fontSize: '1.5rem', fontWeight: 600 },
    h3: { fontSize: '1.25rem', fontWeight: 600 },
    body1: { fontSize: '0.9375rem', lineHeight: 1.6 },
    body2: { fontSize: '0.875rem', lineHeight: 1.5 },
  },
  components: {
    MuiCssBaseline: {
      styleOverrides: {
        ':root': { '--cp-neutral-rgb': '32,35,43' },
        '.dark': { '--cp-neutral-rgb': '255,255,255' },
        body: {
          backgroundColor: 'var(--mui-palette-background-default)',
          color: 'var(--mui-palette-text-primary)',
        },
        '*:focus-visible': { outline: '2px solid var(--mui-palette-primary-main)', outlineOffset: 3 },
        '@media (prefers-reduced-motion: reduce)': {
          '*, *::before, *::after': { scrollBehavior: 'auto !important', animationDuration: '0.01ms !important', transitionDuration: '0.01ms !important' },
        },
      },
    },
    MuiCard: {
      styleOverrides: {
        root: {
          backgroundImage: 'none',
          backgroundColor: 'var(--mui-palette-background-paper)',
          border: '1px solid var(--mui-palette-divider)',
        },
      },
    },
    MuiButton: {
      styleOverrides: {
        root: {
          borderRadius: 50,
          textTransform: 'none',
          fontWeight: 600,
          minHeight: 48,
        },
      },
    },
    MuiDialogActions: {
      styleOverrides: {
        root: {
          flexWrap: 'wrap',
          gap: 8,
          '& > :not(style) ~ :not(style)': {
            marginLeft: 0,
          },
        },
      },
    },
    MuiTableCell: {
      styleOverrides: {
        head: { backgroundColor: 'var(--mui-palette-background-paper)', fontWeight: 600 },
      },
    },
    MuiChip: {
      styleOverrides: {
        root: {
          borderRadius: 8,
          minHeight: 32,
        },
      },
    },
    MuiListItemButton: {
      styleOverrides: {
        root: {
          borderRadius: 12,
          minHeight: 48,
        },
      },
    },
    MuiBottomNavigationAction: {
      styleOverrides: {
        root: {
          minWidth: 0,
          minHeight: 48,
          padding: '6px 0',
          '&.Mui-selected': {
            color: 'var(--mui-palette-primary-main)',
          },
        },
      },
    },
  },
})

export default theme
