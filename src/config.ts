/**
 * Configuration resolution for dsh-browser-native.
 *
 * Precedence (highest first): environment variable `DSH_BROWSER_CDP_URL`,
 * the plugin `config` block written in the profile patch, then the built-in
 * default. Resolution is a pure function so it can be unit tested without a
 * profile or a browser.
 *
 * @module dsh-browser-native/config
 */

/** Default CDP endpoint when nothing is configured. */
export const DEFAULT_CDP_URL = 'http://127.0.0.1:9222'

/** Default budget for establishing the CDP connection. */
export const DEFAULT_CONNECT_TIMEOUT_MS = 20_000

/** Default budget for a single page action (click / type / navigate). */
export const DEFAULT_ACTION_TIMEOUT_MS = 15_000

/** Author-facing plugin config block (all fields optional; defaults apply). */
export interface BrowserNativeConfig {
  /** CDP endpoint: `ws(s)://` (query tokens preserved) or `http(s)://`. */
  cdpUrl?: string
  /** Reserved: only attach is implemented in the MVP, so nothing is launched. */
  headless?: boolean
  /** Budget for `chromium.connectOverCDP`. */
  connectTimeoutMs?: number
  /** Budget for individual page actions. */
  actionTimeoutMs?: number
  /** Directory receiving `browser_screenshot` files; defaults to the process cwd. */
  screenshotDir?: string
}

/** Fully resolved configuration consumed by the session and the tools. */
export interface ResolvedConfig {
  cdpUrl: string
  headless: boolean
  connectTimeoutMs: number
  actionTimeoutMs: number
  screenshotDir: string
}

const SUPPORTED_CDP_PROTOCOLS = new Set(['http:', 'https:', 'ws:', 'wss:'])

/**
 * Validate and canonicalize a CDP endpoint.
 *
 * `ws://` and `wss://` endpoints are passed through untouched so a
 * `?token=...` query survives; `http(s)://` endpoints stay as origin roots and
 * are resolved by playwright-core itself.
 *
 * @param raw - candidate endpoint from config or environment.
 * @returns the trimmed endpoint.
 * @throws when the string is empty or uses an unsupported protocol.
 */
export function normalizeCdpUrl(raw: string): string {
  const trimmed = raw.trim()
  if (trimmed === '') throw new Error('dsh-browser-native: cdpUrl must not be empty')
  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    throw new Error(`dsh-browser-native: cdpUrl "${trimmed}" is not a valid URL`)
  }
  if (!SUPPORTED_CDP_PROTOCOLS.has(parsed.protocol)) {
    throw new Error(
      `dsh-browser-native: cdpUrl "${trimmed}" uses unsupported protocol "${parsed.protocol}" (expected http, https, ws or wss)`,
    )
  }
  return trimmed
}

/**
 * Resolve the effective configuration.
 *
 * `DSH_BROWSER_CDP_URL` wins over `config.cdpUrl`, which wins over
 * {@link DEFAULT_CDP_URL}. A blank environment variable is treated as unset so
 * an exported-but-empty shell variable cannot wipe a working config.
 *
 * @param config - plugin config block, possibly partial.
 * @param env - environment source, defaults to `process.env`.
 * @returns the effective configuration.
 */
export function resolveConfig(
  config: BrowserNativeConfig = {},
  env: NodeJS.ProcessEnv = process.env,
): ResolvedConfig {
  const envUrl = env.DSH_BROWSER_CDP_URL?.trim()
  const configuredUrl = config.cdpUrl?.trim()
  const cdpUrl = normalizeCdpUrl(envUrl || configuredUrl || DEFAULT_CDP_URL)
  return {
    cdpUrl,
    headless: config.headless ?? false,
    connectTimeoutMs: positive(config.connectTimeoutMs, DEFAULT_CONNECT_TIMEOUT_MS, 'connectTimeoutMs'),
    actionTimeoutMs: positive(config.actionTimeoutMs, DEFAULT_ACTION_TIMEOUT_MS, 'actionTimeoutMs'),
    screenshotDir: config.screenshotDir?.trim() ?? '',
  }
}

/** Accept a positive finite number or fall back to the default. */
function positive(value: number | undefined, fallback: number, field: string): number {
  if (value === undefined) return fallback
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`dsh-browser-native: ${field} must be a positive finite number`)
  }
  return value
}
