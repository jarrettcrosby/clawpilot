'use client'

import { useEffect, useMemo, useState, type FormEvent } from 'react'
import Alert from '@mui/material/Alert'
import Avatar from '@mui/material/Avatar'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Chip from '@mui/material/Chip'
import CircularProgress from '@mui/material/CircularProgress'
import Dialog from '@mui/material/Dialog'
import DialogActions from '@mui/material/DialogActions'
import DialogContent from '@mui/material/DialogContent'
import DialogTitle from '@mui/material/DialogTitle'
import Divider from '@mui/material/Divider'
import FormControlLabel from '@mui/material/FormControlLabel'
import IconButton from '@mui/material/IconButton'
import MenuItem from '@mui/material/MenuItem'
import Stack from '@mui/material/Stack'
import Switch from '@mui/material/Switch'
import Tab from '@mui/material/Tab'
import Tabs from '@mui/material/Tabs'
import TextField from '@mui/material/TextField'
import Tooltip from '@mui/material/Tooltip'
import Typography from '@mui/material/Typography'
import useMediaQuery from '@mui/material/useMediaQuery'
import { useTheme } from '@mui/material/styles'
import AccountCircleRounded from '@mui/icons-material/AccountCircleRounded'
import AddToDriveRounded from '@mui/icons-material/AddToDriveRounded'
import AddRounded from '@mui/icons-material/AddRounded'
import CloseRounded from '@mui/icons-material/CloseRounded'
import DeleteOutlineRounded from '@mui/icons-material/DeleteOutlineRounded'
import ErrorOutlineRounded from '@mui/icons-material/ErrorOutlineRounded'
import GroupRounded from '@mui/icons-material/GroupRounded'
import IntegrationInstructionsRounded from '@mui/icons-material/IntegrationInstructionsRounded'
import OpenInNewRounded from '@mui/icons-material/OpenInNewRounded'
import PersonAddRounded from '@mui/icons-material/PersonAddRounded'
import PersonOffRounded from '@mui/icons-material/PersonOffRounded'
import ReplayRounded from '@mui/icons-material/ReplayRounded'
import RestoreRounded from '@mui/icons-material/RestoreRounded'
import SaveRounded from '@mui/icons-material/SaveRounded'
import SecurityRounded from '@mui/icons-material/SecurityRounded'
import ShareRounded from '@mui/icons-material/ShareRounded'
import TableChartRounded from '@mui/icons-material/TableChartRounded'
import ViewKanbanRounded from '@mui/icons-material/ViewKanbanRounded'
import { useUserDateTime } from '@/components/timezone/UserDateTimeProvider'
import { announceUserDateTimeSettings, formatUserDateTime } from '@/lib/userDateTime'
import IntegrationSettingsPanel from './IntegrationSettingsPanel'
import OrganizationBrandingPanel from './OrganizationBrandingPanel'
import SessionSecurityPanel from './SessionSecurityPanel'

type UserRole = 'owner' | 'admin' | 'member'
type UserStatus = 'invited' | 'active' | 'disabled'
type EditableRole = Exclude<UserRole, 'owner'>
type PermissionKey = keyof UserPermissions
type ResourceAccessRole = 'owner' | 'editor' | 'viewer'
type ShareAccessRole = Exclude<ResourceAccessRole, 'owner'>
type ResourceKind = 'board' | 'pipeline'
type PipelineProvisioningStatus = 'not_requested' | 'queued' | 'provisioning' | 'ready' | 'failed'

type UserPermissions = {
  accessDemo: boolean
  inviteUsers: boolean
  manageUserAccess: boolean
  createBoards: boolean
  createPipelines: boolean
  viewOperations: boolean
  manageOperations: boolean
  executeWarehouse: boolean
  manageCarrierRateNetworks: boolean
  grantCarrierRateAccess: boolean
  viewCarrierCost: boolean
  reconcileCarrierBilling: boolean
  approveCarrierSettlement: boolean
  viewFullReleaseHistory: boolean
  manageBackups: boolean
  manageLinks: boolean
  viewAccounting: boolean
  prepareAccounting: boolean
  approveAccounting: boolean
  viewOrganizationAudit: boolean
  viewSystemAudit: boolean
}

type AppUser = {
  email: string
  referenceCode: string | null
  contactReferenceCode: string
  crmUserEnabled: boolean
  role: UserRole
  status: UserStatus
  displayName: string | null
  jobTitle: string | null
  organizationId: string | null
  organizationName: string | null
  suiteCrmUserId: string | null
  suiteCrmUsername: string | null
  timezone: string
  locale: string
  permissions: UserPermissions
  lastLoginAt?: string | null
}

type ApiPayload = {
  ok?: boolean
  error?: string
}

type UsersPayload = ApiPayload & {
  currentUser?: AppUser
  currentOrganization?: {
    id: string
    referenceCode: string
    name: string
  }
  isAdmin?: boolean
  canInvite?: boolean
  canManageUserAccess?: boolean
  users?: AppUser[]
  workspaceOrganizations?: WorkspaceOrganization[]
}

type WorkspaceOrganization = {
  id: string
  referenceCode: string
  parentId: string | null
  parentName: string | null
  name: string
  organizationType: 'root' | 'member'
  depth: number
}

type UserMutationPayload = ApiPayload & {
  user?: AppUser
  delivery?: string
  crmIdentitySync?: 'queued' | 'not-mapped'
  warning?: string
}

type SharedResourceMember = {
  email: string
  displayName: string | null
  status: UserStatus
  accessRole: ShareAccessRole
}

type WorkspaceResource = {
  id: string
  name: string
  ownerEmail: string
  isDefault: boolean
  accessRole: ResourceAccessRole
  members: SharedResourceMember[]
}

type PipelineResource = WorkspaceResource & {
  provisioningStatus: PipelineProvisioningStatus
  provisioningError: string | null
  provisioningRequestedAt: string | null
  provisioningStartedAt: string | null
  provisioningLastAttemptedAt: string | null
  provisioningCompletedAt: string | null
  shortLinkUrl: string | null
  sheetBacked: boolean
  syncEnabled: boolean
}

type WorkspacesPayload = ApiPayload & {
  boards?: WorkspaceResource[]
  pipelines?: PipelineResource[]
  selectedBoardId?: string | null
  selectedPipelineId?: string | null
}

type ProfileForm = {
  displayName: string
  jobTitle: string
  organizationName: string
  timezone: string
  locale: string
}

type ShareDraft = {
  email: string
  accessRole: ShareAccessRole
}

const EMPTY_PROFILE: ProfileForm = {
  displayName: '',
  jobTitle: '',
  organizationName: '',
  timezone: 'America/New_York',
  locale: 'en-US',
}

const EMPTY_SHARE_DRAFT: ShareDraft = { email: '', accessRole: 'viewer' }
const NEW_ORGANIZATION = '__new__'

const TIMEZONES = [
  'UTC',
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Los_Angeles',
  'America/Anchorage',
  'Pacific/Honolulu',
  'America/Toronto',
  'America/Vancouver',
  'America/Mexico_City',
  'America/Sao_Paulo',
  'Europe/London',
  'Europe/Paris',
  'Europe/Berlin',
  'Africa/Johannesburg',
  'Asia/Dubai',
  'Asia/Kolkata',
  'Asia/Singapore',
  'Asia/Tokyo',
  'Australia/Sydney',
]

const LOCALES = [
  'en-US',
  'en-GB',
  'en-CA',
  'es-ES',
  'es-MX',
  'fr-FR',
  'de-DE',
  'pt-BR',
  'ja-JP',
  'zh-CN',
]

const PERMISSIONS: Array<{
  key: PermissionKey
  label: string
  description?: string
  adminOnly?: boolean
}> = [
  { key: 'accessDemo', label: 'Open demo account' },
  { key: 'inviteUsers', label: 'Invite users', adminOnly: true },
  { key: 'manageUserAccess', label: 'Manage access', adminOnly: true },
  { key: 'createBoards', label: 'Create boards' },
  { key: 'createPipelines', label: 'Create pipelines' },
  { key: 'viewOperations', label: 'View operations' },
  { key: 'manageOperations', label: 'Manage operations', adminOnly: true },
  { key: 'executeWarehouse', label: 'Execute warehouse work' },
  {
    key: 'manageCarrierRateNetworks',
    label: 'Manage carrier rate networks',
    description: 'Create, edit, disable, and configure organization carrier rate networks.',
    adminOnly: true,
  },
  {
    key: 'grantCarrierRateAccess',
    label: 'Grant carrier rate access',
    description: 'Grant or revoke downstream access to authorized carrier accounts and rates.',
    adminOnly: true,
  },
  {
    key: 'viewCarrierCost',
    label: 'View carrier costs',
    description: 'View unmarked rates, actual carrier charges, and quoted-to-billed cost variance.',
  },
  {
    key: 'reconcileCarrierBilling',
    label: 'Reconcile carrier billing',
    description: 'Import, match, assign, and resolve carrier billing charges and exceptions. Requires View carrier costs.',
  },
  {
    key: 'approveCarrierSettlement',
    label: 'Approve carrier settlements',
    description: 'Approve reconciled carrier charges and downstream settlement outcomes. Requires View carrier costs.',
    adminOnly: true,
  },
  { key: 'viewFullReleaseHistory', label: 'View full release history', adminOnly: true },
  { key: 'manageBackups', label: 'Manage data checkpoints', adminOnly: true },
  { key: 'manageLinks', label: 'Manage organization short links', adminOnly: true },
  { key: 'viewAccounting', label: 'View accounting data' },
  { key: 'prepareAccounting', label: 'Prepare accounting drafts' },
  { key: 'approveAccounting', label: 'Approve accounting changes', adminOnly: true },
  { key: 'viewOrganizationAudit', label: 'View organization activity', adminOnly: true },
  { key: 'viewSystemAudit', label: 'View global system activity', adminOnly: true },
]

