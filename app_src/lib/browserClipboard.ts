/**
 * Copy plain text from a direct user action. Embedded browsers and restricted
 * clipboard permission policies may reject the modern API, so retain the
 * synchronous selection fallback used by the rest of the app.
 */
export async function copyPlainTextToClipboard(value: string) {
  if (!value) return false

  try {
    if (globalThis.navigator?.clipboard?.writeText) {
      await globalThis.navigator.clipboard.writeText(value)
      return true
    }
  } catch {
    // Continue to the selection-based fallback below.
  }

  const document = globalThis.document
  if (!document?.body || typeof document.execCommand !== 'function') {
    return false
  }

  const textarea = document.createElement('textarea')
  try {
    textarea.value = value
    textarea.setAttribute('readonly', '')
    textarea.style.position = 'fixed'
    textarea.style.top = '0'
    textarea.style.left = '0'
    textarea.style.opacity = '0'
    textarea.style.pointerEvents = 'none'
    document.body.appendChild(textarea)
    textarea.focus()
    textarea.select()
    textarea.setSelectionRange(0, value.length)
    return document.execCommand('copy') === true
  } catch {
    return false
  } finally {
    textarea.remove()
  }
}
