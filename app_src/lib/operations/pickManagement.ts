import { createHash } from 'node:crypto'

export type OperationsPickAssignmentState =
  | 'assigned'
  | 'unassigned'
  | 'mixed'

export type OperationsPickAssignmentPerson = {
  email: string
  displayName: string | null
  taskCount: number
}

export type OperationsCurrentPickAssignment = {
  orderGlobalId: string
  orderNumber: string
  rowVersion: number
  orderStatus: 'released'
  planGlobalId: string
  waveGlobalId: string
  warehouseName: string
  assignmentState: OperationsPickAssignmentState
  assignedTo: string | null
  assignedDisplayName: string | null
  assignedPickers: OperationsPickAssignmentPerson[]
  unassignedTaskCount: number
  assignmentFingerprint: string
  taskCount: number
  readyTaskCount: number
  pickedTaskCount: number
  requiredUnits: number
  pickedUnits: number
  scanEvidenceTaskCount: number
  countEvidenceTaskCount: number
  assignedAt: string | null
  latestActivityAt: string
  handoffExceptionGlobalId: string | null
  interventionExceptionGlobalId: string | null
  managementBlockedReason: string | null
}

export type OperationsCompletedPickHistory = {
  orderGlobalId: string
  orderNumber: string
  orderStatus: string
  planGlobalId: string
  waveGlobalId: string
  pickerEmail: string
  pickerDisplayName: string | null
  taskCount: number
  unitCount: number
  assignedAt: string
  completedAt: string
}

export type OperationsEligiblePicker = {
  email: string
  displayName: string | null
}

export type OperationsPickManagementPageInfo = {
  hasMore: boolean
  nextCursor: string | null
}

export type OperationsPickManagementWorkspace = {
  generatedAt: string
  current: OperationsCurrentPickAssignment[]
  history: OperationsCompletedPickHistory[]
  eligiblePickers: OperationsEligiblePicker[]
  pagination: {
    current: OperationsPickManagementPageInfo
    history: OperationsPickManagementPageInfo
  }
}

export type OperationsManagePickAssignmentResult = {
  orderGlobalId: string
  orderStatus: 'released'
  previousRowVersion: number
  rowVersion: number
  taskCount: number
  previousAssignedTo: string | null | 'mixed'
  assignedTo: string | null
  interventionExceptionGlobalId: string | null
  providerWrites: 0
  replayed: boolean
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object') {
    const source = value as Record<string, unknown>
    return `{${Object.keys(source)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(source[key])}`)
      .join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

export function pickAssignmentFingerprint(
  tasks: ReadonlyArray<{ pickTaskGlobalId: string; assignedTo: string | null }>,
): string {
  return createHash('sha256')
    .update(canonicalJson(tasks
      .map((task) => ({
        pickTaskGlobalId: String(task.pickTaskGlobalId || '').trim(),
        assignedTo: String(task.assignedTo || '').trim().toLowerCase() || null,
      }))
      .sort((left, right) => (
        left.pickTaskGlobalId.localeCompare(right.pickTaskGlobalId)
      ))))
    .digest('hex')
}
