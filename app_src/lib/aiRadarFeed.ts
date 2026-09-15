import type { IncomingMessage } from 'node:http'
import { StringDecoder } from 'node:string_decoder'
import { XMLValidator } from 'fast-xml-parser'

export const MAX_RADAR_FEED_BYTES = 4 * 1024 * 1024
export const MAX_RADAR_FEED_ITEMS = 30

// A feed may retain years of article bodies although Radar only uses its first
// 30 entries. Find that complete prefix while retaining the same byte ceiling.
// Comments, CDATA, processing instructions and quoted attributes must not be
// mistaken for entry boundaries. The finished prefix is still XML-validated.
class FeedPrefix {
  private cursor = 0
  private elements: string[] = []
  private items = 0

  read(xml: string): string | null {
    while (this.cursor < xml.length) {
      const start = xml.indexOf('<', this.cursor)
      if (start < 0) {
        this.cursor = xml.length
        return null
      }
      const special = [
        ['<!--', '-->'],
        ['<![CDATA[', ']]>'],
        ['<?', '?>'],
      ].find(([opening]) => xml.startsWith(opening, start))
      if (special) {
        const end = xml.indexOf(special[1], start + special[0].length)
        if (end < 0) return null
        this.cursor = end + special[1].length
        continue
      }
      // Wait for an opening token split across transport chunks.
      if (['<!--', '<![CDATA[', '<?', '<!DOCTYPE'].some(token => token.startsWith(xml.slice(start)))) return null
      if (xml.startsWith('<!', start)) throw new Error('AI Radar feeds cannot contain XML declarations other than comments or CDATA')
      let quote = ''
      let end = start + 1
      for (; end < xml.length; end += 1) {
        const char = xml[end]
        if (quote) {
          if (char === quote) quote = ''
        } else if (char === '"' || char === "'") quote = char
        else if (char === '>') break
      }
      if (end === xml.length) return null
      const tag = xml.slice(start, end + 1)
      const match = tag.match(/^<(\/?)([A-Za-z_][\w.:-]*)(?=[\s/>])/)
      if (!match) throw new Error('AI Radar feed contains malformed XML tags')
      const closing = Boolean(match[1])
      const name = match[2]
      if (!closing) this.elements.push(name)
      if (closing || /\/\s*>$/.test(tag)) {
        if (this.elements.at(-1) !== name) throw new Error('AI Radar feed contains mismatched XML tags')
        const names = this.elements.map(element => element.split(':').at(-1))
        const entry = (names.length === 3 && names[0] === 'rss' && names[1] === 'channel' && names[2] === 'item')
          || (names.length === 2 && names[0] === 'feed' && names[1] === 'entry')
        this.elements.pop()
        if (entry && ++this.items === MAX_RADAR_FEED_ITEMS) {
          return xml.slice(0, end + 1) + this.elements.slice().reverse().map(element => `</${element}>`).join('')
        }
      }
      this.cursor = end + 1
    }
    return null
  }
}

function validatedXml(xml: string, sourceName: string): string {
  if (Buffer.byteLength(xml, 'utf8') > MAX_RADAR_FEED_BYTES) throw new Error(`${sourceName} feed exceeds ${MAX_RADAR_FEED_BYTES} bytes`)
  if (XMLValidator.validate(xml) !== true) throw new Error(`${sourceName} returned malformed or truncated XML`)
  return xml
}

export async function readBoundedRadarFeed(response: IncomingMessage, sourceName: string): Promise<string> {
  const decoder = new StringDecoder('utf8')
  const prefix = new FeedPrefix()
  let xml = ''
  let bytes = 0
  try {
    // Do not reject a large Content-Length: the response is deliberately
    // cancelled after 30 complete entries, never buffered past this hard cap.
    for await (const value of response) {
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value)
      bytes += chunk.byteLength
      if (bytes > MAX_RADAR_FEED_BYTES) throw new Error(`${sourceName} feed exceeds ${MAX_RADAR_FEED_BYTES} bytes before ${MAX_RADAR_FEED_ITEMS} complete entries`)
      xml += decoder.write(chunk)
      const selected = prefix.read(xml)
      if (selected !== null) return validatedXml(selected, sourceName)
    }
    xml += decoder.end()
    return validatedXml(xml, sourceName)
  } finally {
    // Release the socket on early completion, malformed XML, size overflow or
    // transport failure. Never drain the rest of a historical feed.
    response.destroy()
  }
}
