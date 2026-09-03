#!/usr/bin/env node
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { emailBodyPreview, safeEmailPreviewHref } from '../app_src/lib/crm/emailBodyPreview.mjs'

const previewText = (value) => emailBodyPreview(value).map((part) => part.text).join('')
const source = '<div dir="ltr"><div><p>Hi Adrian,</p><p>Thanks again for taking the time to meet today.</p><p>PDF copies are linked below.</p><p><a href="https://example.test/presentation?a=1&amp;b=2">Presentation — Discussion Draft (PDF)</a></p></div></div>'
assert.equal(previewText(source), 'Hi Adrian,\n\nThanks again for taking the time to meet today.\n\nPDF copies are linked below.\n\nPresentation — Discussion Draft (PDF)')
assert.deepEqual(emailBodyPreview(source).filter((part) => part.href), [{
  text: 'Presentation — Discussion Draft (PDF)',
  href: 'https://example.test/presentation?a=1&b=2',
}])

const reply = 'Thanks, Jarrett.\r\n\r\n\r\n\r\nI will be in touch before end of next week.\r\n\r\n\r\n[cid:image428799.png@B606E9EC.A2511676]\r\n<https://example.test/>\r\n\r\nAdrian Tanner\r\n\r\nPhone: 610-930-1800 ext.<tel:>\r\n\r\nFax: 610-930-2402<fax:610-930-2402>'
assert.equal(previewText(reply), 'Thanks, Jarrett.\n\nI will be in touch before end of next week.\n\nhttps://example.test/\n\nAdrian Tanner\n\nPhone: 610-930-1800 ext.\n\nFax: 610-930-2402')
assert.deepEqual(emailBodyPreview(reply).filter((part) => part.href), [{ text: 'https://example.test/', href: 'https://example.test/' }])

const unsafe = '<head><title>Hidden title</title><style>.tracking{background:url(https://tracker.test)}</style></head><p>Hello<script>alert("bad")</script><!-- secret comment --><img src="https://tracker.test/pixel" onerror="alert(1)"><iframe src="https://tracker.test">hidden</iframe></p><p><a href="javascript:alert(1)">Unsafe link</a> <a href="&#x6a;avascript:alert(1)">Encoded unsafe</a> <a href="data:text/html,evil">Data link</a></p><svg><script>bad()</script></svg><p>Goodbye</p>'
assert.equal(previewText(unsafe), 'Hello\n\nUnsafe link Encoded unsafe Data link\n\nGoodbye')
assert.equal(emailBodyPreview(unsafe).some((part) => part.href), false)
assert.equal(previewText('<p>Visible</p><script>unclosed unsafe content'), 'Visible')
assert.equal(previewText('<p>&lt;script&gt;literal text&lt;/script&gt; &amp; &#x1F600;</p>'), '<script>literal text</script> & 😀')
assert.equal(previewText('<p>Repeated paragraph.</p><p>Repeated paragraph.</p>'), 'Repeated paragraph.\n\nRepeated paragraph.')
assert.equal(previewText('<p>Products:</p><ul><li>Item A</li><li>Item B</li></ul>'), 'Products:\n\n• Item A\n\n• Item B')
assert.equal(previewText('We need < 10 boxes > 5 lb.\nOrder A-03.'), 'We need < 10 boxes > 5 lb.\nOrder A-03.')
assert.equal(previewText('<div><strong>Alex</strong><br>\n <span>Operations</span><br>\n <a href="mailto:alex@example.test">alex@<wbr>example.test</a></div>'), 'Alex\nOperations\nalex@example.test')
assert.equal(previewText('<pre>First line\nSecond line</pre>'), 'First line\nSecond line')
assert.deepEqual(emailBodyPreview('<a title="example href=\'https://wrong.test\'" href="https://right.test">Open report</a>'), [{ text: 'Open report', href: 'https://right.test' }])
assert.deepEqual(emailBodyPreview('<a title="example href=\'https://wrong.test\'">Open report</a>'), [{ text: 'Open report' }])
assert.deepEqual(emailBodyPreview('<a data-preview="href=\'https://wrong.test\'" HREF=https://right.test>Open report</a>'), [{ text: 'Open report', href: 'https://right.test' }])
assert.deepEqual(emailBodyPreview('<a href="https://first.test" href="https://second.test">Open report</a>'), [{ text: 'Open report', href: 'https://first.test' }])

for (const href of ['javascript:alert(1)', 'data:text/html,evil', '//evil.test/x', '/relative', 'file:///etc/passwd', 'vbscript:bad', 'https://user:pass@evil.test', 'java\nscript:bad', 'mailto:person@example.test?bcc=evil@example.test', 'mailto:person@example.test%0aBcc:evil@example.test']) {
  assert.equal(safeEmailPreviewHref(href), undefined, `Unsafe link allowed: ${href}`)
}
assert.equal(safeEmailPreviewHref('https://example.test/report'), 'https://example.test/report')
assert.equal(safeEmailPreviewHref('mailto:person@example.test'), 'mailto:person@example.test')
assert.equal(safeEmailPreviewHref('tel:+16109301800'), 'tel:+16109301800')
assert.deepEqual(emailBodyPreview('See https://example.test/report.'), [
  { text: 'See ' }, { text: 'https://example.test/report', href: 'https://example.test/report' }, { text: '.' },
])
assert.equal(previewText('<p>&#0;0&#0; <a href="https://example.test">Safe</a></p>').includes('\u0000'), false)
assert.deepEqual(emailBodyPreview(null), [])

// Presentation must not rewrite the source or carry out any background resource loading.
const record = Object.freeze({ id: 'gi-demo', description: source, notes: reply, interactionType: 'email' })
emailBodyPreview(record.description)
assert.equal(record.description, source)
assert.equal(record.notes, reply)
const component = readFileSync(new URL('../app_src/components/crm/EmailBodyPreview.tsx', import.meta.url), 'utf8')
const helper = readFileSync(new URL('../app_src/lib/crm/emailBodyPreview.mjs', import.meta.url), 'utf8')
const editor = readFileSync(new URL('../app_src/components/crm/CrmSection.tsx', import.meta.url), 'utf8')
assert.doesNotMatch(component, /dangerouslySetInnerHTML|<img\b|<iframe\b|<style\b|\bfetch\s*\(|useEffect/)
assert.doesNotMatch(helper, /\b(?:fetch|DOMParser)\s*\(/)
assert.match(component, /value=\{value\}/)
assert.match(component, /onChange=\{\(event\) => onChange\(event\.target\.value\)\}/)
assert.match(component, /rel="noopener noreferrer"/)
assert.match(component, /referrerPolicy="no-referrer"/)
assert.match(editor, /editorEntity === 'interactions' && fields\.interactionType === 'email' && editorRecord/)
assert.match(editor, /<TextField disabled=\{!recordEditable\} label="Description" value=\{fields\.description \|\| fields\.notes \|\| ''\}/)

console.log('CRM email preview: HTML/plain text, safe links, no remote content, source preservation passed')
