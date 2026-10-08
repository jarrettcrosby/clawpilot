// Diagram Design editorial grammar, adapted for ClawPilot's private offline viewer.
// Template provenance and MIT notice: ./NOTICE.md and ./LICENSE.diagram-design.
import { readFileSync } from 'node:fs'
import { resolve, sep } from 'node:path'

const escape = (value) => String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
const maskWidth = (text) => Math.ceil((text.length * 8 * 0.62 + 16) / 4) * 4
const inside = (x, y, n) => x > n.x && x < n.x + n.width && y > n.y && y < n.y + n.height
const overlaps = (a, b) => a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y
const labelMask = (text, x, y) => ({ x: x - maskWidth(text) / 2, y: y - 12, width: maskWidth(text), height: 16 })
const safePoint = (p, layout) => p.length === 2 && p.every(Number.isFinite) && p[0] >= 40 && p[0] <= layout.width - 40 && p[1] >= 40 && p[1] <= layout.height - 60
function sequenceGeometry(message, nodes) {
  const x1 = nodes.get(message.from).x + nodes.get(message.from).width / 2
  const x2 = nodes.get(message.to).x + nodes.get(message.to).width / 2
  return {
    points: message.self ? [[x1 + 4, message.y], [x1 + 64, message.y], [x1 + 64, message.y + 32], [x1 + 4, message.y + 32]] : [[x1 + (x2 > x1 ? 4 : -4), message.y], [x2 + (x2 > x1 ? -4 : 4), message.y]],
    labelAt: [message.self ? x1 + 128 : message.labelX ?? (x1 + x2) / 2, message.self ? message.y + 16 : message.y - 16],
  }
}
const crosses = (a, b, n) => a[0] === b[0]
  ? a[0] > n.x && a[0] < n.x + n.width && Math.max(a[1], b[1]) > n.y && Math.min(a[1], b[1]) < n.y + n.height
  : a[1] > n.y && a[1] < n.y + n.height && Math.max(a[0], b[0]) > n.x && Math.min(a[0], b[0]) < n.x + n.width

