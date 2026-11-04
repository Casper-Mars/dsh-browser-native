/**
 * The seven fine-grained browser tools registered by this plugin.
 *
 * Every definition goes through `defineTool`, which compiles the author-facing
 * schema DSL into the enforced JSON Schema subset and adds strict argument
 * validation; `ctx.tools.register` additionally requires `output.render`.
 *
 * Execution only touches the injected {@link BrowserSession}, so the tools can
 * be unit tested with a fake session and no browser at all.
 *
 * @module dsh-browser-native/tools
 */

import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'

import { buildSnapshot } from './html.js'
import type { BrowserSession, PageLike } from './session.js'

/** Names registered by this plugin, in registration order. */
export const BROWSER_TOOL_NAMES = [
  'browser_navigate',
  'browser_snapshot',
  'browser_click',
  'browser_type',
  'browser_screenshot',
  'browser_evaluate',
  'browser_close',
] as const

/** One of the names registered by this plugin. */
export type BrowserToolName = (typeof BROWSER_TOOL_NAMES)[number]

/** Runtime knobs the tools need from the resolved config. */
export interface BrowserToolOptions {
  /** Default per-action timeout in milliseconds. */
  actionTimeoutMs: number
  /** Directory receiving screenshots; empty means the process cwd. */
  screenshotDir: string
  /** Base directory for relative screenshot paths. */
  cwd?: string
}

/** Build a one-line text result. */
function text(value: string): { type: 'text'; text: string }[] {
  return [{ type: 'text', text: value }]
}

/** Narrow a page response to its HTTP status. */
function statusOf(response: { status(): number | null } | null): number | null {
  return response === null ? null : response.status()
}

/** A value that round-trips through JSON without loss. */
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }

/** Project an arbitrary evaluation result onto lossless JSON. */
export function toJsonValue(value: unknown): JsonValue {
  if (value === undefined) return null
  if (typeof value === 'function') return String(value)
  try {
    const encoded = JSON.stringify(value)
    return encoded === undefined ? String(value) : (JSON.parse(encoded) as JsonValue)
  } catch {
    return String(value)
  }
}

/** Resolve where a screenshot is written. */
export function resolveScreenshotPath(
  requested: string | undefined,
  options: Pick<BrowserToolOptions, 'screenshotDir' | 'cwd'>,
  now: Date = new Date(),
): string {
  const base = path.resolve(options.cwd ?? process.cwd(), options.screenshotDir)
  if (requested !== undefined && requested.trim() !== '') {
    return path.isAbsolute(requested) ? requested : path.resolve(base, requested)
  }
  const stamp = now.toISOString().replace(/[:.]/g, '-')
  return path.resolve(base, `browser-screenshot-${stamp}.png`)
}

/**
 * Build the tool definitions bound to one session.
 * @param session - attached-or-lazy browser session.
 * @param options - timeouts and screenshot destination.
 * @returns the seven registry-ready definitions.
 */
