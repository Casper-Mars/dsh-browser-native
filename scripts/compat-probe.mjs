/**
 * 运行时兼容探针：在**真的装上本包**的 dsh profile 上冷启动一次，断言
 * 8 个 browser tool 已注册。`dsh --dump-config` 只证明 patch 能组合，
 * 不证明插件 `apply()` 能跑通；服务契约或模块解析变更会在冷启动时暴露。
 *
 * 用法（由 dsh-compat.sh 调用，必须从 dsh 安装目录运行，裸导入才能解析）：
 *
 *   DSH_HOME=<临时目录> PROBE_PROFILE=compat node compat-probe.mjs
 *
 * 退出码：全 PASS 为 0，任一断言失败为 1，启动失败 / 超时为 1。
 *
 * 本文件同时可被静态检查导入，因此顶层不得有副作用：只有直接执行时才跑探针主体。
 */
import process from 'node:process'
import { pathToFileURL } from 'node:url'

/** 期望由本包注册的工具（与 src/tools.ts 的 BROWSER_TOOL_NAMES 一致）。 */
export const EXPECTED_TOOLS = [
  'browser_navigate',
  'browser_snapshot',
  'browser_click',
  'browser_type',
  'browser_screenshot',
  'browser_evaluate',
  'browser_viewport',
  'browser_close',
]

const DEFAULT_TIMEOUT_MS = 90_000

async function main() {
  const profile = process.env.PROBE_PROFILE ?? 'ci'
  const timeoutMs = Number(process.env.PROBE_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS)
  const failures = []

  const pass = (message) => console.log(`PASS ${message}`)
  const fail = (message) => {
    failures.push(message)
    console.log(`FAIL ${message}`)
  }

  // dsh 对插件加载失败是「记录错误 + 继续启动」，不会让 runProfile 抛错。
  // 只断言 skills / preset / tool 会漏掉「某个插件 never started」这种半启动状态，
  // 所以这里同时捕获启动期的插件加载错误，作为额外的硬闸门。
  const startupErrors = []
  const startupErrorPatterns = [
    /never started/i,
    /ERR_PACKAGE_PATH_NOT_EXPORTED/,
    /Cannot find package/i,
    /does not provide an export/i,
  ]
  const originalError = console.error
  const originalWarn = console.warn
  const captureStartupError = (...args) => {
    const line = args.map((arg) => (typeof arg === 'string' ? arg : String(arg))).join(' ')
    if (startupErrorPatterns.some((pattern) => pattern.test(line))) startupErrors.push(line)
  }
  console.error = (...args) => {
    captureStartupError(...args)
    originalError(...args)
  }
  console.warn = (...args) => {
    captureStartupError(...args)
    originalWarn(...args)
  }

  const timer = setTimeout(() => {
    console.error(`FAIL 冷启动超时（${timeoutMs}ms）：profile "${profile}" 未在限定时间内完成挂载`)
    process.exit(1)
  }, timeoutMs)

  const { runProfile } = await import('@deepseek-ai/dsh/lib/profile-boot.js')
  const environment = new Map(Object.entries(process.env).map(([key, value]) => [key, { value }]))

  let ctx
  let shutdown
  try {
    ;({ ctx, shutdown } = await runProfile({ environment, profile, patchFiles: [], args: [] }))
  } catch (error) {
    clearTimeout(timer)
    console.error = originalError
    console.warn = originalWarn
    const detail = error instanceof Error ? (error.stack ?? error.message) : String(error)
    console.error(`FAIL profile "${profile}" 冷启动失败：${detail}`)
    process.exit(1)
  }

  console.error = originalError
  console.warn = originalWarn

  try {
    if (startupErrors.length > 0) {
      fail(`启动期有 ${startupErrors.length} 条插件加载错误：${startupErrors[0].slice(0, 240)}`)
    } else {
      pass('启动期无插件加载错误')
    }

    const tools = ctx.get('tools')
    if (tools === undefined || typeof tools.definitions !== 'function') {
      fail('ctx.tools 缺失或缺少 definitions()：dsh-tools 服务契约可能已变更')
    } else {
      const names = new Set(tools.definitions().map((tool) => tool.name))
      const missing = EXPECTED_TOOLS.filter((name) => !names.has(name))
      if (missing.length === 0) {
        pass(`8 个 browser tool 已注册：${EXPECTED_TOOLS.join(', ')}`)
      } else {
        fail(`缺少已注册工具：${missing.join(', ')}`)
      }
    }
  } catch (error) {
    const detail = error instanceof Error ? (error.stack ?? error.message) : String(error)
    fail(`探针断言抛错：${detail}`)
  } finally {
    clearTimeout(timer)
    try {
      await shutdown?.shutdown(failures.length === 0 ? 0 : 1)
    } catch {
      // 关停失败不覆盖断言结论
    }
  }

  if (failures.length > 0) {
    console.error(`\n兼容探针失败：${failures.length} 项断言未通过`)
    process.exit(1)
  }
  console.log('\n运行时探针全部通过')
  process.exit(0)
}

const entry = process.argv[1]
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  await main()
}
