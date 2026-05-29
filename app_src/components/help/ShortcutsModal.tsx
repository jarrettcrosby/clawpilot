'use client'

import Dialog from '@mui/material/Dialog'
import DialogContent from '@mui/material/DialogContent'
import Box from '@mui/material/Box'
import Typography from '@mui/material/Typography'
import IconButton from '@mui/material/IconButton'
import Divider from '@mui/material/Divider'
import CloseRounded from '@mui/icons-material/CloseRounded'

const SECTIONS = [
  {
    label: 'Navigation',
    shortcuts: [
      { keys: ['1'], desc: 'Go to Dashboard' },
      { keys: ['2'], desc: 'Go to Docs' },
      { keys: ['3'], desc: 'Go to Projects' },
      { keys: ['4'], desc: 'Go to Pipeline' },
      { keys: ['5'], desc: 'Go to Agents' },
      { keys: ['6'], desc: 'Go to Versions' },
      { keys: ['?'], desc: 'Open keyboard shortcuts' },
    ],
  },
  {
    label: 'Cards (Projects)',
    shortcuts: [
      { keys: ['J'], desc: 'Move focus down to next card' },
      { keys: ['K'], desc: 'Move focus up to previous card' },
      { keys: ['Enter'], desc: 'Open focused card detail' },
      { keys: ['Esc'], desc: 'Close drawer or modal' },
    ],
  },
  {
    label: 'General',
    shortcuts: [
      { keys: ['Esc'], desc: 'Close any open panel' },
    ],
  },
]

function Key({ label }: { label: string }) {
  return (
    <Box component="span" sx={{
      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
      minWidth: 28, height: 24, px: 0.75,
      backgroundColor: 'rgba(255,255,255,0.08)',
      border: '1px solid rgba(255,255,255,0.15)',
      borderBottom: '2px solid rgba(255,255,255,0.2)',
      borderRadius: 1,
      fontFamily: 'monospace',
      fontSize: '0.75rem',
      color: 'rgba(255,255,255,0.85)',
      fontWeight: 600,
    }}>
      {label}
    </Box>
  )
}

type Props = { open: boolean; onClose: () => void }

export default function ShortcutsModal({ open, onClose }: Props) {
  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth
      PaperProps={{ sx: { backgroundColor: '#1A1A23', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 3 } }}>
      <Box display="flex" alignItems="center" justifyContent="space-between" px={3} pt={2.5} pb={1}>
        <Typography variant="h6" fontWeight={700} color="text.primary">Keyboard Shortcuts</Typography>
        <IconButton onClick={onClose} size="small" sx={{ color: 'text.secondary' }}>
          <CloseRounded fontSize="small" />
        </IconButton>
      </Box>
      <DialogContent sx={{ px: 3, pb: 3 }}>
        {SECTIONS.map((section, i) => (
          <Box key={section.label} mb={i < SECTIONS.length - 1 ? 3 : 0}>
            <Typography variant="overline" color="text.disabled" sx={{ fontSize: '0.7rem', letterSpacing: 1.2 }}>
              {section.label}
            </Typography>
            <Divider sx={{ borderColor: 'rgba(255,255,255,0.06)', mt: 0.5, mb: 1.5 }} />
            {section.shortcuts.map(s => (
              <Box key={s.desc} display="flex" alignItems="center" justifyContent="space-between" mb={1.25}>
                <Typography variant="body2" color="text.secondary">{s.desc}</Typography>
                <Box display="flex" gap={0.5}>
                  {s.keys.map(k => <Key key={k} label={k} />)}
                </Box>
              </Box>
            ))}
          </Box>
        ))}
      </DialogContent>
    </Dialog>
  )
}
