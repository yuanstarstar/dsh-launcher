#!/usr/bin/env node
// Host 端离线断言：插件元信息、30 个 Agent 工具、系统提示词、HTTP API 路由与错误映射。
// 不依赖真实网络：游戏库为空，只测试框架行为（提供者测试见 provider-test.mjs）。
import path from 'node:path'
import fsp from 'node:fs/promises'
import { EventEmitter } from 'node:events'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
// 测试隔离：桥接指针写进 test/tmp，不覆盖真实宿主正在使用的指针文件。
process.env.DSH_LAUNCHER_BRIDGE_DIR = path.join(ROOT, 'test', 'tmp', 'http-test-bridge')
const DATA_ROOT = path.join(ROOT, 'test', 'tmp', 'http-test-data')
await fsp.rm(DATA_ROOT, { recursive: true, force: true }).catch(() => {})

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
async function checkAsync(name, fn) {
  try {
    await fn()
    pass += 1
  } catch (error) {
    fail += 1
    failures.push(name + '：' + String((error && error.message) || error))
  }
}
function assert(condition, message) {
  if (!condition) throw new Error(message)
}
function assertEqual(actual, expected, message) {
  const a = JSON.stringify(actual)
  const b = JSON.stringify(expected)
  if (a !== b) throw new Error((message || '值不相等') + '：实际 ' + a + '，期望 ' + b)
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// ---------- 假宿主 ----------
function makeHost() {
  const state = {
    tools: new Map(),
    routes: [],
    promptSections: [],
    warns: [],
    effects: [],
    injected: new Set(['webServer']),
  }
  const services = {
    tools: {
      register(definition) {
        state.tools.set(definition.name, definition)
        return () => state.tools.delete(definition.name)
      },
    },
    webServer: {
      register(route) {
        state.routes.push(route)
        return () => {
          const index = state.routes.indexOf(route)
          if (index >= 0) state.routes.splice(index, 1)
        }
      },
      getOrigin: () => 'http://127.0.0.1:0',
    },
    systemPrompt: {
      section(definition) {
        state.promptSections.push(definition)
      },
    },
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
      for (const name of list) state.injected.add(name)
      return callback(ctx)
    },
  }
  for (const key of Object.keys(services)) {
    Object.defineProperty(ctx, key, {
      configurable: true,
      get() {
        if (!state.injected.has(key)) throw new Error('cannot get property "' + key + '" without inject')
        return services[key]
      },
    })
  }
  state.ctx = ctx
  state.getRoute = () => state.routes.find((route) => route.path === '/dsh-launcher/api')
  return state
}

class FakeRequest extends EventEmitter {
  constructor(method, url, body) {
    super()
    this.method = method
    this.url = url
    this.headers = {}
    this.body = body
  }
  start() {
    if (this.body !== undefined) {
      const text = typeof this.body === 'string' ? this.body : JSON.stringify(this.body)
      this.emit('data', Buffer.from(text, 'utf8'))
    }
    this.emit('end')
  }
}
function makeResponse() {
  return {
    statusCode: 0,
    headers: null,
    body: '',
    writeHead(code, headers) {
      this.statusCode = code
      this.headers = headers || null
    },
    end(chunk) {
      if (chunk !== undefined && chunk !== null) this.body += String(chunk)
    },
  }
}
async function callApi(host, method, url, body) {
  const route = host.getRoute()
  assert(route, '路由未注册')
  const req = new FakeRequest(method, url, body)
  const res = makeResponse()
  const promise = route.handler(req, res)
  req.start()
  await promise
  let json = null
  try {
    json = JSON.parse(res.body)
  } catch {
    json = null
  }
  return { status: res.statusCode, json, raw: res.body }
}

// ---------- 加载插件 ----------
const host = makeHost()
const mod = await import(pathToFileURL(path.join(ROOT, 'index.js')).href)
mod.apply(host.ctx, { dataRoot: DATA_ROOT, downloadConcurrency: 4, retries: 1 })
await sleep(1200)

