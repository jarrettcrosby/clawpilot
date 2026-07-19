'use client'

import { useEffect, useMemo, useState } from 'react'
import Accordion from '@mui/material/Accordion'
import AccordionDetails from '@mui/material/AccordionDetails'
import AccordionSummary from '@mui/material/AccordionSummary'
import Alert from '@mui/material/Alert'
import Autocomplete from '@mui/material/Autocomplete'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Chip from '@mui/material/Chip'
import CircularProgress from '@mui/material/CircularProgress'
import Divider from '@mui/material/Divider'
import Dialog from '@mui/material/Dialog'
import DialogActions from '@mui/material/DialogActions'
import DialogContent from '@mui/material/DialogContent'
import DialogTitle from '@mui/material/DialogTitle'
import FormControl from '@mui/material/FormControl'
import FormControlLabel from '@mui/material/FormControlLabel'
import InputLabel from '@mui/material/InputLabel'
import MenuItem from '@mui/material/MenuItem'
import Select from '@mui/material/Select'
import Stack from '@mui/material/Stack'
import Switch from '@mui/material/Switch'
import TextField from '@mui/material/TextField'
import Typography from '@mui/material/Typography'
import AccountBalanceRounded from '@mui/icons-material/AccountBalanceRounded'
import CloudDoneRounded from '@mui/icons-material/CloudDoneRounded'
import ExpandMoreRounded from '@mui/icons-material/ExpandMoreRounded'
import Inventory2Rounded from '@mui/icons-material/Inventory2Rounded'
import HubRounded from '@mui/icons-material/HubRounded'
import LinkRounded from '@mui/icons-material/LinkRounded'
import PowerSettingsNewRounded from '@mui/icons-material/PowerSettingsNewRounded'
import RefreshRounded from '@mui/icons-material/RefreshRounded'
import RestaurantRounded from '@mui/icons-material/RestaurantRounded'
import SaveRounded from '@mui/icons-material/SaveRounded'
import { useUserDateTime } from '@/components/timezone/UserDateTimeProvider'
import { formatUserDateTime } from '@/lib/userDateTime'

type ConnectionState = {
  configured: boolean
  companyName?: string
  country?: string | null
  status?: string
  catalogSyncEnabled?: boolean
  verifiedAt?: string
  lastCatalogSyncedAt?: string | null
  lastErrorCode?: string | null
}

type Account = {
  id: string
  name: string
  fullyQualifiedName: string
  classification: string | null
  accountType: string | null
  accountSubType: string | null
  active: boolean
}

type Item = {
  id: string
  name: string
  fullyQualifiedName: string
  itemType: string
  sku: string | null
  description: string | null
  unitPrice: number
  purchaseCost: number
  active: boolean
}

type ToastLocation = {
  restaurantGuid: string
  restaurantName: string
  locationName: string | null
}

type Mapping = {
  restaurantGuid: string
  mappingKey: MappingKey
  quickBooksAccountId: string | null
}

type IntegrationState = {
  connection: ConnectionState
  counts: { accounts: number; items: number }
  accounts: Account[]
  items: Item[]
  toastLocations: ToastLocation[]
  mappings: Mapping[]
  draftCounts: Record<string, number>
  crmSync: {
    pipelineId: string | null
    customerSyncEnabled: boolean
    productSyncEnabled: boolean
    lastSyncedAt: string | null
    lastError: string | null
  }
  sync: {
    status: string
    attemptCount: number
    lastError: string | null
    updatedAt: string
    completedAt: string | null
  } | null
}

type QuickBooksPayload = {
  ok?: boolean
  error?: string
  integration?: IntegrationState
  imported?: { imported: number; skipped: number }
}

const MAPPING_FIELDS = [
  ['gross_sales', 'Gross sales'],
  ['discounts', 'Discounts'],
  ['voids', 'Voids'],
  ['refunds', 'Refunds'],
  ['taxes', 'Sales tax'],
  ['tips', 'Tips'],
  ['service_charges', 'Service charges'],
  ['gift_cards', 'Gift cards'],
  ['cash', 'Cash tender'],
  ['card', 'Card tender'],
  ['other_tender', 'Other tender'],
  ['payouts', 'Payouts'],
  ['fees', 'Processing fees'],
  ['over_short', 'Cash over / short'],
] as const