export function validateDiagrams(catalog, layouts, root) {
  const ids = new Set()
  for (const diagram of catalog) {
    if (!/^[a-zA-Z][a-zA-Z0-9]*$/.test(diagram.id) || ids.has(diagram.id)) throw new Error('Invalid diagram identity')
    ids.add(diagram.id)
    const layout = layouts[diagram.id]
    if (!layout || layout.nodes.length > 9 || (layout.edges || layout.messages).length > 12) throw new Error(`${diagram.id}: complexity budget exceeded`)
    if (!['Architecture', 'Flowchart', 'Sequence'].includes(diagram.type) || !/^\d{4}-\d{2}-\d{2}$/.test(diagram.reviewed)) throw new Error(`${diagram.id}: invalid catalog metadata`)
    const nodeIds = new Set()
    for (const n of layout.nodes) {
      if (nodeIds.has(n.id) || !/^[a-zA-Z][a-zA-Z0-9]*$/.test(n.id)) throw new Error(`${diagram.id}: invalid node identity`)
      nodeIds.add(n.id)
      if (![n.x, n.y, n.width, n.height].every((v) => Number.isInteger(v) && v % 4 === 0)) throw new Error(`${diagram.id}/${n.id}: geometry must use a 4px grid`)
      if (n.x < 40 || n.y < 40 || n.x + n.width > layout.width - 40 || n.y + n.height > layout.height - 60) throw new Error(`${diagram.id}/${n.id}: canvas safe area`)
      if (n.title.some((line) => line.length * 12 * 0.60 > n.width - 24) || n.detail.length * 9 * 0.62 > n.width - 24) throw new Error(`${diagram.id}/${n.id}: label width budget`)
    }
    for (let i = 0; i < layout.nodes.length; i++) {
      if (layout.nodes.slice(i + 1).some((n) => overlaps(layout.nodes[i], n))) throw new Error(`${diagram.id}: overlapping nodes`)
    }
    if (layout.nodes.filter((n) => n.kind === 'focal').length > 2) throw new Error(`${diagram.id}: too many focal nodes`)
    for (const e of layout.edges || []) {
      if (!nodeIds.has(e.from) || !nodeIds.has(e.to) || e.points.length < 2) throw new Error(`${diagram.id}: missing edge endpoint`)
      if (!e.points.every((p) => safePoint(p, layout))) throw new Error(`${diagram.id}: connector outside canvas safe area`)
      for (let i = 1; i < e.points.length; i++) {
        const [a, b] = [e.points[i - 1], e.points[i]]
        if ((a[0] !== b[0] && a[1] !== b[1]) || (a[0] === b[0] && a[1] === b[1])) throw new Error(`${diagram.id}: diagonal or zero-length edge`)
        if (layout.nodes.some((n) => n.id !== e.from && n.id !== e.to && crosses(a, b, n))) throw new Error(`${diagram.id}: edge crosses unrelated node ${e.from}->${e.to}`)
      }
      for (const [id, p] of [[e.from, e.points[0]], [e.to, e.points.at(-1)]]) {
        const n = layout.nodes.find((candidate) => candidate.id === id)
        if (inside(...p, n) || !((p[0] === n.x || p[0] === n.x + n.width) && p[1] >= n.y + 8 && p[1] <= n.y + n.height - 8
          || (p[1] === n.y || p[1] === n.y + n.height) && p[0] >= n.x + 8 && p[0] <= n.x + n.width - 8)) throw new Error(`${diagram.id}: edge must attach to node edge`)
      }
      if (e.label) {
        if (e.label.length > 14 || e.label !== e.label.toUpperCase() || !e.labelAt) throw new Error(`${diagram.id}: connector label budget`)
        const mask = labelMask(e.label, ...e.labelAt)
        if (!safePoint([mask.x, mask.y], layout) || !safePoint([mask.x + mask.width, mask.y + mask.height], layout)) throw new Error(`${diagram.id}: label outside canvas safe area`)
        if (layout.nodes.some((n) => overlaps(mask, n))) throw new Error(`${diagram.id}: label mask overlaps node`)
        for (const other of layout.edges) {
          for (let i = 1; i < other.points.length; i++) if (crosses(other.points[i - 1], other.points[i], mask)) throw new Error(`${diagram.id}: label ${e.label} overlaps ${other.from}->${other.to}`)
        }
      }
    }
    let previousMessageEnd = 0
    for (const message of layout.messages || []) {
      if (!nodeIds.has(message.from) || !nodeIds.has(message.to) || message.label.length > 14 || message.label !== message.label.toUpperCase()
        || Boolean(message.self) !== (message.from === message.to)) throw new Error(`${diagram.id}: invalid sequence message`)
      const { points, labelAt } = sequenceGeometry(message, new Map(layout.nodes.map((n) => [n.id, n])))
      const mask = labelMask(message.label, ...labelAt)
      if (!points.every((p) => safePoint(p, layout)) || !safePoint([mask.x, mask.y], layout) || !safePoint([mask.x + mask.width, mask.y + mask.height], layout)) throw new Error(`${diagram.id}: sequence outside canvas safe area`)
      if (layout.nodes.some((n) => overlaps(mask, n) || points.slice(1).some((p, i) => crosses(points[i], p, n)))) throw new Error(`${diagram.id}: sequence obscured by node`)
      if (message.y <= previousMessageEnd) throw new Error(`${diagram.id}: sequence message order`)
      previousMessageEnd = message.y + (message.self ? 32 : 0)
    }
    if (!diagram.sources?.length || !diagram.notes?.length) throw new Error(`${diagram.id}: documentation requires sources and caveats`)
    for (const source of diagram.sources) {
      const file = resolve(root, source.path)
      if (!file.startsWith(`${resolve(root)}${sep}`) || !/^(app_src|docs)\//.test(source.path)) throw new Error('Invalid source path')
      if (!readFileSync(file, 'utf8').includes(source.symbol)) throw new Error(`${diagram.id}: stale source ${source.symbol}`)
    }
  }
  if (ids.size !== Object.keys(layouts).length) throw new Error('Catalog and geometry must have the same views')
}

export function roundedPath(points) {
  let d = `M ${points[0].join(' ')}`
  for (let i = 1; i < points.length - 1; i++) {
    const [a, p, b] = [points[i - 1], points[i], points[i + 1]]
    const radius = Math.min(8, (Math.abs(p[0] - a[0]) + Math.abs(p[1] - a[1])) / 2, (Math.abs(b[0] - p[0]) + Math.abs(b[1] - p[1])) / 2)
    const before = [p[0] - Math.sign(p[0] - a[0]) * radius, p[1] - Math.sign(p[1] - a[1]) * radius]
    const after = [p[0] + Math.sign(b[0] - p[0]) * radius, p[1] + Math.sign(b[1] - p[1]) * radius]
    d += ` L ${before.join(' ')} Q ${p.join(' ')} ${after.join(' ')}`
  }
  return `${d} L ${points.at(-1).join(' ')}`
}

function label(text, x, y) {
  const width = maskWidth(text)
  return `<g class="edge-label"><rect x="${x - width / 2}" y="${y - 12}" width="${width}" height="16" rx="2"/><text x="${x}" y="${y}" text-anchor="middle">${escape(text)}</text></g>`
}
function markers(id) {
  return `<defs>${['arrow', 'accent', 'link'].map((kind) => `<marker id="${id}-${kind}" markerWidth="8" markerHeight="6" refX="8" refY="3" orient="auto"><polygon class="marker-${kind}" points="0 0, 8 3, 0 6"/></marker>`).join('')}<marker id="${id}-open" markerWidth="8" markerHeight="6" refX="8" refY="3" orient="auto"><polyline points="0 0, 8 3, 0 6" fill="none" stroke="var(--muted)" stroke-width="1.2"/></marker></defs>`
}
function box(n) {
  const [cx, cy] = [n.x + n.width / 2, n.y + n.height / 2]
  const shape = n.kind === 'decision'
    ? `<path d="M ${cx} ${n.y} L ${n.x + n.width} ${cy} L ${cx} ${n.y + n.height} L ${n.x} ${cy} Z"/>`
    : `<rect x="${n.x}" y="${n.y}" width="${n.width}" height="${n.height}" rx="${n.kind === 'end' ? 20 : 6}"/>`
  const titleY = n.kind === 'decision' ? cy - 4 : n.y + 42 - (n.title.length > 1 ? 8 : 0)
  return `<g class="node ${n.kind}" data-node="${escape(n.id)}"><title>${escape(n.title.join(' '))}${n.detail ? `: ${escape(n.detail)}` : ''}</title>${shape}
    ${n.kind !== 'decision' ? `<text class="tag" x="${n.x + 12}" y="${n.y + 18}">${escape(n.tag)}</text>` : ''}
    <text class="node-title" x="${cx}" y="${titleY}" text-anchor="middle">${n.title.map((line, i) => `<tspan x="${cx}" dy="${i === 0 ? 0 : 16}">${escape(line)}</tspan>`).join('')}</text>
    ${n.detail ? `<text class="node-detail" x="${cx}" y="${n.y + n.height - 16}" text-anchor="middle">${escape(n.detail)}</text>` : ''}</g>`
}
function renderSvg(diagram, layout) {
  const id = diagram.id
  const nodes = new Map(layout.nodes.map((n) => [n.id, n]))
  const relationships = (layout.messages || layout.edges).map((path, index) => {
    const from = nodes.get(path.from).title.join(' ')
    const to = nodes.get(path.to).title.join(' ')
    return `${layout.sequence ? `Step ${index + 1}: ` : ''}${from} to ${to}${path.label ? ` (${path.label})` : ''}.`
  }).join(' ')
  let lines = ''
  if (layout.sequence) {
    lines += layout.nodes.map((n) => `<line class="lifeline" x1="${n.x + n.width / 2}" y1="${n.y + n.height}" x2="${n.x + n.width / 2}" y2="${layout.height - 72}"/>`).join('')
    lines += '<rect class="activation" x="364" y="152" width="8" height="416"/><rect class="activation" x="604" y="288" width="8" height="88"/>'
    for (const m of layout.messages) {
      const { points, labelAt } = sequenceGeometry(m, nodes)
      lines += `<path class="edge${m.dashed || m.async ? ' dashed' : ''}" data-from="${m.from}" data-to="${m.to}" d="${roundedPath(points)}" marker-end="url(#${id}-${m.async ? 'open' : 'arrow'})"/>`
      lines += label(m.label, ...labelAt)
    }
  } else {
    for (const e of layout.edges) {
      const accent = nodes.get(e.from).kind === 'focal' || nodes.get(e.to).kind === 'focal'
      lines += `<path class="edge${accent ? ' focal-edge' : ''}${e.dashed ? ' dashed' : ''}" data-from="${e.from}" data-to="${e.to}" d="${roundedPath(e.points)}" marker-end="url(#${id}-${accent ? 'accent' : 'arrow'})"/>`
      if (e.label) lines += label(e.label, ...e.labelAt)
    }
  }
  const legendY = layout.height - 40
  return `<svg style="--canvas-width:${layout.width}px" viewBox="0 0 ${layout.width} ${layout.height}" xmlns="http://www.w3.org/2000/svg" role="img" aria-labelledby="${id}-title ${id}-desc">
    <title id="${id}-title">${escape(diagram.title)}</title><desc id="${id}-desc">${escape(`${diagram.summary} Relationships: ${relationships}`)}</desc>${markers(id)}
    ${lines}${layout.nodes.map((n) => box(n)).join('')}
    <g class="legend"><line x1="40" y1="${legendY - 16}" x2="${layout.width - 40}" y2="${legendY - 16}"/><text x="40" y="${legendY + 8}">LEGEND</text>
      <line class="edge" x1="112" y1="${legendY + 4}" x2="140" y2="${legendY + 4}"/><text x="152" y="${legendY + 8}">Reviewed path</text>
      <line class="edge dashed" x1="328" y1="${legendY + 4}" x2="356" y2="${legendY + 4}"/><text x="368" y="${legendY + 8}">${layout.sequence ? 'Return / async sync' : 'Async / alternate path'}</text>
      <rect class="legend-focus" x="632" y="${legendY - 4}" width="16" height="16" rx="2"/><text x="660" y="${legendY + 8}">Key boundary</text></g></svg>`
}

export function renderArchitecture(catalog, layouts, template, script) {
  const options = catalog.map((d) => `<option value="${d.id}">${escape(d.title)}</option>`).join('')
  const sections = catalog.map((d, index) => `<section id="view-${d.id}" data-view="${d.id}" ${index ? 'hidden' : ''} aria-labelledby="heading-${d.id}">
    <header class="header"><p class="eyebrow">${escape(d.type)} · source-reviewed ${escape(d.reviewed)}</p><h1 id="heading-${d.id}" tabindex="-1">${escape(d.title)}</h1><p class="subtitle">${escape(d.summary)}</p></header>
    <p class="scroll-hint">On a narrow screen, scroll the diagram sideways to keep labels readable.</p>
    <div class="diagram-container" tabindex="0" role="region" aria-label="${escape(d.title)} diagram">${renderSvg(d, layouts[d.id])}</div>
    ${layouts[d.id].callout ? `<p class="diagram-note">${escape(layouts[d.id].callout)}</p>` : ''}
    <div class="cards">${d.notes.map((n) => `<article class="card"><h2>${escape(n.title)}</h2><p>${escape(n.text)}</p></article>`).join('')}</div>
    <details class="sources"><summary>Implementation references (${d.sources.length})</summary><ul>${d.sources.map((s) => `<li><code>${escape(s.path)}</code><span>${escape(s.symbol)}</span></li>`).join('')}</ul></details>
  </section>`).join('')
  return template.replace('<!-- DIAGRAM_OPTIONS -->', () => options).replace('<!-- DIAGRAM_SECTIONS -->', () => sections).replace('<!-- VIEWER_SCRIPT -->', () => `<script>${script}</script>`)
}
