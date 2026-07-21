'use client'

import { useState, type ReactNode } from 'react'
import Alert from '@mui/material/Alert'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Chip from '@mui/material/Chip'
import Dialog from '@mui/material/Dialog'
import DialogActions from '@mui/material/DialogActions'
import DialogContent from '@mui/material/DialogContent'
import DialogTitle from '@mui/material/DialogTitle'
import Divider from '@mui/material/Divider'
import IconButton from '@mui/material/IconButton'
import Stack from '@mui/material/Stack'
import Tab from '@mui/material/Tab'
import Tabs from '@mui/material/Tabs'
import Typography from '@mui/material/Typography'
import useMediaQuery from '@mui/material/useMediaQuery'
import AccountBalanceRounded from '@mui/icons-material/AccountBalanceRounded'
import CloseRounded from '@mui/icons-material/CloseRounded'
import InsightsRounded from '@mui/icons-material/InsightsRounded'
import PointOfSaleRounded from '@mui/icons-material/PointOfSaleRounded'
import ReceiptLongRounded from '@mui/icons-material/ReceiptLongRounded'
import SyncAltRounded from '@mui/icons-material/SyncAltRounded'

export type PosGuideView = 'overview' | 'orders' | 'reports' | 'accounting'

type GuideSection = 'start' | 'orders' | 'reports' | 'accounting'

type PosGuideDialogProps = {
  open: boolean
  onClose: () => void
  onOpenView: (view: PosGuideView) => void
  isDemo: boolean | null
  canManage: boolean
  standardStatus: string
  analyticsStatus: string
  accountingStatus: string
  hasAccountingDraft: boolean
}

function statusColor(label: string): 'default' | 'success' | 'warning' | 'error' | 'info' {
  const value = label.toLowerCase()
  if (value.includes('ready') || value.includes('available') || value.includes('connected')) return 'success'
  if (value.includes('fail') || value.includes('error')) return 'error'
  if (value.includes('setup') || value.includes('waiting') || value.includes('partial')) return 'warning'
  return 'default'
}

function GuideHeading({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <Box display="flex" alignItems="center" gap={0.8}>
      {icon}
      <Typography variant="subtitle1" fontWeight={700}>{children}</Typography>
    </Box>
  )
}

function GuideStep({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Box>
      <Typography variant="subtitle2" fontWeight={700}>{title}</Typography>
      <Typography variant="body2" color="text.secondary" mt={0.4}>{children}</Typography>
    </Box>
  )
}