// ---------- 元信息 ----------
check('插件名', () => assertEqual(mod.name, '@local/dsh-launcher'))
check('声明 webServer 注入', () => assert(mod.inject.includes('webServer')))
check('零注册失败警告', () => {
  const bad = host.warns.filter((line) => /注册失败|初始化失败|without inject/.test(line))
  assert(!bad.length, bad.join(' | '))
})
check('1 个 prefix 路由', () => {
  assertEqual(host.routes.length, 1)
  assertEqual(host.routes[0].kind, 'prefix')
  assertEqual(host.routes[0].path, '/dsh-launcher/api')
})
check('1 个系统提示词段 order=61', () => {
  assertEqual(host.promptSections.length, 1)
  assertEqual(host.promptSections[0].order, 61)
  assert(host.promptSections[0].text.length > 100, '提示词过短')
})
check('30 个 launcher_* 工具', () => {
  const names = [...host.tools.keys()]
  assertEqual(names.length, 30)
  const expected = [
    'launcher_status',
    'launcher_list_games',
    'launcher_add_game',
    'launcher_remove_game',
    'launcher_list_sublaunchers',
    'launcher_install_sublauncher',
    'launcher_update_sublauncher',
    'launcher_remove_sublauncher',
    'launcher_list_catalog',
    'launcher_list_versions',
    'launcher_list_loaders',
    'launcher_search_content',
    'launcher_content_versions',
    'launcher_list_runtimes',
    'launcher_install_game',
    'launcher_list_instances',
    'launcher_get_instance',
    'launcher_launch_game',
    'launcher_stop_game',
    'launcher_instance_log',
    'launcher_list_jobs',
    'launcher_job_status',
    'launcher_cancel_job',
    'launcher_add_content',
    'launcher_remove_content',
    'launcher_open_folder',
    'launcher_rename_instance',
    'launcher_set_config',
    'launcher_verify_instance',
    'launcher_delete_instance',
  ]
  for (const name of expected) assert(host.tools.has(name), '缺少工具 ' + name)
})
check('工具定义结构完整', () => {
  for (const [name, definition] of host.tools) {
    assert(typeof definition.description === 'string' && definition.description.length > 4, name + ' 描述缺失')
    assert(definition.parameters && definition.parameters.type === 'object', name + ' parameters 缺失')
    assert(definition.output && definition.output.schema && typeof definition.output.render === 'function', name + ' output 缺失')
    assert(typeof definition.execute === 'function', name + ' execute 缺失')
  }
})

