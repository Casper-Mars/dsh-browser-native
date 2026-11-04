/**
 * Pure HTML → snapshot/text helpers.
 *
 * The snapshot tools must work without a DOM implementation on the Node side
 * (the dependency allow-list for this plugin is playwright-core only), so this
 * module implements a small, deterministic tokenizer over the serialized page
 * HTML that playwright hands back. Everything here is a pure function of its
 * input: no clocks, no randomness, no I/O.
 *
 * @module dsh-browser-native/html
 */

/** One interactive element surfaced by the snapshot. */
export interface SnapshotElement {
  tag: string
  role: string
  name: string
}

/** Snapshot payload derived from page HTML. */
export interface HtmlSnapshot {
  title: string
  text: string
  elements: SnapshotElement[]
  truncated: boolean
}

/** Options for {@link buildSnapshot}. */
export interface SnapshotOptions {
  /** Character budget for the visible text (default 20000). */
  maxLength?: number
  /** Element budget for the interactive element list (default 200). */
  maxElements?: number
}

const DEFAULT_MAX_LENGTH = 20_000
const DEFAULT_MAX_ELEMENTS = 200

/** Tags whose content is never part of the visible text. */
const INVISIBLE_TAGS = ['script', 'style', 'noscript', 'template', 'svg', 'canvas', 'title']

/** Tags that start a new text line. */
const BLOCK_TAGS = new Set([
  'address', 'article', 'aside', 'blockquote', 'br', 'dd', 'div', 'dl', 'dt',
  'fieldset', 'figcaption', 'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4',
  'h5', 'h6', 'header', 'hr', 'li', 'main', 'nav', 'ol', 'p', 'pre', 'section',
  'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr', 'ul',
])

/** Tags that are interactive on their own. */
const INTERACTIVE_TAGS = new Set(['a', 'button', 'input', 'select', 'summary', 'textarea'])

/** Implicit ARIA role per interactive tag. */
const IMPLICIT_ROLES: Record<string, string> = {
  a: 'link',
  button: 'button',
  input: 'textbox',
  select: 'combobox',
  summary: 'button',
  textarea: 'textbox',
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  hellip: '…',
  mdash: '—',
  ndash: '–',
  copy: '©',
  reg: '®',
  times: '×',
}

/**
 * Decode the HTML entities that matter for readable text.
 * @param input - raw HTML text.
 * @returns text with named and numeric entities decoded.
 */
export function decodeEntities(input: string): string {
  return input.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (match, entity: string) => {
    if (entity.startsWith('#x') || entity.startsWith('#X')) {
      const code = Number.parseInt(entity.slice(2), 16)
      return Number.isFinite(code) ? String.fromCodePoint(code) : match
    }
    if (entity.startsWith('#')) {
      const code = Number.parseInt(entity.slice(1), 10)
      return Number.isFinite(code) ? String.fromCodePoint(code) : match
    }
    return NAMED_ENTITIES[entity.toLowerCase()] ?? match
  })
}

/**
 * Extract the document title.
 * @param html - serialized page HTML.
 * @returns decoded, whitespace-collapsed title ('' when absent).
 */
export function extractTitle(html: string): string {
  const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)
  if (match?.[1] === undefined) return ''
  return decodeEntities(stripTags(match[1])).replace(/\s+/g, ' ').trim()
}

/**
 * Remove tags whose content is invisible, plus HTML comments.
 * @param html - serialized page HTML.
 * @returns HTML without scripts, styles, comments and friends.
 */