export default function PosGuideDialog({
  open,
  onClose,
  onOpenView,
  isDemo,
  canManage,
  standardStatus,
  analyticsStatus,
  accountingStatus,
  hasAccountingDraft,
}: PosGuideDialogProps) {
  const fullScreen = useMediaQuery('(max-width:699px), (max-height:520px) and (orientation: landscape)')
  const [section, setSection] = useState<GuideSection>('start')

  function closeDialog() {
    setSection('start')
    onClose()
  }

  function openView(view: PosGuideView) {
    onOpenView(view)
    closeDialog()
  }

  return (
    <Dialog
      open={open}
      onClose={closeDialog}
      aria-labelledby="pos-guide-title"
      fullScreen={fullScreen}
      fullWidth
      maxWidth="md"
      PaperProps={{
        sx: {
          bgcolor: '#171821',
          backgroundImage: 'none',
          border: fullScreen ? 0 : '1px solid rgba(255,255,255,0.09)',
          borderRadius: fullScreen ? 0 : '8px',
        },
      }}
    >
      <DialogTitle component="div" id="pos-guide-title" sx={{ pr: 7, pb: 1.25 }}>
        <Box display="flex" alignItems="center" gap={1}>
          <PointOfSaleRounded sx={{ color: '#A8C7FA' }} />
          <Box minWidth={0}>
            <Typography component="h2" variant="h6" fontWeight={700}>How POS works</Typography>
            <Typography variant="caption" color="text.secondary">
              Toast operations, reporting, and controlled accounting
            </Typography>
          </Box>
        </Box>
        <IconButton aria-label="Close POS guide" onClick={closeDialog} sx={{ position: 'absolute', right: 12, top: 12 }}>
          <CloseRounded />
        </IconButton>
      </DialogTitle>

      <Box px={{ xs: 2, sm: 3 }} pb={1.5} display="flex" flexWrap="wrap" gap={0.75}>
        <Chip
          size="small"
          color={isDemo === true ? 'info' : isDemo === false ? 'success' : 'default'}
          variant="outlined"
          label={isDemo === true ? 'Demo account' : isDemo === false ? 'Live business' : 'Current workspace'}
        />
        <Chip size="small" color={statusColor(standardStatus)} variant="outlined" label={`Orders: ${standardStatus}`} />
        <Chip size="small" color={statusColor(analyticsStatus)} variant="outlined" label={`Reconciliation: ${analyticsStatus}`} />
        <Chip size="small" color={statusColor(accountingStatus)} variant="outlined" label={`Drafts: ${accountingStatus}`} />
      </Box>

      <Tabs
        value={section}
        onChange={(_, value: GuideSection) => setSection(value)}
        variant="scrollable"
        scrollButtons="auto"
        aria-label="POS guide sections"
        sx={{ px: { xs: 1, sm: 2 }, borderTop: '1px solid rgba(255,255,255,0.07)' }}
      >
        <Tab id="pos-guide-tab-start" aria-controls="pos-guide-panel-start" value="start" label="Start here" />
        <Tab id="pos-guide-tab-orders" aria-controls="pos-guide-panel-orders" value="orders" label="Orders" />
        <Tab id="pos-guide-tab-reports" aria-controls="pos-guide-panel-reports" value="reports" label="Reports" />
        <Tab id="pos-guide-tab-accounting" aria-controls="pos-guide-panel-accounting" value="accounting" label="Accounting" />
      </Tabs>

      <DialogContent dividers sx={{ px: { xs: 2, sm: 3 }, py: 2.5 }}>
        <Box
          role="tabpanel"
          id={`pos-guide-panel-${section}`}
          aria-labelledby={`pos-guide-tab-${section}`}
          tabIndex={0}
          sx={{ outline: 'none' }}
        >
        {section === 'start' ? (
          <Stack spacing={2.25}>
            <Alert severity={isDemo === false ? 'success' : 'info'} sx={{ borderRadius: '8px' }}>
              {isDemo === true
                ? 'This is a protected, read-only demonstration with rolling synthetic sales. It never uses a live Toast or QuickBooks credential.'
                : isDemo === null
                  ? 'Workspace details are still loading. The guide remains available even when POS data is temporarily unavailable.'
                  : canManage
                    ? 'You are viewing the active business. Settings and accounting mappings are available only when your organization permissions allow them.'
                    : 'You are viewing the active business. Organization permissions determine whether you can prepare accounting drafts or review reports; an administrator manages provider connections and access.'}
            </Alert>

            <Box>
              <GuideHeading icon={<SyncAltRounded sx={{ color: '#70D6A7' }} />}>The data path</GuideHeading>
              <Typography variant="body2" color="text.secondary" mt={0.75}>
                Toast read-only APIs feed organization-scoped ClawPilot projections. Orders power POS reporting and sales-backed accounting drafts. Approved connector workflows can later send reviewed changes to QuickBooks. When a manager enables catalog synchronization for a selected pipeline, QuickBooks customers and products can feed that organization&apos;s CRM catalogs.
              </Typography>
            </Box>
            <Divider />
            <GuideStep title="1. Choose a business date and location">
              Every total, order, report, and accounting draft stays scoped to the active ClawPilot business, selected restaurant, and date range. Switching workspaces never reuses another business&apos;s POS data.
            </GuideStep>
            <GuideStep title="2. Read the source status independently">
              Standard Orders supplies detailed checks and line items. Analytics adds management reporting and payout evidence. One source can be ready while the other still needs setup.
            </GuideStep>
            <GuideStep title="3. Refresh the current ClawPilot view">
              Refresh POS data rereads the latest durable projection. Provider ingestion runs through scheduled synchronization or an authorized integration refresh, so repeatedly refreshing the page does not duplicate orders.
            </GuideStep>
            <Button variant="outlined" onClick={() => openView('overview')} sx={{ alignSelf: 'flex-start' }}>
              Open Overview
            </Button>
          </Stack>
        ) : null}

        {section === 'orders' ? (
          <Stack spacing={2.25}>
            <GuideHeading icon={<ReceiptLongRounded sx={{ color: '#A8C7FA' }} />}>Orders and checks</GuideHeading>
            <GuideStep title="Search the server-backed order list">
              Search, date, and location filters run against the active organization&apos;s durable order projection. Pagination keeps large business days usable without loading every order into the browser.
            </GuideStep>
            <GuideStep title="Open an order for the complete operating detail">
              The order drawer reconstructs checks, items, quantities, modifiers, discounts, tax, service charges, payments, tips, and refunds from sanitized Toast evidence. Customer identity and payment credentials are never exposed.
            </GuideStep>
            <GuideStep title="Use the business timestamp">
              Order timestamps display in the signed-in user&apos;s timezone. Business dates remain the restaurant&apos;s accounting dates and are not shifted by the browser timezone.
            </GuideStep>
            <Alert severity="info" sx={{ borderRadius: '8px' }}>
              Refunds and later Toast edits replace the affected daily projection without creating a second order.
            </Alert>
            <Button variant="outlined" onClick={() => openView('orders')} sx={{ alignSelf: 'flex-start' }}>
              Open Orders
            </Button>
          </Stack>
        ) : null}

        {section === 'reports' ? (
          <Stack spacing={2.25}>
            <GuideHeading icon={<InsightsRounded sx={{ color: '#CFC6EA' }} />}>Operational reports</GuideHeading>
            <GuideStep title="Reconcile the day before analyzing trends">
              Sales summaries separate net sales, discounts, service charges, tax, tips, tenders, and refunds. Checks and payments provide the evidence behind the headline totals.
            </GuideStep>
            <GuideStep title="Inspect product and tender performance">
              Product reporting groups stable Toast menu identities, quantities, and sales by item and category. Payment reporting separates cash, card, other tenders, and card brand when Toast supplies it.
            </GuideStep>
            <GuideStep title="Treat calculated values as calculated">
              Comparisons and run rates use only available business-date history. Payouts, weather, COGS, gross margin, and settlement evidence remain unavailable until a verified source supplies them.
            </GuideStep>
            <Button variant="outlined" onClick={() => openView('reports')} sx={{ alignSelf: 'flex-start' }}>
              Open Reports
            </Button>
          </Stack>
        ) : null}

        {section === 'accounting' ? (
          <Stack spacing={2.25}>
            <GuideHeading icon={<AccountBalanceRounded sx={{ color: '#F2B76D' }} />}>Accounting workflow</GuideHeading>
            <GuideStep title="Connect the correct QuickBooks company">
              The active ClawPilot business must be explicitly bound to its own QuickBooks company. Accounts, items, tax codes, classes, locations, customers, and vendors are refreshed into a read-only reference catalog.
            </GuideStep>
            <GuideStep title="Map Toast sources to stable targets">
              Match menu items, discounts, taxes, service charges, tenders, fees, and cash operations to QuickBooks items or accounts. An unmatched Toast item can prepare a reviewable product draft; it is never created silently.
            </GuideStep>
            <GuideStep title="Review the controlled posting preview">
              A sales receipt and balanced payments journal are generated only for a sales-backed business date. Missing mappings, open checks, source variance, or an unbalanced journal hold the draft for correction. Mapping changes regenerate only unapproved drafts; approved, posting, and posted evidence is protected.
            </GuideStep>
            <GuideStep title="Understand the status">
              Needs mapping means a destination is missing. Needs review means the evidence exists but requires an operator. Approved and Posted evidence cannot be overwritten. Failed work remains visible for a controlled retry.
            </GuideStep>
            <Alert severity={hasAccountingDraft ? 'warning' : 'info'} sx={{ borderRadius: '8px' }}>
              {hasAccountingDraft
                ? 'A draft exists in this date range. Open Accounting to review its mappings, balance, and hold reasons.'
                : 'No sales-backed accounting draft exists in this date range. Dates with no Toast sales do not create empty drafts.'}
            </Alert>
            <Alert severity="info" sx={{ borderRadius: '8px' }}>
              Posting is currently locked. ClawPilot prepares and validates accounting evidence; it does not bypass review or silently write raw Toast data to QuickBooks.
            </Alert>
            <Button variant="outlined" onClick={() => openView('accounting')} sx={{ alignSelf: 'flex-start' }}>
              Open Accounting
            </Button>
          </Stack>
        ) : null}
        </Box>
      </DialogContent>

      <DialogActions sx={{ px: { xs: 2, sm: 3 }, py: 1.5 }}>
        <Button onClick={closeDialog}>Done</Button>
      </DialogActions>
    </Dialog>
  )
}
