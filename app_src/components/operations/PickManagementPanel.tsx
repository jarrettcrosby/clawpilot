'use client'

import { FormEvent, useCallback, useEffect, useState } from 'react'
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  FormControl,
  InputLabel,
  MenuItem,
  Select,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  TextField,
  Typography,
} from '@mui/material'
import AssignmentIndRounded from '@mui/icons-material/AssignmentIndRounded'
import OpenInNewRounded from '@mui/icons-material/OpenInNewRounded'
import RefreshRounded from '@mui/icons-material/RefreshRounded'
import type {
  OperationsCurrentPickAssignment,
  OperationsManagePickAssignmentResult,
  OperationsPickManagementWorkspace,
} from '@/lib/operations/pickManagement'
import { useUserDateTime } from '@/components/timezone/UserDateTimeProvider'
import { formatUserDateTime } from '@/lib/userDateTime'

type PickManagementPayload = {
  ok?: boolean
  error?: string
  code?: string
  pickManagement?: OperationsPickManagementWorkspace
  result?: OperationsManagePickAssignmentResult
}

function pickerLabel(input: {
  assignedTo: string | null
  assignedDisplayName: string | null
  assignmentState: OperationsCurrentPickAssignment['assignmentState']
}) {
  if (input.assignmentState === 'mixed') return 'Mixed assignment'
  if (!input.assignedTo) return 'Unassigned'
  return input.assignedDisplayName || input.assignedTo
}

function assignmentColor(
  state: OperationsCurrentPickAssignment['assignmentState'],
) {
  if (state === 'assigned') return 'success' as const
  if (state === 'mixed') return 'warning' as const
  return 'default' as const
}

function appendUniqueBy<T>(
  existing: T[],
  incoming: T[],
  key: (value: T) => string,
): T[] {
  const merged = new Map(existing.map((value) => [key(value), value]))
  for (const value of incoming) merged.set(key(value), value)
  return [...merged.values()]
}

