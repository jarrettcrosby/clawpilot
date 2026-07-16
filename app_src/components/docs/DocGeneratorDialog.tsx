'use client'

import { useEffect, useState } from 'react'
import Alert from '@mui/material/Alert'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Dialog from '@mui/material/Dialog'
import DialogActions from '@mui/material/DialogActions'
import DialogContent from '@mui/material/DialogContent'
import DialogTitle from '@mui/material/DialogTitle'
import FormControl from '@mui/material/FormControl'
import IconButton from '@mui/material/IconButton'
import InputLabel from '@mui/material/InputLabel'
import MenuItem from '@mui/material/MenuItem'
import Select from '@mui/material/Select'
import useMediaQuery from '@mui/material/useMediaQuery'
import { useTheme } from '@mui/material/styles'
import AutoAwesomeRounded from '@mui/icons-material/AutoAwesomeRounded'
import CloseRounded from '@mui/icons-material/CloseRounded'

type GeneratedDocumentKind = 'build-brief' | 'project-report' | 'pipeline-report' | 'research-radar'
type WorkspaceResource = { id: string; name: string }
type WorkspacePayload = {
  boards?: WorkspaceResource[]
  pipelines?: WorkspaceResource[]
  selectedBoardId?: string | null
  selectedPipelineId?: string | null
}
type GeneratedDocument = { id: string; title: string; slug: string }

type Props = {
  open: boolean
  onClose: () => void
  onGenerated: (document: GeneratedDocument) => void | Promise<void>
}

const DOCUMENT_TYPES: Array<{ value: GeneratedDocumentKind; label: string }> = [
  { value: 'project-report', label: 'Project board report' },
  { value: 'pipeline-report', label: 'Pipeline report' },
  { value: 'build-brief', label: 'Build and release brief' },
  { value: 'research-radar', label: 'AI and opportunity radar' },
]

export default function DocGeneratorDialog({ open, onClose, onGenerated }: Props) {
  const theme = useTheme()
  const narrowScreen = useMediaQuery(theme.breakpoints.down('sm'))
  const [kind, setKind] = useState<GeneratedDocumentKind>('project-report')
  const [boards, setBoards] = useState<WorkspaceResource[]>([])
  const [pipelines, setPipelines] = useState<WorkspaceResource[]>([])
  const [boardId, setBoardId] = useState('')
  const [pipelineId, setPipelineId] = useState('')
  const [loading, setLoading] = useState(false)
  const [generating, setGenerating] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!open) return
    const controller = new AbortController()
    setLoading(true)
    setError('')
    void fetch('/api/workspaces', { signal: controller.signal })
      .then(async (response) => {
        const payload = await response.json() as WorkspacePayload & { error?: string }
        if (!response.ok) throw new Error(payload.error || 'Unable to load document sources')
        const nextBoards = Array.isArray(payload.boards) ? payload.boards : []
        const nextPipelines = Array.isArray(payload.pipelines) ? payload.pipelines : []
        setBoards(nextBoards)
        setPipelines(nextPipelines)
        setBoardId(payload.selectedBoardId || nextBoards[0]?.id || '')
        setPipelineId(payload.selectedPipelineId || nextPipelines[0]?.id || '')
      })
      .catch((requestError) => {
        if (requestError instanceof DOMException && requestError.name === 'AbortError') return
        setError(requestError instanceof Error ? requestError.message : 'Unable to load document sources')
      })
      .finally(() => setLoading(false))
    return () => controller.abort()
  }, [open])

  async function generate() {
    setGenerating(true)
    setError('')
    try {
      const response = await fetch('/api/docs/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind, boardId: boardId || null, pipelineId: pipelineId || null }),
      })
      const payload = await response.json() as { document?: GeneratedDocument; error?: string }
      if (!response.ok || !payload.document) throw new Error(payload.error || 'Unable to generate document')
      await onGenerated(payload.document)
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Unable to generate document')
    } finally {
      setGenerating(false)
    }
  }

  const sourceMissing = kind === 'project-report'
    ? !boardId
    : kind === 'pipeline-report'
      ? !pipelineId
      : false

  return (
    <Dialog
      open={open}
      onClose={generating ? undefined : onClose}
      fullWidth
      maxWidth="sm"
      fullScreen={narrowScreen}
      PaperProps={{ sx: { backgroundColor: '#1A1A23', backgroundImage: 'none' } }}
    >
      <DialogTitle sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontWeight: 700 }}>
        New document
        <IconButton aria-label="Close new document" onClick={onClose} disabled={generating} sx={{ color: 'text.secondary' }}>
          <CloseRounded />
        </IconButton>
      </DialogTitle>
      <DialogContent dividers sx={{ borderColor: 'rgba(255,255,255,0.07)', pt: 3 }}>
        <Box sx={{ display: 'grid', gap: 2.5 }}>
          {error && <Alert severity="error">{error}</Alert>}
          <FormControl fullWidth disabled={loading || generating}>
            <InputLabel id="document-type-label">Document type</InputLabel>
            <Select
              labelId="document-type-label"
              label="Document type"
              value={kind}
              onChange={(event) => setKind(event.target.value as GeneratedDocumentKind)}
            >
              {DOCUMENT_TYPES.map((option) => <MenuItem key={option.value} value={option.value}>{option.label}</MenuItem>)}
            </Select>
          </FormControl>
          {kind === 'project-report' && (
            <FormControl fullWidth disabled={loading || generating}>
              <InputLabel id="document-board-label">Board</InputLabel>
              <Select
                labelId="document-board-label"
                label="Board"
                value={boardId}
                onChange={(event) => setBoardId(String(event.target.value))}
              >
                {boards.map((board) => <MenuItem key={board.id} value={board.id}>{board.name}</MenuItem>)}
              </Select>
            </FormControl>
          )}
          {kind === 'pipeline-report' && (
            <FormControl fullWidth disabled={loading || generating}>
              <InputLabel id="document-pipeline-label">Pipeline</InputLabel>
              <Select
                labelId="document-pipeline-label"
                label="Pipeline"
                value={pipelineId}
                onChange={(event) => setPipelineId(String(event.target.value))}
              >
                {pipelines.map((pipeline) => <MenuItem key={pipeline.id} value={pipeline.id}>{pipeline.name}</MenuItem>)}
              </Select>
            </FormControl>
          )}
        </Box>
      </DialogContent>
      <DialogActions sx={{ px: { xs: 2, sm: 3 }, py: 2, pb: { xs: 'calc(env(safe-area-inset-bottom) + 16px)', sm: 2 } }}>
        <Button onClick={onClose} disabled={generating} color="inherit">Cancel</Button>
        <Button
          variant="contained"
          startIcon={<AutoAwesomeRounded />}
          onClick={() => void generate()}
          disabled={loading || generating || sourceMissing}
        >
          {generating ? 'Generating' : 'Generate'}
        </Button>
      </DialogActions>
    </Dialog>
  )
}
