/**
 * 严格注入测试（模拟 Cordis 严格访问器）：
 * 未在 inject 声明的服务，访问属性必须抛错；插件必须用 ctx.inject 惰性注册且零注册失败。
 *
 * 用法：node scripts/inject-test.mjs
 * 退出码 0 = 全 PASS。
 */
import path from 'node:path'
import fsp from 'node:fs/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
// 测试隔离：桥接指针写进 test/tmp，不覆盖真实宿主正在使用的指针文件。
process.env.DSH_LAUNCHER_BRIDGE_DIR = path.join(ROOT, 'test', 'tmp', 'inject-test-bridge')

let pass = 0
let fail = 0
const failures = []
function check(name, fn) {
  try {
    fn()
    pass += 1
  } catch (error) {
    fail += 1
    failures.push(name + '：' + String((error && error.message) || error))
  }
}
function expectThrow(fn, pattern) {
  try {
    fn()
  } catch (error) {
    const message = String((error && error.message) || error)
    if (pattern && !pattern.test(message)) throw new Error('错误信息不匹配：' + message)
    return message
  }
  throw new Error('期望抛错但没有抛出')
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** 构造严格 Cordis 上下文 */
function makeStrictCtx() {
  const injected = new Set()
  const state = {
    injected,
    tools: new Map(),
    routes: [],
    promptSections: [],
    effects: [],
    warns: [],
  }

  const makeService = (key) => {
    if (key === 'tools') {
      return {
        register(definition) {
          state.tools.set(definition.name, definition)
          return () => state.tools.delete(definition.name)
        },
      }
    }
    if (key === 'webServer') {
      return {
        register(route) {
          const record = { ...route, disposed: false }
          state.routes.push(record)
          return () => {
            record.disposed = true
          }
        },
        getOrigin: () => 'http://127.0.0.1:0',
      }
    }
    if (key === 'systemPrompt') {
      return {
        section(definition) {
          state.promptSections.push(definition)
        },
      }
    }
    return {}
  }

  const ctx = {
    logger: {
      info: () => {},
      warn: (...args) => state.warns.push(args.map(String).join(' ')),
      error: (...args) => state.warns.push(args.map(String).join(' ')),
      debug: () => {},
    },
    effect(fn, label) {
      const dispose = fn()
      state.effects.push({ label, dispose })
      return () => {
        if (typeof dispose === 'function') dispose()
      }
    },
    inject(names, callback) {
      const list = Array.isArray(names) ? names : [names]
      for (const name of list) injected.add(name)
      return callback(ctx)
    },
  }

  for (const key of ['webServer', 'tools', 'systemPrompt']) {
    Object.defineProperty(ctx, key, {
      configurable: true,
      get() {
        if (!injected.has(key)) throw new Error('cannot get property "' + key + '" without inject')
        return makeService(key)
      },
    })
  }
  state.ctx = ctx
  return state
}

const tmpRoot = path.join(ROOT, 'test', 'tmp', 'inject-test-data')
await fsp.rm(tmpRoot, { recursive: true, force: true }).catch(() => {})

const mod = await import(pathToFileURL(path.join(ROOT, 'index.js')).href)
check('index.js 导出 apply/inject/name', () => {
  if (typeof mod.apply !== 'function') throw new Error('缺少 apply')
  if (!Array.isArray(mod.inject)) throw new Error('缺少 inject 数组')
  if (typeof mod.name !== 'string' || !mod.name) throw new Error('缺少 name')
})

check('声明 webServer 注入', () => {
  if (!mod.inject.includes('webServer')) throw new Error('inject 未声明 webServer：' + JSON.stringify(mod.inject))
})

const state = makeStrictCtx()
for (const key of mod.inject || []) state.injected.add(key)

try {
  mod.apply(state.ctx, { dataRoot: tmpRoot, downloadConcurrency: 2, retries: 0 })
} catch (error) {
  fail += 1
  failures.push('apply 抛错：' + String((error && error.message) || error))
}

await sleep(1500)

check('零注册失败警告', () => {
  const bad = state.warns.filter((line) => /注册失败|初始化失败|without inject/.test(line))
  if (bad.length) throw new Error('出现失败日志：' + bad.join(' | '))
})

check('30 个 launcher_* 工具已注册', () => {
  const names = [...state.tools.keys()]
  const launcherTools = names.filter((name) => name.startsWith('launcher_'))
  if (launcherTools.length !== 30) throw new Error('数量 ' + launcherTools.length + '：' + launcherTools.join(','))
  if (!names.every((name) => name.startsWith('launcher_'))) throw new Error('存在非 launcher_ 前缀工具')
})

check('1 个系统提示词段', () => {
  if (state.promptSections.length !== 1) throw new Error('数量 ' + state.promptSections.length)
  const section = state.promptSections[0]
  if (!section.text || section.order !== 61) throw new Error('字段错误：' + JSON.stringify(section).slice(0, 120))
  if (!/启动器/.test(section.text)) throw new Error('提示词缺少品牌名')
})

check('1 个 prefix 路由', () => {
  if (state.routes.length !== 1) throw new Error('数量 ' + state.routes.length)
  const route = state.routes[0]
  if (route.kind !== 'prefix' || route.path !== '/dsh-launcher/api') throw new Error('路由错误：' + route.kind + ' ' + route.path)
})

check('工具定义含 output.schema/render/execute 与描述/参数', () => {
  for (const [name, definition] of state.tools) {
    if (!definition.output || !definition.output.schema || typeof definition.output.render !== 'function') throw new Error(name + ' 缺 output')
    if (typeof definition.execute !== 'function') throw new Error(name + ' 缺 execute')
    if (!definition.description || !definition.parameters) throw new Error(name + ' 缺描述/参数')
  }
})

check('严格访问器生效（未注入访问必抛错）', () => {
  const strict = makeStrictCtx()
  expectThrow(() => strict.ctx.tools, /cannot get property "tools" without inject/)
  expectThrow(() => strict.ctx.systemPrompt, /cannot get property "systemPrompt" without inject/)
})

console.log(`inject-test：${pass} PASS / ${fail} FAIL（工具 ${state.tools.size}，提示词段 ${state.promptSections.length}，路由 ${state.routes.length}）`)
if (fail) {
  for (const item of failures) console.error('  - ' + item)
  process.exitCode = 1
}