export function createBrowserTools(
  session: BrowserSession,
  options: BrowserToolOptions,
): ToolDefinition[] {
  const navigate = defineTool({
    name: 'browser_navigate',
    description:
      'Navigate the attached browser tab to a URL and wait for the requested lifecycle event. Use it before snapshot or element interaction.',
    parameters: {
      url: { type: 'string', required: true, description: 'Absolute URL to open.' },
      waitUntil: {
        type: 'string',
        enum: ['load', 'domcontentloaded', 'networkidle', 'commit'],
        description: 'Lifecycle event to wait for (default "load").',
      },
      timeoutMs: { type: 'integer', description: 'Navigation budget in milliseconds.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          url: { type: 'string', required: true },
          title: { type: 'string', required: true },
          status: { oneOf: [{ type: 'integer' }, { type: 'null' }], required: true },
        },
      },
      render: (_args, value) =>
        text(`Navigated to ${value.url} (status ${value.status === null ? 'none' : value.status}) — ${value.title}`),
    },
    async execute(args) {
      const page = await session.ensurePage()
      const response = await page.goto(args.url, {
        waitUntil: args.waitUntil ?? 'load',
        timeout: args.timeoutMs ?? options.actionTimeoutMs,
      })
      return { url: page.url(), title: await page.title(), status: statusOf(response) }
    },
  })

  const snapshot = defineTool({
    name: 'browser_snapshot',
    description:
      'Read the current tab as readable text plus the list of interactive elements (role and accessible name). Prefer it over raw HTML to decide what to click or type.',
    parameters: {
      maxLength: { type: 'integer', description: 'Character budget for the text (default 20000).' },
      maxElements: { type: 'integer', description: 'Element budget for the interactive list (default 200).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          url: { type: 'string', required: true },
          title: { type: 'string', required: true },
          text: { type: 'string', required: true },
          truncated: { type: 'boolean', required: true },
          elements: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                tag: { type: 'string', required: true },
                role: { type: 'string', required: true },
                name: { type: 'string', required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => {
        const elements = value.elements
          .map((element, index) => `${index + 1}. [${element.role}] ${element.name} <${element.tag}>`)
          .join('\n')
        return text(
          `${value.title || '(untitled)'} — ${value.url}\n\n${value.text}${value.truncated ? '\n…(truncated)' : ''}\n\nElements:\n${elements}`,
        )
      },
    },
    async execute(args) {
      const page = await session.ensurePage()
      const built = buildSnapshot(await page.content(), {
        ...(args.maxLength === undefined ? {} : { maxLength: args.maxLength }),
        ...(args.maxElements === undefined ? {} : { maxElements: args.maxElements }),
      })
      return { url: page.url(), ...built }
    },
  })

  const click = defineTool({
    name: 'browser_click',
    description: 'Click the element matching a CSS selector in the attached tab, then report the resulting URL.',
    parameters: {
      selector: { type: 'string', required: true, description: 'CSS selector of the element to click.' },
      timeoutMs: { type: 'integer', description: 'Wait budget for the element in milliseconds.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          selector: { type: 'string', required: true },
          url: { type: 'string', required: true },
          title: { type: 'string', required: true },
        },
      },
      render: (_args, value) => text(`Clicked ${value.selector} → ${value.url} (${value.title})`),
    },
    async execute(args) {
      const page: PageLike = await session.ensurePage()
      await page.click(args.selector, { timeout: args.timeoutMs ?? options.actionTimeoutMs })
      return { selector: args.selector, url: page.url(), title: await page.title() }
    },
  })

  const type = defineTool({
    name: 'browser_type',
    description:
      'Fill an input or textarea matched by a CSS selector, optionally pressing Enter to submit afterwards.',
    parameters: {
      selector: { type: 'string', required: true, description: 'CSS selector of the input to fill.' },
      text: { type: 'string', required: true, description: 'Text to type into the field.' },
      submit: { type: 'boolean', description: 'Press Enter after filling (default false).' },
      timeoutMs: { type: 'integer', description: 'Wait budget for the element in milliseconds.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          selector: { type: 'string', required: true },
          url: { type: 'string', required: true },
          submitted: { type: 'boolean', required: true },
        },
      },
      render: (_args, value) =>
        text(`Typed into ${value.selector}${value.submitted ? ' and pressed Enter' : ''} → ${value.url}`),
    },
    async execute(args) {
      const page = await session.ensurePage()
      const timeout = args.timeoutMs ?? options.actionTimeoutMs
      await page.fill(args.selector, args.text, { timeout })
      const submitted = args.submit === true
      if (submitted) await page.press(args.selector, 'Enter', { timeout })
      return { selector: args.selector, url: page.url(), submitted }
    },
  })

  const screenshot = defineTool({
    name: 'browser_screenshot',
    description:
      'Capture a PNG of the current tab and write it to disk; returns the saved path so the file can be attached or inspected.',
    parameters: {
      path: {
        type: 'string',
        description: 'Destination file path (absolute, or relative to the configured screenshot directory).',
      },
      fullPage: { type: 'boolean', description: 'Capture the full scrollable page (default false).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', required: true },
          bytes: { type: 'integer', required: true },
          fullPage: { type: 'boolean', required: true },
        },
      },
      render: (_args, value) =>
        text(`Saved ${value.fullPage ? 'full-page ' : ''}screenshot (${value.bytes} bytes) to ${value.path}`),
    },
    async execute(args) {
      const page = await session.ensurePage()
      const fullPage = args.fullPage === true
      const destination = resolveScreenshotPath(args.path, options)
      const buffer = await page.screenshot({ fullPage })
      await mkdir(path.dirname(destination), { recursive: true })
      await writeFile(destination, buffer)
      return { path: destination, bytes: buffer.byteLength, fullPage }
    },
  })

  const evaluate = defineTool({
    name: 'browser_evaluate',
    description:
      'Evaluate a JavaScript expression in the current page and return its JSON result. The expression runs in page context, so it can inspect the DOM or app state.',
    parameters: {
      expression: {
        type: 'string',
        required: true,
        description: 'JavaScript expression, e.g. "document.title" or "Array.from(document.links).map(a => a.href)".',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          url: { type: 'string', required: true },
          result: { type: 'json', required: true },
        },
      },
      render: (_args, value) => text(JSON.stringify(value.result, null, 2)),
    },
    async execute(args) {
      const page = await session.ensurePage()
      const raw = await page.evaluate(args.expression)
      return { url: page.url(), result: toJsonValue(raw) }
    },
  })

  const close = defineTool({
    name: 'browser_close',
    description:
      'Disconnect from the attached browser. This only releases this client connection; it never closes or kills the remote browser, which can be attached again later.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          closed: { type: 'boolean', required: true },
          cdpUrl: { type: 'string', required: true },
        },
      },
      render: (_args, value) =>
        text(value.closed ? `Disconnected from ${value.cdpUrl}` : `No active connection to ${value.cdpUrl}`),
    },
    async execute() {
      const { closed } = await session.close()
      return { closed, cdpUrl: session.cdpUrl }
    },
  })

  return [navigate, snapshot, click, type, screenshot, evaluate, close]
}
