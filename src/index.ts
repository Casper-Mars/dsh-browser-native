/**
 * dsh-browser-native: a DSH bundle plugin that attaches natively to a
 * query-token WebSocket CDP endpoint and registers fine-grained browser tools.
 *
 * The attach path exists because puppeteer's connected mode discovers
 * `new URL('/json/version', browserURL)`, which drops the query string and
 * cannot use a `ws://` endpoint; playwright-core's `connectOverCDP` takes the
 * WebSocket endpoint (token included) verbatim.
 *
 * MVP scope: attach only. `headless` is accepted and reserved — the plugin
 * never launches a browser of its own.
 *
 * @module dsh-browser-native
 */

import z from '@deepseek-ai/schemastery'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'

import {
  DEFAULT_ACTION_TIMEOUT_MS,
  DEFAULT_CDP_URL,
  DEFAULT_CONNECT_TIMEOUT_MS,
  resolveConfig,
  type BrowserNativeConfig,
} from './config.js'
import { CdpSession } from './session.js'
import { BROWSER_TOOL_NAMES, createBrowserTools } from './tools.js'

/** Cordis plugin name; matches the id used in `cordis.patch.yml`. */
export const name = 'dsh-browser-native'

/** The tools registry is the only service this plugin needs. */
export const inject = ['tools']

/** Config block schema validated by the profile loader. */
export const Config = z.object({
  cdpUrl: z.string().default(DEFAULT_CDP_URL),
  headless: z.boolean().default(false),
  connectTimeoutMs: z.number().default(DEFAULT_CONNECT_TIMEOUT_MS),
  actionTimeoutMs: z.number().default(DEFAULT_ACTION_TIMEOUT_MS),
  screenshotDir: z.string().default(''),
})

/** The slice of a cordis context this plugin uses. */
export interface PluginContext {
  tools: { register(definition: ToolDefinition): () => void }
  effect?(execute: () => () => unknown): void
}

/**
 * Register the browser tools and own the process-wide CDP session.
 * @param ctx - cordis context providing `ctx.tools`.
 * @param config - validated plugin config; `DSH_BROWSER_CDP_URL` still wins.
 */
export function apply(ctx: PluginContext, config: BrowserNativeConfig = {}): void {
  const resolved = resolveConfig(config)
  const session = new CdpSession({
    cdpUrl: resolved.cdpUrl,
    connectTimeoutMs: resolved.connectTimeoutMs,
  })
  const tools = createBrowserTools(session, {
    actionTimeoutMs: resolved.actionTimeoutMs,
    screenshotDir: resolved.screenshotDir,
  })
  for (const tool of tools) ctx.tools.register(tool)
  // Teardown disconnects only; the remote browser belongs to the user.
  ctx.effect?.(() => () => session.dispose())
}

export { BROWSER_TOOL_NAMES, createBrowserTools } from './tools.js'
export { CdpSession } from './session.js'
export { DEFAULT_CDP_URL, resolveConfig, normalizeCdpUrl, type BrowserNativeConfig } from './config.js'
export { buildSnapshot, htmlToText, extractElements } from './html.js'