// ---------- HTTP API ----------
await checkAsync('GET /state', async () => {
  const { status, json } = await callApi(host, 'GET', '/dsh-launcher/api/state')
  assertEqual(status, 200)
  assert(json.ok === true, 'ok 不为 true')
  assert(json.data.config, '缺 config')
  assert(Array.isArray(json.data.games), 'games 不是数组')
  assert(Array.isArray(json.data.instances), 'instances 不是数组')
  assert(Array.isArray(json.data.running), 'running 不是数组')
  assert(Array.isArray(json.data.jobs), 'jobs 不是数组')
})
await checkAsync('GET /games（空）', async () => {
  const { status, json } = await callApi(host, 'GET', '/dsh-launcher/api/games')
  assertEqual(status, 200)
  assertEqual(json.data.games, [])
})
await checkAsync('GET /instances（空）', async () => {
  const { status, json } = await callApi(host, 'GET', '/dsh-launcher/api/instances')
  assertEqual(status, 200)
  assertEqual(json.data.instances, [])
})
await checkAsync('GET /catalog（空目录）', async () => {
  const { status, json } = await callApi(host, 'GET', '/dsh-launcher/api/catalog')
  assertEqual(status, 200)
  assert(Array.isArray(json.data.entries), 'entries 不是数组')
  assertEqual(json.data.entries, [])
})
await checkAsync('GET /sublaunchers（空）', async () => {
  const { status, json } = await callApi(host, 'GET', '/dsh-launcher/api/sublaunchers')
  assertEqual(status, 200)
  assert(Array.isArray(json.data.launchers), 'launchers 不是数组')
  assertEqual(json.data.launchers, [])
})
await checkAsync('POST /sublaunchers/install 缺来源 → 400', async () => {
  const { status, json } = await callApi(host, 'POST', '/dsh-launcher/api/sublaunchers/install', {})
  assertEqual(status, 400)
  assert(json.ok === false, 'ok 不为 false')
  assert(json.error && json.error.length > 2, '错误信息缺失')
})
await checkAsync('POST /sublaunchers/nope/check → 404', async () => {
  const { status, json } = await callApi(host, 'POST', '/dsh-launcher/api/sublaunchers/nope/check')
  assertEqual(status, 404)
  assertEqual(json.ok, false)
})
await checkAsync('DELETE /sublaunchers/nope → 404', async () => {
  const { status } = await callApi(host, 'DELETE', '/dsh-launcher/api/sublaunchers/nope')
  assertEqual(status, 404)
})
await checkAsync('GET /instances/nope → 404', async () => {
  const { status, json } = await callApi(host, 'GET', '/dsh-launcher/api/instances/nope')
  assertEqual(status, 404)
  assertEqual(json.ok, false)
  assert(/不存在/.test(json.error), '错误信息：' + json.error)
})
await checkAsync('GET /versions 缺 game → 400', async () => {
  const { status, json } = await callApi(host, 'GET', '/dsh-launcher/api/versions')
  assertEqual(status, 400)
  assert(/缺少游戏 id/.test(json.error), '错误信息：' + json.error)
})
await checkAsync('GET /loaders 缺参数 → 400', async () => {
  const { status, json } = await callApi(host, 'GET', '/dsh-launcher/api/loaders?game=x')
  assertEqual(status, 400)
})
await checkAsync('GET /content/search 缺 game → 400', async () => {
  const { status } = await callApi(host, 'GET', '/dsh-launcher/api/content/search?query=a')
  assertEqual(status, 400)
})
await checkAsync('GET /runtimes 缺 game → 400', async () => {
  const { status } = await callApi(host, 'GET', '/dsh-launcher/api/runtimes')
  assertEqual(status, 400)
})
await checkAsync('POST /install 缺版本 → 400', async () => {
  const { status, json } = await callApi(host, 'POST', '/dsh-launcher/api/install', { game: 'x' })
  assertEqual(status, 400)
  assert(/缺少版本号|还没有添加游戏/.test(json.error), '错误信息：' + json.error)
})
await checkAsync('POST /games 非法提供者 → 400', async () => {
  const { status, json } = await callApi(host, 'POST', '/dsh-launcher/api/games', { provider: 'nope', config: {} })
  assertEqual(status, 400)
  assert(json.ok === false)
  assert(json.error && json.error.length > 2, '错误信息缺失')
})
await checkAsync('POST /games/test 非法提供者 → 400', async () => {
  const { status } = await callApi(host, 'POST', '/dsh-launcher/api/games/test', { provider: 'nope', config: {} })
  assertEqual(status, 400)
})
await checkAsync('PATCH /config 保存并发', async () => {
  const { status, json } = await callApi(host, 'PATCH', '/dsh-launcher/api/config', { downloadConcurrency: 8, retries: 2 })
  assertEqual(status, 200)
  assertEqual(json.data.downloadConcurrency, 8)
  assertEqual(json.data.retries, 2)
})
await checkAsync('PATCH /config 非法值 → 400', async () => {
  const { status } = await callApi(host, 'PATCH', '/dsh-launcher/api/config', { downloadConcurrency: 999 })
  assertEqual(status, 400)
})
await checkAsync('GET /jobs（空）', async () => {
  const { status, json } = await callApi(host, 'GET', '/dsh-launcher/api/jobs')
  assertEqual(status, 200)
  assertEqual(json.data.jobs, [])
})
await checkAsync('GET /jobs/nope → 404', async () => {
  const { status } = await callApi(host, 'GET', '/dsh-launcher/api/jobs/nope')
  assertEqual(status, 404)
})
await checkAsync('未知路由 → 404', async () => {
  const { status, json } = await callApi(host, 'GET', '/dsh-launcher/api/nope')
  assertEqual(status, 404)
  assertEqual(json.ok, false)
})
await checkAsync('POST body 非 JSON → 400', async () => {
  const { status } = await callApi(host, 'POST', '/dsh-launcher/api/games', 'not-json')
  assertEqual(status, 400)
})

