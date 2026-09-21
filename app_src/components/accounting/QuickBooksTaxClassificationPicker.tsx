'use client'

import { useRef, useState } from 'react'
import Alert from '@mui/material/Alert'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import CircularProgress from '@mui/material/CircularProgress'
import MenuItem from '@mui/material/MenuItem'
import Stack from '@mui/material/Stack'
import TextField from '@mui/material/TextField'
import Typography from '@mui/material/Typography'
import {
  taxClassificationAppliesToItem,
  type QuickBooksTaxClassification,
} from '@/lib/integrations/quickBooksTaxClassifications'

export type QuickBooksTaxClassificationChoice = { id: string; name: string }

export type QuickBooksTaxClassificationPickerProps = {
  itemType: 'Inventory' | 'NonInventory' | 'Service'
  value: QuickBooksTaxClassificationChoice | null
  onChange: (value: QuickBooksTaxClassificationChoice | null) => void
  /** null reads top-level categories; an ID reads that category's children. */
  loadPage: (parentId: string | null) => Promise<QuickBooksTaxClassification[]>
  disabled?: boolean
}

/**
 * A two-level, on-demand picker for QuickBooks' Automated Sales Tax catalog.
 * The parent form must clear `value` if it changes `itemType` programmatically.
 */
export default function QuickBooksTaxClassificationPicker({
  itemType, value, onChange, loadPage, disabled = false,
}: QuickBooksTaxClassificationPickerProps) {
  const [expanded, setExpanded] = useState(false)
  const [roots, setRoots] = useState<QuickBooksTaxClassification[] | null>(null)
  const [children, setChildren] = useState<QuickBooksTaxClassification[] | null>(null)
  const [rootId, setRootId] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const requestEpoch = useRef(0)

  const openPicker = async () => {
    setExpanded(true)
    if (roots) return
    const epoch = ++requestEpoch.current
    setLoading(true)
    setError(null)
    try {
      const page = await loadPage(null)
      if (epoch === requestEpoch.current) setRoots(page)
    } catch (cause) {
      if (epoch === requestEpoch.current) setError(cause instanceof Error ? cause.message : 'Sales tax categories could not be loaded')
    } finally {
      if (epoch === requestEpoch.current) setLoading(false)
    }
  }

  const selectRoot = async (selectedId: string) => {
    const root = roots?.find((row) => row.id === selectedId)
    const epoch = ++requestEpoch.current
    setRootId(selectedId)
    setChildren(null)
    setError(null)
    // Browsing another branch must not erase a previously selected category.
    // Only a valid leaf selection commits a change to the parent form.
    if (!root) return
    setLoading(true)
    try {
      const page = await loadPage(root.id)
      if (epoch !== requestEpoch.current) return
      setChildren(page)
      // A top-level classification with no children is itself a selectable leaf.
      if (page.length === 0 && taxClassificationAppliesToItem(root, itemType)) {
        onChange({ id: root.id, name: root.name })
      }
    } catch (cause) {
      if (epoch === requestEpoch.current) setError(cause instanceof Error ? cause.message : 'Sales tax subcategories could not be loaded')
    } finally {
      if (epoch === requestEpoch.current) setLoading(false)
    }
  }

  const eligibleRoots = (roots || []).filter((row) => row.applicableTo.length === 0 || taxClassificationAppliesToItem(row, itemType))
  const eligibleChildren = (children || []).filter((row) => taxClassificationAppliesToItem(row, itemType))

  return (
    <Stack spacing={1}>
      <Box>
        <Typography variant="body2" fontWeight={600}>Sales tax category</Typography>
        <Typography variant="caption" color="text.secondary">
          QuickBooks tax treatment; separate from the product category and taxable setting.
        </Typography>
      </Box>
      {value ? <Typography variant="body2">Selected: {value.name}</Typography> : null}
      <Box><Button variant="outlined" size="small" disabled={disabled} onClick={() => { void openPicker() }}>
        {value ? 'Change sales tax category' : 'Choose sales tax category'}
      </Button></Box>
      {expanded ? (
        <Stack spacing={1}>
          {loading ? <Box display="flex" alignItems="center" gap={1}><CircularProgress size={16} /><Typography variant="caption">Loading QuickBooks categories…</Typography></Box> : null}
          {error ? <Alert severity="error">{error}</Alert> : null}
          {roots ? <TextField select size="small" label="Category" value={rootId} disabled={disabled || loading} onChange={(event) => { void selectRoot(event.target.value) }}>
            <MenuItem value="">Select a category</MenuItem>
            {eligibleRoots.map((root) => <MenuItem key={root.id} value={root.id}>{root.name}</MenuItem>)}
          </TextField> : null}
          {children && children.length > 0 ? (
            eligibleChildren.length > 0 ? <TextField select size="small" label="What you sell" value={eligibleChildren.some((child) => child.id === value?.id) ? value!.id : ''} disabled={disabled} onChange={(event) => {
              const child = eligibleChildren.find((row) => row.id === event.target.value)
              if (child) onChange({ id: child.id, name: child.name })
            }}>
              <MenuItem value="">Select a subcategory</MenuItem>
              {eligibleChildren.map((child) => <MenuItem key={child.id} value={child.id}>{child.name}</MenuItem>)}
            </TextField> : <Alert severity="info">No sales tax subcategories apply to this product type.</Alert>
          ) : null}
          {roots && roots.length === 0 ? <Alert severity="info">QuickBooks returned no sales tax categories for this company.</Alert> : null}
        </Stack>
      ) : null}
    </Stack>
  )
}
