'use client'

import { useState, useCallback, useRef } from 'react'
import useMediaQuery from '@mui/material/useMediaQuery'
import Drawer from '@mui/material/Drawer'
import Box from '@mui/material/Box'
import Typography from '@mui/material/Typography'
import Chip from '@mui/material/Chip'
import Divider from '@mui/material/Divider'
import IconButton from '@mui/material/IconButton'
import Stack from '@mui/material/Stack'
import TextField from '@mui/material/TextField'
import Button from '@mui/material/Button'
import Tooltip from '@mui/material/Tooltip'
import Popover from '@mui/material/Popover'
import Collapse from '@mui/material/Collapse'
import Dialog from '@mui/material/Dialog'
import DialogTitle from '@mui/material/DialogTitle'
import DialogContent from '@mui/material/DialogContent'
import DialogActions from '@mui/material/DialogActions'
import MenuItem from '@mui/material/MenuItem'
import Select from '@mui/material/Select'
import Checkbox from '@mui/material/Checkbox'
import LinearProgress from '@mui/material/LinearProgress'
import Alert from '@mui/material/Alert'
import Link from '@mui/material/Link'
import CloseRounded from '@mui/icons-material/CloseRounded'
import ArchiveRounded from '@mui/icons-material/ArchiveRounded'
import FlagRounded from '@mui/icons-material/FlagRounded'
import SwapHorizRounded from '@mui/icons-material/SwapHorizRounded'
import AddCircleOutlineRounded from '@mui/icons-material/AddCircleOutlineRounded'
import LabelRounded from '@mui/icons-material/LabelRounded'
import AccessTimeRounded from '@mui/icons-material/AccessTimeRounded'
import EditRounded from '@mui/icons-material/EditRounded'
import CheckRounded from '@mui/icons-material/CheckRounded'
import ChatBubbleOutlineRounded from '@mui/icons-material/ChatBubbleOutlineRounded'
import SendRounded from '@mui/icons-material/SendRounded'
import AddRounded from '@mui/icons-material/AddRounded'
import DeleteOutlineRounded from '@mui/icons-material/DeleteOutlineRounded'
import CodeRounded from '@mui/icons-material/CodeRounded'
import ContentCopyRounded from '@mui/icons-material/ContentCopyRounded'
import IosShareRounded from '@mui/icons-material/IosShareRounded'
import CheckBoxRounded from '@mui/icons-material/CheckBoxRounded'
import PersonRounded from '@mui/icons-material/PersonRounded'
import SmartToyRounded from '@mui/icons-material/SmartToyRounded'
import CalendarTodayRounded from '@mui/icons-material/CalendarTodayRounded'
import CheckBoxOutlined from '@mui/icons-material/CheckBoxOutlined'
import OpenInNewRounded from '@mui/icons-material/OpenInNewRounded'
import { useUserDateTime } from '@/components/timezone/UserDateTimeProvider'
import type { Task, ChecklistItem, Comment } from '@/lib/types'
import { ASSIGNABLE_PRODUCT_AGENT_IDS, PRIORITY_COLORS, PRIORITY_LABELS, STATUS_LABELS, AVAILABLE_LABELS, COLUMNS, PEOPLE, CATEGORY_OPTIONS } from '@/lib/types'
import { displayCategory } from '@/lib/format'
import { formatUserDateTime, type UserDateTimeSettings } from '@/lib/userDateTime'

type Props = {
  task: Task | null
  open: boolean
  onClose: () => void
  onUpdate?: (t: Task) => void
  onArchive?: (t: Task) => void
  readOnly?: boolean
}

type NavigatorShare = Navigator & { share?: (data: { text: string; title?: string }) => Promise<void> }
type NextActionEditorProps = {
  initialValue: string
  onSave: (value: string) => void
}

function formatDate(iso: string, settings: UserDateTimeSettings) {
  return formatUserDateTime(iso, settings, {
    month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', fallback: 'Unknown date',
  })
}

function ActivityIcon({ type }: { type: string }) {
  const sx = { fontSize: 15 }
  if (type === 'moved') return <SwapHorizRounded sx={{ ...sx, color: '#A8C7FA' }} />
  if (type === 'label_added' || type === 'label_removed') return <LabelRounded sx={{ ...sx, color: '#CFC6EA' }} />
  if (type === 'created') return <AddCircleOutlineRounded sx={{ ...sx, color: '#66BB6A' }} />
  if (type === 'comment') return <ChatBubbleOutlineRounded sx={{ ...sx, color: '#FFA726' }} />
  if (type === 'checklist') return <CheckBoxRounded sx={{ ...sx, color: '#AB47BC' }} />
  return <AccessTimeRounded sx={{ ...sx, color: 'rgba(255,255,255,0.3)' }} />
}

function PersonAvatar({ personId, size = 28 }: { personId?: string; size?: number }) {
  const person = PEOPLE.find(p => p.id === personId || p.name === personId)
  if (!person) return null

  const botIds = new Set(['clawpilot', 'projects', 'pipeline', 'docs', 'calendar'])
  const isBot = botIds.has(person.id)

  return (
    <Tooltip title={person.name}>
      <Box
        sx={{
          width: size,
          height: size,
          borderRadius: '50%',
          backgroundColor: person.color + '22',
          border: `1px solid ${person.color}44`,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexShrink: 0,
          cursor: 'default',
        }}
      >
        {isBot ? (
          <SmartToyRounded sx={{ fontSize: size > 24 ? 16 : 14, color: person.color }} />
        ) : (
          <Typography variant="caption" sx={{ color: person.color, fontWeight: 700, fontSize: size > 24 ? '0.7rem' : '0.6rem' }}>
            {person.initials.slice(0, 1)}
          </Typography>
        )}
      </Box>
    </Tooltip>
  )
}

const selectSx = {
  fontSize: '0.8rem', backgroundColor: '#232330', borderRadius: 2, color: 'text.primary',
  '& .MuiOutlinedInput-notchedOutline': { borderColor: 'rgba(255,255,255,0.12)' },
  '&:hover .MuiOutlinedInput-notchedOutline': { borderColor: 'rgba(255,255,255,0.24)' },
  '&.Mui-focused .MuiOutlinedInput-notchedOutline': { borderColor: '#A8C7FA' },
  '& .MuiSelect-select': { py: 0.75, px: 1.25 },
  '& .MuiSvgIcon-root': { color: 'text.disabled' },
}
const menuPaper = { PaperProps: { sx: { backgroundColor: '#232330', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 2, mt: 0.5 } } }

function NextActionEditor({ initialValue, onSave }: NextActionEditorProps) {
  const [value, setValue] = useState(initialValue)

  return (
    <Stack direction="row" spacing={1} alignItems="center" sx={{ flex: 1 }}>
      <TextField
        size="small"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            onSave(value.trim())
          }
        }}
        placeholder="Set next action"
        sx={{
          flex: 1,
          '& .MuiOutlinedInput-root': {
            backgroundColor: '#232330',
            borderRadius: 2,
            fontSize: '0.78rem',
          },
        }}
      />
      <Button
        size="small"
        variant="outlined"
        onClick={() => onSave(value.trim())}
        sx={{ textTransform: 'none', minWidth: 64 }}
      >
        Set
      </Button>
    </Stack>
  )
}

