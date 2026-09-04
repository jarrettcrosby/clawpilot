import Alert from '@mui/material/Alert'
import Typography from '@mui/material/Typography'
import type { OperationsNativeActivityCoverage } from '@/lib/operations/types'

export function NativeActivityCoverageNotice({ coverage }: {
  coverage: OperationsNativeActivityCoverage | undefined
}) {
  if (!coverage) return (
    <Typography variant="caption" color="text.secondary" data-testid="native-activity-not-captured">
      Refresh from Shopify to load order activity.
    </Typography>
  )
  if (coverage.state === 'unavailable') return (
    <Alert severity="info" data-testid="native-activity-unavailable">
      Shopify activity couldn’t be loaded. Order and fulfillment details are still available.
    </Alert>
  )
  if (coverage.state === 'partial' || coverage.displayTruncated) return (
    <Alert severity="warning" data-testid="native-activity-partial">
      Partial Shopify history · {coverage.fetchedCount} events loaded.
      {coverage.reason === 'page_budget' ? ' More events are available in Shopify.' : ''}
      {coverage.reason === 'text_limit' ? ' Some activity text was shortened.' : ''}
      {coverage.displayTruncated ? ' Only the latest events are shown here.' : ''}
    </Alert>
  )
  return (
    <Typography variant="caption" color="text.secondary" data-testid="native-activity-complete">
      {coverage.fetchedCount} available Shopify events loaded.
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
      {redacted ? 'Activity details are no longer retained.'
        : message || 'Activity details unavailable.'}
    </Typography>
    <Typography variant="caption" color="text.secondary" display="block"
      data-testid="native-activity-actor" sx={{ overflowWrap: 'anywhere' }}>
      {!redacted && actor ? `By ${actor} · Shopify` : 'Author unavailable'}
    </Typography>
  </>
}
