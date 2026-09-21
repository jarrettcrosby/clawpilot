'use client'

import { useEffect, useState } from 'react'
import Alert from '@mui/material/Alert'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import CircularProgress from '@mui/material/CircularProgress'
import Dialog from '@mui/material/Dialog'
import DialogActions from '@mui/material/DialogActions'
import DialogContent from '@mui/material/DialogContent'
import DialogTitle from '@mui/material/DialogTitle'
import FormControlLabel from '@mui/material/FormControlLabel'
import Stack from '@mui/material/Stack'
import Switch from '@mui/material/Switch'
import TextField from '@mui/material/TextField'
import Typography from '@mui/material/Typography'
import QuickBooksTaxClassificationPicker from './QuickBooksTaxClassificationPicker'
import type { QuickBooksTaxClassification } from '@/lib/integrations/quickBooksTaxClassifications'

export type EditableQuickBooksProduct = {
  id: string
  syncToken: string
  name: string
  sku: string | null
  description: string | null
  unitPrice: number
  purchaseCost: number
  taxable: boolean
  itemType: 'Inventory' | 'NonInventory' | 'Service'
  taxClassificationId: string
  taxClassificationName: string
}

export default function QuickBooksProductEditDialog({ product, onClose, onPrepared }: {
  product: EditableQuickBooksProduct | null
  onClose: () => void
  onPrepared: (requestId: string) => void
}) {
  const [clientRequestId, setClientRequestId] = useState('')
  const [name, setName] = useState('')
  const [sku, setSku] = useState('')
  const [description, setDescription] = useState('')
  const [unitPrice, setUnitPrice] = useState('')
  const [purchaseCost, setPurchaseCost] = useState('')
  const [taxable, setTaxable] = useState(false)
  const [taxClassificationId, setTaxClassificationId] = useState('')
  const [taxClassificationName, setTaxClassificationName] = useState('')
  const [taxClassificationParentId, setTaxClassificationParentId] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!product) return
    setClientRequestId(globalThis.crypto.randomUUID())
    setName(product.name)
    setSku(product.sku || '')
    setDescription(product.description || '')
    setUnitPrice(String(product.unitPrice))
    setPurchaseCost(String(product.purchaseCost))
    setTaxable(product.taxable)
    setTaxClassificationId(product.taxClassificationId)
    setTaxClassificationName(product.taxClassificationName)
    setTaxClassificationParentId('')
    setError(null)
  }, [product])

  async function prepareUpdate() {
    if (!product || !clientRequestId) return
    setBusy(true)
    setError(null)
    try {
      const response = await fetch('/api/accounting/quickbooks/actions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          clientRequestId,
          operationKind: 'item.update',
          payload: {
            itemId: product.id,
            expectedSyncToken: product.syncToken,
            name: name.trim(),
            sku: sku.trim(),
            description: description.trim(),
            unitPrice,
            purchaseCost,
            taxable,
            ...(taxClassificationId && taxClassificationId !== product.taxClassificationId
              ? { taxClassificationId, taxClassificationParentId } : {}),
          },
        }),
      })
      const result = await response.json().catch(() => ({})) as {
        ok?: boolean
        error?: string
        request?: { id?: string }
      }
      if (!response.ok || !result.ok || !result.request?.id) {
        throw new Error(result.error || 'The product update draft could not be prepared')
      }
      onPrepared(result.request.id)
    } catch (prepareError) {
      setError((prepareError as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const validPrice = unitPrice.trim() !== '' && Number.isFinite(Number(unitPrice)) && Number(unitPrice) >= 0
  const validCost = purchaseCost.trim() !== '' && Number.isFinite(Number(purchaseCost)) && Number(purchaseCost) >= 0

  return (
    <Dialog open={Boolean(product)} onClose={busy ? undefined : onClose} fullWidth maxWidth="sm">
      <DialogTitle>Edit QuickBooks product</DialogTitle>
      <DialogContent>
        <Stack spacing={2} pt={0.5}>
          <Alert severity="info">
            This prepares a reviewable change. Nothing is updated in QuickBooks until an authorized user approves it.
          </Alert>
          {error ? <Alert severity="error">{error}</Alert> : null}
          <TextField label="Product name" value={name} onChange={(event) => setName(event.target.value)} required />
          <TextField label="SKU" value={sku} onChange={(event) => setSku(event.target.value)} />
          <TextField label="Sales description" value={description} onChange={(event) => setDescription(event.target.value)} multiline minRows={2} inputProps={{ maxLength: 4000 }} />
          <Box display="grid" gridTemplateColumns={{ xs: '1fr', sm: '1fr 1fr' }} gap={1.5}>
            <TextField label="Sales price or rate" type="number" value={unitPrice} onChange={(event) => setUnitPrice(event.target.value)} required inputProps={{ min: 0, step: '0.01' }} />
            <TextField label="Purchase cost" type="number" value={purchaseCost} onChange={(event) => setPurchaseCost(event.target.value)} required inputProps={{ min: 0, step: '0.01' }} />
          </Box>
          <FormControlLabel control={<Switch checked={taxable} onChange={(event) => setTaxable(event.target.checked)} />} label="Taxable" />
          {product && ['Inventory', 'NonInventory', 'Service'].includes(product.itemType) ? (
            <QuickBooksTaxClassificationPicker
              key={product.id}
              itemType={product.itemType}
              value={taxClassificationId ? { id: taxClassificationId, name: taxClassificationName || taxClassificationId, parentId: taxClassificationParentId || null } : null}
              onChange={(choice) => {
                setTaxClassificationId(choice?.id || '')
                setTaxClassificationName(choice?.name || '')
                setTaxClassificationParentId(choice?.parentId || '')
              }}
              loadPage={async (parentId): Promise<QuickBooksTaxClassification[]> => {
                const parameters = new URLSearchParams({ itemType: product.itemType })
                if (parentId) parameters.set('parentId', parentId)
                const response = await fetch(`/api/accounting/quickbooks/tax-classifications?${parameters}`, { cache: 'no-store' })
                const payload = await response.json() as { ok?: boolean; error?: string; categories?: QuickBooksTaxClassification[] }
                if (!response.ok || !payload.ok || !Array.isArray(payload.categories)) {
                  throw new Error(payload.error || 'QuickBooks sales tax categories are unavailable')
                }
                return payload.categories
              }}
            />
          ) : null}
          <Typography variant="caption" color="text.secondary">
            Product type, accounting category, accounts, and stock quantity stay unchanged in this edit.
          </Typography>
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={busy}>Cancel</Button>
        <Button variant="contained" onClick={() => { void prepareUpdate() }} disabled={busy || !product?.syncToken || !name.trim() || !validPrice || !validCost}>
          {busy ? <CircularProgress size={18} /> : 'Prepare for review'}
        </Button>
      </DialogActions>
    </Dialog>
  )
}
