const DEFAULT_INITIAL_POLL_MS = 25
const DEFAULT_MAXIMUM_POLL_MS = 200

function deadlineError() {
  const error = new Error('Shopify checkout callback deadline exceeded')
  Object.assign(error, {
    code: 'SHOPIFY_CHECKOUT_CALLBACK_DEADLINE_EXCEEDED',
  })
  return error
}

function waitForPoll(
  delayMs: number,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) return Promise.reject(deadlineError())
  return new Promise<void>((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer)
      reject(deadlineError())
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort)
      resolve()
    }, delayMs)
    signal.addEventListener('abort', abort, { once: true })
  })
}

/**
 * Shopify can issue duplicate requests for one checkout while the first
 * carrier calculation is still running. Poll only the durable terminal
 * receipt so every duplicate returns the same evidence without calling the
 * carriers or cartonizer again.
 */
export async function waitForShopifyCheckoutReceiptCompletion<T>(input: {
  signal: AbortSignal
  deadlineAt: number
  read: () => Promise<T | null>
  initialPollMs?: number
  maximumPollMs?: number
}): Promise<T> {
  const initialPollMs = Math.max(
    1,
    Math.min(input.initialPollMs ?? DEFAULT_INITIAL_POLL_MS, 1_000),
  )
  const maximumPollMs = Math.max(
    initialPollMs,
    Math.min(input.maximumPollMs ?? DEFAULT_MAXIMUM_POLL_MS, 1_000),
  )
  let delayMs = initialPollMs
  while (true) {
    if (input.signal.aborted || Date.now() >= input.deadlineAt) {
      throw deadlineError()
    }
    const receipt = await input.read()
    if (receipt) return receipt
    const remainingMs = input.deadlineAt - Date.now()
    if (remainingMs <= 0) throw deadlineError()
    await waitForPoll(
      Math.min(delayMs, remainingMs),
      input.signal,
    )
    delayMs = Math.min(maximumPollMs, delayMs * 2)
  }
}
