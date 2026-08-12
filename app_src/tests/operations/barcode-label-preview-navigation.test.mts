import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const dialog = readFileSync(
  new URL('../../components/operations/BarcodeLabelsDialog.tsx', import.meta.url),
  'utf8',
)

test('barcode label previews use popup-independent same-window navigation', () => {
  assert.match(
    dialog,
    /return `\/api\/operations\/barcode-labels\/\$\{encodeURIComponent\(batchGlobalId\)\}\/preview`/,
    'Preview navigation must stay on the authenticated same-origin route with an encoded batch ID',
  )
  assert.match(
    dialog,
    /window\.location\.assign\(barcodeLabelPreviewUrl\(payload\.batch\.globalId\)\)/,
    'A generated batch must navigate only after the authenticated API returns its batch ID',
  )
  assert.doesNotMatch(
    dialog,
    /window\.open\(/,
    'Label previews must not depend on a browser or installed-app popup policy',
  )
  assert.match(
    dialog,
    /component="a"[\s\S]*?href=\{barcodeLabelPreviewUrl\(labelBatch\.globalId\)\}[\s\S]*?>Preview<\/Button>/,
    'Existing batches must expose a real same-origin anchor',
  )
  assert.doesNotMatch(
    dialog,
    /href=\{barcodeLabelPreviewUrl\(labelBatch\.globalId\)\}[\s\S]{0,180}target="_blank"/,
    'Existing batch previews must remain in the current Chrome or installed-app window',
  )
  assert.match(dialog, /Preview opens in this window; use your browser Back control to return\./)
})
