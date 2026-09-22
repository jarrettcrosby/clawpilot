import { createRoot } from 'react-dom/client'
import { createTheme, ThemeProvider } from '@mui/material/styles'
import CssBaseline from '@mui/material/CssBaseline'
import QuickBooksProductEditDialog from '../../app_src/components/accounting/QuickBooksProductEditDialog'
import QuickBooksActionsPanel from '../../app_src/components/accounting/QuickBooksActionsPanel'
import PosAccountingPanel from '../../app_src/components/pos/PosAccountingPanel'

const query = new URLSearchParams(location.search)
const product = {
  id: 'product-fixture', syncToken: '7', name: 'Banana', sku: 'BAN', description: 'Original description',
  unitPrice: 1.25, purchaseCost: 0.5, taxable: true, itemType: 'NonInventory' as const,
  taxClassificationId: 'original-tax', taxClassificationName: 'Original category',
}
createRoot(document.getElementById('root')!).render(
  <ThemeProvider theme={createTheme({ palette: { mode: query.get('mode') === 'dark' ? 'dark' : 'light' } })}>
    <CssBaseline />
    <main style={{ padding: 16 }}>
      {query.get('panel') === 'edit' ? <QuickBooksProductEditDialog product={product} onClose={() => {}}
        onPrepared={(id) => { document.body.dataset.prepared = id }} />
        : query.get('panel') === 'pos' ? <PosAccountingPanel location="location-fixture" businessDate="2026-09-22" revision={0}
          money={(value) => `$${value.toFixed(2)}`} number={(value) => String(value)} />
          : <QuickBooksActionsPanel />}
    </main>
  </ThemeProvider>,
)
