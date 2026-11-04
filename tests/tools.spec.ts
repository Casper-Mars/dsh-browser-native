import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { ToolArgsError } from '@deepseek-ai/dsh-tools'
import { describe, expect, it } from 'vitest'

import type { BrowserSession, PageLike, SessionStatus } from '../src/session.js'
import {
  BROWSER_TOOL_NAMES,
  createBrowserTools,
  resolveScreenshotPath,
  toJsonValue,
  type BrowserToolOptions,
} from '../src/tools.js'

const OPTIONS: BrowserToolOptions = { actionTimeoutMs: 5000, screenshotDir: '' }

/** Stand-in execution context; the tools never read it. */
const NO_EXEC = {} as never

/** In-memory page standing in for a playwright page. */
class FakePage implements PageLike {
  currentUrl = 'about:blank'
  currentTitle = ''
  html = '<html><head><title>Fake</title></head><body><button>Go</button></body></html>'
  clicked: string[] = []
  filled: { selector: string; value: string }[] = []
  pressed: string[] = []
  screenshots: { fullPage: boolean }[] = []
  evaluated: string[] = []
  closed = false
  status: number | null = 200

  constructor(private readonly gotoTitle = 'Fake') {}

  async goto(url: string): Promise<{ status(): number | null } | null> {
    this.currentUrl = url
    this.currentTitle = this.gotoTitle
    return this.status === null ? null : { status: () => this.status }
  }

  url(): string {
    return this.currentUrl
  }

  async title(): Promise<string> {
    return this.currentTitle
  }

  async content(): Promise<string> {
    return this.html
  }

  async click(selector: string): Promise<void> {
    this.clicked.push(selector)
  }

  async fill(selector: string, value: string): Promise<void> {
    this.filled.push({ selector, value })
  }

  async press(_selector: string, key: string): Promise<void> {
    this.pressed.push(key)
  }

  async screenshot(options?: { fullPage?: boolean }): Promise<Buffer> {
    this.screenshots.push({ fullPage: options?.fullPage === true })
    return Buffer.from('fake-png')
  }

  async evaluate(expression: string): Promise<unknown> {
    this.evaluated.push(expression)
    return { expression, ok: true }
  }

  isClosed(): boolean {
    return this.closed
  }

  async close(): Promise<void> {
    this.closed = true
  }
}

/** Session wrapper that counts attaches and records closes. */
class FakeSession implements BrowserSession {
  readonly cdpUrl: string
  ensurePageCalls = 0
  closeCalls = 0
  statusCalls = 0
  connected = true
  constructor(readonly page: FakePage, cdpUrl = 'ws://127.0.0.1:3000/?token=t') {
    this.cdpUrl = cdpUrl
  }

  async ensurePage(): Promise<PageLike> {
    this.ensurePageCalls += 1
    return this.page
  }

  status(): SessionStatus {
    this.statusCalls += 1
    return { connected: this.connected, cdpUrl: this.cdpUrl }
  }

  async close(): Promise<{ closed: boolean }> {
    this.closeCalls += 1
    const wasConnected = this.connected
    this.connected = false
    return { closed: wasConnected }
  }

  async dispose(): Promise<void> {
    await this.close()
  }
}

function build(options: BrowserToolOptions = OPTIONS): { tools: ReturnType<typeof createBrowserTools>; page: FakePage; session: FakeSession } {
  const page = new FakePage()
  const session = new FakeSession(page)
  return { tools: createBrowserTools(session, options), page, session }
}

function toolNamed(tools: ReturnType<typeof createBrowserTools>, name: string) {
  const tool = tools.find((candidate) => candidate.name === name)
  if (tool === undefined) throw new Error(`missing tool ${name}`)
  return tool
}

const REQUIRED_PARAMETERS: Record<string, string[]> = {
  browser_navigate: ['url'],
  browser_snapshot: [],
  browser_click: ['selector'],
  browser_type: ['selector', 'text'],
  browser_screenshot: [],
  browser_evaluate: ['expression'],
  browser_close: [],
}

const EXPECTED_PROPERTIES: Record<string, string[]> = {
  browser_navigate: ['url', 'waitUntil', 'timeoutMs'],
  browser_snapshot: ['maxLength', 'maxElements'],
  browser_click: ['selector', 'timeoutMs'],
  browser_type: ['selector', 'text', 'submit', 'timeoutMs'],
  browser_screenshot: ['path', 'fullPage'],
  browser_evaluate: ['expression'],
  browser_close: [],
}