// ---------- 工具执行 ----------
await checkAsync('launcher_status 可执行且输出可渲染', async () => {
  const tool = host.tools.get('launcher_status')
  const result = await tool.execute({})
  assert(result && typeof result === 'object', '返回值不是对象')
  assert(result.config, '缺 config')
  const rendered = tool.output.render({}, result)
  assert(Array.isArray(rendered) && rendered.length === 1, 'render 输出异常')
  assert(rendered[0].type === 'text', 'render 类型异常')
  assert(JSON.parse(rendered[0].text), 'render 内容不是合法 JSON')
})
await checkAsync('launcher_list_games 空列表', async () => {
  const result = await host.tools.get('launcher_list_games').execute({})
  assertEqual(result.games, [])
})
await checkAsync('launcher_add_game 非法提供者抛中文错误', async () => {
  let message = ''
  try {
    await host.tools.get('launcher_add_game').execute({ provider: 'nope', config: {} })
  } catch (error) {
    message = String((error && error.message) || error)
  }
  assert(message.length > 0, '未抛错')
})
await checkAsync('launcher_delete_instance 需要 confirm 确认', async () => {
  let message = ''
  try {
    await host.tools.get('launcher_delete_instance').execute({ instance: 'x' })
  } catch (error) {
    message = String((error && error.message) || error)
  }
  assert(/confirm/.test(message), '错误信息：' + message)
})
await checkAsync('launcher_list_sublaunchers 空列表', async () => {
  const result = await host.tools.get('launcher_list_sublaunchers').execute({})
  assert(Array.isArray(result.launchers), 'launchers 不是数组')
  assertEqual(result.launchers, [])
})
await checkAsync('launcher_remove_sublauncher 需要 confirm 确认', async () => {
  let message = ''
  try {
    await host.tools.get('launcher_remove_sublauncher').execute({ launcher: 'x' })
  } catch (error) {
    message = String((error && error.message) || error)
  }
  assert(/confirm/.test(message), '错误信息：' + message)
})
await checkAsync('launcher_list_catalog 可执行且 entries 为数组', async () => {
  const result = await host.tools.get('launcher_list_catalog').execute({})
  assert(Array.isArray(result.entries), 'entries 不是数组')
  assertEqual(result.entries, [])
})
await checkAsync('launcher_set_config 生效', async () => {
  const result = await host.tools.get('launcher_set_config').execute({ downloadConcurrency: 12, retries: 1 })
  assertEqual(result.downloadConcurrency, 12)
})

// ---------- 卸载 ----------
await checkAsync('清理后路由/工具注销', async () => {
  for (const effect of host.effects.reverse()) {
    if (typeof effect.dispose === 'function') effect.dispose()
  }
  await sleep(50)
  assertEqual(host.routes.length, 0)
  assertEqual(host.tools.size, 0)
})

console.log(`http-test：${pass} PASS / ${fail} FAIL`)
if (fail) {
  for (const item of failures) console.error('  - ' + item)
  process.exitCode = 1
}
