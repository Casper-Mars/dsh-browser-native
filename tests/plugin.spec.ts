import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { afterEach, describe, expect, it } from 'vitest'

import { Config, BROWSER_TOOL_NAMES, apply, inject, name } from '../src/index.js'

const ORIGINAL_ENV = process.env.DSH_BROWSER_CDP_URL

afterEach(() => {
  if (ORIGINAL_ENV === undefined) delete process.env.DSH_BROWSER_CDP_URL
  else process.env.DSH_BROWSER_CDP_URL = ORIGINAL_ENV
})

/** Minimal cordis context capturing registrations and disposers. */
function fakeContext(): {
  ctx: { tools: { register(definition: ToolDefinition): () => void }; effect(execute: () => () => unknown): void }
  registered: ToolDefinition[]
  runDisposers: () => Promise<void>
} {
  const registered: ToolDefinition[] = []
  const disposers: (() => unknown)[] = []
  return {
    registered,
    ctx: {
      tools: {
        register(definition: ToolDefinition): () => void {
          registered.push(definition)
          return () => undefined
        },
      },
      effect(execute: () => () => unknown): void {
        disposers.push(execute())
      },
    },
    async runDisposers() {
      for (const disposer of disposers) await disposer()
    },
  }
}

describe('plugin shape', () => {
  it('declares the bundle id and the tools injection', () => {
    expect(name).toBe('dsh-browser-native')
    expect(inject).toEqual(['tools'])
  })

  it('exposes a config schema with the documented defaults', () => {
    const parsed = Config({}) as { cdpUrl: string; headless: boolean }
    expect(parsed.cdpUrl).toBe('http://127.0.0.1:9222')
    expect(parsed.headless).toBe(false)
  })
})

describe('apply', () => {
  it('registers all seven browser tools on ctx.tools', () => {
    const { ctx, registered } = fakeContext()
    apply(ctx, { cdpUrl: 'ws://host.docker.internal:3000/?token=test-token' })
    expect(registered.map((tool) => tool.name)).toEqual([...BROWSER_TOOL_NAMES])
    for (const tool of registered) expect(typeof tool.output.render).toBe('function')
  })

  it('lets DSH_BROWSER_CDP_URL win over the config block', async () => {
    process.env.DSH_BROWSER_CDP_URL = 'ws://127.0.0.1:4000/?token=env'
    const { ctx, registered } = fakeContext()
    apply(ctx, { cdpUrl: 'ws://127.0.0.1:3000/?token=config' })
    const closeTool = registered.find((tool) => tool.name === 'browser_close')
    const result = await closeTool?.execute({}, {} as never)
    expect(result).toEqual({ closed: false, cdpUrl: 'ws://127.0.0.1:4000/?token=env' })
  })

  it('disposes the session through ctx.effect', async () => {
    const { ctx, registered, runDisposers } = fakeContext()
    apply(ctx, {})
    expect(registered).toHaveLength(BROWSER_TOOL_NAMES.length)
    await expect(runDisposers()).resolves.toBeUndefined()
  })
})