// Highlight @mentions in comment text
async function tryCopyToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    // fall through to legacy copy
  }

  try {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.setAttribute('readonly', '')
    ta.style.position = 'fixed'
    ta.style.top = '0'
    ta.style.left = '0'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.focus()
    ta.select()
    const ok = document.execCommand('copy')
    document.body.removeChild(ta)
    return ok
  } catch {
    return false
  }
}

// Highlight @mentions in comment text
function renderCommentText(text: string) {
  const parts = text.split(/(@\w[\w\s-]*)/g)
  return parts.map((part, i) =>
    part.startsWith('@') ? (
      <Box key={i} component="span" sx={{ color: '#A8C7FA', fontWeight: 600, backgroundColor: 'rgba(168,199,250,0.1)', borderRadius: 0.5, px: 0.4 }}>{part}</Box>
    ) : part
  )
}

export default function CardDetailDrawer({ task, open, onClose, onUpdate, onArchive, readOnly = false }: Props) {
  const dateTimeSettings = useUserDateTime()
  const [editingTitle, setEditingTitle] = useState(false)
  const [titleVal, setTitleVal] = useState('')
  const [editingDesc, setEditingDesc] = useState(false)
  const [descVal, setDescVal] = useState('')
  const [commentText, setCommentText] = useState('')
  const [editingCommentId, setEditingCommentId] = useState<string | null>(null)
  const [editingCommentText, setEditingCommentText] = useState('')
  const [mentionAnchor, setMentionAnchor] = useState<HTMLElement | null>(null)
  const [labelAnchor, setLabelAnchor] = useState<HTMLElement | null>(null)
  const [expandedJson, setExpandedJson] = useState<string | null>(null)
  const [copyFallbackText, setCopyFallbackText] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [patchError, setPatchError] = useState('')
  const [newCheckItem, setNewCheckItem] = useState('')
  const [checkItemAssignee, setCheckItemAssignee] = useState('')
  const [checkItemDue, setCheckItemDue] = useState('')
  const [showCheckAdd, setShowCheckAdd] = useState(false)
  const [editingChecklistId, setEditingChecklistId] = useState<string | null>(null)
  const [editCheckText, setEditCheckText] = useState('')
  const [editCheckAssignee, setEditCheckAssignee] = useState('')
  const [editCheckDue, setEditCheckDue] = useState('')
  const commentRef = useRef<HTMLInputElement>(null)
  const touchLandscape = useMediaQuery('(orientation: landscape) and (pointer: coarse)')
  const shortLandscape = useMediaQuery('(orientation: landscape) and (max-height: 500px) and (max-width: 899.95px)')

  const patch = useCallback(async (payload: Record<string, unknown>) => {
    if (!task) return
    if (readOnly) {
      setPatchError('This board is view-only.')
      return null
    }
    setSaving(true)
    setPatchError('')
    try {
      const response = await fetch('/api/tasks', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: task.id, _actor: 'Jarrett', ...payload }) })
      const result = await response.json()
      if (!response.ok) throw new Error(result.operatorMessage || result.error || 'Unable to update task.')
      onUpdate?.(result as Task)
      return result as Task
    } catch (error) {
      setPatchError(error instanceof Error ? error.message : 'Unable to update task.')
      return null
    } finally {
      setSaving(false)
    }
  }, [task, onUpdate, readOnly])

  async function archiveCard() {
    if (!task || readOnly) return
    const res = await fetch('/api/tasks', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: task.id, _archive: true, _actor: 'ClawPilot' }),
    })
    const updated: Task = await res.json()
    onArchive?.(updated)
    onClose()
  }

  if (!task) return null
  const agentDispatch = task.execution?.agentDispatch
  const agentResponding = agentDispatch?.status === 'queued' || agentDispatch?.status === 'running'
  const generatedCrmCard = Boolean(task.crm)
  const displayedDescription = task.crm?.description ?? task.desc

  const saveTitle = () => { if (titleVal.trim() && titleVal !== task.title) patch({ title: titleVal.trim() }); setEditingTitle(false) }
  const saveDesc = () => {
    if (descVal !== displayedDescription) {
      patch(task.crm
        ? { crmDescription: descVal, crmDescriptionHash: task.crm.descriptionHash }
        : { desc: descVal })
    }
    setEditingDesc(false)
  }

  const handleCommentKey = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === '@') {
      setMentionAnchor(commentRef.current)
    }
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submitComment() }
  }

  const submitComment = async () => {
    const text = commentText.trim()
    if (!text) return
    setCommentText('')
    await patch({ _comment: text })
  }

  async function assignTask(agentId: string) {
    await patch({ assignedAgent: agentId })
  }

  const saveEditedComment = () => {
    if (!editingCommentId || !editingCommentText.trim()) return
    patch({ _editCommentId: editingCommentId, _editCommentText: editingCommentText.trim() })
    setEditingCommentId(null)
    setEditingCommentText('')
  }

  const insertMention = (name: string) => {
    setCommentText(prev => prev + name + ' ')
    setMentionAnchor(null)
    commentRef.current?.focus()
  }

  const addChecklistItem = () => {
    if (!newCheckItem.trim()) return
    patch({ _checklistAdd: { text: newCheckItem.trim(), assignee: checkItemAssignee || undefined, dueDate: checkItemDue || undefined } })
    setNewCheckItem(''); setCheckItemAssignee(''); setCheckItemDue(''); setShowCheckAdd(false)
  }

  const startEditChecklist = (item: ChecklistItem) => {
    setEditingChecklistId(item.id)
    setEditCheckText(item.text || '')
    setEditCheckAssignee(item.assignee || '')
    setEditCheckDue(item.dueDate || '')
  }

  const saveChecklistEdit = () => {
    if (!editingChecklistId) return
    patch({ _checklistUpdate: { id: editingChecklistId, text: editCheckText.trim(), assignee: editCheckAssignee || undefined, dueDate: editCheckDue || undefined } })
    setEditingChecklistId(null)
    setEditCheckText('')
    setEditCheckAssignee('')
    setEditCheckDue('')
  }

  const doneCount = (task.checklist || []).filter(c => c.done).length
  const totalCount = (task.checklist || []).length
  const progress = totalCount > 0 ? Math.round((doneCount / totalCount) * 100) : 0
  const visibleLabels = (task.tags || []).filter((tag) => AVAILABLE_LABELS.some((label) => label.id === tag))

  return (
    <Drawer anchor="right" open={open} onClose={onClose} PaperProps={{
      sx: {
        width: shortLandscape ? '100vw' : touchLandscape ? { xs: '96vw', sm: 520 } : { xs: '100vw', sm: 480 },
        maxWidth: '100vw',
        height: '100dvh',
        backgroundColor: '#1A1A23',
        borderLeft: '1px solid rgba(255,255,255,0.08)',
        display: 'flex',
        flexDirection: 'column',
      }
    }}>
      {/* Header */}
      <Box sx={{ px: shortLandscape ? 1.5 : 3, pt: shortLandscape ? 1 : 3, pb: shortLandscape ? 1 : 2, borderBottom: '1px solid rgba(255,255,255,0.06)', flexShrink: 0 }}>
        <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <Stack direction="row" spacing={1} alignItems="center" mb={1.5}>
            <FlagRounded sx={{ fontSize: 16, color: PRIORITY_COLORS[task.priority] }} />
            <Typography variant="overline" sx={{ color: PRIORITY_COLORS[task.priority], fontSize: '0.65rem', letterSpacing: 1.5 }}>{PRIORITY_LABELS[task.priority]}</Typography>
          </Stack>
          <Box sx={{ display: 'flex', gap: 0.5 }}>
            {!readOnly ? <Tooltip title={generatedCrmCard ? 'CRM cards remain available while the CRM record is active' : 'Archive card'}>
              <span><IconButton disabled={generatedCrmCard} onClick={archiveCard} sx={{ color: 'text.disabled', mt: -0.5 }}><ArchiveRounded sx={{ fontSize: 20 }} /></IconButton></span>
            </Tooltip> : null}
            <IconButton aria-label="Close drawer" onClick={onClose} sx={{ color: 'text.disabled', mt: -0.5 }}><CloseRounded /></IconButton>
          </Box>
        </Box>
        {editingTitle ? (
          <Box sx={{ display: 'flex', gap: 1 }}>
            <TextField autoFocus fullWidth multiline maxRows={3} value={titleVal} onChange={e => setTitleVal(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); saveTitle() } if (e.key === 'Escape') setEditingTitle(false) }}
              size="small" sx={{ '& .MuiOutlinedInput-root': { fontSize: '1.05rem', fontWeight: 700, backgroundColor: '#232330', borderRadius: 2 } }} />
            <IconButton size="small" onClick={saveTitle} sx={{ color: '#66BB6A' }}><CheckRounded /></IconButton>
          </Box>
        ) : (
          <Box sx={{ display: 'flex', gap: 1, cursor: readOnly || generatedCrmCard ? 'default' : 'pointer', '&:hover .ei': { opacity: readOnly || generatedCrmCard ? 0 : 1 } }} onClick={() => { if (!readOnly && !generatedCrmCard) { setTitleVal(task.title); setEditingTitle(true) } }}>
            <Typography variant="h6" fontWeight={700} color="text.primary" sx={{ lineHeight: 1.3, flex: 1 }}>{task.title}</Typography>
            <EditRounded className="ei" sx={{ fontSize: 16, color: 'text.disabled', opacity: 0, transition: 'opacity 0.15s', mt: 0.5, flexShrink: 0 }} />
          </Box>

        )}
      </Box>


      <Box sx={{ flex: 1, minHeight: 0, overflow: 'auto', px: shortLandscape ? 1.5 : { xs: 2, sm: 3 }, py: shortLandscape ? 1.25 : 2.5, pb: 'calc(env(safe-area-inset-bottom) + 20px)', display: 'flex', flexDirection: 'column', gap: shortLandscape ? 1.5 : 2.5, WebkitOverflowScrolling: 'touch' }}>

        {patchError && <Alert severity="warning" onClose={() => setPatchError('')} sx={{ borderRadius: 1 }}>{patchError}</Alert>}

        {/* Details */}
        <Box>
          <Typography variant="overline" color="text.disabled" sx={{ fontSize: '0.65rem', letterSpacing: 1.5, display: 'block', mb: 1.5 }}>DETAILS</Typography>
          <Stack spacing={1.25}>
            <Stack direction="row" alignItems="center" spacing={2}>
              <Typography variant="body2" color="text.disabled" sx={{ minWidth: 80, fontSize: '0.8rem' }}>Status</Typography>
              <Select disabled={readOnly} size="small" value={task.status} onChange={e => patch({ status: e.target.value })} sx={selectSx} MenuProps={menuPaper}>
                {COLUMNS.map(c => (
                  <MenuItem key={c.status} value={c.status} sx={{ fontSize: '0.8rem', '&:hover': { backgroundColor: 'rgba(168,199,250,0.08)' } }}>
                    <Stack direction="row" spacing={1} alignItems="center">
                      <Box sx={{ width: 8, height: 8, borderRadius: '50%', backgroundColor: c.color }} />
                      <span>{STATUS_LABELS[c.status]}</span>
                    </Stack>
                  </MenuItem>
                ))}
              </Select>
            </Stack>
            <Stack direction="row" alignItems="center" spacing={2}>
              <Typography variant="body2" color="text.disabled" sx={{ minWidth: 80, fontSize: '0.8rem' }}>Priority</Typography>
              <Select disabled={readOnly} size="small" value={task.priority} onChange={e => patch({ priority: e.target.value })} sx={selectSx} MenuProps={menuPaper}>
                {(['high','medium','low'] as const).map(p => (
                  <MenuItem key={p} value={p} sx={{ fontSize: '0.8rem', '&:hover': { backgroundColor: 'rgba(168,199,250,0.08)' } }}>
                    <Stack direction="row" spacing={1} alignItems="center">
                      <FlagRounded sx={{ fontSize: 14, color: PRIORITY_COLORS[p] }} />
                      <span style={{ color: PRIORITY_COLORS[p] }}>{PRIORITY_LABELS[p]}</span>
                    </Stack>
                  </MenuItem>
                ))}
              </Select>
            </Stack>
            <Stack direction="row" alignItems="center" spacing={2}>
              <Typography variant="body2" color="text.disabled" sx={{ minWidth: 80, fontSize: '0.8rem' }}>Category</Typography>
              <Select disabled={readOnly} size="small" value={task.category} onChange={e => patch({ category: e.target.value })} sx={selectSx} MenuProps={menuPaper}>
                {CATEGORY_OPTIONS.map(c => (
                  <MenuItem key={c} value={c} sx={{ fontSize: '0.8rem', '&:hover': { backgroundColor: 'rgba(168,199,250,0.08)' } }}>{displayCategory(c)}</MenuItem>
                ))}
              </Select>
            </Stack>
            <Stack direction="row" alignItems="center" spacing={2}>
              <Typography variant="body2" color="text.disabled" sx={{ minWidth: 80, fontSize: '0.8rem' }}>Assignee</Typography>
              <Select disabled={readOnly} size="small" value={task.assignedAgent || ''} onChange={e => { void assignTask(String(e.target.value)) }} sx={selectSx} MenuProps={menuPaper} displayEmpty renderValue={v => v ? (
                <Stack direction="row" spacing={1} alignItems="center">
                  <PersonAvatar personId={v as string} size={20} />
                  <span>{PEOPLE.find(p => p.id === v)?.name || PEOPLE.find(p => p.name === v)?.name || v as string}</span>
                </Stack>
              ) : <Typography variant="body2" color="text.disabled" sx={{ fontSize: '0.8rem' }}>Unassigned</Typography>}>
                <MenuItem value="" sx={{ fontSize: '0.8rem' }}>Unassigned</MenuItem>
                {PEOPLE.filter(p => ASSIGNABLE_PRODUCT_AGENT_IDS.includes(p.id as typeof ASSIGNABLE_PRODUCT_AGENT_IDS[number])).map(p => (
                  <MenuItem key={p.id} value={p.id} sx={{ fontSize: '0.8rem', '&:hover': { backgroundColor: 'rgba(168,199,250,0.08)' } }}>
                    <Stack direction="row" spacing={1} alignItems="center">
                      <PersonAvatar personId={p.id} size={22} />
                      <span>{p.name}</span>
                    </Stack>
                  </MenuItem>
                ))}
              </Select>
            </Stack>
            <Stack direction="row" alignItems="center" spacing={2}>
              <Typography variant="body2" color="text.disabled" sx={{ minWidth: 80, fontSize: '0.8rem' }}>Next action</Typography>
              <NextActionEditor
                key={`${task.id}:${task.workItem?.nextAction || ''}`}
                initialValue={task.workItem?.nextAction || ''}
                onSave={(value) => patch({ nextAction: value })}
              />
            </Stack>
            {(task.workItem?.lastConcreteAction || task.workItem?.waitingOn) && (
              <Box sx={{ ml: '80px', p: 1, borderRadius: 1.5, backgroundColor: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.06)' }}>
                {task.workItem?.lastConcreteAction && (
                  <Typography variant="caption" color="text.secondary" sx={{ display: 'block', lineHeight: 1.4 }}>
                    <Box component="span" sx={{ color: 'text.disabled' }}>Last action:</Box> {task.workItem.lastConcreteAction}
                  </Typography>
                )}
                {task.workItem?.waitingOn && (
                  <Typography variant="caption" color="text.secondary" sx={{ display: 'block', lineHeight: 1.4, mt: task.workItem?.lastConcreteAction ? 0.5 : 0 }}>
                    <Box component="span" sx={{ color: 'text.disabled' }}>Waiting on:</Box> {task.workItem.waitingOn}
                  </Typography>
                )}
              </Box>
            )}
            <Stack direction="row" alignItems="center" spacing={2}>
              <Typography variant="body2" color="text.disabled" sx={{ minWidth: 80, fontSize: '0.8rem' }}>Due Date</Typography>
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                <Box sx={{ position: 'relative' }}>
                  <Box component="input" disabled={readOnly} type="date" value={task.dueDate || ''} onChange={(e: React.ChangeEvent<HTMLInputElement>) => patch({ dueDate: e.target.value })}
                    sx={{ backgroundColor: '#232330', border: '1px solid rgba(255,255,255,0.12)', borderRadius: 2, color: 'white', px: 1.25, py: 0.75, fontSize: '0.8rem', outline: 'none', cursor: 'pointer', minWidth: 150,
                      '&::-webkit-calendar-picker-indicator': { filter: 'invert(0.6)', cursor: 'pointer' },
                      '&:hover': { borderColor: 'rgba(255,255,255,0.24)' } }} />
                  {!task.dueDate && (
                    <Typography variant="caption" sx={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: 'rgba(255,255,255,0.45)', pointerEvents: 'none', fontSize: '0.72rem' }}>
                      MM/DD/YYYY
                    </Typography>
                  )}
                </Box>
                {task.dueDate && (
                  <IconButton disabled={readOnly} size="small" onClick={() => patch({ dueDate: '' })} sx={{ p: 0.25, color: 'text.disabled', '&:hover': { color: '#EF5350' } }}>
                    <CloseRounded sx={{ fontSize: 14 }} />
                  </IconButton>
                )}
              </Box>
            </Stack>
          </Stack>
        </Box>

        <Divider sx={{ borderColor: 'rgba(255,255,255,0.06)' }} />

        {/* Labels */}
        <Box>
          <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 1 }}>
            <Typography variant="overline" color="text.disabled" sx={{ fontSize: '0.65rem', letterSpacing: 1.5 }}>LABELS</Typography>
            <IconButton disabled={readOnly} size="small" onClick={e => setLabelAnchor(e.currentTarget)} sx={{ color: 'text.disabled', '&:hover': { color: '#A8C7FA' } }}>
              <AddRounded sx={{ fontSize: 16 }} />
            </IconButton>
          </Box>
          <Stack direction="row" flexWrap="wrap" gap={0.75}>
            {visibleLabels.length === 0 && <Typography variant="caption" color="text.disabled">No labels — tap + to add</Typography>}
            {visibleLabels.map(tag => {
              const def = AVAILABLE_LABELS.find(l => l.id === tag)
              return <Chip key={tag} size="small" label={def?.label || tag} onDelete={() => { const next = (task.tags||[]).filter(t=>t!==tag); patch({ tags: next }) }}
                sx={{ height: 24, fontSize: '0.7rem', borderRadius: 1.5, border: 'none', backgroundColor: (def?.color||'#A8C7FA')+'22', color: def?.color||'#A8C7FA', '& .MuiChip-deleteIcon': { fontSize: 14, color: def?.color||'#A8C7FA', opacity: 0.7 } }} />
            })}
          </Stack>
          <Popover open={Boolean(labelAnchor)} anchorEl={labelAnchor} onClose={() => setLabelAnchor(null)} anchorOrigin={{ vertical: 'bottom', horizontal: 'left' }}
            PaperProps={{ sx: { backgroundColor: '#232330', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 2, p: 1.5, width: 260 } }}>
            <Typography variant="overline" color="text.disabled" sx={{ fontSize: '0.65rem', letterSpacing: 1.5, display: 'block', mb: 1 }}>ALL LABELS</Typography>
            <Stack direction="row" flexWrap="wrap" gap={0.75}>
              {AVAILABLE_LABELS.map(l => {
                const active = (task.tags||[]).includes(l.id)
                return <Chip key={l.id} size="small" label={l.label} onClick={() => { const cur=task.tags||[]; patch({ tags: active?cur.filter(t=>t!==l.id):[...cur,l.id] }) }}
                  sx={{ height: 26, fontSize: '0.72rem', borderRadius: 1.5, cursor: 'pointer', border: 'none', backgroundColor: active?l.color+'33':'rgba(255,255,255,0.06)', color: active?l.color:'rgba(255,255,255,0.5)', outline: active?`1px solid ${l.color}55`:'none', transition: 'all 0.15s', '&:hover': { backgroundColor: l.color+'22', color: l.color } }} />
              })}
            </Stack>
          </Popover>
        </Box>

        <Divider sx={{ borderColor: 'rgba(255,255,255,0.06)' }} />

        {/* Description */}
        <Box>
          {task.crm && (
            <Stack spacing={1.1} sx={{ mb: 2, p: 1.5, border: '1px solid rgba(168,199,250,0.18)', borderRadius: 2, backgroundColor: 'rgba(168,199,250,0.035)' }}>
              <Typography variant="overline" color="text.disabled" sx={{ fontSize: '0.65rem', letterSpacing: 1.5 }}>CRM RECORD</Typography>
              <Stack direction={{ xs: 'column', sm: 'row' }} gap={{ xs: 0.25, sm: 1 }}>
                <Typography variant="caption" color="text.disabled" sx={{ minWidth: 104 }}>Global ID</Typography>
                <Link href={task.crm.recordUrl} target="_blank" rel="noreferrer" underline="hover" sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.5, fontSize: '0.82rem' }}>
                  {task.crm.referenceCode}<OpenInNewRounded sx={{ fontSize: 14 }} />
                </Link>
              </Stack>
              {task.crm.entity === 'contacts' && (
                <Stack direction={{ xs: 'column', sm: 'row' }} gap={{ xs: 0.25, sm: 1 }}>
                  <Typography variant="caption" color="text.disabled" sx={{ minWidth: 104 }}>Contact</Typography>
                  <Link href={task.crm.recordUrl} target="_blank" rel="noreferrer" underline="hover" sx={{ fontSize: '0.82rem' }}>{task.crm.recordName}</Link>
                </Stack>
              )}
              <Stack direction={{ xs: 'column', sm: 'row' }} gap={{ xs: 0.25, sm: 1 }}>
                <Typography variant="caption" color="text.disabled" sx={{ minWidth: 104 }}>Account Name</Typography>
                <Link href={task.crm.accountUrl} target="_blank" rel="noreferrer" underline="hover" sx={{ fontSize: '0.82rem' }}>{task.crm.accountName}</Link>
              </Stack>
              <Stack direction={{ xs: 'column', sm: 'row' }} gap={{ xs: 0.25, sm: 1 }}>
                <Typography variant="caption" color="text.disabled" sx={{ minWidth: 104 }}>Email</Typography>
                {task.crm.email && task.crm.emailUrl ? (
                  <Link href={task.crm.emailUrl} target="_blank" rel="noreferrer" underline="hover" sx={{ fontSize: '0.82rem', overflowWrap: 'anywhere' }}>{task.crm.email}</Link>
                ) : <Typography variant="body2" color="text.disabled">Not set</Typography>}
              </Stack>
              {task.crm.syncStatus === 'conflict' && (
                <Alert severity="warning" sx={{ mt: 0.5 }}>Card and CRM descriptions both changed. Neither version was overwritten.</Alert>
              )}
            </Stack>
          )}
          <Typography variant="overline" color="text.disabled" sx={{ fontSize: '0.65rem', letterSpacing: 1.5, display: 'block', mb: 1 }}>DESCRIPTION</Typography>
          {editingDesc ? (
            <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
              <TextField multiline minRows={3} maxRows={8} fullWidth value={descVal} onChange={e => setDescVal(e.target.value)}
                onKeyDown={e => { if (e.key === 'Escape') setEditingDesc(false) }} placeholder="Add a description..."
                sx={{ '& .MuiOutlinedInput-root': { fontSize: '0.875rem', backgroundColor: '#232330', borderRadius: 2, '& fieldset': { borderColor: 'rgba(255,255,255,0.08)' }, '&.Mui-focused fieldset': { borderColor: '#A8C7FA' } } }} />
              <Stack direction="row" spacing={1}>
                <Button size="small" variant="contained" onClick={saveDesc} disabled={saving}
                  sx={{ borderRadius: 2, textTransform: 'none', fontWeight: 600, backgroundColor: '#A8C7FA', color: '#001D36', fontSize: '0.8rem' }}>Save</Button>
                <Button size="small" onClick={() => setEditingDesc(false)} sx={{ borderRadius: 2, textTransform: 'none', color: 'text.secondary', fontSize: '0.8rem' }}>Cancel</Button>
              </Stack>
            </Box>
          ) : (
            <Box onClick={() => { if (!readOnly) { setDescVal(displayedDescription); setEditingDesc(true) } }}
              sx={{ cursor: readOnly ? 'default' : 'pointer', p: 1.5, borderRadius: 2, border: '1px solid transparent', transition: 'border-color 0.15s', '&:hover': { borderColor: readOnly ? 'transparent' : 'rgba(255,255,255,0.1)', backgroundColor: readOnly ? 'transparent' : 'rgba(255,255,255,0.02)' } }}>
              <Typography variant="body2" color={displayedDescription ? 'text.secondary' : 'text.disabled'} sx={{ lineHeight: 1.7, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
                {displayedDescription || 'Click to add a description...'}
              </Typography>
            </Box>
          )}
        </Box>

        <Divider sx={{ borderColor: 'rgba(255,255,255,0.06)' }} />

        {/* Checklist */}
        <Box>
          <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 1 }}>
            <Stack direction="row" spacing={1} alignItems="center">
              <CheckBoxOutlined sx={{ fontSize: 16, color: 'text.disabled' }} />
              <Typography variant="overline" color="text.disabled" sx={{ fontSize: '0.65rem', letterSpacing: 1.5 }}>
                CHECKLIST
              </Typography>
            </Stack>
            {!readOnly ? <Button size="small" onClick={() => setShowCheckAdd(v => !v)} sx={{ textTransform: 'none', fontSize: '0.72rem', color: '#A8C7FA' }}>
              {showCheckAdd ? 'Cancel' : 'Add item'}
            </Button> : null}
          </Box>

          {totalCount > 0 && (
            <Box sx={{ mb: 1.25 }}>
              <Stack direction="row" spacing={1} alignItems="center" mb={0.5}>
                <Typography variant="caption" color="text.disabled">{doneCount}/{totalCount} complete</Typography>
                <Typography variant="caption" color="text.disabled">{progress}%</Typography>
              </Stack>
              <LinearProgress variant="determinate" value={progress} sx={{ height: 6, borderRadius: 6, backgroundColor: 'rgba(255,255,255,0.08)', '& .MuiLinearProgress-bar': { backgroundColor: progress === 100 ? '#66BB6A' : '#A8C7FA' } }} />
            </Box>
          )}

          {showCheckAdd && (
            <Box sx={{ p: 1.25, mb: 1, borderRadius: 2, backgroundColor: '#232330', border: '1px solid rgba(255,255,255,0.08)' }}>
              <TextField size="small" fullWidth placeholder="Add checklist item" value={newCheckItem} onChange={e => setNewCheckItem(e.target.value)}
                sx={{ mb: 1, '& .MuiOutlinedInput-root': { backgroundColor: '#1A1A23', borderRadius: 2, fontSize: '0.85rem' } }} />
              <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} alignItems={{ xs: 'stretch', sm: 'center' }} mb={1}>
                <Select size="small" value={checkItemAssignee} onChange={e => setCheckItemAssignee(e.target.value)} displayEmpty sx={{ ...selectSx, minWidth: { xs: 0, sm: 160 }, width: { xs: '100%', sm: 'auto' } }} MenuProps={menuPaper}
                  renderValue={v => v ? (PEOPLE.find(p => p.id === v)?.name || v as string) : 'Assignee (optional)'}>
                  <MenuItem value="">Unassigned</MenuItem>
                  {PEOPLE.filter(p => ASSIGNABLE_PRODUCT_AGENT_IDS.includes(p.id as typeof ASSIGNABLE_PRODUCT_AGENT_IDS[number])).map(p => (
                    <MenuItem key={p.id} value={p.id}>{p.name}</MenuItem>
                  ))}
                </Select>
                <Box component="input" type="date" value={checkItemDue} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setCheckItemDue(e.target.value)}
                  sx={{ backgroundColor: '#1A1A23', border: '1px solid rgba(255,255,255,0.12)', borderRadius: 2, color: 'white', px: 1.25, py: 0.75, fontSize: '0.75rem', outline: 'none', cursor: 'pointer', minWidth: { xs: 0, sm: 150 }, width: { xs: '100%', sm: 'auto' }, boxSizing: 'border-box',
                    '&::-webkit-calendar-picker-indicator': { filter: 'invert(0.6)', cursor: 'pointer' } }} />
              </Stack>
              <Box sx={{ display: 'flex', justifyContent: 'flex-end', gap: 1 }}>
                <Button size="small" onClick={() => { setShowCheckAdd(false); setNewCheckItem(''); setCheckItemAssignee(''); setCheckItemDue('') }} sx={{ textTransform: 'none', color: 'text.secondary' }}>Cancel</Button>
                <Button size="small" variant="contained" onClick={addChecklistItem} disabled={!newCheckItem.trim()} sx={{ textTransform: 'none', backgroundColor: '#A8C7FA', color: '#001D36' }}>Add</Button>
              </Box>
            </Box>
          )}

          {(task.checklist || []).length === 0 && !showCheckAdd && (
            <Typography variant="caption" color="text.disabled">No checklist items</Typography>
          )}

          <Stack spacing={0.5}>
            {(task.checklist || []).map(it => (
              <Box key={it.id} sx={{ display: 'flex', alignItems: 'flex-start', gap: 1, py: 0.5, px: 0.5, borderRadius: 1, backgroundColor: 'rgba(255,255,255,0.02)' }}>
                <Checkbox disabled={readOnly} size="small" checked={!!it.done} onChange={() => patch({ _checklistToggle: it.id })} sx={{ p: 0.5 }} />
                <Box sx={{ flex: 1 }}>
                  {editingChecklistId === it.id ? (
                    <Box>
                      <TextField size="small" fullWidth value={editCheckText} onChange={(e) => setEditCheckText(e.target.value)}
                        sx={{ mb: 1, '& .MuiOutlinedInput-root': { backgroundColor: '#1A1A23', borderRadius: 2, fontSize: '0.85rem' } }} />
                      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} alignItems={{ xs: 'stretch', sm: 'center' }} mb={1}>
                        <Select size="small" value={editCheckAssignee} onChange={e => setEditCheckAssignee(e.target.value)} displayEmpty sx={{ ...selectSx, minWidth: { xs: 0, sm: 160 }, width: { xs: '100%', sm: 'auto' } }} MenuProps={menuPaper}
                          renderValue={v => v ? (PEOPLE.find(p => p.id === v)?.name || v as string) : 'Assignee (optional)'}>
                          <MenuItem value="">Unassigned</MenuItem>
                          {PEOPLE.filter(p => ASSIGNABLE_PRODUCT_AGENT_IDS.includes(p.id as typeof ASSIGNABLE_PRODUCT_AGENT_IDS[number])).map(p => (
                            <MenuItem key={p.id} value={p.id}>{p.name}</MenuItem>
                          ))}
                        </Select>
                        <Box component="input" type="date" value={editCheckDue} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setEditCheckDue(e.target.value)}
                          sx={{ backgroundColor: '#1A1A23', border: '1px solid rgba(255,255,255,0.12)', borderRadius: 2, color: 'white', px: 1.25, py: 0.75, fontSize: '0.75rem', outline: 'none', cursor: 'pointer', minWidth: { xs: 0, sm: 150 }, width: { xs: '100%', sm: 'auto' }, boxSizing: 'border-box',
                            '&::-webkit-calendar-picker-indicator': { filter: 'invert(0.6)', cursor: 'pointer' } }} />
                      </Stack>
                      <Stack direction="row" spacing={1}>
                        <Button size="small" variant="contained" onClick={saveChecklistEdit} disabled={!editCheckText.trim()} sx={{ textTransform: 'none', backgroundColor: '#A8C7FA', color: '#001D36' }}>Save</Button>
                        <Button size="small" onClick={() => { setEditingChecklistId(null); setEditCheckText(''); setEditCheckAssignee(''); setEditCheckDue('') }} sx={{ textTransform: 'none', color: 'text.secondary' }}>Cancel</Button>
                      </Stack>
                    </Box>
                  ) : (
                    <Box>
                      <Typography variant="body2" color={it.done ? 'text.disabled' : 'text.primary'} sx={{ fontSize: '0.85rem' }}>{it.text}</Typography>
                      <Box sx={{ display: 'flex', gap: 1, alignItems: 'center', mt: 0.25 }}>
                        {it.assignee && (
                          <Tooltip title={it.assignee}>
                            <PersonRounded sx={{ fontSize: 12, color: 'rgba(255,255,255,0.45)' }} />
                          </Tooltip>
                        )}
                        {it.dueDate && (
                          <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
                            <CalendarTodayRounded sx={{ fontSize: 12, color: 'rgba(255,255,255,0.45)' }} />
                            <Typography variant="caption" color="text.disabled">{new Date(it.dueDate).toLocaleDateString()}</Typography>
                          </Box>
                        )}
                      </Box>
                    </Box>
                  )}
                </Box>
                {editingChecklistId !== it.id && !readOnly && (
                  <Stack direction="row" spacing={0.25}>
                    <Tooltip title="Edit item">
                      <IconButton size="small" onClick={() => startEditChecklist(it)} sx={{ p: 0.25, color: 'rgba(255,255,255,0.2)', '&:hover': { color: '#A8C7FA' } }}>
                        <EditRounded sx={{ fontSize: 14 }} />
                      </IconButton>
                    </Tooltip>
                    <Tooltip title="Delete item">
                      <IconButton size="small" onClick={() => patch({ _checklistDelete: it.id })} sx={{ p: 0.25, color: 'rgba(255,255,255,0.2)', '&:hover': { color: '#EF5350' } }}>
                        <DeleteOutlineRounded sx={{ fontSize: 14 }} />
                      </IconButton>
                    </Tooltip>
                  </Stack>
                )}
              </Box>
            ))}
          </Stack>
        </Box>

        <Divider sx={{ borderColor: 'rgba(255,255,255,0.06)' }} />

        {/* Comments */}
        <Box>
          <Typography variant="overline" color="text.disabled" sx={{ fontSize: '0.65rem', letterSpacing: 1.5, display: 'block', mb: 1.5 }}>
            COMMENTS ({(task.comments||[]).length})
          </Typography>
          <Box sx={{ display: 'flex', gap: 1, mb: 2.5, alignItems: 'flex-end' }}>
            <TextField disabled={readOnly} inputRef={commentRef} multiline maxRows={4} fullWidth placeholder={readOnly ? 'View-only board' : 'Write a comment... (@ to mention)'} size="small"
              value={commentText} onChange={e => setCommentText(e.target.value)} onKeyDown={handleCommentKey}
              sx={{ '& .MuiOutlinedInput-root': { fontSize: '0.875rem', backgroundColor: '#232330', borderRadius: 2, '& fieldset': { borderColor: 'rgba(255,255,255,0.08)' }, '&.Mui-focused fieldset': { borderColor: '#A8C7FA' } } }} />
            <IconButton onClick={() => { void submitComment() }} disabled={readOnly||!commentText.trim()||saving} sx={{ color: commentText.trim()?'#A8C7FA':'text.disabled', mb: 0.25 }}>
              <SendRounded sx={{ fontSize: 20 }} />
            </IconButton>
          </Box>
          {agentResponding && (
            <Alert severity="info" sx={{ mb: 2, borderRadius: 1 }}>
              {agentDispatch?.status === 'queued'
                ? `${PEOPLE.find((person) => person.id === task.assignedAgent)?.name || 'Agent'} is queued.`
                : `${PEOPLE.find((person) => person.id === task.assignedAgent)?.name || 'Agent'} is responding.`}
            </Alert>
          )}
          {agentDispatch?.status === 'failed' && (
            <Alert severity="error" sx={{ mb: 2, borderRadius: 1 }}>
              {task.execution?.latestExecutionNote || 'Agent execution failed.'}
            </Alert>
          )}
          {/* @ mention picker */}
          <Popover open={Boolean(mentionAnchor)} anchorEl={mentionAnchor} onClose={() => setMentionAnchor(null)} anchorOrigin={{ vertical: 'top', horizontal: 'left' }}
            PaperProps={{ sx: { backgroundColor: '#232330', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 2, p: 0.5, minWidth: 180 } }}>
            <Typography variant="overline" color="text.disabled" sx={{ fontSize: '0.6rem', letterSpacing: 1.5, px: 1.5, py: 0.5, display: 'block' }}>MENTION</Typography>
            {PEOPLE.map(p => (
              <MenuItem key={p.id} onClick={() => insertMention(`@${p.name}`)}
                sx={{ borderRadius: 1.5, fontSize: '0.85rem', '&:hover': { backgroundColor: 'rgba(168,199,250,0.08)' } }}>
                <Stack direction="row" spacing={1.5} alignItems="center">
                  <Box sx={{ width: 28, height: 28, borderRadius: '50%', backgroundColor: p.color+'22', border: `1px solid ${p.color}44`, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    <Typography variant="caption" sx={{ color: p.color, fontWeight: 700, fontSize: '0.68rem' }}>{p.initials}</Typography>
                  </Box>
                  <Typography variant="body2">{p.name}</Typography>
                </Stack>
              </MenuItem>
            ))}
          </Popover>
          <Stack spacing={2}>
            {[...(task.comments||[])].reverse().map(c => (
              <Box key={c.id}>
                <Stack direction="row" spacing={1} alignItems="center" mb={0.75}>
                  {PersonAvatar({ personId: c.author, size: 28 }) || (
                    <Box sx={{ width: 28, height: 28, borderRadius: '50%', backgroundColor: 'rgba(255,255,255,0.06)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                      <Typography variant="caption" sx={{ color: 'text.disabled', fontWeight: 700, fontSize: '0.72rem' }}>{String(c.author || '?').slice(0, 1).toUpperCase()}</Typography>
                    </Box>
                  )}
                  <Box sx={{ flex: 1 }}>
                    <Typography variant="caption" color="text.primary" fontWeight={600}>{c.author}</Typography>
                    <Typography variant="caption" color="text.disabled" sx={{ ml: 1 }}>{formatDate((c as Comment).timestamp || (c as Comment).createdAt || task.updatedAt, dateTimeSettings)}</Typography>
                  </Box>
                  <Tooltip title="Edit comment">
                    <IconButton disabled={readOnly} size="small" onClick={() => { setEditingCommentId(c.id); setEditingCommentText(c.text || '') }}
                      sx={{ p: 0.5, color: 'rgba(255,255,255,0.2)', '&:hover': { color: '#A8C7FA' } }}>
                      <EditRounded sx={{ fontSize: 14 }} />
                    </IconButton>
                  </Tooltip>
                  <Tooltip title="Delete comment">
                    <IconButton disabled={readOnly} size="small" onClick={() => patch({ _deleteCommentId: c.id })}
                      sx={{ p: 0.5, color: 'rgba(255,255,255,0.2)', '&:hover': { color: '#EF5350' } }}>
                      <DeleteOutlineRounded sx={{ fontSize: 14 }} />
                    </IconButton>
                  </Tooltip>
                </Stack>
                <Box sx={{ ml: 4.5, backgroundColor: '#232330', borderRadius: 2, px: 2, py: 1.25 }}>
                  {editingCommentId === c.id ? (
                    <Box>
                      <TextField
                        fullWidth
                        multiline
                        minRows={2}
                        size="small"
                        value={editingCommentText}
                        onChange={(e) => setEditingCommentText(e.target.value)}
                        sx={{ mb: 1, '& .MuiOutlinedInput-root': { fontSize: '0.85rem', backgroundColor: '#1A1A23', borderRadius: 2 } }}
                      />
                      <Stack direction="row" spacing={1}>
                        <Button size="small" variant="contained" onClick={saveEditedComment} disabled={!editingCommentText.trim()} sx={{ textTransform: 'none', borderRadius: 2 }}>Save</Button>
                        <Button size="small" onClick={() => { setEditingCommentId(null); setEditingCommentText('') }} sx={{ textTransform: 'none', color: 'text.secondary' }}>Cancel</Button>
                      </Stack>
                    </Box>
                  ) : (
                    <Typography variant="body2" color="text.secondary" sx={{ lineHeight: 1.6, whiteSpace: 'pre-wrap' }}>
                      {renderCommentText(c.text)}
                    </Typography>
                  )}
                </Box>
              </Box>
            ))}
            {(task.comments||[]).length===0 && <Typography variant="caption" color="text.disabled">No comments yet</Typography>}

          </Stack>
        </Box>

        <Divider sx={{ borderColor: 'rgba(255,255,255,0.06)' }} />

        {/* Activity */}
        <Box>
          <Typography variant="overline" color="text.disabled" sx={{ fontSize: '0.65rem', letterSpacing: 1.5, display: 'block', mb: 2 }}>ACTIVITY</Typography>
          <Stack spacing={2}>
            {[...(task.activity||[])].reverse().map((entry, i) => (
              <Box key={i} sx={{ display: 'flex', gap: 1.5, alignItems: 'flex-start' }}>
                <Box sx={{ width: 28, height: 28, borderRadius: '50%', backgroundColor: 'rgba(255,255,255,0.05)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                  <ActivityIcon type={entry.type} />
                </Box>
                <Box sx={{ flex: 1 }}>
                  <Box sx={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 1 }}>
                    <Box sx={{ flex: 1 }}>
                      <Typography variant="caption" color="text.disabled" sx={{ fontWeight: 600 }}>{entry.actor || 'Jarrett'} </Typography>
                      <Typography variant="body2" color="text.primary" fontWeight={500} sx={{ lineHeight: 1.4, display: 'inline' }}>{entry.message}</Typography>
                    </Box>
                    <Tooltip title={expandedJson===`a${i}` ? 'Hide JSON' : 'View raw JSON'}>
                      <IconButton size="small" onClick={() => setExpandedJson(expandedJson===`a${i}` ? null : `a${i}`)}
                        sx={{ p: 0.25, color: 'rgba(255,255,255,0.15)', flexShrink: 0, '&:hover': { color: '#A8C7FA' } }}>
                        <CodeRounded sx={{ fontSize: 13 }} />
                      </IconButton>
                    </Tooltip>
                  </Box>
                  <Typography variant="caption" color="text.disabled" display="block" mt={0.25}>{formatDate(entry.timestamp, dateTimeSettings)}</Typography>
                  {entry.from && entry.to && (
                    <Stack direction="row" spacing={0.75} alignItems="center" mt={0.75}>
                      <Chip size="small" label={STATUS_LABELS[entry.from as Task['status']]||entry.from} variant="outlined" sx={{ height: 20, fontSize: '0.65rem', borderColor: 'rgba(255,255,255,0.1)', color: 'text.disabled', borderRadius: 1 }} />
                      <SwapHorizRounded sx={{ fontSize: 14, color: 'text.disabled' }} />
                      <Chip size="small" label={STATUS_LABELS[entry.to as Task['status']]||entry.to} sx={{ height: 20, fontSize: '0.65rem', borderRadius: 1, backgroundColor: 'rgba(168,199,250,0.1)', color: '#A8C7FA', border: 'none' }} />
                    </Stack>
                  )}
                  <Collapse in={expandedJson===`a${i}`}>
                    <Box sx={{ backgroundColor: '#12141C', borderRadius: 2, p: 1.5, mt: 1, border: '1px solid rgba(255,255,255,0.06)' }}>
                      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 0.75 }}>
                        <Typography variant="caption" color="text.disabled" sx={{ fontFamily: 'monospace', fontSize: '0.65rem', letterSpacing: 0.5 }}>JSON RECORD</Typography>
                        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
                          <Tooltip title="Copy JSON">
                            <IconButton
                              size="small"
                              onClick={async () => {
                                const text = JSON.stringify(entry, null, 2)
                                const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent)
                                const insecure = window.location.protocol !== 'https:'

                                // iOS Safari blocks clipboard writes on http; show manual-copy dialog.
                                if (isIOS && insecure) {
                                  setCopyFallbackText(text)
                                  return
                                }

                                const ok = await tryCopyToClipboard(text)
                                if (!ok) setCopyFallbackText(text)
                              }}
                              sx={{ p: 0.25, color: 'rgba(255,255,255,0.2)', '&:hover': { color: '#66BB6A' } }}
                            >
                              <ContentCopyRounded sx={{ fontSize: 12 }} />
                            </IconButton>
                          </Tooltip>

                          <Tooltip title="Share (iOS workaround)">
                            <IconButton
                              size="small"
                              onClick={async () => {
                                const text = JSON.stringify(entry, null, 2)
                                try {
                                  // On iOS this opens a share sheet where user can Copy.
                                  const nav = navigator as NavigatorShare
                                if (nav.share) {
                                  await nav.share({ text, title: 'ClawPilot JSON Record' })
                                } else {
                                  setCopyFallbackText(text)
                                }
                                } catch {
                                  // user cancelled share sheet
                                }
                              }}
                              sx={{ p: 0.25, color: 'rgba(255,255,255,0.2)', '&:hover': { color: '#A8C7FA' } }}
                            >
                              <IosShareRounded sx={{ fontSize: 12 }} />
                            </IconButton>
                          </Tooltip>
                        </Box>
                      </Box>
                      <Box component="pre" sx={{ m: 0, fontFamily: 'monospace', fontSize: '0.72rem', color: '#A8C7FA', overflowX: 'auto', lineHeight: 1.6, whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
                        {JSON.stringify(entry, null, 2)}
                      </Box>

                      {entry.type === 'comment' && String(entry.message || '').toLowerCase().startsWith('comment deleted') && (
                        <Box sx={{ mt: 1 }}>
                          <Button
                            size="small"
                            variant="outlined"
                            onClick={() => {
                              const deleted = task.deletedComments || []
                              const match = deleted.find(c => c.deletedAt === entry.timestamp) || deleted[deleted.length - 1]
                              if (!match?.id) return
                              patch({ _restoreCommentId: match.id, _actor: entry.actor || 'Jarrett' })
                            }}
                            sx={{ borderColor: 'rgba(168,199,250,0.35)', color: '#A8C7FA', fontSize: '0.72rem', '&:hover': { borderColor: '#A8C7FA', backgroundColor: 'rgba(168,199,250,0.08)' } }}
                          >
                            Restore deleted comment
                          </Button>
                        </Box>
                      )}
                    </Box>
                  </Collapse>
                </Box>
              </Box>
            ))}
          </Stack>
        </Box>
      </Box>

      {/* Clipboard fallback (iOS/http) */}
      <Dialog
        open={!!copyFallbackText}
        onClose={() => setCopyFallbackText(null)}
        PaperProps={{ sx: { backgroundColor: '#1A1A23', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 3, width: { xs: '92vw', sm: 560 } } }}
      >
        <DialogTitle sx={{ color: 'text.primary', fontWeight: 700 }}>Copy JSON</DialogTitle>
        <DialogContent>
          <Typography variant="body2" color="text.secondary" mb={1.5}>
            Your browser blocked automatic clipboard copy. Long-press the text below and choose Copy.
          </Typography>
          <TextField
            value={copyFallbackText || ''}
            multiline
            minRows={8}
            fullWidth
            autoFocus
            onFocus={(e) => e.target.select()}
            sx={{ '& .MuiOutlinedInput-root': { fontFamily: 'monospace', fontSize: '0.78rem', backgroundColor: '#12141C', borderRadius: 2 } }}
          />
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2 }}>
          <Button onClick={() => setCopyFallbackText(null)} sx={{ color: 'text.secondary' }}>Done</Button>
        </DialogActions>
      </Dialog>
    </Drawer>
  )
}
