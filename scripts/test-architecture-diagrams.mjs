#!/usr/bin/env node
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { layouts } from '../tools/architecture/layouts.mjs'
import { renderArchitecture, roundedPath, validateDiagrams } from '../tools/architecture/renderer.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const catalog = JSON.parse(readFileSync(`${root}/tools/architecture/catalog.json`, 'utf8'))
validateDiagrams(catalog, layouts, root)
const variant = (change) => { const copy = structuredClone(layouts); change(copy); return copy }
assert.throws(() => validateDiagrams(catalog, variant((d) => { d.orders.edges[0].points[1][0] += 4 }), root), /diagonal/)
assert.throws(() => validateDiagrams(catalog, variant((d) => { d.index.nodes[0].x = 41 }), root), /grid/)
assert.throws(() => validateDiagrams(catalog, variant((d) => { d.index.nodes[0].title = ['An impossibly long title which must be rejected instead of clipped'] }), root), /width/)
assert.throws(() => validateDiagrams(catalog, variant((d) => { d.index.edges[0].labelAt = [140, 80] }), root), /mask overlaps node/)
assert.throws(() => validateDiagrams(catalog, variant((d) => { d.index.nodes[2].x = d.index.nodes[1].x }), root), /overlapping nodes/)
assert.throws(() => validateDiagrams(catalog, variant((d) => { d.email.edges[8].points[1][0] = 1000 }), root), /connector outside/)
assert.throws(() => validateDiagrams(catalog, variant((d) => { d.meetings.messages[0].y = 80 }), root), /sequence obscured/)
assert.throws(() => validateDiagrams(catalog, variant((d) => { d.meetings.messages[0].labelX = 1000 }), root), /sequence outside/)
const stale = structuredClone(catalog); stale[0].sources[0].symbol = 'not-a-real-source-symbol'
assert.throws(() => validateDiagrams(stale, layouts, root), /stale source/)
assert.match(roundedPath([[0, 0], [40, 0], [40, 40]]), /Q 40 0 40 8/)
const literalCatalog = structuredClone(catalog)
literalCatalog[0].title = "Literal $& $` $' $$ <img>"
literalCatalog[0].notes[0].text = literalCatalog[0].title
const literalScript = 'const literal = "$& $` $\' $$"'
const literalHtml = renderArchitecture(literalCatalog, layouts, '<!-- DIAGRAM_OPTIONS --><!-- DIAGRAM_SECTIONS --><!-- VIEWER_SCRIPT -->', literalScript)
assert(literalHtml.includes('Literal $&amp; $` $&#39; $$ &lt;img&gt;'), 'Catalog text is escaped and replacement tokens are preserved literally')
assert(literalHtml.endsWith(`<script>${literalScript}</script>`), 'Script text is not interpreted as replacement syntax')
assert(!literalHtml.includes('<!-- DIAGRAM_'), 'Replacement tokens cannot reinsert template markers')
assert(literalHtml.includes('All blockers cleared? to Promote candidate (YES).'), 'Accessible description includes decision relationships')
assert(literalHtml.includes('All blockers cleared? to Needs information (NO).'), 'Accessible description includes the hold branch')
assert(literalHtml.includes('Step 1: Operator to ClawPilot (REVIEW CHOICE).'), 'Accessible sequence description preserves message order')
for (const name of ['model.c4', 'likec4.config.json', 'package.json', 'package-lock.json']) {
  assert.equal(existsSync(`${root}/tools/architecture/${name}`), false, `Old compiler/model removed: ${name}`)
}
const build = readFileSync(`${root}/scripts/build-architecture-viewer.mjs`, 'utf8')
assert.doesNotMatch(build, /npm.*ci|likec4\.mjs|fetch\(/)
console.log('Diagram content: bounded source-backed views, no old compiler, deterministic geometry, stale-source and clipping guards passed')
