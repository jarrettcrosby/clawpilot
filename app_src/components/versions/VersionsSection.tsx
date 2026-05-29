'use client'

import { useEffect, useState } from 'react'
import Box from '@mui/material/Box'
import Typography from '@mui/material/Typography'
import Chip from '@mui/material/Chip'
import Button from '@mui/material/Button'
import Divider from '@mui/material/Divider'
import CircularProgress from '@mui/material/CircularProgress'
import Alert from '@mui/material/Alert'
import Tabs from '@mui/material/Tabs'
import Tab from '@mui/material/Tab'
import Dialog from '@mui/material/Dialog'
import DialogTitle from '@mui/material/DialogTitle'
import DialogContent from '@mui/material/DialogContent'
import DialogActions from '@mui/material/DialogActions'

type Commit = { hash: string; short: string; subject: string; date: string; author: string }
type Backup = { name: string; timestamp: string }

export default function VersionsSection() {
  const [tab, setTab] = useState(0)
  const [commits, setCommits] = useState<Commit[]>([])
  const [backups, setBackups] = useState<Backup[]>([])
  const [loading, setLoading] = useState(true)
  const [reverting, setReverting] = useState<string | null>(null)
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null)
  const [confirm, setConfirm] = useState<{ type: 'commit' | 'backup'; id: string; label: string } | null>(null)

  useEffect(() => {
    fetch('/api/versions').then(r => r.json()).then(data => {
      setCommits(data.commits || [])
      setBackups(data.backups || [])
      setLoading(false)
    })
  }, [])

  async function doRevert() {
    if (!confirm) return
    setReverting(confirm.id)
    setConfirm(null)
    setResult(null)
    const body = confirm.type === 'commit' ? { hash: confirm.id } : { backup: confirm.id }
    const res = await fetch('/api/versions/revert', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    const data = await res.json()
    setResult({ ok: res.ok, message: data.message || data.error })
    setReverting(null)
  }

  return (
    <Box p={3} pt={4} maxWidth={720}>
      <Typography variant="h5" fontWeight={700} color="text.primary" mb={0.5}>
        Versions
      </Typography>
      <Typography variant="body2" color="text.secondary" mb={3}>
        Git history and data backups. Revert code or restore task data.
      </Typography>

      {result && (
        <Alert severity={result.ok ? 'success' : 'error'} sx={{ mb: 3 }} onClose={() => setResult(null)}>
          {result.message}
        </Alert>
      )}

      <Tabs value={tab} onChange={(_, v) => setTab(v)} sx={{ mb: 3, borderBottom: '1px solid rgba(255,255,255,0.08)' }}>
        <Tab label="Code History" sx={{ textTransform: 'none', color: 'text.secondary' }} />
        <Tab label="Data Backups" sx={{ textTransform: 'none', color: 'text.secondary' }} />
      </Tabs>

      {loading ? (
        <Box display="flex" justifyContent="center" pt={4}><CircularProgress size={28} /></Box>
      ) : tab === 0 ? (
        <Box>
          {commits.length === 0 && (
            <Typography color="text.secondary">No commits yet.</Typography>
          )}
          {commits.map((c, i) => (
            <Box key={c.hash}>
              <Box display="flex" alignItems="flex-start" justifyContent="space-between" py={1.5} gap={2}>
                <Box flex={1} minWidth={0}>
                  <Box display="flex" alignItems="center" gap={1} mb={0.5} flexWrap="wrap">
                    <Chip label={c.short} size="small" sx={{ fontFamily: 'monospace', fontSize: '0.7rem', backgroundColor: 'rgba(168,199,250,0.12)', color: '#A8C7FA', height: 20 }} />
                    {i === 0 && <Chip label="current" size="small" color="success" sx={{ height: 20, fontSize: '0.7rem' }} />}
                  </Box>
                  <Typography variant="body2" color="text.primary" fontWeight={500} sx={{ wordBreak: 'break-word' }}>
                    {c.subject}
                  </Typography>
                  <Typography variant="caption" color="text.secondary">
                    {new Date(c.date).toLocaleString()}
                  </Typography>
                </Box>
                {i > 0 && (
                  <Button
                    size="small"
                    variant="outlined"
                    disabled={!!reverting}
                    onClick={() => setConfirm({ type: 'commit', id: c.hash, label: c.subject })}
                    sx={{ flexShrink: 0, borderColor: 'rgba(255,255,255,0.15)', color: 'text.secondary', fontSize: '0.75rem', '&:hover': { borderColor: '#A8C7FA', color: '#A8C7FA' } }}
                  >
                    {reverting === c.hash ? <CircularProgress size={14} /> : 'Revert'}
                  </Button>
                )}
              </Box>
              {i < commits.length - 1 && <Divider sx={{ borderColor: 'rgba(255,255,255,0.06)' }} />}
            </Box>
          ))}
        </Box>
      ) : (
        <Box>
          {backups.length === 0 && (
            <Typography color="text.secondary">No backups yet. Run a deploy to create one.</Typography>
          )}
          {backups.map((b, i) => (
            <Box key={b.name}>
              <Box display="flex" alignItems="center" justifyContent="space-between" py={1.5} gap={2}>
                <Box>
                  <Typography variant="body2" color="text.primary" fontWeight={500}>
                    tasks.json
                  </Typography>
                  <Typography variant="caption" color="text.secondary">
                    {b.timestamp.replace(/-/g, '/').replace('_', ' at ')}
                  </Typography>
                </Box>
                <Button
                  size="small"
                  variant="outlined"
                  disabled={!!reverting}
                  onClick={() => setConfirm({ type: 'backup', id: b.name, label: b.timestamp })}
                  sx={{ flexShrink: 0, borderColor: 'rgba(255,255,255,0.15)', color: 'text.secondary', fontSize: '0.75rem', '&:hover': { borderColor: '#A8C7FA', color: '#A8C7FA' } }}
                >
                  {reverting === b.name ? <CircularProgress size={14} /> : 'Restore'}
                </Button>
              </Box>
              {i < backups.length - 1 && <Divider sx={{ borderColor: 'rgba(255,255,255,0.06)' }} />}
            </Box>
          ))}
        </Box>
      )}

      <Dialog open={!!confirm} onClose={() => setConfirm(null)}
        PaperProps={{ sx: { backgroundColor: '#1A1A23', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 3, minWidth: 320 } }}>
        <DialogTitle sx={{ color: 'text.primary', fontWeight: 700 }}>Are you sure?</DialogTitle>
        <DialogContent>
          <Typography variant="body2" color="text.secondary">
            {confirm?.type === 'commit'
              ? 'This will revert the app to this commit and redeploy. The app will be briefly unavailable.'
              : 'This will restore task data from this backup. Current tasks.json will be overwritten.'}
          </Typography>
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2, gap: 1 }}>
          <Button onClick={() => setConfirm(null)} sx={{ color: 'text.secondary' }}>Cancel</Button>
          <Button onClick={doRevert} variant="contained" color="error">
            Yes, {confirm?.type === 'commit' ? 'Revert' : 'Restore'}
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  )
}