export default function PickManagementPanel({
  canManage,
  canExecute,
  onOpenOrder,
}: {
  canManage: boolean
  canExecute: boolean
  onOpenOrder: (orderGlobalId: string) => void
}) {
  const dateTime = useUserDateTime()
  const [workspace, setWorkspace] =
    useState<OperationsPickManagementWorkspace | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [selected, setSelected] =
    useState<OperationsCurrentPickAssignment | null>(null)
  const [assignedTo, setAssignedTo] = useState('')
  const [reason, setReason] = useState('')
  const [idempotencyKey, setIdempotencyKey] = useState('')
  const [saving, setSaving] = useState(false)
  const [loadingMore, setLoadingMore] =
    useState<'current' | 'history' | null>(null)

  const load = useCallback(async () => {
    if (!canManage) {
      setWorkspace(null)
      setLoading(false)
      return
    }
    setLoading(true)
    setError('')
    try {
      const response = await fetch('/api/operations/pick-management', {
        cache: 'no-store',
      })
      const payload = await response.json() as PickManagementPayload
      if (!response.ok || !payload.ok || !payload.pickManagement) {
        throw new Error(
          `${payload.error || 'Pick assignments could not be loaded'}`
          + `${payload.code ? ` [${payload.code}]` : ''}`,
        )
      }
      setWorkspace(payload.pickManagement)
    } catch (caught) {
      setError(caught instanceof Error
        ? caught.message
        : 'Pick assignments could not be loaded')
    } finally {
      setLoading(false)
    }
  }, [canManage])

  useEffect(() => {
    void load()
  }, [load])

  const loadMorePage = async (section: 'current' | 'history') => {
    const cursor = workspace?.pagination[section].nextCursor
    if (!cursor || loadingMore) return
    setLoadingMore(section)
    setError('')
    try {
      const search = new URLSearchParams({ section })
      search.set(
        section === 'current' ? 'currentCursor' : 'historyCursor',
        cursor,
      )
      const response = await fetch(
        `/api/operations/pick-management?${search.toString()}`,
        { cache: 'no-store' },
      )
      const payload = await response.json() as PickManagementPayload
      if (!response.ok || !payload.ok || !payload.pickManagement) {
        throw new Error(
          `${payload.error || 'More pick-management records could not be loaded'}`
          + `${payload.code ? ` [${payload.code}]` : ''}`,
        )
      }
      const next = payload.pickManagement
      setWorkspace((currentWorkspace) => {
        if (!currentWorkspace) return next
        return {
          ...currentWorkspace,
          generatedAt: next.generatedAt,
          current: section === 'current'
            ? appendUniqueBy(
              currentWorkspace.current,
              next.current,
              (assignment) => assignment.orderGlobalId,
            )
            : currentWorkspace.current,
          history: section === 'history'
            ? appendUniqueBy(
              currentWorkspace.history,
              next.history,
              (history) => (
                `${history.planGlobalId}:${history.waveGlobalId}:${history.pickerEmail}`
              ),
            )
            : currentWorkspace.history,
          eligiblePickers: next.eligiblePickers.length
            ? next.eligiblePickers
            : currentWorkspace.eligiblePickers,
          pagination: {
            ...currentWorkspace.pagination,
            [section]: next.pagination[section],
          },
        }
      })
    } catch (caught) {
      setError(caught instanceof Error
        ? caught.message
        : 'More pick-management records could not be loaded')
    } finally {
      setLoadingMore(null)
    }
  }

  const rotateKey = (orderGlobalId: string) => {
    setIdempotencyKey(
      `operations-pick-assignment:${orderGlobalId}:${crypto.randomUUID()}`,
    )
  }

  const openIntervention = (assignment: OperationsCurrentPickAssignment) => {
    setSelected(assignment)
    setAssignedTo(assignment.assignedTo || '')
    setReason('')
    setError('')
    setNotice('')
    rotateKey(assignment.orderGlobalId)
  }

  const closeIntervention = () => {
    if (saving) return
    setSelected(null)
    setAssignedTo('')
    setReason('')
    setIdempotencyKey('')
  }

  const assignmentUnchanged = Boolean(
    selected
    && selected.assignmentState !== 'mixed'
    && (selected.assignedTo || '') === assignedTo,
  )

  const saveIntervention = async (event: FormEvent) => {
    event.preventDefault()
    if (
      !selected
      || !idempotencyKey
      || !reason.trim()
      || assignmentUnchanged
    ) return
    setSaving(true)
    setError('')
    setNotice('')
    try {
      const response = await fetch('/api/operations', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': idempotencyKey,
        },
        body: JSON.stringify({
          action: 'manage-pick-assignment',
          orderGlobalId: selected.orderGlobalId,
          expectedRowVersion: selected.rowVersion,
          expectedTaskCount: selected.taskCount,
          expectedAssignmentFingerprint: selected.assignmentFingerprint,
          assignedTo: assignedTo || null,
          reason: reason.trim(),
        }),
      })
      const payload = await response.json() as PickManagementPayload
      if (!response.ok || !payload.ok || !payload.result) {
        throw new Error(
          `${payload.error || 'Picker assignment could not be changed'}`
          + `${payload.code ? ` [${payload.code}]` : ''}`,
        )
      }
      const result = payload.result
      setSelected(null)
      setNotice(result.assignedTo
        ? `${result.orderGlobalId} assigned to ${result.assignedTo}.${result.interventionExceptionGlobalId ? ' Manager review remains open.' : ''}`
        : `${result.orderGlobalId} is unassigned and flagged for manager review.`)
      await load()
    } catch (caught) {
      setError(caught instanceof Error
        ? caught.message
        : 'Picker assignment could not be changed')
    } finally {
      setSaving(false)
    }
  }

  if (!canManage) {
    return (
      <Alert severity="info" sx={{ m: 3 }}>
        Manager access is required.
      </Alert>
    )
  }

  if (loading && !workspace) {
    return (
      <Box sx={{ height: '100%', display: 'grid', placeItems: 'center' }}>
        <CircularProgress size={30} />
      </Box>
    )
  }

  const assignedOrders = workspace?.current.filter(
    (assignment) => assignment.assignmentState === 'assigned',
  ).length || 0
  const attentionOrders = workspace?.current.filter(
    (assignment) => assignment.assignmentState !== 'assigned',
  ).length || 0

  return (
    <Box sx={{ p: { xs: 2, md: 3 }, minWidth: 0 }}>
      <Stack spacing={2.5}>
        <Stack
          direction={{ xs: 'column', sm: 'row' }}
          justifyContent="space-between"
          alignItems={{ xs: 'stretch', sm: 'center' }}
          gap={1.5}
        >
          <Box>
            <Typography variant="h6" fontWeight={700}>
              Picking control
            </Typography>
          </Box>
          <Button
            variant="outlined"
            startIcon={loading ? <CircularProgress size={16} /> : <RefreshRounded />}
            disabled={loading}
            onClick={() => void load()}
          >
            Refresh
          </Button>
        </Stack>

        {error && <Alert severity="error" onClose={() => setError('')}>{error}</Alert>}
        {notice && <Alert severity="success" onClose={() => setNotice('')}>{notice}</Alert>}

        <Stack direction="row" spacing={1} sx={{ flexWrap: 'wrap', rowGap: 1 }}>
          <Chip label={`${workspace?.current.length || 0}${workspace?.pagination.current.hasMore ? '+' : ''} active orders loaded`} />
          <Chip color="success" label={`${assignedOrders} assigned`} />
          <Chip
            color={attentionOrders ? 'warning' : 'default'}
            label={`${attentionOrders} need assignment review`}
          />
          <Chip label={`${workspace?.history.length || 0}${workspace?.pagination.history.hasMore ? '+' : ''} completed records loaded`} />
        </Stack>

        <Box>
          <Typography variant="subtitle1" fontWeight={700} sx={{ mb: 1 }}>
            Current assignments
          </Typography>
          {workspace?.current.length ? (
            <Stack spacing={1.25}>
              {workspace.current.map((assignment) => (
                <Box
                  key={assignment.orderGlobalId}
                  data-testid={`pick-assignment-${assignment.orderGlobalId}`}
                  sx={{
                    p: 2,
                    border: '1px solid rgba(255,255,255,0.1)',
                    borderRadius: 2,
                    backgroundColor: 'rgba(255,255,255,0.025)',
                  }}
                >
                  <Stack
                    direction={{ xs: 'column', md: 'row' }}
                    justifyContent="space-between"
                    gap={2}
                  >
                    <Box sx={{ minWidth: 0, flex: 1 }}>
                      <Stack
                        direction="row"
                        spacing={1}
                        alignItems="center"
                        sx={{ flexWrap: 'wrap', rowGap: 0.75 }}
                      >
                        <Typography fontWeight={700}>
                          Order {assignment.orderNumber}
                        </Typography>
                        <Chip
                          size="small"
                          color={assignmentColor(assignment.assignmentState)}
                          label={pickerLabel(assignment)}
                        />
                        {assignment.handoffExceptionGlobalId && (
                          <Chip size="small" color="warning" label="Handoff open" />
                        )}
                        {assignment.interventionExceptionGlobalId && (
                          <Chip size="small" color="warning" label="Manager exception open" />
                        )}
                      </Stack>
                      <Typography variant="caption" color="#A8C7FA">
                        {assignment.orderGlobalId} · {assignment.warehouseName}
                      </Typography>
                      {assignment.assignmentState === 'mixed' && (
                        <Typography variant="body2" color="text.secondary" sx={{ mt: 0.75 }}>
                          {assignment.assignedPickers.map((picker) => (
                            `${picker.displayName || picker.email} (${picker.taskCount})`
                          )).join(' · ')}
                          {assignment.unassignedTaskCount
                            ? ` · Unassigned (${assignment.unassignedTaskCount})`
                            : ''}
                        </Typography>
                      )}
                    </Box>
                    <Box
                      sx={{
                        display: 'grid',
                        gridTemplateColumns: 'repeat(2, minmax(92px, 1fr))',
                        gap: 1,
                        minWidth: { md: 250 },
                      }}
                    >
                      <Box>
                        <Typography variant="caption" color="text.secondary">Tasks ready</Typography>
                        <Typography fontWeight={700}>{assignment.readyTaskCount} / {assignment.taskCount}</Typography>
                      </Box>
                      <Box>
                        <Typography variant="caption" color="text.secondary">Units</Typography>
                        <Typography fontWeight={700}>{assignment.pickedUnits} / {assignment.requiredUnits}</Typography>
                      </Box>
                      <Box>
                        <Typography variant="caption" color="text.secondary">Scanned</Typography>
                        <Typography fontWeight={700}>{assignment.scanEvidenceTaskCount} / {assignment.taskCount}</Typography>
                      </Box>
                      <Box>
                        <Typography variant="caption" color="text.secondary">Counted</Typography>
                        <Typography fontWeight={700}>{assignment.countEvidenceTaskCount} / {assignment.taskCount}</Typography>
                      </Box>
                    </Box>
                  </Stack>

                  {assignment.handoffExceptionGlobalId && (
                    <Alert severity="warning" sx={{ mt: 1.5 }}>
                      Picker handoff remains open.
                    </Alert>
                  )}
                  {assignment.interventionExceptionGlobalId && (
                    <Alert severity="warning" sx={{ mt: 1.5 }}>
                      Manager review remains open.
                    </Alert>
                  )}
                  {assignment.managementBlockedReason && (
                    <Alert severity="info" sx={{ mt: 1.5 }}>
                      {assignment.managementBlockedReason}
                    </Alert>
                  )}
                  <Stack direction="row" spacing={1} sx={{ mt: 1.5 }}>
                    <Button
                      size="small"
                      variant="contained"
                      startIcon={<AssignmentIndRounded />}
                      disabled={
                        !canExecute
                        || Boolean(assignment.managementBlockedReason)
                      }
                      onClick={() => openIntervention(assignment)}
                    >
                      Manage assignment
                    </Button>
                    <Button
                      size="small"
                      variant="text"
                      endIcon={<OpenInNewRounded />}
                      onClick={() => onOpenOrder(assignment.orderGlobalId)}
                    >
                      Open order
                    </Button>
                  </Stack>
                </Box>
              ))}
              {workspace.pagination.current.hasMore && (
                <Button
                  data-testid="load-more-current-pick-assignments"
                  variant="outlined"
                  disabled={loadingMore !== null}
                  onClick={() => void loadMorePage('current')}
                  startIcon={loadingMore === 'current'
                    ? <CircularProgress size={16} />
                    : undefined}
                  sx={{ alignSelf: 'flex-start' }}
                >
                  Load more active assignments
                </Button>
              )}
            </Stack>
          ) : (
            <Alert severity="info">
              No active pick assignments.
            </Alert>
          )}
        </Box>

        <Divider />

        <Box>
          <Typography variant="subtitle1" fontWeight={700} sx={{ mb: 1 }}>
            Completed picks
          </Typography>
          {workspace?.history.length ? (
            <TableContainer sx={{ maxWidth: '100%', overflowX: 'auto' }}>
              <Table size="small" aria-label="Completed picker history">
                <TableHead>
                  <TableRow>
                    <TableCell>Completed</TableCell>
                    <TableCell>Order</TableCell>
                    <TableCell>Picker</TableCell>
                    <TableCell align="right">Tasks</TableCell>
                    <TableCell align="right">Units</TableCell>
                    <TableCell>Status</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {workspace.history.map((history) => (
                    <TableRow
                      key={`${history.planGlobalId}:${history.waveGlobalId}:${history.pickerEmail}`}
                      hover
                    >
                      <TableCell sx={{ whiteSpace: 'nowrap' }}>
                        {formatUserDateTime(history.completedAt, dateTime, {
                          year: 'numeric',
                          month: 'short',
                          day: 'numeric',
                          hour: 'numeric',
                          minute: '2-digit',
                          fallback: 'Unknown',
                        })}
                      </TableCell>
                      <TableCell>
                        <Button
                          size="small"
                          variant="text"
                          onClick={() => onOpenOrder(history.orderGlobalId)}
                          sx={{ justifyContent: 'flex-start', px: 0 }}
                        >
                          {history.orderNumber}
                        </Button>
                        <Typography variant="caption" color="#A8C7FA" display="block">
                          {history.orderGlobalId}
                        </Typography>
                      </TableCell>
                      <TableCell>
                        {history.pickerDisplayName || history.pickerEmail}
                        <Typography variant="caption" color="text.secondary" display="block">
                          {history.pickerEmail}
                        </Typography>
                      </TableCell>
                      <TableCell align="right">{history.taskCount}</TableCell>
                      <TableCell align="right">{history.unitCount}</TableCell>
                      <TableCell><Chip size="small" label={history.orderStatus} /></TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              {workspace.pagination.history.hasMore && (
                <Button
                  data-testid="load-more-completed-pick-history"
                  variant="outlined"
                  disabled={loadingMore !== null}
                  onClick={() => void loadMorePage('history')}
                  startIcon={loadingMore === 'history'
                    ? <CircularProgress size={16} />
                    : undefined}
                  sx={{ mt: 1.5 }}
                >
                  Load more completed picks
                </Button>
              )}
            </TableContainer>
          ) : (
            <Typography variant="body2" color="text.secondary">
              Completed pick history will appear after the first confirmed order.
            </Typography>
          )}
        </Box>
      </Stack>

      <Dialog
        open={Boolean(selected)}
        onClose={closeIntervention}
        fullWidth
        maxWidth="sm"
      >
        <Box component="form" onSubmit={saveIntervention}>
          <DialogTitle>Manager pick intervention</DialogTitle>
          <DialogContent dividers>
            <Stack spacing={2}>
              <Alert severity="warning">
                This changes only the picker on the exact wholly unstarted task
                set. It never deletes scan/count evidence, changes picked
                quantity, or overwrites physical work. Unassigning creates a
                high-priority exception so the order cannot disappear from
                manager attention.
              </Alert>
              {selected?.handoffExceptionGlobalId && (
                <Alert severity="info">
                  Handoff {selected.handoffExceptionGlobalId} remains open after
                  this command and must be reviewed separately.
                </Alert>
              )}
              <Box>
                <Typography fontWeight={700}>
                  Order {selected?.orderNumber}
                </Typography>
                <Typography variant="caption" color="text.secondary">
                  Version {selected?.rowVersion} · {selected?.taskCount || 0} exact tasks
                </Typography>
              </Box>
              <FormControl fullWidth>
                <InputLabel id="manager-pick-assignment-label">Picker</InputLabel>
                <Select
                  labelId="manager-pick-assignment-label"
                  label="Picker"
                  value={assignedTo}
                  onChange={(event) => {
                    const value = event.target.value
                    setAssignedTo(value)
                    setError('')
                    if (selected) rotateKey(selected.orderGlobalId)
                  }}
                >
                  <MenuItem value=""><em>Leave unassigned and flag</em></MenuItem>
                  {workspace?.eligiblePickers.map((picker) => (
                    <MenuItem key={picker.email} value={picker.email}>
                      {picker.displayName || picker.email}
                      {picker.displayName ? ` · ${picker.email}` : ''}
                    </MenuItem>
                  ))}
                </Select>
              </FormControl>
              <TextField
                required
                autoFocus
                label="Manager intervention reason"
                value={reason}
                onChange={(event) => {
                  setReason(event.target.value)
                  setError('')
                  if (selected) rotateKey(selected.orderGlobalId)
                }}
                inputProps={{ maxLength: 500 }}
                helperText={`${reason.trim().length}/500 · Retained in domain and audit history`}
              />
              {error && <Alert severity="error">{error}</Alert>}
            </Stack>
          </DialogContent>
          <DialogActions>
            <Button onClick={closeIntervention} disabled={saving}>Cancel</Button>
            <Button
              type="submit"
              variant="contained"
              color={assignedTo ? 'primary' : 'warning'}
              disabled={
                saving
                || !canExecute
                || !reason.trim()
                || assignmentUnchanged
              }
              startIcon={saving
                ? <CircularProgress size={16} />
                : <AssignmentIndRounded />}
            >
              {saving
                ? 'Saving exact assignment'
                : assignedTo
                  ? selected?.assignedTo
                    ? 'Reassign exact tasks'
                    : 'Assign exact tasks'
                  : 'Unassign and flag'}
            </Button>
          </DialogActions>
        </Box>
      </Dialog>
    </Box>
  )
}
