/**
 * Lazy, process-wide CDP attachment.
 *
 * playwright-core's `chromium.connectOverCDP` accepts a WebSocket endpoint
 * verbatim, so a `ws://host:port/?token=...` URL keeps its query string — the
 * exact case puppeteer's `/json/version` discovery breaks.
 *
 * One {@link CdpSession} owns at most one connection: the first tool call
 * connects, later calls reuse it, and `browser_close` only disconnects. The
 * browser is never launched and never killed by this plugin (MVP is
 * attach-only); `headless` is reserved for a later launch mode.
 *
 * @module dsh-browser-native/session
 */

import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core'

/** Handle identifying one element or the page a tool acted on. */
export interface PageLike {
  goto(url: string, options?: { waitUntil?: string; timeout?: number }): Promise<{ status(): number | null } | null>
  url(): string
  title(): Promise<string>
  content(): Promise<string>
  click(selector: string, options?: { timeout?: number }): Promise<void>
  fill(selector: string, value: string, options?: { timeout?: number }): Promise<void>
  press(selector: string, key: string, options?: { timeout?: number }): Promise<void>
  screenshot(options?: { fullPage?: boolean; path?: string }): Promise<Buffer>
  evaluate(expression: string): Promise<unknown>
  isClosed(): boolean
  close(): Promise<void>
}

/** Snapshot of the attachment state. */
export interface SessionStatus {
  connected: boolean
  cdpUrl: string
  version?: string
}

/** Everything the tools are allowed to require from a session. */
export interface BrowserSession {
  /** Endpoint currently configured. */
  readonly cdpUrl: string
  /** Attach if needed and return a usable page. */
  ensurePage(): Promise<PageLike>
  /** Report attachment state without connecting. */
  status(): SessionStatus
  /** Disconnect from the remote browser (never kills it). */
  close(): Promise<{ closed: boolean }>
  /** Idempotent teardown used by the plugin disposer. */
  dispose(): Promise<void>
}

/** Connect options accepted by {@link CdpSession}. */
export interface CdpSessionOptions {
  cdpUrl: string
  connectTimeoutMs: number
}

/** Attaches to a CDP endpoint on demand and reuses the connection. */
export class CdpSession implements BrowserSession {
  readonly cdpUrl: string
  readonly #connectTimeoutMs: number
  #browser?: Browser
  #connecting?: Promise<Browser>
  #page?: Page
  #context?: BrowserContext

  constructor(options: CdpSessionOptions) {
    this.cdpUrl = options.cdpUrl
    this.#connectTimeoutMs = options.connectTimeoutMs
  }

  status(): SessionStatus {
    const connected = this.#browser?.isConnected() ?? false
    if (!connected) return { connected, cdpUrl: this.cdpUrl }
    return { connected, cdpUrl: this.cdpUrl, version: this.#browser?.version() }
  }

  async ensurePage(): Promise<PageLike> {
    const browser = await this.#attach()
    const existing = this.#page
    if (existing !== undefined && !existing.isClosed()) return existing
    const context = this.#context ?? browser.contexts()[0] ?? (await browser.newContext())
    this.#context = context
    const page = context.pages()[0] ?? (await context.newPage())
    this.#page = page
    return page
  }

  async close(): Promise<{ closed: boolean }> {
    const browser = this.#browser
    this.#browser = undefined
    this.#connecting = undefined
    this.#page = undefined
    this.#context = undefined
    if (browser === undefined || !browser.isConnected()) return { closed: false }
    // For a CDP attachment `close()` disconnects this client; the remote
    // browser keeps running (verified against the live endpoint).
    await browser.close()
    return { closed: true }
  }

  async dispose(): Promise<void> {
    try {
      await this.close()
    } catch {
      // Teardown must not mask the failure that triggered it.
    }
  }

  /** Reuse a live connection, share an in-flight one, or start a new one. */
  async #attach(): Promise<Browser> {
    const current = this.#browser
    if (current !== undefined && current.isConnected()) return current
    if (this.#connecting !== undefined) return this.#connecting
    const connecting = chromium.connectOverCDP(this.cdpUrl, { timeout: this.#connectTimeoutMs })
    this.#connecting = connecting
    try {
      const browser = await connecting
      this.#browser = browser
      return browser
    } finally {
      this.#connecting = undefined
    }
  }
}
