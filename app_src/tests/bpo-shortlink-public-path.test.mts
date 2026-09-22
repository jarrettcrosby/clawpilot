import assert from 'node:assert/strict'
import test from 'node:test'
import { isPublicBpoShortlinkResolvePath } from '../lib/bpoShortlinkPublicPath.mjs'

test('only the exact one-segment BPO resolver GET or HEAD bypasses session auth', () => {
  for (const method of ['GET', 'HEAD']) {
    assert.equal(isPublicBpoShortlinkResolvePath('/api/shortlinks/bpo/resolve/abc', method), true)
    assert.equal(isPublicBpoShortlinkResolvePath('/api/shortlinks/bpo/resolve/Ab3_-', method), true)
  }
  for (const pathname of [
    '/api/shortlinks/bpo/resolve',
    '/api/shortlinks/bpo/resolve/ab',
    '/api/shortlinks/bpo/resolve/abc/more',
    '/api/shortlinks/bpo/resolve/abc%2Fmore',
    '/api/shortlinks/bpo/resolve/abc.any',
    '/api/shortlinks/bpo/resolve/' + 'a'.repeat(65),
    '/api/shortlinks/bpo/create/abc',
    '/api/shortlinks',
  ]) {
    assert.equal(isPublicBpoShortlinkResolvePath(pathname, 'GET'), false, pathname)
  }
  for (const method of ['POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS']) {
    assert.equal(isPublicBpoShortlinkResolvePath('/api/shortlinks/bpo/resolve/abc', method), false, method)
  }
})
