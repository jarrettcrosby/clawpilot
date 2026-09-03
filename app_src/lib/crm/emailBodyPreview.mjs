import { decodeHtmlEntities } from '../htmlEntities.mjs'

/** @typedef {{ text: string, href?: string }} EmailPreviewPart */

const HTML_TAG = /<!--[\s\S]*?(?:-->|$)|<![^>]*>|<\/?([a-z][\w:-]*)\b(?:[^<>"']|"[^"]*"|'[^']*')*>/gi
const BLOCK_TAGS = new Set(['address', 'article', 'aside', 'blockquote', 'div', 'dl', 'dt', 'dd', 'footer', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'main', 'ol', 'p', 'pre', 'section', 'table', 'tr', 'ul'])
const OMIT_CONTENT_TAGS = new Set(['head', 'script', 'style', 'title', 'iframe', 'object', 'svg', 'template', 'noscript'])

/** Only user-activated, ordinary web/email/phone links can leave this preview. */
export function safeEmailPreviewHref(value) {
  const href = decodeHtmlEntities(value).trim()
  if (!href || /[\u0000-\u0020\u007f]/u.test(href)) return undefined
  try {
    const url = new URL(href)
    if ((url.protocol === 'https:' || url.protocol === 'http:') && url.hostname && !url.username && !url.password) return href
    if (url.protocol === 'mailto:' && !url.search && !url.hash && /^[^\s@?&#]+@[^\s@?&#]+\.[^\s@?&#]+$/u.test(url.pathname) && !/%0[ad]/i.test(href)) return href
    if (url.protocol === 'tel:' && !url.search && !url.hash && /^\+?[\d().-]+$/u.test(url.pathname)) return href
  } catch {
    // Invalid and relative URLs remain ordinary text.
  }
  return undefined
}

function readableWhitespace(value) {
  return value
    .replace(/\r\n?/g, '\n')
    .replace(/\[(?:cid):[^\]\r\n]*\]|<cid:[^>\r\n]*>/gi, '')
    .replace(/<(?:tel|fax):[^>\r\n]*>/gi, '')
    .replace(/<(https?:\/\/[^>\r\n]+)>/gi, '$1')
    .replace(/[\t\f\v\u00a0 ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function proseUrlHref(value) {
  const openingFor = { ')': '(', ']': '[', '}': '{' }
  const balances = { '(': 0, '[': 0, '{': 0 }
  const unmatchedClosings = new Set()
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]
    if (Object.hasOwn(balances, character)) balances[character] += 1
    else if (Object.hasOwn(openingFor, character)) {
      const opening = openingFor[character]
      if (balances[opening]) balances[opening] -= 1
      else unmatchedClosings.add(index)
    }
  }
  // A paired closer belongs to the URL (including IPv6 host brackets). Only
  // unmatched trailing closers and adjacent prose punctuation stay outside it.
  let end = value.length
  while (end > 0 && (/[.,;!?]/u.test(value[end - 1]) || unmatchedClosings.has(end - 1))) end -= 1
  return value.slice(0, end)
}

function decodedText(value) {
  // NUL is reserved for locally generated link placeholders, never provider text.
  return decodeHtmlEntities(value).replace(/\u0000/g, '')
}

function anchorHref(tag) {
  const attributes = tag.replace(/^<a\b/i, '').replace(/>$/, '')
  // Consume each complete attribute, including its quoted value. A string such
  // as title="example href='...'" must never supply a link destination.
  for (const attribute of attributes.matchAll(/([^\s=/>"']+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) {
    if (attribute[1].toLowerCase() === 'href') {
      return safeEmailPreviewHref(attribute[2] ?? attribute[3] ?? attribute[4] ?? '')
    }
  }
  return undefined
}

function htmlTextAndLinks(source) {
  let text = ''
  let position = 0
  let omittedTag = ''
  let preformatted = false
  /** @type {{ href?: string, text: string } | undefined} */
  let anchor
  /** @type {EmailPreviewPart[]} */
  const links = []
  const emit = (value) => {
    if (anchor) anchor.text += value
    else text += value
  }
  const emitHtmlText = (value) => {
    const decoded = decodedText(value)
    emit(preformatted ? decoded : decoded.replace(/\s+/g, ' '))
  }
  const finishAnchor = () => {
    if (!anchor) return
    const label = readableWhitespace(anchor.text).replace(/\s+/g, ' ')
    if (label && anchor.href) {
      links.push({ text: label, href: anchor.href })
      text += `\u0000${links.length - 1}\u0000`
    } else text += label
    anchor = undefined
  }
  for (const match of source.matchAll(HTML_TAG)) {
    if (!omittedTag) emitHtmlText(source.slice(position, match.index))
    position = match.index + match[0].length
    const tag = (match[1] || '').toLowerCase()
    const closing = match[0].startsWith('</')
    if (omittedTag) {
      if (tag === omittedTag && closing) omittedTag = ''
      continue
    }
    if (!tag) continue
    if (OMIT_CONTENT_TAGS.has(tag)) {
      if (!closing && !match[0].endsWith('/>')) omittedTag = tag
      continue
    }
    if (tag === 'pre') preformatted = !closing
    if (tag === 'a') {
      finishAnchor()
      if (!closing) {
        anchor = { text: '', href: anchorHref(match[0]) }
      }
    } else if (tag === 'br' || tag === 'hr') emit('\n')
    else if (tag === 'li') emit(closing ? '\n' : '\n• ')
    else if (tag === 'td' || tag === 'th') emit(' ')
    else if (BLOCK_TAGS.has(tag)) emit('\n\n')
    // Images, CSS, attributes and all other markup are discarded, never mounted.
  }
  if (!omittedTag) emitHtmlText(source.slice(position))
  finishAnchor()
  return { text, links }
}

/**
 * Presentation-only projection. It never writes back to the archived message.
 * Output is React text plus allowlisted links, NOT sanitized HTML or innerHTML.
 * No DOM parser, image, iframe, style or other remote-resource element is used.
 * @param {unknown} value
 * @returns {EmailPreviewPart[]}
 */
export function emailBodyPreview(value) {
  const source = typeof value === 'string' ? value.replace(/\u0000/g, '') : ''
  const isHtml = /<\/?(?:html|body|div|p|br|hr|pre|h[1-6]|address|article|aside|section|header|footer|main|span|font|a|table|tbody|thead|tfoot|tr|td|th|dl|dt|dd|ul|ol|li|blockquote|b|strong|em|i|img|script|style|head|title|iframe|object|svg|template|noscript)\b(?:[\s/>])/i.test(source)
  const projected = isHtml ? htmlTextAndLinks(source) : { text: source, links: [] }
  const text = readableWhitespace(projected.text)
  /** @type {EmailPreviewPart[]} */
  const parts = []
  let position = 0
  for (const match of text.matchAll(/\u0000(\d+)\u0000|https?:\/\/[^\s<>\u0000]+/gi)) {
    if (match.index > position) parts.push({ text: text.slice(position, match.index) })
    if (match[1] !== undefined) {
      const link = projected.links[Number(match[1])]
      if (link) parts.push(link)
    } else {
      // Avoid swallowing punctuation after a prose URL.
      const href = proseUrlHref(match[0])
      parts.push({ text: href, href: safeEmailPreviewHref(href) })
      if (href.length < match[0].length) parts.push({ text: match[0].slice(href.length) })
    }
    position = match.index + match[0].length
  }
  if (position < text.length) parts.push({ text: text.slice(position) })
  return parts
}
