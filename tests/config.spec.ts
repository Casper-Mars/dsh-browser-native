import { describe, expect, it } from 'vitest'

import {
  DEFAULT_CDP_URL,
  DEFAULT_CONNECT_TIMEOUT_MS,
  DEFAULT_ACTION_TIMEOUT_MS,
  normalizeCdpUrl,
  resolveConfig,
} from '../src/config.js'

const EMPTY_ENV: NodeJS.ProcessEnv = {}

describe('normalizeCdpUrl', () => {
  it('keeps a ws endpoint with a query token intact', () => {
    const url = 'ws://host.docker.internal:3000/?token=test-token'
    expect(normalizeCdpUrl(url)).toBe(url)
  })

  it('trims surrounding whitespace', () => {
    expect(normalizeCdpUrl('  http://127.0.0.1:9222  ')).toBe('http://127.0.0.1:9222')
  })

  it('rejects empty input', () => {
    expect(() => normalizeCdpUrl('   ')).toThrow(/must not be empty/)
  })

  it('rejects unparseable input', () => {
    expect(() => normalizeCdpUrl('not a url')).toThrow(/not a valid URL/)
  })

  it('rejects unsupported protocols', () => {
    expect(() => normalizeCdpUrl('ftp://127.0.0.1:9222')).toThrow(/unsupported protocol/)
  })
})

describe('resolveConfig', () => {
  it('falls back to the documented defaults', () => {
    expect(resolveConfig({}, EMPTY_ENV)).toEqual({
      cdpUrl: DEFAULT_CDP_URL,
      headless: false,
      connectTimeoutMs: DEFAULT_CONNECT_TIMEOUT_MS,
      actionTimeoutMs: DEFAULT_ACTION_TIMEOUT_MS,
      screenshotDir: '',
    })
  })

  it('uses the config block when the environment is silent', () => {
    const resolved = resolveConfig(
      {
        cdpUrl: 'ws://127.0.0.1:3000/?token=from-config',
        headless: true,
        connectTimeoutMs: 1234,
        actionTimeoutMs: 4321,
        screenshotDir: '/tmp/shots',
      },
      EMPTY_ENV,
    )
    expect(resolved).toEqual({
      cdpUrl: 'ws://127.0.0.1:3000/?token=from-config',
      headless: true,
      connectTimeoutMs: 1234,
      actionTimeoutMs: 4321,
      screenshotDir: '/tmp/shots',
    })
  })

  it('gives DSH_BROWSER_CDP_URL priority over the config block', () => {
    const resolved = resolveConfig(
      { cdpUrl: 'http://127.0.0.1:9222' },
      { DSH_BROWSER_CDP_URL: 'ws://host.docker.internal:3000/?token=from-env' },
    )
    expect(resolved.cdpUrl).toBe('ws://host.docker.internal:3000/?token=from-env')
  })

  it('treats a blank DSH_BROWSER_CDP_URL as unset', () => {
    const resolved = resolveConfig({ cdpUrl: 'http://127.0.0.1:9333' }, { DSH_BROWSER_CDP_URL: '   ' })
    expect(resolved.cdpUrl).toBe('http://127.0.0.1:9333')
  })

  it('defaults headless to false and keeps an explicit false', () => {
    expect(resolveConfig({}, EMPTY_ENV).headless).toBe(false)
    expect(resolveConfig({ headless: false }, EMPTY_ENV).headless).toBe(false)
  })

  it('rejects non-positive timeouts', () => {
    expect(() => resolveConfig({ connectTimeoutMs: 0 }, EMPTY_ENV)).toThrow(/connectTimeoutMs must be a positive/)
    expect(() => resolveConfig({ actionTimeoutMs: -5 }, EMPTY_ENV)).toThrow(/actionTimeoutMs must be a positive/)
    expect(() => resolveConfig({ actionTimeoutMs: Number.POSITIVE_INFINITY }, EMPTY_ENV)).toThrow(
      /actionTimeoutMs must be a positive/,
    )
  })

  it('rejects an invalid endpoint from the environment before the config fallback applies', () => {
    expect(() => resolveConfig({}, { DSH_BROWSER_CDP_URL: 'nope' })).toThrow(/not a valid URL/)
  })
})