function permissionsForRolePreset(role: EditableRole, current: UserPermissions): UserPermissions {
  const enabled = role === 'admin'
  return {
    ...current,
    inviteUsers: enabled,
    manageUserAccess: enabled,
    viewOperations: enabled,
    manageOperations: enabled,
    executeWarehouse: enabled,
    manageCarrierRateNetworks: enabled,
    grantCarrierRateAccess: enabled,
    viewCarrierCost: enabled,
    reconcileCarrierBilling: enabled,
    approveCarrierSettlement: enabled,
    viewFullReleaseHistory: enabled,
    manageBackups: enabled,
    manageLinks: enabled,
    viewAccounting: enabled,
    prepareAccounting: enabled,
    approveAccounting: enabled,
    viewOrganizationAudit: enabled,
    viewSystemAudit: enabled,
  }
}

const panelSx = {
  border: '1px solid rgba(255,255,255,0.09)',
  borderRadius: '8px',
  backgroundColor: 'rgba(255,255,255,0.025)',
}

const compactButtonSx = {
  minHeight: 36,
  borderRadius: '8px',
  px: 1.5,
  whiteSpace: 'nowrap',
}

const fieldSx = {
  '& .MuiOutlinedInput-root': {
    borderRadius: '8px',
    backgroundColor: '#20202A',
  },
}

async function requestJson<T extends ApiPayload>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init)
  const result = await response.json().catch(() => ({})) as T
  if (!response.ok || !result.ok) throw new Error(result.error || 'Request failed')
  return result
}

function messageFrom(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback
}

function profileFrom(user: AppUser): ProfileForm {
  return {
    displayName: user.displayName || '',
    jobTitle: user.jobTitle || '',
    organizationName: user.organizationName || '',
    timezone: user.timezone || 'America/New_York',
    locale: user.locale || 'en-US',
  }
}

function roleLabel(role: UserRole) {
  if (role === 'owner') return 'Owner / admin'
  return role === 'admin' ? 'Admin' : 'Member'
}

function statusLabel(status: UserStatus) {
  return status.charAt(0).toUpperCase() + status.slice(1)
}

function initials(user: Pick<AppUser, 'displayName' | 'email'>) {
  const source = user.displayName?.trim() || user.email.split('@')[0]
  return source
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part.charAt(0).toUpperCase())
    .join('')
}

function isEmail(value: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim())
}

function httpsUrl(value: string | null | undefined) {
  const candidate = String(value || '').trim()
  if (!candidate) return null
  try {
    return new URL(candidate).protocol === 'https:' ? candidate : null
  } catch {
    return null
  }
}

