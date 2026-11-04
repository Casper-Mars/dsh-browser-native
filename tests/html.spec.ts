import { describe, expect, it } from 'vitest'

import {
  buildSnapshot,
  collapseInline,
  decodeEntities,
  extractElements,
  extractTitle,
  htmlToText,
  stripInvisible,
  truncate,
} from '../src/html.js'

describe('decodeEntities', () => {
  it('decodes named and numeric entities', () => {
    expect(decodeEntities('a &amp; b &lt;c&gt; &#65; &#x42; &nbsp;d')).toBe('a & b <c> A B  d')
  })

  it('leaves unknown entities untouched', () => {
    expect(decodeEntities('&unknownentity;')).toBe('&unknownentity;')
  })
})

describe('stripInvisible', () => {
  it('removes script, style and comments', () => {
    const html = '<div>hi</div><script>alert(1)</script><!-- note --><style>p{}</style><p>there</p>'
    expect(stripInvisible(html)).toBe('<div>hi</div><p>there</p>')
  })
})

describe('extractTitle', () => {
  it('returns the decoded, collapsed title', () => {
    expect(extractTitle('<html><head><title>  Foo &amp;\n Bar </title></head></html>')).toBe('Foo & Bar')
  })

  it('returns an empty string when there is no title', () => {
    expect(extractTitle('<p>hello</p>')).toBe('')
  })
})

describe('htmlToText', () => {
  it('keeps readable text and drops markup plus invisible blocks', () => {
    const html = [
      '<html><head><title>T</title><style>.a{}</style></head>',
      '<body><h1>Hello</h1><script>var x = 1</script>',
      '<p>First   line &amp; more</p><p>Second</p>',
      '<ul><li>one</li><li>two</li></ul></body></html>',
    ].join('')
    expect(htmlToText(html)).toBe('Hello\nFirst line & more\nSecond\none\ntwo')
  })

  it('collapses blank lines', () => {
    expect(htmlToText('<div>a</div><div></div><div></div><div>b</div>')).toBe('a\nb')
  })

  it('renders br as a line break', () => {
    expect(htmlToText('a<br>b')).toBe('a\nb')
  })

  it('collapseInline normalizes inline whitespace', () => {
    expect(collapseInline('  a \t b  ')).toBe('a b')
  })
})

describe('extractElements', () => {
  const html = [
    '<a href="/docs">Docs</a>',
    '<a name="anchor-only">No href</a>',
    '<button>  Save &amp; close </button>',
    '<input type="text" aria-label="Search box">',
    '<input type="hidden" name="csrf">',
    '<div role="tab">Tab one</div>',
    '<select id="locale"><option>en</option></select>',
    '<textarea placeholder="Comment"></textarea>',
  ].join('')

  it('lists interactive elements with role and accessible name', () => {
    expect(extractElements(html)).toEqual([
      { tag: 'a', role: 'link', name: 'Docs' },
      { tag: 'button', role: 'button', name: 'Save & close' },
      { tag: 'input', role: 'textbox', name: 'Search box' },
      { tag: 'div', role: 'tab', name: 'Tab one' },
      { tag: 'select', role: 'combobox', name: 'locale' },
      { tag: 'textarea', role: 'textbox', name: 'Comment' },
    ])
  })

  it('honors the element budget', () => {
    expect(extractElements(html, 2)).toHaveLength(2)
  })

  it('returns an empty list for plain text', () => {
    expect(extractElements('<p>nothing interactive</p>')).toEqual([])
  })
})

describe('truncate', () => {
  it('keeps short text untouched', () => {
    expect(truncate('abc', 10)).toEqual({ text: 'abc', truncated: false })
  })

  it('cuts long text and flags it', () => {
    expect(truncate('abcdef', 3)).toEqual({ text: 'abc', truncated: true })
  })

  it('rejects a non-positive budget', () => {
    expect(() => truncate('abc', 0)).toThrow(/maxLength must be a positive/)
  })
})

describe('buildSnapshot', () => {
  it('combines title, text and elements', () => {
    const html =
      '<html><head><title>Page</title></head><body><h1>Heading</h1><button>Go</button><script>x()</script></body></html>'
    expect(buildSnapshot(html)).toEqual({
      title: 'Page',
      text: 'Heading\nGo',
      elements: [{ tag: 'button', role: 'button', name: 'Go' }],
      truncated: false,
    })
  })

  it('marks truncation and applies the element budget', () => {
    const html = '<p>abcdefghij</p><button>One</button><button>Two</button>'
    const snapshot = buildSnapshot(html, { maxLength: 4, maxElements: 1 })
    expect(snapshot.text).toBe('abcd')
    expect(snapshot.truncated).toBe(true)
    expect(snapshot.elements).toEqual([{ tag: 'button', role: 'button', name: 'One' }])
  })
})
