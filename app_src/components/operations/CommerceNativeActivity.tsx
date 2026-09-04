import Alert from '@mui/material/Alert'
import Typography from '@mui/material/Typography'
import type { OperationsNativeActivityCoverage } from '@/lib/operations/types'

export function NativeActivityCoverageNotice({ coverage }: {
  coverage: OperationsNativeActivityCoverage | undefined
}) {
  if (!coverage) return (
    <Typography variant="caption" color="text.secondary" data-testid="native-activity-not-captured">
      Native Shopify activity has not yet been captured. Refresh from Shopify to read available events.
    </Typography>
  )
  if (coverage.state === 'unavailable') return (
    <Alert severity="info" data-testid="native-activity-unavailable">
      Native Shopify activity is unavailable for this read. Order and fulfillment details remain available.
    </Alert>
  )
  if (coverage.state === 'partial' || coverage.displayTruncated) return (
    <Alert severity="warning" data-testid="native-activity-partial">
      Shopify activity is partial ({coverage.fetchedCount} events read).
      {coverage.reason === 'page_budget' ? ' This read reached its two-page limit.' : ''}
      {coverage.reason === 'text_limit' ? ' Some provider text exceeded the retained-text limit.' : ''}
      {coverage.displayTruncated ? ' This view also reached its timeline display limit.' : ''}
      {' '}This is not the complete Shopify Admin timeline.
    </Alert>
  )
  return (
    <Typography variant="caption" color="text.secondary" data-testid="native-activity-complete">
      {coverage.fetchedCount} provider-available Shopify events captured at the last refresh.
      {' '}Shopify API history is retention-limited and may differ from the Admin timeline.
    </Typography>
  )
}

/** Text-only by design: no provider HTML, link targets, images or embeds enter
 * the DOM. Provider display labels never become local actor identities. */
export function NativeActivityText({ message, actor, redacted }: {
  message: string | null | undefined
  actor: string | null | undefined
  redacted?: boolean
}) {
  return <>
    <Typography variant="body2" data-testid="native-activity-message"
      sx={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
      {redacted ? 'Provider activity text expired or was redacted.'
        : message || 'Provider activity text was not supplied.'}
    </Typography>
    <Typography variant="caption" color="text.secondary" display="block"
      data-testid="native-activity-actor" sx={{ overflowWrap: 'anywhere' }}>
      {!redacted && actor ? `Shopify actor: ${actor}` : 'Shopify author not supplied'}
    </Typography>
  </>
}