export function stripInvisible(html: string): string {
  let output = html.replace(/<!--[\s\S]*?-->/g, '')
  for (const tag of INVISIBLE_TAGS) {
    output = output.replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}>`, 'gi'), '')
  }
  return output
}

/**
 * Drop every remaining tag.
 * @param html - fragment.
 * @returns the fragment with tags removed but text preserved.
 */
export function stripTags(html: string): string {
  return html.replace(/<[^>]*>/g, '')
}

/**
 * Collapse runs of inline whitespace to one space.
 * @param input - text fragment.
 * @returns the collapsed text.
 */
export function collapseInline(input: string): string {
  return input.replace(/[ \t\f\v\u00a0]+/g, ' ').trim()
}

/**
 * Convert HTML to readable text: block boundaries become newlines, entities
 * are decoded, blank lines collapse, and inline whitespace normalizes.
 * @param html - serialized page HTML (or a fragment).
 * @returns the readable text.
 */
export function htmlToText(html: string): string {
  let output = stripInvisible(html)
  output = output.replace(/<(br|hr)\s*\/?>/gi, '\n')
  output = output.replace(/<\/?([a-zA-Z][\w-]*)([^>]*)>/g, (_match: string, rawTag: string) =>
    BLOCK_TAGS.has(rawTag.toLowerCase()) ? '\n' : ' ',
  )
  output = output.replace(/<[^>]*>/g, ' ')
  output = decodeEntities(output)
  return output
    .split('\n')
    .map((line) => collapseInline(line))
    .filter((line) => line !== '')
    .join('\n')
}

/** Parse the attributes of one opening tag. */
function parseAttributes(source: string): Record<string, string> {
  const attributes: Record<string, string> = {}
  const pattern = /([\w:-]+)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))/g
  let match: RegExpExecArray | null
  while ((match = pattern.exec(source)) !== null) {
    const name = (match[1] ?? '').toLowerCase()
    const value = match[3] ?? match[4] ?? match[5] ?? ''
    attributes[name] = decodeEntities(value)
  }
  return attributes
}

/** Text content of an element, used as a last-resort accessible name. */
function elementText(html: string, tag: string): string {
  const match = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i').exec(html)
  if (match?.[1] === undefined) return ''
  return collapseInline(decodeEntities(stripTags(stripInvisible(match[1]))))
}

/** Best available accessible name for one element. */
function accessibleName(attributes: Record<string, string>, fallbackText: string): string {
  const candidates = [
    attributes['aria-label'],
    attributes['placeholder'],
    attributes['alt'],
    attributes['title'],
    attributes['name'],
    attributes['id'],
  ]
  for (const candidate of candidates) {
    if (candidate !== undefined && candidate.trim() !== '') return collapseInline(candidate)
  }
  if (attributes['type'] === 'submit' && attributes['value'] !== undefined) return collapseInline(attributes['value'])
  return fallbackText
}

/**
 * List interactive elements with their role and accessible name.
 * @param html - serialized page HTML.
 * @param maxElements - element budget (default 200).
 * @returns elements in document order.
 */
export function extractElements(html: string, maxElements: number = DEFAULT_MAX_ELEMENTS): SnapshotElement[] {
  const visible = stripInvisible(html)
  const elements: SnapshotElement[] = []
  const pattern = /<([a-zA-Z][\w-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>/g
  let match: RegExpExecArray | null
  while ((match = pattern.exec(visible)) !== null) {
    const tag = (match[1] ?? '').toLowerCase()
    const attributes = parseAttributes(match[2] ?? '')
    const explicitRole = attributes['role']?.trim().toLowerCase()
    const interactive = INTERACTIVE_TAGS.has(tag) || explicitRole !== undefined
    if (!interactive) continue
    if (tag === 'a' && attributes['href'] === undefined) continue
    if (tag === 'input' && attributes['type'] === 'hidden') continue
    const role = explicitRole !== undefined && explicitRole !== '' ? explicitRole : IMPLICIT_ROLES[tag] ?? 'generic'
    const name = accessibleName(attributes, elementText(visible, tag))
    elements.push({ tag, role, name })
    if (elements.length >= maxElements) break
  }
  return elements
}

/**
 * Truncate text to a character budget.
 * @param text - input text.
 * @param maxLength - positive character budget.
 * @returns the possibly shortened text and whether it was shortened.
 */
export function truncate(text: string, maxLength: number): { text: string; truncated: boolean } {
  if (!Number.isFinite(maxLength) || maxLength <= 0) {
    throw new Error('dsh-browser-native: maxLength must be a positive finite number')
  }
  if (text.length <= maxLength) return { text, truncated: false }
  return { text: text.slice(0, maxLength), truncated: true }
}

/**
 * Build the snapshot payload from serialized page HTML.
 * @param html - serialized page HTML.
 * @param options - text and element budgets.
 * @returns title, readable text, interactive elements and the truncation flag.
 */
export function buildSnapshot(html: string, options: SnapshotOptions = {}): HtmlSnapshot {
  const maxLength = options.maxLength ?? DEFAULT_MAX_LENGTH
  const maxElements = options.maxElements ?? DEFAULT_MAX_ELEMENTS
  const cut = truncate(htmlToText(html), maxLength)
  return {
    title: extractTitle(html),
    text: cut.text,
    elements: extractElements(html, maxElements),
    truncated: cut.truncated,
  }
}
