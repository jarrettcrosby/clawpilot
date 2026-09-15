#!/usr/bin/env node
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { Readable } from 'node:stream'
import vm from 'node:vm'

const require = createRequire(new URL('../app_src/package.json', import.meta.url))
const ts = require('typescript')
const source = readFileSync(new URL('../app_src/lib/aiRadarFeed.ts', import.meta.url), 'utf8')
const js = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText
const module = { exports: {} }
vm.runInNewContext(js, { module, exports: module.exports, require, Buffer }, { filename: 'aiRadarFeed.ts' })
const { readBoundedRadarFeed, MAX_RADAR_FEED_BYTES, MAX_RADAR_FEED_ITEMS } = module.exports
const { XMLParser } = require('fast-xml-parser')
const parser = new XMLParser({ ignoreAttributes: false, removeNSPrefix: true })
assert.equal(MAX_RADAR_FEED_BYTES, 4 * 1024 * 1024)
assert.equal(MAX_RADAR_FEED_ITEMS, 30)

const item = (n, body = `Article ${n}`) => `<item><title>Title ${n}</title><link>https://example.com/${n}</link><description>${body}</description></item>`
const rss = (items) => `<?xml version="1.0"?><rss version="2.0"><channel><title>Test</title>${items}</channel></rss>`
function response(parts, length = 0) {
  let reads = 0
  let destroyed = 0
  return {
    headers: { 'content-length': String(length) },
    get reads() { return reads },
    get destroyed() { return destroyed },
    destroy() { destroyed += 1 },
    async *[Symbol.asyncIterator]() {
      for (const part of parts) {
        reads += 1
        if (part instanceof Error) throw part
        yield Buffer.isBuffer(part) ? part : Buffer.from(part)
      }
    },
  }
}
async function rejects(feed, pattern) {
  await assert.rejects(() => readBoundedRadarFeed(feed, 'Test'), pattern)
  assert.ok(feed.destroyed > 0, 'failed reads must cancel the response')
}

// Large declared history is safe only when 30 whole entries fit under the cap;
// do not read a later chunk (or its failure) after the selected prefix.
const firstThirty = Array.from({ length: 30 }, (_, n) => item(n)).join('')
const historical = response([`<rss><channel>${firstThirty}`, new Error('tail must not be read')], MAX_RADAR_FEED_BYTES * 10)
const selected = await readBoundedRadarFeed(historical, 'Test')
assert.equal(parser.parse(selected).rss.channel.item.length, 30)
assert.equal(historical.reads, 1)
assert.equal(historical.destroyed, 1)

// Exact first-30 semantics: no thirty-first entry even in the same chunk.
const allInOne = await readBoundedRadarFeed(response([rss(firstThirty + item(30))]), 'Test')
assert.equal(parser.parse(allInOne).rss.channel.item.length, 30)
assert.ok(!allInOne.includes('Title 30'))

// Lexical boundaries must ignore fake tags in CDATA, comments and attributes;
// byte-by-byte chunks also split XML tokens and multi-byte UTF-8 characters.
const tricky = rss(Array.from({ length: 30 }, (_, n) => item(n, `<![CDATA[Café 🚂 </item><item> fake]]><!-- </item><item> --><?example value="</item>"?>`)).join(''))
const bytes = Buffer.from(tricky)
const chunked = response(Array.from(bytes, (_, index) => bytes.subarray(index, index + 1)))
const chunkedResult = await readBoundedRadarFeed(chunked, 'Test')
assert.equal(parser.parse(chunkedResult).rss.channel.item.length, 30)
assert.ok(chunkedResult.includes('Café 🚂'))
assert.ok(!chunkedResult.includes('�'))
const quoted = rss(Array.from({ length: 30 }, (_, n) => `<item label="a > b"><title>${n}</title></item>`).join(''))
assert.equal(parser.parse(await readBoundedRadarFeed(response([quoted]), 'Test')).rss.channel.item.length, 30)

