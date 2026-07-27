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
  palette: {
    mode: 'dark',
    primary: { main: '#A8C7FA', contrastText: '#001D36' },
    secondary: { main: '#CFC6EA', contrastText: '#332D41' },
    background: { default: '#0F0F13', paper: '#1A1A23' },
    surface: '#1A1A23',
    surfaceVariant: '#232330',
    error: { main: '#FFB4AB' },
    text: { primary: '#E4E1EC', secondary: '#CAC4D0' },
    outline: '#46464F',
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
        body: {
          backgroundColor: '#0F0F13',
          color: '#E4E1EC',
        },
      },
    },
    MuiCard: {
      styleOverrides: {
        root: {
          backgroundImage: 'none',
          backgroundColor: '#1A1A23',
          border: '1px solid rgba(255,255,255,0.06)',
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
            color: '#A8C7FA',
          },
        },
      },
    },
  },
})

export default theme
