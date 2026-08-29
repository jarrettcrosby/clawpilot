import assert from 'node:assert/strict'
import test from 'node:test'
import {
  commerceOrderRevisionRefreshNeedsNewIdempotencyKey,
} from '../../lib/operations/commerceOrderRevisionRetry.ts'

for (const code of [
  'SHOPIFY_ORDER_REVISION_PROVIDER_READ_FAILED',
  'FAIRE_ORDER_REVISION_PROVIDER_READ_FAILED',
]) {
  test(`${code} releases the key only after terminal receipt confirmation`, () => {
    assert.equal(commerceOrderRevisionRefreshNeedsNewIdempotencyKey({
      ok: false,
      code,
      retryWithNewIdempotencyKey: true,
    }), true)
    assert.equal(commerceOrderRevisionRefreshNeedsNewIdempotencyKey({
      ok: false,
      code,
    }), false)
  })
}

test('ambiguous and malformed responses retain the current key', () => {
  for (const payload of [
    null,
    undefined,
    {},
    [],
    { retryWithNewIdempotencyKey: false },
    { retryWithNewIdempotencyKey: 'true' },
  ]) {
    assert.equal(
      commerceOrderRevisionRefreshNeedsNewIdempotencyKey(payload),
      false,
    )
  }
})
