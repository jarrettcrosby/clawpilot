const pipelineCurrencyFormatter = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
})

export function formatPipelineCurrency(value: number): string {
  return Number.isFinite(value) ? pipelineCurrencyFormatter.format(value) : '—'
}