type MappingKey = typeof MAPPING_FIELDS[number][0]
type MappingDraft = Record<MappingKey, string>

const EMPTY_STATE: IntegrationState = {
  connection: { configured: false },
  counts: { accounts: 0, items: 0 },
  accounts: [],
  items: [],
  toastLocations: [],
  mappings: [],
  draftCounts: {},
  crmSync: {
    pipelineId: null,
    customerSyncEnabled: false,
    productSyncEnabled: false,
    lastSyncedAt: null,
    lastError: null,
  },
  sync: null,
}

const fieldSx = {
  '& .MuiOutlinedInput-root': { borderRadius: '8px', backgroundColor: '#20202A' },
}

const buttonSx = {
  minHeight: 40,
  borderRadius: '8px',
  px: 1.5,
  whiteSpace: 'nowrap',
  width: { xs: '100%', sm: 'auto' },
}

async function requestQuickBooks(init?: RequestInit): Promise<QuickBooksPayload> {
  const response = await fetch('/api/integrations/quickbooks', init)
  const result = await response.json().catch(() => ({})) as QuickBooksPayload
  if (!response.ok || !result.ok) throw new Error(result.error || 'QuickBooks integration request failed')
  return result
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : 'QuickBooks integration request failed'
}

function initialMappings(integration: IntegrationState, restaurantGuid: string): MappingDraft {
  return Object.fromEntries(MAPPING_FIELDS.map(([key]) => [
    key,
    integration.mappings.find((mapping) => (
      mapping.restaurantGuid === restaurantGuid && mapping.mappingKey === key
    ))?.quickBooksAccountId || '',
  ])) as MappingDraft
}

