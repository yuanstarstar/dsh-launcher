#!/usr/bin/env node
// bridge-test.mjs —— 跨插件文件桥接机制的本地集成测试
//
// 验证场景（模拟核心包与适配器包运行在隔离上下文）：
//   1. 核心引擎启动后写出 ~/.dsh-launcher/bridge.json 指针文件；
//   2. 适配器插件在「拿不到 globalThis 注册表、也无法 import 核心包」时，
//      能通过指针文件把自己的桥接模块写进 <dataRoot>/adapters/；
//   3. 核心包轮询目录并在数秒内热加载出游戏（无需重启进程）；
//   4. 删除桥接文件后，核心包在数秒内自动卸载该游戏。
//
// 运行：node scripts/bridge-test.mjs
import fsp from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
// 测试隔离：核心包与适配器都支持 DSH_LAUNCHER_BRIDGE_DIR 覆盖指针目录，
// 避免测试覆盖真实宿主正在使用的 ~/.dsh-launcher/bridge.json。
const TEST_BRIDGE_DIR = path.join(ROOT, 'test', 'tmp', 'bridge-test', 'bridge')
process.env.DSH_LAUNCHER_BRIDGE_DIR = TEST_BRIDGE_DIR
const BRIDGE_POINTER = path.join(TEST_BRIDGE_DIR, 'bridge.json')
const DATA_ROOT = path.join(ROOT, 'test', 'tmp', 'bridge-test', 'data')

const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok: Boolean(ok), detail })
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? ' —— ' + detail : ''))
}
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
async function waitFor(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await predicate()
    if (value) return value
    await sleep(250)
  }
  throw new Error('等待超时：' + label)
}

async function main() {
  await fsp.rm(path.dirname(DATA_ROOT), { recursive: true, force: true })
  await fsp.rm(TEST_BRIDGE_DIR, { recursive: true, force: true }).catch(() => {})

  const { createEngine } = await import(pathToFileURL(path.join(ROOT, 'lib/core/engine.js')).href)
  const engine = createEngine({ config: { dataRoot: DATA_ROOT }, log: () => {} })
  const logs = []
  await engine.init()
  check('核心引擎初始化', true, DATA_ROOT)

  // 1) 指针文件已写出
  const pointer = JSON.parse(await fsp.readFile(BRIDGE_POINTER, 'utf8'))
  check('写出桥接指针文件', pointer.dataRoot === DATA_ROOT, BRIDGE_POINTER)
  check('指针内容含 adapters 目录', pointer.adaptersDir === path.join(DATA_ROOT, 'adapters'), pointer.adaptersDir)

  // 2) 模拟隔离上下文：移除 globalThis 注册表，再加载适配器插件
  delete globalThis.__dshLauncherRegistry
  const adapterModule = await import(pathToFileURL(path.join(ROOT, 'plugins/minecraft-adapter/index.js')).href)
  const disposers = []
  const fakeCtx = {
    logger: {
      info: (...args) => logs.push(['info', args.join(' ')]),
      warn: (...args) => logs.push(['warn', args.join(' ')]),
      error: (...args) => logs.push(['error', args.join(' ')]),
    },
    effect: (fn) => {
      const disposer = fn()
      disposers.push(disposer)
    },
  }
  await adapterModule.apply(fakeCtx, {})
  const bridgeFile = path.join(DATA_ROOT, 'adapters', 'adapter-' + adapterModule.adapter.id + '.mjs')
  const bridgeText = await fsp.readFile(bridgeFile, 'utf8')
  check('适配器写出桥接模块', bridgeText.includes('lib/adapter.js'), bridgeFile)
  check('桥接模块可被核心导入（含 default export）', bridgeText.includes('export default adapter'), '')

  // 3) 核心热加载出游戏
  const games = await waitFor(async () => {
    const list = await engine.listGames()
    const found = list.find((game) => game.id === adapterModule.adapter.id)
    return found ? list : null
  }, 12000, '核心热加载适配器')
  check('核心热加载出游戏', games.length === 1, games.map((game) => game.label).join(','))
  check('游戏来源标记为外部适配器', games[0] && games[0].source === 'external', String(games[0] && games[0].source))

  // 4) 删除桥接文件 → 自动卸载
  await fsp.rm(bridgeFile, { force: true })
  await waitFor(async () => (await engine.listGames()).length === 0, 12000, '核心卸载游戏')
  check('删除桥接文件后自动卸载游戏', (await engine.listGames()).length === 0, '')

  // 5) 卸载适配器插件时应清理桥接文件
  await adapterModule.apply(
    {
      logger: { info() {}, warn() {}, error() {} },
      effect: (fn) => disposers.push(fn()),
    },
    {},
  )
  await waitFor(async () => (await engine.listGames()).length === 1, 12000, '再次加载游戏')
  for (const dispose of disposers) {
    try {
      dispose && dispose()
    } catch {
      /* 忽略 */
    }
  }
  await waitFor(async () => (await engine.listGames()).length === 0, 12000, '插件卸载后清理游戏')
  check('插件卸载清理桥接文件', !(await fsp.readFile(bridgeFile, 'utf8').then(() => true).catch(() => false)), '')

  engine.dispose()
  await fsp.rm(path.dirname(DATA_ROOT), { recursive: true, force: true }).catch(() => {})
  await fsp.rm(TEST_BRIDGE_DIR, { recursive: true, force: true }).catch(() => {})

  const passed = results.filter((item) => item.ok).length
  console.log('\nbridge-test: ' + passed + '/' + results.length + ' PASS')
  if (passed !== results.length) process.exitCode = 1
}

main().catch(async (error) => {
  console.error('bridge-test FAILED: ' + (error && error.stack ? error.stack : error))
  await fsp.rm(path.dirname(DATA_ROOT), { recursive: true, force: true }).catch(() => {})
  await fsp.rm(TEST_BRIDGE_DIR, { recursive: true, force: true }).catch(() => {})
  process.exitCode = 1
})