const atom = `<atom:feed xmlns:atom="http://www.w3.org/2005/Atom">${Array.from({ length: 31 }, (_, n) => `<atom:entry><atom:title>${n}</atom:title><atom:summary><![CDATA[</atom:entry>]]></atom:summary></atom:entry>`).join('')}</atom:feed>`
assert.equal(parser.parse(await readBoundedRadarFeed(response([atom]), 'Test')).feed.entry.length, 30)
const selfClosing = `<rss><channel>${'<item/>'.repeat(31)}</channel></rss>`
assert.equal(parser.parse(await readBoundedRadarFeed(response([selfClosing]), 'Test')).rss.channel.item.length, 30)

// Small, complete feeds remain intact, including empty feeds.
const small = rss(item(1))
assert.equal(await readBoundedRadarFeed(response([small]), 'Test'), small)
assert.equal(await readBoundedRadarFeed(response([rss('')]), 'Test'), rss(''))

await rejects(response([`<rss><channel>${item(1)}`]), /malformed or truncated XML/)
await rejects(response(['<rss><channel><item></channel></rss>']), /mismatched XML/)
await rejects(response(['<rss><channel><item invalid=></item></channel></rss>']), /malformed or truncated XML/)
await rejects(response(['<rss><channel><![CDATA[incomplete']), /malformed or truncated XML/)
await rejects(response(['<!DOCTYPE rss [<!ENTITY value "test">]><rss><channel/></rss>']), /cannot contain XML declarations/)
await rejects(response(['<rss><channel><item>', Buffer.alloc(MAX_RADAR_FEED_BYTES, 97)]), /exceeds 4194304 bytes/)
await rejects(response([rss(item(1)), Buffer.alloc(MAX_RADAR_FEED_BYTES, 32)]), /exceeds 4194304 bytes/)
const almostFull = `<rss><channel>${'<item/>'.repeat(29)}<item>`
const exactCapPrefix = almostFull + 'x'.repeat(MAX_RADAR_FEED_BYTES - Buffer.byteLength(almostFull + '</item>')) + '</item>'
await rejects(response([exactCapPrefix]), /exceeds 4194304 bytes/)
await rejects(response(['<rss><channel>', new Error('upstream aborted')]), /upstream aborted/)

// Real Node streams must be destroyed immediately on early success and error.
let tailRead = false
const real = Readable.from((async function* () {
  yield `<rss><channel>${firstThirty}`
  await new Promise(resolve => setTimeout(resolve, 5))
  tailRead = true
  yield '</channel></rss>'
})(), { objectMode: false, highWaterMark: 1 })
await readBoundedRadarFeed(real, 'Test')
assert.equal(real.destroyed, true)
assert.equal(tailRead, false)
const failed = Readable.from(['<rss><channel><item>'], { objectMode: false })
await assert.rejects(() => readBoundedRadarFeed(failed, 'Test'), /malformed or truncated XML/)
assert.equal(failed.destroyed, true)

// Integration keeps the publisher's official feed plus network safety guards.
const radar = readFileSync(new URL('../app_src/lib/aiRadar.ts', import.meta.url), 'utf8')
assert.ok(radar.includes("url: 'https://blog.railway.com/rss.xml'"))
assert.ok(radar.includes('await readBoundedRadarFeed(response, source.name)'))
assert.ok(radar.includes('const MAX_REDIRECTS = 3'))
assert.ok(radar.includes('addresses.some((entry) => !isPublicIpAddress(entry.address))'))
assert.ok(radar.includes('lookup: pinnedLookup'))
assert.ok(radar.includes('entries.slice(0, MAX_ITEMS_PER_SOURCE)'))
console.log('AI Radar bounded feed tests passed: 30-entry RSS/Atom prefix, 4 MiB cap, UTF-8/chunk boundaries, malformed/truncated input and cancellation')