function safeProvisioningError(value: string | null | undefined) {
  const sanitized = String(value || '')
    .replace(/https?:\/\/\S+/gi, '[link removed]')
    .replace(/\b(?:sheet|connection|folder|file)\s+id\s*[:=]?\s*[A-Za-z0-9_-]+/gi, 'managed resource')
    .replace(/\b[A-Za-z0-9_-]{24,}\b/g, '[identifier removed]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 240)
  return sanitized || 'Google Workspace provisioning failed.'
}

export default function UserAccessDialog({
  open,
  initialTab = 0,
  onClose,
}: {
  open: boolean
  initialTab?: number
  onClose: () => void
}) {
  const dateTimeSettings = useUserDateTime()
  const theme = useTheme()
  const narrowScreen = useMediaQuery(theme.breakpoints.down('sm'))
  const shortViewport = useMediaQuery('(max-height: 500px)')
  const fullScreen = narrowScreen || shortViewport
  const [activeTab, setActiveTab] = useState(0)
  const [usersPayload, setUsersPayload] = useState<UsersPayload | null>(null)
  const [workspacesPayload, setWorkspacesPayload] = useState<WorkspacesPayload | null>(null)
  const [profile, setProfile] = useState<ProfileForm>(EMPTY_PROFILE)
  const [inviteEmail, setInviteEmail] = useState('')
  const [inviteCrmEmployee, setInviteCrmEmployee] = useState(false)
  const [inviteDemoAccess, setInviteDemoAccess] = useState(false)
  const [inviteOrganizationId, setInviteOrganizationId] = useState('')
  const [newOrganizationName, setNewOrganizationName] = useState('')
  const [newOrganizationParentId, setNewOrganizationParentId] = useState('')
  const [createNames, setCreateNames] = useState({ board: '', pipeline: '' })
  const [shareDrafts, setShareDrafts] = useState<Record<string, ShareDraft>>({})
  const [provisioningPipeline, setProvisioningPipeline] = useState<PipelineResource | null>(null)
  const [loading, setLoading] = useState(false)
  const [pendingAction, setPendingAction] = useState<string | null>(null)
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')

  const currentUser = usersPayload?.currentUser
  const busy = pendingAction !== null
  const hasActivePipelineProvisioning = Boolean(workspacesPayload?.pipelines?.some((pipeline) => (
    pipeline.provisioningStatus === 'queued' || pipeline.provisioningStatus === 'provisioning'
  )))

  const displayedUsers = useMemo(() => {
    if (!currentUser) return []
    if (!usersPayload?.isAdmin) return [currentUser]
    return usersPayload.users || [currentUser]
  }, [currentUser, usersPayload])

  const eligibleShareEmails = useMemo(() => {
    return (usersPayload?.users || [])
      .filter((user) => user.status !== 'disabled' && user.email !== currentUser?.email)
      .map((user) => user.email)
  }, [currentUser?.email, usersPayload?.users])

  const timezoneOptions = useMemo(
    () => Array.from(new Set([profile.timezone, ...TIMEZONES])).filter(Boolean),
    [profile.timezone],
  )
  const localeOptions = useMemo(
    () => Array.from(new Set([profile.locale, ...LOCALES])).filter(Boolean),
    [profile.locale],
  )

  const persistedProfile = currentUser ? profileFrom(currentUser) : EMPTY_PROFILE
  const profileDirty = currentUser
    ? profile.displayName.trim() !== persistedProfile.displayName
      || profile.jobTitle.trim() !== persistedProfile.jobTitle
      || profile.organizationName.trim() !== persistedProfile.organizationName
      || profile.timezone !== persistedProfile.timezone
      || profile.locale !== persistedProfile.locale
    : false

  useEffect(() => {
    if (!open) return

    let active = true
    setActiveTab(initialTab)
    setUsersPayload(null)
    setWorkspacesPayload(null)
    setProfile(EMPTY_PROFILE)
    setInviteEmail('')
    setInviteCrmEmployee(false)
    setInviteDemoAccess(false)
    setInviteOrganizationId('')
    setNewOrganizationName('')
    setNewOrganizationParentId('')
    setCreateNames({ board: '', pipeline: '' })
    setShareDrafts({})
    setProvisioningPipeline(null)
    setNotice('')
    setError('')
    setLoading(true)

    Promise.allSettled([
      requestJson<UsersPayload>('/api/users'),
      requestJson<WorkspacesPayload>('/api/workspaces'),
    ]).then(([usersResult, workspacesResult]) => {
      if (!active) return
      const loadErrors: string[] = []

      if (usersResult.status === 'fulfilled') {
        setUsersPayload(usersResult.value)
        if (usersResult.value.currentUser) {
          setProfile(profileFrom(usersResult.value.currentUser))
          const organizationId = usersResult.value.currentUser.organizationId || ''
          setInviteOrganizationId(organizationId)
          setNewOrganizationParentId(organizationId)
        }
      } else {
        loadErrors.push(messageFrom(usersResult.reason, 'Unable to load users'))
      }

      if (workspacesResult.status === 'fulfilled') {
        setWorkspacesPayload(workspacesResult.value)
      } else {
        loadErrors.push(messageFrom(workspacesResult.reason, 'Unable to load workspaces'))
      }

      setError(Array.from(new Set(loadErrors)).join(' '))
      setLoading(false)
    })

    return () => { active = false }
  }, [initialTab, open])

  useEffect(() => {
    if (!open || busy || !hasActivePipelineProvisioning) return

    let active = true
    let controller: AbortController | null = null
    let timeoutId: number | undefined
    const pollWorkspaces = async () => {
      controller = new AbortController()
      try {
        const result = await requestJson<WorkspacesPayload>('/api/workspaces', { signal: controller.signal })
        if (active) setWorkspacesPayload(result)
      } catch {
        // Keep the last known provisioning state and retry on the next interval.
      } finally {
        if (active) timeoutId = window.setTimeout(pollWorkspaces, 3000)
      }
    }

    timeoutId = window.setTimeout(pollWorkspaces, 3000)
    return () => {
      active = false
      controller?.abort()
      if (timeoutId !== undefined) window.clearTimeout(timeoutId)
    }
  }, [busy, hasActivePipelineProvisioning, open])

  function startAction(key: string) {
    setPendingAction(key)
    setError('')
    setNotice('')
  }

  function finishAction() {
    setPendingAction(null)
  }

  function upsertUser(user: AppUser) {
    setUsersPayload((current) => {
      if (!current) return current
      const existing = current.users || []
      const sameMembership = (candidate: AppUser) => candidate.email === user.email
        && candidate.organizationId === user.organizationId
      const users = existing.some(sameMembership)
        ? existing.map((candidate) => sameMembership(candidate) ? user : candidate)
        : [...existing, user]
      return {
        ...current,
        currentUser: current.currentUser?.email === user.email ? user : current.currentUser,
        users,
      }
    })
    setWorkspacesPayload((current) => current ? {
      ...current,
      boards: current.boards?.map((resource) => ({
        ...resource,
        members: resource.members.map((member) => member.email === user.email
          ? { ...member, displayName: user.displayName, status: user.status }
          : member),
      })),
      pipelines: current.pipelines?.map((resource) => ({
        ...resource,
        members: resource.members.map((member) => member.email === user.email
          ? { ...member, displayName: user.displayName, status: user.status }
          : member),
      })),
    } : current)
  }

  async function saveProfile(event: FormEvent) {
    event.preventDefault()
    if (busy || !profile.displayName.trim() || !profile.organizationName.trim()) return
    startAction('profile')
    try {
      const result = await requestJson<UserMutationPayload>('/api/users', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'profile',
          displayName: profile.displayName.trim(),
          jobTitle: profile.jobTitle.trim(),
          organizationName: profile.organizationName.trim(),
          timezone: profile.timezone,
          locale: profile.locale,
        }),
      })
      if (!result.user) throw new Error('Profile response was incomplete')
      upsertUser(result.user)
      setProfile(profileFrom(result.user))
      announceUserDateTimeSettings(result.user)
      setNotice('Profile saved.')
    } catch (saveError) {
      setError(messageFrom(saveError, 'Unable to save profile'))
    } finally {
      finishAction()
    }
  }

  async function inviteUser(event: FormEvent) {
    event.preventDefault()
    const email = inviteEmail.trim().toLowerCase()
    const creatingOrganization = inviteOrganizationId === NEW_ORGANIZATION
    if (
      busy
      || !isEmail(email)
      || (!creatingOrganization && !inviteOrganizationId)
      || (creatingOrganization && (!newOrganizationName.trim() || !newOrganizationParentId))
    ) return
    startAction('invite')
    try {
      const result = await requestJson<UserMutationPayload>('/api/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email,
          organizationId: creatingOrganization ? undefined : inviteOrganizationId,
          createOrganization: creatingOrganization,
          organizationName: creatingOrganization ? newOrganizationName.trim() : undefined,
          parentOrganizationId: creatingOrganization ? newOrganizationParentId : undefined,
          crmUserEnabled: inviteCrmEmployee,
          demoAccess: inviteDemoAccess,
        }),
      })
      if (result.user) upsertUser(result.user)
      const refreshed = await requestJson<UsersPayload>('/api/users')
      setUsersPayload(refreshed)
      setInviteEmail('')
      setInviteCrmEmployee(false)
      setInviteDemoAccess(false)
      setInviteOrganizationId(refreshed.currentUser?.organizationId || '')
      setNewOrganizationName('')
      setNewOrganizationParentId(refreshed.currentUser?.organizationId || '')
      setNotice(result.delivery === 'sent' ? `Invitation sent to ${email}.` : `${email} invited.`)
    } catch (inviteError) {
      setError(messageFrom(inviteError, 'Unable to invite user'))
    } finally {
      finishAction()
    }
  }

  function canManageUser(user: AppUser) {
    if (!usersPayload?.canManageUserAccess || !currentUser || user.role === 'owner') return false
    if (currentUser.role === 'owner') return true
    return currentUser.role === 'admin' && user.role === 'member' && user.email !== currentUser.email
  }

  async function updateStatus(user: AppUser) {
    if (busy || !canManageUser(user)) return
    const status: UserStatus = user.status === 'disabled' ? 'active' : 'disabled'
    startAction(`status:${user.email}`)
    try {
      const result = await requestJson<UserMutationPayload>('/api/users', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: user.email, organizationId: user.organizationId, status }),
      })
      if (!result.user) throw new Error('User response was incomplete')
      upsertUser(result.user)
      setNotice(status === 'active' ? `${user.email} restored.` : `${user.email} disabled.`)
    } catch (updateError) {
      setError(messageFrom(updateError, 'Unable to update user'))
    } finally {
      finishAction()
    }
  }

  async function updateAccess(user: AppUser, role: EditableRole, permissions: UserPermissions) {
    if (busy || !canManageUser(user)) return
    startAction(`access:${user.email}`)
    try {
      const result = await requestJson<UserMutationPayload>('/api/users', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'access',
          email: user.email,
          organizationId: user.organizationId,
          role,
          permissions,
        }),
      })
      if (!result.user) throw new Error('User response was incomplete')
      upsertUser(result.user)
      setNotice(`Access updated for ${result.user.displayName || result.user.email}.`)
    } catch (updateError) {
      setError(messageFrom(updateError, 'Unable to update access'))
    } finally {
      finishAction()
    }
  }

  function canManageCrmMapping(user: AppUser) {
    if (!usersPayload?.canManageUserAccess || !currentUser) return false
    if (currentUser.role === 'owner') return true
    return currentUser.email === user.email || user.role === 'member'
  }

  async function syncSuiteCrmUser(user: AppUser) {
    if (busy || !canManageCrmMapping(user) || !user.referenceCode) return
    startAction(`crm-map:${user.email}`)
    try {
      const result = await requestJson<UserMutationPayload>('/api/users', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'crm-user-sync',
          email: user.email,
          organizationId: user.organizationId,
        }),
      })
      if (!result.user) throw new Error('CRM mapping response was incomplete')
      upsertUser(result.user)
      setNotice(`${result.user.displayName || result.user.email} is syncing to SuiteCRM as ${result.user.referenceCode}.`)
    } catch (mappingError) {
      setError(messageFrom(mappingError, 'Unable to map SuiteCRM user'))
    } finally {
      finishAction()
    }
  }

  async function updateCrmEmployee(user: AppUser, enabled: boolean) {
    if (busy || !canManageCrmMapping(user) || user.role === 'owner') return
    startAction(`crm-employee:${user.email}`)
    try {
      const result = await requestJson<UserMutationPayload>('/api/users', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'crm-employee',
          email: user.email,
          organizationId: user.organizationId,
          enabled,
        }),
      })
      if (!result.user) throw new Error('CRM employee response was incomplete')
      upsertUser(result.user)
      setNotice(result.warning || (enabled
        ? `${result.user.displayName || result.user.email} is now a CRM employee with username ${result.user.referenceCode}.`
        : `${result.user.displayName || result.user.email} was removed as a CRM employee.`)
      )
    } catch (employeeError) {
      setError(messageFrom(employeeError, 'Unable to update CRM employee access'))
    } finally {
      finishAction()
    }
  }

  async function mutateWorkspace(
    body: Record<string, unknown>,
    key: string,
    successMessage: string,
    failureMessage = 'Unable to update sharing',
  ) {
    if (busy) return false
    startAction(key)
    try {
      const result = await requestJson<WorkspacesPayload>('/api/workspaces', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      setWorkspacesPayload(result)
      setNotice(successMessage)
      return true
    } catch (workspaceError) {
      setError(messageFrom(workspaceError, failureMessage))
      return false
    } finally {
      finishAction()
    }
  }

  async function createResource(kind: ResourceKind) {
    const name = createNames[kind].trim()
    if (!name) return
    const created = await mutateWorkspace(
      { action: kind === 'board' ? 'create-board' : 'create-pipeline', name },
      `create:${kind}`,
      `${kind === 'board' ? 'Board' : 'Pipeline'} created.`,
    )
    if (created) setCreateNames((current) => ({ ...current, [kind]: '' }))
  }

  function requestPipelineProvisioning(pipeline: PipelineResource) {
    const owned = pipeline.ownerEmail === currentUser?.email && pipeline.accessRole === 'owner'
    const active = pipeline.provisioningStatus === 'queued' || pipeline.provisioningStatus === 'provisioning'
    if (busy || !owned || pipeline.sheetBacked || active) return
    setError('')
    setNotice('')
    setProvisioningPipeline(pipeline)
  }

  async function confirmPipelineProvisioning() {
    const pipeline = provisioningPipeline
    if (!pipeline || busy) return
    await mutateWorkspace(
      { action: 'provision-pipeline', pipelineId: pipeline.id },
      `provision:pipeline:${pipeline.id}`,
      `${pipeline.name} Sheet provisioning queued.`,
      `Unable to provision a Sheet for ${pipeline.name}`,
    )
    setProvisioningPipeline(null)
  }

  function openPipelineSheet(pipeline: PipelineResource) {
    const url = httpsUrl(pipeline.shortLinkUrl)
    if (!url) return
    const opened = window.open(url, '_blank', 'noopener,noreferrer')
    if (opened) opened.opener = null
  }

  function shareDraftKey(kind: ResourceKind, resourceId: string) {
    return `${kind}:${resourceId}`
  }

  function shareDraft(kind: ResourceKind, resourceId: string) {
    return shareDrafts[shareDraftKey(kind, resourceId)] || EMPTY_SHARE_DRAFT
  }

  function updateShareDraft(kind: ResourceKind, resourceId: string, patch: Partial<ShareDraft>) {
    const key = shareDraftKey(kind, resourceId)
    setShareDrafts((current) => ({
      ...current,
      [key]: { ...(current[key] || EMPTY_SHARE_DRAFT), ...patch },
    }))
  }

  async function shareResource(kind: ResourceKind, resource: WorkspaceResource) {
    const draft = shareDraft(kind, resource.id)
    const email = draft.email.trim().toLowerCase()
    if (!isEmail(email)) return
    const shared = await mutateWorkspace(
      {
        action: kind === 'board' ? 'share-board' : 'share-pipeline',
        [`${kind}Id`]: resource.id,
        email,
        accessRole: draft.accessRole,
      },
      `share:${kind}:${resource.id}`,
      `${resource.name} shared with ${email}.`,
    )
    if (shared) updateShareDraft(kind, resource.id, { email: '', accessRole: 'viewer' })
  }

  async function changeShareRole(
    kind: ResourceKind,
    resource: WorkspaceResource,
    member: SharedResourceMember,
    accessRole: ShareAccessRole,
  ) {
    await mutateWorkspace(
      {
        action: kind === 'board' ? 'share-board' : 'share-pipeline',
        [`${kind}Id`]: resource.id,
        email: member.email,
        accessRole,
      },
      `share-role:${kind}:${resource.id}:${member.email}`,
      `Access updated for ${member.displayName || member.email}.`,
    )
  }

  async function removeShare(kind: ResourceKind, resource: WorkspaceResource, member: SharedResourceMember) {
    await mutateWorkspace(
      {
        action: kind === 'board' ? 'remove-board-share' : 'remove-pipeline-share',
        [`${kind}Id`]: resource.id,
        email: member.email,
      },
      `remove-share:${kind}:${resource.id}:${member.email}`,
      `${member.email} removed from ${resource.name}.`,
    )
  }

  const canCreateBoards = currentUser?.role === 'owner' || Boolean(currentUser?.permissions.createBoards)
  const canCreatePipelines = currentUser?.role === 'owner' || Boolean(currentUser?.permissions.createPipelines)

  const workspaceSections: Array<{
    kind: ResourceKind
    title: string
    resources: WorkspaceResource[]
    selectedId: string | null
    canCreate: boolean
  }> = [
    {
      kind: 'board',
      title: 'Boards',
      resources: workspacesPayload?.boards || [],
      selectedId: workspacesPayload?.selectedBoardId || null,
      canCreate: canCreateBoards,
    },
    {
      kind: 'pipeline',
      title: 'Pipelines',
      resources: workspacesPayload?.pipelines || [],
      selectedId: workspacesPayload?.selectedPipelineId || null,
      canCreate: canCreatePipelines,
    },
  ]

  return (
    <Dialog
      open={open}
      onClose={() => { if (!busy) onClose() }}
      aria-labelledby="settings-dialog-title"
      fullWidth
      fullScreen={fullScreen}
      maxWidth="md"
      PaperProps={{
        'data-testid': 'settings-dialog',
        sx: {
          width: '100%',
          height: fullScreen ? '100%' : 'min(780px, calc(100vh - 48px))',
          maxHeight: fullScreen ? '100%' : 'calc(100vh - 48px)',
          backgroundColor: '#1A1A23',
          backgroundImage: 'none',
          border: '1px solid rgba(255,255,255,0.09)',
          borderRadius: fullScreen ? 0 : '8px',
          overflow: 'hidden',
        },
      }}
    >
      <Box sx={{ px: { xs: 2, sm: 3 }, pt: { xs: 'calc(env(safe-area-inset-top) + 12px)', sm: 2.25 }, pb: 1.5 }}>
        <Box display="flex" alignItems="center" justifyContent="space-between" gap={2} mb={1.5}>
          <Box minWidth={0}>
            <Typography id="settings-dialog-title" variant="h6" color="text.primary" fontWeight={700}>Settings</Typography>
            {currentUser ? (
              <Typography variant="caption" color="text.disabled" sx={{ display: 'block', overflowWrap: 'anywhere' }}>
                {currentUser.email}
              </Typography>
            ) : null}
          </Box>
          <Stack direction="row" spacing={0.5} alignItems="center">
            {busy ? <CircularProgress size={18} /> : null}
            <Tooltip title="Close settings">
              <span>
                <IconButton
                  aria-label="Close settings"
                  size="small"
                  onClick={onClose}
                  disabled={busy}
                  sx={{ color: 'text.secondary' }}
                >
                  <CloseRounded fontSize="small" />
                </IconButton>
              </span>
            </Tooltip>
          </Stack>
        </Box>

        <Tabs
          value={activeTab}
          onChange={(_, value: number) => setActiveTab(value)}
          aria-label="Settings sections"
          variant={fullScreen ? 'scrollable' : 'fullWidth'}
          scrollButtons={false}
          sx={{
            minHeight: 42,
            p: '3px',
            borderRadius: '8px',
            backgroundColor: '#232330',
            '& .MuiTabs-indicator': { display: 'none' },
            '& .MuiTab-root': {
              minHeight: 36,
              minWidth: { xs: 'auto', sm: 0 },
              borderRadius: '6px',
              color: 'text.secondary',
              textTransform: 'none',
              fontWeight: 600,
              fontSize: { xs: '0.78rem', sm: '0.875rem' },
              gap: { xs: 0.5, sm: 0.75 },
              px: { xs: 1.25, sm: 1.5 },
            },
            '& .MuiTab-root.Mui-selected': {
              color: 'text.primary',
              backgroundColor: 'rgba(168,199,250,0.12)',
            },
          }}
        >
          <Tab icon={<AccountCircleRounded sx={{ fontSize: 18 }} />} iconPosition="start" label="Profile" id="settings-tab-0" aria-controls="settings-panel-0" />
          <Tab icon={<GroupRounded sx={{ fontSize: 18 }} />} iconPosition="start" label="People" id="settings-tab-1" aria-controls="settings-panel-1" />
          <Tab icon={<ShareRounded sx={{ fontSize: 18 }} />} iconPosition="start" label="Sharing" id="settings-tab-2" aria-controls="settings-panel-2" />
          <Tab icon={<IntegrationInstructionsRounded sx={{ fontSize: 18 }} />} iconPosition="start" label="Integrations" id="settings-tab-3" aria-controls="settings-panel-3" />
          <Tab icon={<SecurityRounded sx={{ fontSize: 18 }} />} iconPosition="start" label="Security" id="settings-tab-4" aria-controls="settings-panel-4" />
        </Tabs>
      </Box>

      <Divider sx={{ borderColor: 'rgba(255,255,255,0.07)' }} />

      <DialogContent sx={{ px: { xs: 2, sm: 3 }, pt: { xs: 2, sm: 2.5 }, pb: { xs: 'calc(env(safe-area-inset-bottom) + 20px)', sm: 2.5 } }}>
        {error ? <Alert severity="error" onClose={() => setError('')} sx={{ mb: 2, borderRadius: '8px' }}>{error}</Alert> : null}
        {notice ? <Alert severity="success" onClose={() => setNotice('')} sx={{ mb: 2, borderRadius: '8px' }}>{notice}</Alert> : null}

        {loading ? (
          <Box display="grid" sx={{ minHeight: 360, placeItems: 'center' }}>
            <CircularProgress size={28} />
          </Box>
        ) : null}

        {!loading && activeTab === 0 ? (
          <Box
            component="form"
            role="tabpanel"
            id="settings-panel-0"
            aria-labelledby="settings-tab-0"
            onSubmit={saveProfile}
            sx={{ maxWidth: 720, mx: 'auto' }}
          >
            {currentUser ? (
              <>
                <Stack direction="row" spacing={1.5} alignItems="center" mb={2.5}>
                  <Avatar sx={{ width: 44, height: 44, bgcolor: 'rgba(168,199,250,0.16)', color: 'primary.main', fontWeight: 700 }}>
                    {initials(currentUser)}
                  </Avatar>
                  <Box minWidth={0}>
                    <Typography variant="subtitle1" color="text.primary" fontWeight={700} noWrap>
                      {currentUser.displayName || 'Profile'}
                    </Typography>
                    <Typography variant="body2" color="text.secondary" sx={{ overflowWrap: 'anywhere' }}>
                      {roleLabel(currentUser.role)}
                    </Typography>
                  </Box>
                </Stack>

                <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', sm: '1fr 1fr' }, gap: 2 }}>
                  <TextField
                    required
                    size="small"
                    label="Display name"
                    value={profile.displayName}
                    onChange={(event) => setProfile((current) => ({ ...current, displayName: event.target.value }))}
                    disabled={busy}
                    inputProps={{ maxLength: 100 }}
                    sx={fieldSx}
                  />
                  <TextField
                    size="small"
                    label="Job title"
                    value={profile.jobTitle}
                    onChange={(event) => setProfile((current) => ({ ...current, jobTitle: event.target.value }))}
                    disabled={busy}
                    inputProps={{ maxLength: 120 }}
                    sx={fieldSx}
                  />
                  <TextField
                    required
                    size="small"
                    label="Organization name"
                    value={profile.organizationName}
                    onChange={(event) => setProfile((current) => ({ ...current, organizationName: event.target.value }))}
                    disabled={busy || !usersPayload?.canManageUserAccess}
                    autoComplete="organization"
                    inputProps={{ maxLength: 200 }}
                    sx={{ ...fieldSx, gridColumn: { sm: '1 / -1' } }}
                  />
                  <TextField
                    select
                    size="small"
                    label="Timezone"
                    value={profile.timezone}
                    onChange={(event) => setProfile((current) => ({ ...current, timezone: event.target.value }))}
                    disabled={busy}
                    sx={fieldSx}
                  >
                    {timezoneOptions.map((timezone) => <MenuItem key={timezone} value={timezone}>{timezone}</MenuItem>)}
                  </TextField>
                  <TextField
                    select
                    size="small"
                    label="Locale"
                    value={profile.locale}
                    onChange={(event) => setProfile((current) => ({ ...current, locale: event.target.value }))}
                    disabled={busy}
                    sx={fieldSx}
                  >
                    {localeOptions.map((locale) => <MenuItem key={locale} value={locale}>{locale}</MenuItem>)}
                  </TextField>
                  <TextField
                    size="small"
                    label="Email"
                    value={currentUser.email}
                    disabled
                    sx={{ ...fieldSx, gridColumn: { sm: '1 / -1' } }}
                  />
                  <TextField
                    size="small"
                    label="CRM user Global ID"
                    value={currentUser.crmUserEnabled ? currentUser.referenceCode || '' : 'Not a CRM employee'}
                    disabled
                    sx={fieldSx}
                  />
                  <TextField
                    size="small"
                    label="CRM contact Global ID"
                    value={currentUser.contactReferenceCode || ''}
                    disabled
                    sx={fieldSx}
                  />
                  <TextField
                    size="small"
                    label="CRM organization"
                    value={usersPayload?.currentOrganization?.referenceCode || ''}
                    disabled
                    sx={fieldSx}
                  />
                </Box>

                <Box display="flex" justifyContent="flex-end" mt={3}>
                  <Button
                    type="submit"
                    variant="contained"
                    startIcon={pendingAction === 'profile' ? <CircularProgress size={16} color="inherit" /> : <SaveRounded />}
                    disabled={busy || !profile.displayName.trim() || !profile.organizationName.trim() || !profileDirty}
                    sx={compactButtonSx}
                  >
                    Save profile
                  </Button>
                </Box>
                <OrganizationBrandingPanel />
              </>
            ) : (
              <Typography color="text.secondary">Profile unavailable.</Typography>
            )}
          </Box>
        ) : null}

        {!loading && activeTab === 1 ? (
          <Box role="tabpanel" id="settings-panel-1" aria-labelledby="settings-tab-1">
            {usersPayload?.isAdmin && usersPayload.canInvite ? (
              <Box component="form" onSubmit={inviteUser} mb={2.5}>
                <Typography variant="subtitle2" color="text.primary" fontWeight={700} mb={1}>Invite</Typography>
                <Alert severity="info" variant="outlined" sx={{ mb: 1.5, borderRadius: '8px' }}>
                  Choose the organization whose data this person may access. New invitations start as Members; after inviting,
                  the owner can promote the person to Admin and select administrative permissions on their user card. Enable
                  CRM employee only when the person should own CRM records.
                </Alert>
                <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', sm: 'minmax(0, 1fr) minmax(0, 1fr) auto' }, gap: 1 }}>
                  <TextField
                    required
                    fullWidth
                    size="small"
                    type="email"
                    label="Email"
                    value={inviteEmail}
                    onChange={(event) => setInviteEmail(event.target.value)}
                    disabled={busy}
                    sx={fieldSx}
                  />
                  <TextField
                    select
                    required
                    fullWidth
                    size="small"
                    label="Organization"
                    value={inviteOrganizationId}
                    onChange={(event) => {
                      const value = event.target.value
                      setInviteOrganizationId(value)
                      if (value !== NEW_ORGANIZATION) setNewOrganizationName('')
                    }}
                    disabled={busy}
                    sx={fieldSx}
                  >
                    {(usersPayload.workspaceOrganizations || []).map((organization) => (
                      <MenuItem key={organization.id} value={organization.id}>
                        {'  '.repeat(Math.max(0, organization.depth))}{organization.name} ({organization.referenceCode})
                      </MenuItem>
                    ))}
                    <Divider />
                    <MenuItem value={NEW_ORGANIZATION}>Create child organization</MenuItem>
                  </TextField>
                  <Button
                    type="submit"
                    variant="contained"
                    startIcon={pendingAction === 'invite' ? <CircularProgress size={16} color="inherit" /> : <PersonAddRounded />}
                    disabled={busy
                      || !isEmail(inviteEmail)
                      || (!inviteOrganizationId)
                      || (inviteOrganizationId === NEW_ORGANIZATION
                        && (!newOrganizationName.trim() || !newOrganizationParentId))}
                    sx={compactButtonSx}
                  >
                    Invite
                  </Button>
                  {inviteOrganizationId === NEW_ORGANIZATION ? (
                    <>
                      <TextField
                        required
                        fullWidth
                        size="small"
                        label="New organization name"
                        value={newOrganizationName}
                        onChange={(event) => setNewOrganizationName(event.target.value)}
                        disabled={busy}
                        inputProps={{ maxLength: 200 }}
                        sx={{ ...fieldSx, gridColumn: { sm: '1 / 2' } }}
                      />
                      <TextField
                        select
                        required
                        fullWidth
                        size="small"
                        label="Parent organization"
                        value={newOrganizationParentId}
                        onChange={(event) => setNewOrganizationParentId(event.target.value)}
                        disabled={busy}
                        sx={{ ...fieldSx, gridColumn: { sm: '2 / 3' } }}
                      >
                        {(usersPayload.workspaceOrganizations || []).map((organization) => (
                          <MenuItem key={organization.id} value={organization.id}>
                            {'  '.repeat(Math.max(0, organization.depth))}{organization.name} ({organization.referenceCode})
                          </MenuItem>
                        ))}
                      </TextField>
                    </>
                  ) : null}
                  <Box sx={{ gridColumn: { sm: '1 / -1' }, px: 0.25 }}>
                    <FormControlLabel
                      control={(
                        <Switch
                          size="small"
                          checked={inviteCrmEmployee}
                          onChange={(event) => setInviteCrmEmployee(event.target.checked)}
                          disabled={busy}
                          inputProps={{ 'aria-label': 'Configure invited user as a CRM employee' }}
                        />
                      )}
                      label="CRM employee"
                    />
                    <Typography variant="caption" color="text.disabled" display="block">
                      Creates a permanent gu identity. Link the employee to an existing SuiteCRM user after invitation if needed.
                    </Typography>
                    <FormControlLabel
                      control={(
                        <Switch
                          size="small"
                          checked={inviteDemoAccess}
                          onChange={(event) => setInviteDemoAccess(event.target.checked)}
                          disabled={busy}
                          inputProps={{ 'aria-label': 'Allow invited user to open the demo account' }}
                        />
                      )}
                      label="Demo account access"
                      sx={{ mt: 1 }}
                    />
                    <Typography variant="caption" color="text.disabled" display="block">
                      Off by default. When enabled, the user can open the shared synthetic, read-only account after signing in.
                    </Typography>
                  </Box>
                </Box>
              </Box>
            ) : null}

            <Stack spacing={1.5}>
              {displayedUsers.map((user) => {
                const manageable = canManageUser(user)
                const canChangeRole = manageable && currentUser?.role === 'owner'
                const crmMappingManageable = canManageCrmMapping(user)
                const crmEmployeeManageable = crmMappingManageable && user.role !== 'owner'
                const permissionGuidance = user.role === 'owner'
                  ? 'Owner access is fixed and always includes every permission. Transfer ownership through a separate audited workflow.'
                  : !manageable
                    ? currentUser?.email === user.email
                      ? 'Your permissions are managed by another organization administrator.'
                      : 'Manage access permission is required to change this user.'
                    : user.role === 'member'
                      ? 'Members can receive work and specialist permissions. Promote this user to Admin to enable administrative permissions.'
                      : 'Admin permissions can be adjusted individually. An admin cannot grant access they do not hold.'
                const userPending = pendingAction === `status:${user.email}`
                  || pendingAction === `access:${user.email}`
                  || pendingAction === `crm-employee:${user.email}`
                  || pendingAction === `crm-map:${user.email}`

                return (
                  <Box key={`${user.email}:${user.organizationId || 'identity'}`} sx={panelSx}>
                    <Box sx={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) auto', gap: 1.5, alignItems: 'start', p: { xs: 1.5, sm: 2 } }}>
                      <Stack direction="row" spacing={1.25} alignItems="center" minWidth={0}>
                        <Avatar sx={{ width: 38, height: 38, bgcolor: '#2D3442', color: 'primary.main', fontSize: '0.8rem', fontWeight: 700 }}>
                          {initials(user)}
                        </Avatar>
                        <Box minWidth={0}>
                          <Stack direction="row" spacing={0.75} alignItems="center" flexWrap="wrap" useFlexGap>
                            <Typography variant="body2" color="text.primary" fontWeight={700} sx={{ overflowWrap: 'anywhere' }}>
                              {user.displayName || user.email.split('@')[0]}
                            </Typography>
                            <Chip size="small" label={roleLabel(user.role)} sx={{ height: 24, minHeight: 24, fontSize: '0.7rem' }} />
                            <Chip
                              size="small"
                              color={user.status === 'active' ? 'success' : user.status === 'invited' ? 'warning' : 'default'}
                              label={statusLabel(user.status)}
                              sx={{ height: 24, minHeight: 24, fontSize: '0.7rem' }}
                            />
                            <Chip
                              size="small"
                              color={user.crmUserEnabled && user.suiteCrmUserId ? 'success' : 'default'}
                              variant="outlined"
                              label={!user.crmUserEnabled
                                ? 'App only'
                                : user.suiteCrmUserId ? `CRM: ${user.referenceCode}` : `CRM employee: ${user.referenceCode}`}
                              sx={{ height: 24, minHeight: 24, fontSize: '0.7rem' }}
                            />
                          </Stack>
                          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', overflowWrap: 'anywhere' }}>
                            {user.email}
                          </Typography>
                          <Typography variant="caption" color="text.disabled" sx={{ display: 'block', overflowWrap: 'anywhere' }}>
                            {user.organizationName || 'Organization not assigned'}
                          </Typography>
                          {user.jobTitle || user.lastLoginAt ? (
                            <Typography variant="caption" color="text.disabled" sx={{ display: 'block' }}>
                              {user.jobTitle || `Last sign-in ${formatUserDateTime(user.lastLoginAt, dateTimeSettings, {
                                year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', fallback: 'Unknown date',
                              })}`}
                            </Typography>
                          ) : null}
                        </Box>
                      </Stack>

                      {manageable ? (
                        <Tooltip title={user.status === 'disabled' ? 'Restore access' : 'Disable access'}>
                          <span>
                            <IconButton
                              aria-label={user.status === 'disabled' ? `Restore ${user.email}` : `Disable ${user.email}`}
                              size="small"
                              onClick={() => { void updateStatus(user) }}
                              disabled={busy}
                              sx={{ color: user.status === 'disabled' ? 'primary.main' : 'text.secondary' }}
                            >
                              {pendingAction === `status:${user.email}`
                                ? <CircularProgress size={18} />
                                : user.status === 'disabled' ? <RestoreRounded fontSize="small" /> : <PersonOffRounded fontSize="small" />}
                            </IconButton>
                          </span>
                        </Tooltip>
                      ) : userPending ? <CircularProgress size={18} /> : null}
                    </Box>

                    <Divider sx={{ borderColor: 'rgba(255,255,255,0.07)' }} />

                    <Box sx={{ p: { xs: 1.5, sm: 2 }, pt: { xs: 1.25, sm: 1.5 } }}>
                      {crmMappingManageable ? (
                        <Box display="flex" alignItems="center" justifyContent="space-between" gap={1.5} mb={1.5}>
                          <Box>
                            <Typography variant="body2" color="text.primary" fontWeight={700}>CRM employee</Typography>
                            <Typography variant="caption" color="text.disabled">
                              Employee identities receive a permanent gu Global ID and may own CRM records.
                            </Typography>
                          </Box>
                          <Switch
                            size="small"
                            checked={user.crmUserEnabled}
                            onChange={(event) => { void updateCrmEmployee(user, event.target.checked) }}
                            disabled={busy || !crmEmployeeManageable}
                            inputProps={{ 'aria-label': `CRM employee access for ${user.email}` }}
                          />
                        </Box>
                      ) : null}
                      {crmMappingManageable && user.crmUserEnabled ? (
                        <Box sx={{ display: 'grid', gridTemplateColumns: { xs: 'minmax(0, 1fr)', sm: 'minmax(0, 1fr) auto' }, gap: 1, mb: 1.5 }}>
                          <TextField
                            size="small"
                            label="SuiteCRM username"
                            value={user.referenceCode || ''}
                            disabled={busy}
                            helperText="Permanent ClawPilot user Global ID"
                            inputProps={{ readOnly: true, 'aria-label': `SuiteCRM username for ${user.email}` }}
                            sx={fieldSx}
                          />
                          <Button
                            variant="outlined"
                            onClick={() => { void syncSuiteCrmUser(user) }}
                            disabled={busy || !user.referenceCode}
                            startIcon={pendingAction === `crm-map:${user.email}` ? <CircularProgress size={16} /> : <ReplayRounded />}
                            sx={compactButtonSx}
                          >
                            {user.suiteCrmUserId ? 'Resync CRM identity' : 'Sync CRM identity'}
                          </Button>
                        </Box>
                      ) : null}
                      <Box display="flex" alignItems="center" justifyContent="space-between" gap={1.5} mb={0.75}>
                        <Typography variant="caption" color="text.disabled" fontWeight={700}>Permissions</Typography>
                        {canChangeRole ? (
                          <TextField
                            select
                            size="small"
                            label="Role"
                            value={user.role === 'owner' ? 'admin' : user.role}
                            onChange={(event) => {
                              const role = event.target.value as EditableRole
                              void updateAccess(user, role, permissionsForRolePreset(role, user.permissions))
                            }}
                            disabled={busy}
                            sx={{ ...fieldSx, width: 132 }}
                          >
                            <MenuItem value="admin">Admin</MenuItem>
                            <MenuItem value="member">Member</MenuItem>
                          </TextField>
                        ) : null}
                      </Box>

                      <Typography
                        variant="caption"
                        color="text.disabled"
                        sx={{ display: 'block', mb: 0.75, lineHeight: 1.45 }}
                      >
                        {permissionGuidance}
                      </Typography>

                      <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', sm: '1fr 1fr' }, columnGap: 2, rowGap: 0 }}>
                        {PERMISSIONS.map((permission) => {
                          const permissionEditable = manageable && (!permission.adminOnly || user.role === 'admin')
                          return (
                            <Tooltip
                              key={permission.key}
                              title={permission.description || ''}
                              placement="top"
                              arrow
                              describeChild={Boolean(permission.description)}
                            >
                              <FormControlLabel
                                label={permission.label}
                                labelPlacement="start"
                                control={(
                                  <Switch
                                    size="small"
                                    checked={Boolean(user.permissions[permission.key])}
                                    onChange={(event) => {
                                      void updateAccess(user, user.role as EditableRole, {
                                        ...user.permissions,
                                        [permission.key]: event.target.checked,
                                      })
                                    }}
                                    disabled={busy || !permissionEditable}
                                    inputProps={{ 'aria-label': `${permission.label} for ${user.email}` }}
                                  />
                                )}
                                sx={{
                                  m: 0,
                                  minHeight: 38,
                                  justifyContent: 'space-between',
                                  gap: 1,
                                  '& .MuiFormControlLabel-label': { fontSize: '0.82rem', color: 'text.secondary' },
                                }}
                              />
                            </Tooltip>
                          )
                        })}
                      </Box>
                    </Box>
                  </Box>
                )
              })}

              {displayedUsers.length === 0 ? (
                <Typography variant="body2" color="text.secondary">Account unavailable.</Typography>
              ) : null}
            </Stack>
          </Box>
        ) : null}

        {!loading && activeTab === 2 ? (
          <Box role="tabpanel" id="settings-panel-2" aria-labelledby="settings-tab-2">
            <Stack spacing={3}>
              {workspaceSections.map((section) => (
                <Box component="section" key={section.kind}>
                  <Box display="flex" alignItems="center" justifyContent="space-between" gap={2} mb={1.25}>
                    <Stack direction="row" spacing={0.75} alignItems="center">
                      {section.kind === 'board'
                        ? <ViewKanbanRounded sx={{ fontSize: 19, color: 'text.secondary' }} />
                        : <TableChartRounded sx={{ fontSize: 19, color: 'text.secondary' }} />}
                      <Typography variant="subtitle2" color="text.primary" fontWeight={700}>{section.title}</Typography>
                    </Stack>
                  </Box>

                  {section.canCreate ? (
                    <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} mb={1.5}>
                      <TextField
                        fullWidth
                        size="small"
                        label={section.kind === 'board' ? 'Board name' : 'Pipeline name'}
                        value={createNames[section.kind]}
                        onChange={(event) => setCreateNames((current) => ({ ...current, [section.kind]: event.target.value }))}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter') {
                            event.preventDefault()
                            void createResource(section.kind)
                          }
                        }}
                        disabled={busy}
                        inputProps={{ maxLength: 100 }}
                        sx={fieldSx}
                      />
                      <Button
                        variant="outlined"
                        startIcon={pendingAction === `create:${section.kind}` ? <CircularProgress size={16} /> : <AddRounded />}
                        onClick={() => { void createResource(section.kind) }}
                        disabled={busy || !createNames[section.kind].trim()}
                        sx={compactButtonSx}
                      >
                        Create
                      </Button>
                    </Stack>
                  ) : null}

                  <Stack spacing={1.25}>
                    {section.resources.map((resource) => {
                      const owned = resource.ownerEmail === currentUser?.email && resource.accessRole === 'owner'
                      const draft = shareDraft(section.kind, resource.id)
                      const pipeline = 'sheetBacked' in resource ? resource as PipelineResource : null
                      const suggestions = eligibleShareEmails.filter((email) => !resource.members.some((member) => member.email === email))
                      const shareKey = `share:${section.kind}:${resource.id}`
                      const provisionKey = `provision:pipeline:${resource.id}`
                      const provisioningActive = pipeline?.provisioningStatus === 'queued' || pipeline?.provisioningStatus === 'provisioning'
                      const provisioningFailed = pipeline?.provisioningStatus === 'failed'
                      const sheetUrl = httpsUrl(pipeline?.shortLinkUrl)
                      const openSheetCommand = pipeline?.shortLinkUrl ? (
                        <Tooltip title={sheetUrl ? `Open ${resource.name} Sheet` : 'Sheet link is unavailable'}>
                          <Box component="span" sx={{ width: { xs: '100%', sm: 'auto' } }}>
                            <Button
                              variant="outlined"
                              startIcon={<OpenInNewRounded />}
                              aria-label={`Open Sheet for ${resource.name}`}
                              onClick={() => openPipelineSheet(pipeline)}
                              disabled={busy || !sheetUrl}
                              sx={{ ...compactButtonSx, width: { xs: '100%', sm: 'auto' } }}
                            >
                              Open Sheet
                            </Button>
                          </Box>
                        </Tooltip>
                      ) : null

                      return (
                        <Box key={resource.id} sx={panelSx}>
                          <Box sx={{ p: { xs: 1.5, sm: 2 } }}>
                            <Box sx={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) auto', gap: 1, alignItems: 'start' }}>
                              <Box minWidth={0}>
                                <Stack direction="row" spacing={0.75} alignItems="center" flexWrap="wrap" useFlexGap>
                                  <Typography variant="body2" color="text.primary" fontWeight={700} sx={{ overflowWrap: 'anywhere' }}>
                                    {resource.name}
                                  </Typography>
                                  {section.selectedId === resource.id ? <Chip size="small" label="Current" color="primary" sx={{ height: 24, minHeight: 24, fontSize: '0.7rem' }} /> : null}
                                  {resource.isDefault ? <Chip size="small" label="Default" sx={{ height: 24, minHeight: 24, fontSize: '0.7rem' }} /> : null}
                                  <Chip size="small" label={resource.accessRole.charAt(0).toUpperCase() + resource.accessRole.slice(1)} sx={{ height: 24, minHeight: 24, fontSize: '0.7rem' }} />
                                </Stack>
                                <Typography variant="caption" color="text.disabled" sx={{ display: 'block', overflowWrap: 'anywhere' }}>
                                  Owner · {resource.ownerEmail}
                                </Typography>
                              </Box>
                              {pendingAction?.includes(`:${section.kind}:${resource.id}`) ? <CircularProgress size={18} /> : null}
                            </Box>

                            {pipeline ? (
                              <>
                                <Stack direction="row" spacing={0.75} mt={1} flexWrap="wrap" useFlexGap>
                                  <Chip size="small" variant="outlined" label={pipeline.sheetBacked ? 'Sheet-backed' : 'App data'} sx={{ height: 24, minHeight: 24, fontSize: '0.7rem' }} />
                                  <Chip size="small" variant="outlined" label={pipeline.syncEnabled ? 'Sync on' : 'Sync off'} sx={{ height: 24, minHeight: 24, fontSize: '0.7rem' }} />
                                </Stack>

                                {provisioningActive ? (
                                  <Stack
                                    direction={{ xs: 'column', sm: 'row' }}
                                    alignItems={{ xs: 'stretch', sm: 'center' }}
                                    justifyContent="space-between"
                                    spacing={1}
                                    mt={1.25}
                                    sx={{ minHeight: 40 }}
                                  >
                                    <Stack
                                      direction="row"
                                      alignItems="center"
                                      spacing={1}
                                      role="status"
                                      aria-live="polite"
                                      sx={{ minWidth: { sm: 220 }, minHeight: 40 }}
                                    >
                                      <CircularProgress size={18} />
                                      <Typography variant="body2" color="text.secondary" fontWeight={600}>
                                        {pipeline.provisioningStatus === 'queued' ? 'Sheet creation queued' : 'Creating private Sheet'}
                                      </Typography>
                                    </Stack>
                                    {openSheetCommand}
                                  </Stack>
                                ) : provisioningFailed ? (
                                  <Box mt={1.25} sx={{ minHeight: 64 }}>
                                    <Stack
                                      direction={{ xs: 'column', sm: 'row' }}
                                      alignItems={{ xs: 'stretch', sm: 'center' }}
                                      justifyContent="space-between"
                                      spacing={1}
                                      sx={{ minHeight: 40 }}
                                    >
                                      <Stack direction="row" alignItems="center" spacing={0.75} sx={{ minHeight: 40 }}>
                                        <ErrorOutlineRounded color="error" sx={{ fontSize: 20, flexShrink: 0 }} />
                                        <Typography variant="body2" color="error.light" fontWeight={700}>Sheet setup failed</Typography>
                                      </Stack>
                                      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1}>
                                        {owned && !pipeline.sheetBacked ? (
                                          <Button
                                            variant="outlined"
                                            startIcon={pendingAction === provisionKey ? <CircularProgress size={16} /> : <ReplayRounded />}
                                            onClick={() => requestPipelineProvisioning(pipeline)}
                                            disabled={busy}
                                            sx={{ ...compactButtonSx, width: { xs: '100%', sm: 'auto' } }}
                                          >
                                            Retry
                                          </Button>
                                        ) : null}
                                        {openSheetCommand}
                                      </Stack>
                                    </Stack>
                                    <Typography variant="caption" color="error.light" sx={{ display: 'block', mt: 0.5, overflowWrap: 'anywhere' }}>
                                      {safeProvisioningError(pipeline.provisioningError)}
                                    </Typography>
                                  </Box>
                                ) : owned && !pipeline.sheetBacked ? (
                                  <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} mt={1.25} sx={{ minHeight: 40 }}>
                                    <Button
                                      variant="outlined"
                                      startIcon={pendingAction === provisionKey ? <CircularProgress size={16} /> : <AddToDriveRounded />}
                                      onClick={() => requestPipelineProvisioning(pipeline)}
                                      disabled={busy}
                                      sx={{ ...compactButtonSx, width: { xs: '100%', sm: 'auto' } }}
                                    >
                                      Create private Sheet
                                    </Button>
                                    {openSheetCommand}
                                  </Stack>
                                ) : openSheetCommand ? (
                                  <Stack direction="row" mt={1.25} sx={{ minHeight: 40 }}>{openSheetCommand}</Stack>
                                ) : null}
                              </>
                            ) : null}
                          </Box>

                          {owned ? (
                            <>
                              <Divider sx={{ borderColor: 'rgba(255,255,255,0.07)' }} />
                              <Box sx={{ p: { xs: 1.5, sm: 2 } }}>
                                <Typography variant="caption" color="text.disabled" fontWeight={700}>Share</Typography>
                                <Box
                                  sx={{
                                    display: 'grid',
                                    gridTemplateColumns: { xs: '1fr', sm: 'minmax(0, 1fr) 132px auto' },
                                    gap: 1,
                                    mt: 1,
                                  }}
                                >
                                  <TextField
                                    size="small"
                                    type="email"
                                    label="User email"
                                    value={draft.email}
                                    onChange={(event) => updateShareDraft(section.kind, resource.id, { email: event.target.value })}
                                    disabled={busy}
                                    inputProps={{ list: `share-users-${resource.id}` }}
                                    sx={fieldSx}
                                  />
                                  <datalist id={`share-users-${resource.id}`}>
                                    {suggestions.map((email) => <option key={email} value={email} />)}
                                  </datalist>
                                  <TextField
                                    select
                                    size="small"
                                    label="Access"
                                    value={draft.accessRole}
                                    onChange={(event) => updateShareDraft(section.kind, resource.id, { accessRole: event.target.value as ShareAccessRole })}
                                    disabled={busy}
                                    sx={fieldSx}
                                  >
                                    <MenuItem value="viewer">Viewer</MenuItem>
                                    <MenuItem value="editor">Editor</MenuItem>
                                  </TextField>
                                  <Button
                                    variant="contained"
                                    startIcon={pendingAction === shareKey ? <CircularProgress size={16} color="inherit" /> : <ShareRounded />}
                                    onClick={() => { void shareResource(section.kind, resource) }}
                                    disabled={busy || !isEmail(draft.email)}
                                    sx={compactButtonSx}
                                  >
                                    Share
                                  </Button>
                                </Box>
                              </Box>
                            </>
                          ) : null}

                          {owned ? <>
                            <Divider sx={{ borderColor: 'rgba(255,255,255,0.07)' }} />

                            <Box sx={{ px: { xs: 1.5, sm: 2 }, py: 0.5 }}>
                            {resource.members.length > 0 ? resource.members.map((member, index) => (
                              <Box
                                key={member.email}
                                sx={{
                                  display: 'grid',
                                  gridTemplateColumns: owned
                                    ? { xs: 'minmax(0, 1fr) auto', sm: 'minmax(0, 1fr) 120px auto' }
                                    : 'minmax(0, 1fr) auto',
                                  gridTemplateAreas: owned
                                    ? { xs: '"identity identity" "access remove"', sm: '"identity access remove"' }
                                    : '"identity access"',
                                  alignItems: 'center',
                                  gap: 1,
                                  py: 1.25,
                                  borderTop: index === 0 ? 0 : '1px solid rgba(255,255,255,0.06)',
                                }}
                              >
                                <Box minWidth={0} sx={{ gridArea: 'identity' }}>
                                  <Typography variant="body2" color="text.primary" sx={{ overflowWrap: 'anywhere' }}>
                                    {member.displayName || member.email}
                                  </Typography>
                                  <Typography variant="caption" color="text.disabled" sx={{ display: 'block', overflowWrap: 'anywhere' }}>
                                    {member.displayName ? member.email : statusLabel(member.status)}
                                    {member.displayName ? ` · ${statusLabel(member.status)}` : ''}
                                  </Typography>
                                </Box>

                                {owned ? (
                                  <TextField
                                    select
                                    size="small"
                                    aria-label={`Access for ${member.email}`}
                                    value={member.accessRole}
                                    onChange={(event) => { void changeShareRole(section.kind, resource, member, event.target.value as ShareAccessRole) }}
                                    disabled={busy || member.status === 'disabled'}
                                    sx={{ ...fieldSx, minWidth: 110, gridArea: 'access' }}
                                  >
                                    <MenuItem value="viewer">Viewer</MenuItem>
                                    <MenuItem value="editor">Editor</MenuItem>
                                  </TextField>
                                ) : (
                                  <Chip
                                    size="small"
                                    label={member.accessRole === 'editor' ? 'Editor' : 'Viewer'}
                                    sx={{ height: 24, minHeight: 24, fontSize: '0.7rem', justifySelf: 'end', gridArea: 'access' }}
                                  />
                                )}

                                {owned ? (
                                  <Tooltip title="Remove access">
                                    <Box component="span" sx={{ gridArea: 'remove' }}>
                                      <IconButton
                                        aria-label={`Remove ${member.email} from ${resource.name}`}
                                        size="small"
                                        onClick={() => { void removeShare(section.kind, resource, member) }}
                                        disabled={busy}
                                        sx={{ color: 'text.secondary' }}
                                      >
                                        {pendingAction === `remove-share:${section.kind}:${resource.id}:${member.email}`
                                          ? <CircularProgress size={17} />
                                          : <DeleteOutlineRounded fontSize="small" />}
                                      </IconButton>
                                    </Box>
                                  </Tooltip>
                                ) : null}
                              </Box>
                            )) : (
                              <Typography variant="body2" color="text.disabled" sx={{ py: 1.25 }}>
                                No shared access
                              </Typography>
                            )}
                            </Box>
                          </> : null}
                        </Box>
                      )
                    })}

                    {section.resources.length === 0 ? (
                      <Typography variant="body2" color="text.secondary">No {section.title.toLowerCase()} available.</Typography>
                    ) : null}
                  </Stack>
                </Box>
              ))}
            </Stack>
          </Box>
        ) : null}

        {!loading && activeTab === 3 ? (
          <IntegrationSettingsPanel
            initialIntegration={initialTab === 3 ? 'commerce' : undefined}
            isOwner={currentUser?.role === 'owner'}
            canManageOrganizationIntegrations={Boolean(
              currentUser?.role === 'owner'
              || (currentUser?.role === 'admin' && currentUser.permissions.manageUserAccess)
            )}
            canManageOperationsIntegrations={Boolean(
              currentUser?.role === 'owner'
              || currentUser?.permissions.manageOperations
            )}
          />
        ) : null}
        {!loading && activeTab === 4 ? <SessionSecurityPanel /> : null}
      </DialogContent>

      <Dialog
        open={Boolean(provisioningPipeline)}
        onClose={() => { if (!busy) setProvisioningPipeline(null) }}
        aria-labelledby="provision-pipeline-title"
        aria-describedby="provision-pipeline-description"
        fullWidth
        fullScreen={fullScreen}
        maxWidth="xs"
        PaperProps={{
          sx: {
            backgroundColor: '#1A1A23',
            backgroundImage: 'none',
            border: '1px solid rgba(255,255,255,0.09)',
            borderRadius: fullScreen ? 0 : '8px',
          },
        }}
      >
        <DialogTitle id="provision-pipeline-title" fontWeight={700}>
          {provisioningPipeline?.provisioningStatus === 'failed' ? 'Retry private Sheet setup?' : 'Create private Sheet?'}
        </DialogTitle>
        <DialogContent>
          <Typography id="provision-pipeline-description" variant="body2" color="text.secondary">
            This creates a managed Google Drive folder, a private Google Sheet, and a ClawPilot short link for{' '}
            <Box component="span" color="text.primary" fontWeight={700}>{provisioningPipeline?.name}</Box>.
          </Typography>
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2.5 }}>
          <Button onClick={() => setProvisioningPipeline(null)} disabled={busy}>Cancel</Button>
          <Button
            variant="contained"
            startIcon={pendingAction?.startsWith('provision:pipeline:')
              ? <CircularProgress size={16} color="inherit" />
              : provisioningPipeline?.provisioningStatus === 'failed' ? <ReplayRounded /> : <AddToDriveRounded />}
            onClick={() => { void confirmPipelineProvisioning() }}
            disabled={busy || !provisioningPipeline}
          >
            {provisioningPipeline?.provisioningStatus === 'failed' ? 'Retry' : 'Create private Sheet'}
          </Button>
        </DialogActions>
      </Dialog>
    </Dialog>
  )
}