export default function QuickBooksIntegrationPanel() {
  const dateTimeSettings = useUserDateTime()
  const [integration, setIntegration] = useState(EMPTY_STATE)
  const [selectedItems, setSelectedItems] = useState<Item[]>([])
  const [mappingDrafts, setMappingDrafts] = useState<Record<string, MappingDraft>>({})
  const [pendingAction, setPendingAction] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [confirmDisconnect, setConfirmDisconnect] = useState(false)
  const [crmCustomers, setCrmCustomers] = useState(false)
  const [crmProducts, setCrmProducts] = useState(false)

  const busy = Boolean(pendingAction)
  const importableItems = useMemo(() => integration.items.filter((item) => (
    item.active && item.itemType.toLowerCase() !== 'category'
  )), [integration.items])
  const activeAccounts = useMemo(() => integration.accounts.filter((account) => account.active), [integration.accounts])

  function applyIntegration(next: IntegrationState) {
    setIntegration(next)
    setSelectedItems((current) => current.filter((item) => next.items.some((candidate) => candidate.id === item.id)))
    setMappingDrafts(Object.fromEntries(next.toastLocations.map((location) => [
      location.restaurantGuid,
      initialMappings(next, location.restaurantGuid),
    ])))
    setCrmCustomers(next.crmSync.customerSyncEnabled)
    setCrmProducts(next.crmSync.productSyncEnabled)
  }

  useEffect(() => {
    let active = true
    requestQuickBooks()
      .then((result) => {
        if (active && result.integration) applyIntegration(result.integration)
      })
      .catch((caught) => { if (active) setError(errorMessage(caught)) })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [])

  async function patch(action: string, body: Record<string, unknown>, success: string) {
    setPendingAction(action)
    setError('')
    setNotice('')
    try {
      const result = await requestQuickBooks({
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (result.integration) applyIntegration(result.integration)
      setNotice(success)
      return result
    } catch (caught) {
      setError(errorMessage(caught))
      return null
    } finally {
      setPendingAction('')
    }
  }

  const lastSync = integration.connection.lastCatalogSyncedAt
    ? formatUserDateTime(integration.connection.lastCatalogSyncedAt, dateTimeSettings, {
        year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
      })
    : null

  if (loading) {
    return <Box display="grid" sx={{ minHeight: 320, placeItems: 'center' }}><CircularProgress size={28} /></Box>
  }

  return (
    <Box sx={{ maxWidth: 840, mx: 'auto' }}>
      {error ? <Alert severity="error" onClose={() => setError('')} sx={{ mb: 2, borderRadius: '8px' }}>{error}</Alert> : null}
      {notice ? <Alert severity="success" onClose={() => setNotice('')} sx={{ mb: 2, borderRadius: '8px' }}>{notice}</Alert> : null}

      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5} justifyContent="space-between" alignItems={{ xs: 'stretch', sm: 'center' }}>
        <Box minWidth={0}>
          <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
            <AccountBalanceRounded color="primary" />
            <Typography variant="h6" fontWeight={700}>QuickBooks Online</Typography>
            <Chip
              size="small"
              variant="outlined"
              color={integration.connection.configured && integration.connection.status === 'active' ? 'success' : integration.connection.configured ? 'warning' : 'default'}
              label={integration.connection.configured ? integration.connection.companyName : 'Not connected'}
            />
          </Stack>
          <Typography variant="caption" color="text.disabled" sx={{ display: 'block', mt: 0.5 }}>
            {lastSync ? `Catalog refreshed ${lastSync}` : 'Bind the active organization to your selected Maton QuickBooks connection.'}
          </Typography>
        </Box>
        {integration.connection.configured ? (
          <FormControlLabel
            control={(
              <Switch
                checked={integration.connection.catalogSyncEnabled === true}
                onChange={(_, enabled) => {
                  void patch('configure-sync', { action: 'configure-sync', enabled }, enabled ? 'Daily QuickBooks refresh enabled.' : 'Daily QuickBooks refresh disabled.')
                }}
                disabled={busy}
              />
            )}
            label="Daily QuickBooks refresh"
            sx={{ m: 0 }}
          />
        ) : null}
      </Stack>

      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} mt={2}>
        {!integration.connection.configured ? (
          <Button
            variant="contained"
            startIcon={pendingAction === 'bind' ? <CircularProgress size={16} /> : <LinkRounded />}
            onClick={() => { void patch('bind', { action: 'bind-selected-connection' }, 'QuickBooks company connected and data refresh queued.') }}
            disabled={busy}
            sx={buttonSx}
          >
            Connect selected QuickBooks
          </Button>
        ) : (
          <>
            <Button
              variant="outlined"
              startIcon={pendingAction === 'refresh' ? <CircularProgress size={16} /> : <RefreshRounded />}
              onClick={() => { void patch('refresh', { action: 'refresh-catalog' }, 'QuickBooks data refresh queued.') }}
              disabled={busy}
              sx={buttonSx}
            >
              Refresh QuickBooks data
            </Button>
            <Button
              color="error"
              variant="text"
              startIcon={<PowerSettingsNewRounded />}
              onClick={() => setConfirmDisconnect(true)}
              disabled={busy}
              sx={buttonSx}
            >
              Disconnect
            </Button>
          </>
        )}
      </Stack>

      {integration.sync ? (
        <Stack direction="row" spacing={0.75} mt={1.5} flexWrap="wrap" useFlexGap>
          <Chip size="small" variant="outlined" label={`Catalog ${integration.sync.status}`} color={integration.sync.status === 'succeeded' ? 'success' : integration.sync.status === 'dead' ? 'error' : 'warning'} />
          <Chip size="small" variant="outlined" label={`${integration.counts.accounts} accounts`} />
          <Chip size="small" variant="outlined" label={`${integration.counts.items} items`} />
        </Stack>
      ) : null}

      <Divider sx={{ my: 3 }} />

      <Box component="section" aria-labelledby="quickbooks-products-heading">
        <Stack direction="row" spacing={1} alignItems="center" mb={1.5}>
          <Inventory2Rounded color="primary" />
          <Box>
            <Typography id="quickbooks-products-heading" fontWeight={700}>Product and service catalog</Typography>
            <Typography variant="caption" color="text.secondary">Import only selected active items into the current pipeline.</Typography>
          </Box>
        </Stack>
        <Autocomplete
          multiple
          disableCloseOnSelect
          options={importableItems}
          value={selectedItems}
          onChange={(_, value) => setSelectedItems(value)}
          getOptionLabel={(option) => option.fullyQualifiedName || option.name}
          isOptionEqualToValue={(option, value) => option.id === value.id}
          disabled={!integration.connection.configured || busy}
          renderInput={(params) => (
            <TextField
              {...params}
              label="QuickBooks products and services"
              placeholder={selectedItems.length ? '' : 'Search catalog'}
              size="small"
              sx={fieldSx}
            />
          )}
          renderOption={(props, option) => (
            <Box component="li" {...props} key={option.id}>
              <Box minWidth={0}>
                <Typography variant="body2" noWrap>{option.fullyQualifiedName || option.name}</Typography>
                <Typography variant="caption" color="text.secondary">{option.itemType}{option.sku ? ` · ${option.sku}` : ''}</Typography>
              </Box>
            </Box>
          )}
          sx={{ ...fieldSx, mb: 1.5 }}
        />
        <Button
          variant="contained"
          startIcon={pendingAction === 'import-products' ? <CircularProgress size={16} /> : <CloudDoneRounded />}
          onClick={async () => {
            const result = await patch(
              'import-products',
              { action: 'import-products', itemIds: selectedItems.map((item) => item.id) },
              'Selected QuickBooks products imported into the active pipeline.',
            )
            if (result) setSelectedItems([])
          }}
          disabled={!integration.connection.configured || busy || selectedItems.length === 0 || selectedItems.length > 100}
          sx={buttonSx}
        >
          Import {selectedItems.length || ''} selected
        </Button>
      </Box>

      <Divider sx={{ my: 3 }} />

      <Box component="section" aria-labelledby="quickbooks-crm-heading">
        <Stack direction="row" spacing={1} alignItems="center" mb={1.5}>
          <HubRounded color="primary" />
          <Box>
            <Typography id="quickbooks-crm-heading" fontWeight={700}>CRM reconciliation</Typography>
            <Typography variant="caption" color="text.secondary">
              Link QuickBooks customer and product identities to the selected pipeline so repeated syncs update reconciled records.
            </Typography>
          </Box>
        </Stack>
        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} mb={1.5}>
          <FormControlLabel
            control={<Switch checked={crmCustomers} onChange={(_, checked) => setCrmCustomers(checked)} disabled={busy || !integration.connection.configured} />}
            label="Customers to CRM"
            sx={{ m: 0 }}
          />
          <FormControlLabel
            control={<Switch checked={crmProducts} onChange={(_, checked) => setCrmProducts(checked)} disabled={busy || !integration.connection.configured} />}
            label="Products to CRM"
            sx={{ m: 0 }}
          />
        </Stack>
        <Button
          variant="outlined"
          startIcon={pendingAction === 'configure-crm-sync' ? <CircularProgress size={16} /> : <HubRounded />}
          onClick={() => {
            void patch(
              'configure-crm-sync',
              { action: 'configure-crm-sync', customers: crmCustomers, products: crmProducts },
              'QuickBooks CRM reconciliation settings saved and cached records reconciled.',
            )
          }}
          disabled={!integration.connection.configured || busy}
          sx={buttonSx}
        >
          Save and reconcile
        </Button>
        {integration.crmSync.lastSyncedAt ? (
          <Typography variant="caption" color="text.secondary" display="block" mt={1.25}>
            Last reconciled {new Date(integration.crmSync.lastSyncedAt).toLocaleString()}
          </Typography>
        ) : null}
        {integration.crmSync.lastError ? <Alert severity="warning" sx={{ mt: 1.5, borderRadius: '8px' }}>{integration.crmSync.lastError}</Alert> : null}
      </Box>

      <Divider sx={{ my: 3 }} />

      <Box component="section" aria-labelledby="quickbooks-toast-mapping-heading">
        <Stack direction="row" spacing={1} alignItems="center" mb={1.5}>
          <RestaurantRounded color="primary" />
          <Box>
            <Typography id="quickbooks-toast-mapping-heading" fontWeight={700}>Toast accounting mappings</Typography>
            <Typography variant="caption" color="text.secondary">Map each selected restaurant location before reviewing accounting drafts.</Typography>
          </Box>
        </Stack>

        {integration.toastLocations.length ? integration.toastLocations.map((location) => {
          const draft = mappingDrafts[location.restaurantGuid] || initialMappings(integration, location.restaurantGuid)
          const mappedCount = MAPPING_FIELDS.filter(([key]) => Boolean(draft[key])).length
          return (
            <Accordion
              key={location.restaurantGuid}
              disableGutters
              elevation={0}
              sx={{ backgroundColor: 'transparent', borderTop: '1px solid rgba(255,255,255,0.1)', '&:before': { display: 'none' } }}
            >
              <AccordionSummary expandIcon={<ExpandMoreRounded />}>
                <Box minWidth={0} flex={1}>
                  <Typography fontWeight={650} noWrap>{location.locationName || location.restaurantName}</Typography>
                  <Typography variant="caption" color="text.secondary">{mappedCount} of {MAPPING_FIELDS.length} accounts mapped</Typography>
                </Box>
              </AccordionSummary>
              <AccordionDetails>
                <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', md: 'repeat(2, minmax(0, 1fr))' }, gap: 1.5 }}>
                  {MAPPING_FIELDS.map(([key, label]) => (
                    <FormControl key={key} size="small" fullWidth sx={fieldSx}>
                      <InputLabel id={`${location.restaurantGuid}-${key}-label`}>{label}</InputLabel>
                      <Select
                        labelId={`${location.restaurantGuid}-${key}-label`}
                        label={label}
                        value={draft[key]}
                        onChange={(event) => setMappingDrafts((current) => ({
                          ...current,
                          [location.restaurantGuid]: { ...draft, [key]: event.target.value },
                        }))}
                        disabled={busy}
                      >
                        <MenuItem value=""><em>Not mapped</em></MenuItem>
                        {activeAccounts.map((account) => (
                          <MenuItem key={account.id} value={account.id}>{account.fullyQualifiedName}</MenuItem>
                        ))}
                      </Select>
                    </FormControl>
                  ))}
                </Box>
                <Button
                  variant="outlined"
                  startIcon={pendingAction === `mapping:${location.restaurantGuid}` ? <CircularProgress size={16} /> : <SaveRounded />}
                  onClick={() => {
                    void patch(
                      `mapping:${location.restaurantGuid}`,
                      { action: 'save-mappings', restaurantGuid: location.restaurantGuid, mappings: draft },
                      `${location.locationName || location.restaurantName} account mappings saved.`,
                    )
                  }}
                  disabled={busy || !integration.connection.configured}
                  sx={{ ...buttonSx, mt: 2 }}
                >
                  Save mappings
                </Button>
              </AccordionDetails>
            </Accordion>
          )
        }) : (
          <Typography color="text.secondary" variant="body2">Select a Toast location to configure accounting mappings.</Typography>
        )}
      </Box>

      <Alert severity="info" sx={{ mt: 3, borderRadius: '8px' }}>
        Customers, products, and invoices can be prepared in Accounting as immutable review drafts. Provider posting remains disabled until this organization and the server runtime are verified for the same QuickBooks environment.
      </Alert>

      <Dialog
        open={confirmDisconnect}
        onClose={() => { if (!busy) setConfirmDisconnect(false) }}
        fullWidth
        maxWidth="xs"
      >
        <DialogTitle>Disconnect QuickBooks?</DialogTitle>
        <DialogContent>
          <Typography color="text.secondary">
            Cached accounts and products will be removed, and Toast account mappings will require review before accounting drafts can proceed.
          </Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setConfirmDisconnect(false)} disabled={busy}>Cancel</Button>
          <Button
            color="error"
            variant="contained"
            disabled={busy}
            startIcon={pendingAction === 'disconnect' ? <CircularProgress size={16} /> : <PowerSettingsNewRounded />}
            onClick={async () => {
              const result = await patch('disconnect', { action: 'disconnect' }, 'QuickBooks company disconnected.')
              if (result) setConfirmDisconnect(false)
            }}
          >
            Disconnect
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  )
}
