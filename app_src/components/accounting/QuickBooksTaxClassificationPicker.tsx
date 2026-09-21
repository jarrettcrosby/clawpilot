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

export type QuickBooksTaxClassificationChoice = { id: string; name: string; parentId: string | null }
type PickerLevel = { parentId: string | null; rows: QuickBooksTaxClassification[]; selectedId: string }

export type QuickBooksTaxClassificationPickerProps = {
  itemType: 'Inventory' | 'NonInventory' | 'Service'
  value: QuickBooksTaxClassificationChoice | null
  onChange: (value: QuickBooksTaxClassificationChoice | null) => void
  /** null reads top-level categories; an ID reads that category's children. */
  loadPage: (parentId: string | null) => Promise<QuickBooksTaxClassification[]>
  disabled?: boolean
}

/**
 * An on-demand hierarchy picker for QuickBooks' Automated Sales Tax catalog.
 * The parent form must clear `value` if it changes `itemType` programmatically.
 */
export default function QuickBooksTaxClassificationPicker({
  itemType, value, onChange, loadPage, disabled = false,
}: QuickBooksTaxClassificationPickerProps) {
  const [expanded, setExpanded] = useState(false)
  const [levels, setLevels] = useState<PickerLevel[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const requestEpoch = useRef(0)

  const openPicker = async () => {
    setExpanded(true)
    if (levels.length) return
    const epoch = ++requestEpoch.current
    setLoading(true)
    setError(null)
    try {
      const page = await loadPage(null)
      if (epoch === requestEpoch.current) setLevels([{ parentId: null, rows: page, selectedId: '' }])
    } catch (cause) {
      if (epoch === requestEpoch.current) setError(cause instanceof Error ? cause.message : 'Sales tax categories could not be loaded')
    } finally {
      if (epoch === requestEpoch.current) setLoading(false)
    }
  }

  const selectCategory = async (levelIndex: number, selectedId: string) => {
    const level = levels[levelIndex]
    const selected = level?.rows.find((row) => row.id === selectedId)
    const currentPath = levels.slice(0, levelIndex + 1).map((entry, index) => index === levelIndex
      ? { ...entry, selectedId } : entry)
    const epoch = ++requestEpoch.current
    setLevels(currentPath)
    setError(null)
    // Browsing another branch must not erase a previously selected category.
    // Only a valid leaf selection commits a change to the parent form.
    if (!selected) return
    setLoading(true)
    try {
      const page = await loadPage(selected.id)
      if (epoch !== requestEpoch.current) return
      if (page.length > 0) {
        setLevels([...currentPath, { parentId: selected.id, rows: page, selectedId: '' }])
      } else if (taxClassificationAppliesToItem(selected, itemType)) {
        const names = currentPath.map((entry) => entry.rows.find((row) => row.id === entry.selectedId)?.name || '')
        onChange({ id: selected.id, name: names.join(':'), parentId: level.parentId })
      }
    } catch (cause) {
      if (epoch === requestEpoch.current) setError(cause instanceof Error ? cause.message : 'Sales tax subcategories could not be loaded')
    } finally {
      if (epoch === requestEpoch.current) setLoading(false)
    }
  }

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
          {levels.map((level, index) => {
            const eligible = level.rows.filter((row) => row.applicableTo.length === 0
              || taxClassificationAppliesToItem(row, itemType))
            return eligible.length > 0 ? <TextField key={level.parentId || 'root'} select size="small"
              label={index === 0 ? 'Category' : `Subcategory ${index}`}
              value={level.selectedId} disabled={disabled || loading}
              onChange={(event) => { void selectCategory(index, event.target.value) }}>
              <MenuItem value="">Select a category</MenuItem>
              {eligible.map((category) => <MenuItem key={category.id} value={category.id}>{category.name}</MenuItem>)}
            </TextField> : <Alert key={level.parentId || 'root'} severity="info">
              No sales tax subcategories apply to this product type.
            </Alert>
          })}
          {levels.length === 1 && levels[0].rows.length === 0 ? <Alert severity="info">QuickBooks returned no sales tax categories for this company.</Alert> : null}
        </Stack>
      ) : null}
    </Stack>
  )
}