describe('createBrowserTools', () => {
  it('registers exactly the seven documented tool names in order', () => {
    const { tools } = build()
    expect(tools.map((tool) => tool.name)).toEqual([...BROWSER_TOOL_NAMES])
  })

  it('declares an output schema plus a render function for every tool', () => {
    const { tools } = build()
    for (const tool of tools) {
      expect(typeof tool.output.render).toBe('function')
      expect(tool.output.schema).toBeTypeOf('object')
      const schema = tool.output.schema as unknown as { type?: string; additionalProperties?: boolean }
      expect(schema.type).toBe('object')
      expect(schema.additionalProperties).toBe(false)
      expect(Object.keys(schema).length).toBeGreaterThan(0)
    }
  })

  it.each(Object.keys(REQUIRED_PARAMETERS))('exposes the documented parameter schema for %s', (name) => {
    const { tools } = build()
    const tool = toolNamed(tools, name)
    const schema = tool.parameters as unknown as {
      type?: string
      properties?: Record<string, { type?: string }>
      required?: string[]
    }
    expect(schema.type).toBe('object')
    expect(Object.keys(schema.properties ?? {}).sort()).toEqual([...EXPECTED_PROPERTIES[name]!].sort())
    expect(schema.required ?? []).toEqual(REQUIRED_PARAMETERS[name])
    for (const property of Object.values(schema.properties ?? {})) {
      expect(typeof property.type).toBe('string')
    }
  })

  it('renders a text block for every tool', () => {
    const { tools } = build()
    const rendered = toolNamed(tools, 'browser_close')
    expect(rendered.output.render({}, { closed: true, cdpUrl: 'ws://example' })).toEqual([
      { type: 'text', text: 'Disconnected from ws://example' },
    ])
  })

  it('navigates and reports the resulting url, title and status', async () => {
    const { tools, page } = build()
    const result = await toolNamed(tools, 'browser_navigate').execute(
      { url: 'https://example.com', waitUntil: 'domcontentloaded' },
      NO_EXEC,
    )
    expect(page.currentUrl).toBe('https://example.com')
    expect(result).toEqual({ url: 'https://example.com', title: 'Fake', status: 200 })
  })

  it('reports a null status when navigation has no response', async () => {
    const { tools, page } = build()
    page.status = null
    const result = await toolNamed(tools, 'browser_navigate').execute({ url: 'about:blank' }, NO_EXEC)
    expect(result).toEqual({ url: 'about:blank', title: 'Fake', status: null })
  })

  it('rejects missing required arguments', async () => {
    const { tools } = build()
    await expect(toolNamed(tools, 'browser_navigate').execute({}, NO_EXEC)).rejects.toBeInstanceOf(ToolArgsError)
    await expect(toolNamed(tools, 'browser_click').execute({}, NO_EXEC)).rejects.toBeInstanceOf(ToolArgsError)
  })

  it('rejects an argument of the wrong type', async () => {
    const { tools } = build()
    await expect(
      toolNamed(tools, 'browser_type').execute({ selector: 'input', text: 42 }, NO_EXEC),
    ).rejects.toBeInstanceOf(ToolArgsError)
  })

  it('snapshots the current page as text plus elements', async () => {
    const { tools } = build()
    const result = await toolNamed(tools, 'browser_snapshot').execute({}, NO_EXEC)
    expect(result).toEqual({
      url: 'about:blank',
      title: 'Fake',
      text: 'Go',
      truncated: false,
      elements: [{ tag: 'button', role: 'button', name: 'Go' }],
    })
  })

  it('clicks and types, pressing Enter only when submit is requested', async () => {
    const { tools, page } = build()
    const clickResult = await toolNamed(tools, 'browser_click').execute({ selector: 'button' }, NO_EXEC)
    expect(clickResult).toEqual({ selector: 'button', url: 'about:blank', title: '' })
    expect(page.clicked).toEqual(['button'])

    const quiet = await toolNamed(tools, 'browser_type').execute({ selector: 'input', text: 'hello' }, NO_EXEC)
    expect(quiet).toEqual({ selector: 'input', url: 'about:blank', submitted: false })
    const submitted = await toolNamed(tools, 'browser_type').execute(
      { selector: 'input', text: 'hello', submit: true },
      NO_EXEC,
    )
    expect(submitted).toEqual({ selector: 'input', url: 'about:blank', submitted: true })
    expect(page.filled).toEqual([
      { selector: 'input', value: 'hello' },
      { selector: 'input', value: 'hello' },
    ])
    expect(page.pressed).toEqual(['Enter'])
  })

  it('evaluates an expression and returns its JSON result', async () => {
    const { tools, page } = build()
    const result = await toolNamed(tools, 'browser_evaluate').execute(
      { expression: 'document.title' },
      NO_EXEC,
    )
    expect(page.evaluated).toEqual(['document.title'])
    expect(result).toEqual({ url: 'about:blank', result: { expression: 'document.title', ok: true } })
  })

  it('writes screenshots to disk and reports the byte count', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'dsh-browser-native-'))
    try {
      const { tools, page } = build({ actionTimeoutMs: 5000, screenshotDir: dir })
      const result = (await toolNamed(tools, "browser_screenshot").execute({ path: "shot.png" }, NO_EXEC)) as {
        path: string
        bytes: number
        fullPage: boolean
      }
      expect(result).toEqual({ path: path.join(dir, 'shot.png'), bytes: 8, fullPage: false })
      expect(page.screenshots).toEqual([{ fullPage: false }])
      expect(await readFile(result.path, 'utf8')).toBe('fake-png')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('disconnects on close without closing the page', async () => {
    const { tools, session, page } = build()
    const result = await toolNamed(tools, 'browser_close').execute({}, NO_EXEC)
    expect(result).toEqual({ closed: true, cdpUrl: 'ws://127.0.0.1:3000/?token=t' })
    expect(session.closeCalls).toBe(1)
    expect(page.closed).toBe(false)
  })
})

describe('resolveScreenshotPath', () => {
  it('keeps an absolute path untouched', () => {
    expect(resolveScreenshotPath('/tmp/a.png', { screenshotDir: 'shots', cwd: '/work' })).toBe('/tmp/a.png')
  })

  it('resolves a relative path under the screenshot directory', () => {
    expect(resolveScreenshotPath('a.png', { screenshotDir: 'shots', cwd: '/work' })).toBe('/work/shots/a.png')
  })

  it('generates a timestamped name when no path is given', () => {
    const destination = resolveScreenshotPath(undefined, { screenshotDir: 'shots', cwd: '/work' }, new Date('2026-01-02T03:04:05.678Z'))
    expect(destination).toBe('/work/shots/browser-screenshot-2026-01-02T03-04-05-678Z.png')
  })
})

describe('toJsonValue', () => {
  it('maps undefined to null and serializes functions', () => {
    expect(toJsonValue(undefined)).toBeNull()
    expect(toJsonValue({ a: 1 })).toEqual({ a: 1 })
    expect(toJsonValue(1n)).toBe('1')
  })
})
