#!/usr/bin/env node
// bridge-test.mjs —— 外部适配器「文件桥接 + 热加载」本地集成测试
//
// 验证场景（模拟核心包与外部适配器运行在隔离上下文/不同进程）：
//   1. 核心引擎启动后写出桥接指针文件（指向数据根/adapters 等）；
//   2. 外部适配器把自己的 re-export 桥接模块写进 <dataRoot>/adapters/；
//   3. 核心引擎轮询目录并在数秒内热加载出游戏（无需重启进程）；
//   4. 删除桥接文件后，核心引擎在数秒内自动卸载该游戏；
//   5. 引擎 dispose 后清理指针文件。
//
// 本测试不需要任何具体游戏实现：用演示适配器验证机制本身。
// 运行：node scripts/bridge-test.mjs
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
// 测试隔离：用 DSH_LAUNCHER_BRIDGE_DIR 覆盖指针目录，避免测试覆盖真实宿主正在用的指针。
const TEST_BRIDGE_DIR = path.join(ROOT, 'test', 'tmp', 'bridge-test', 'bridge')
process.env.DSH_LAUNCHER_BRIDGE_DIR = TEST_BRIDGE_DIR
const BRIDGE_POINTER = path.join(TEST_BRIDGE_DIR, 'bridge.json')
const TMP_ROOT = path.join(ROOT, 'test', 'tmp', 'bridge-test')
const DATA_ROOT = path.join(TMP_ROOT, 'data')

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

const ADAPTER_SOURCE = `
const adapter = {
  id: 'demo-bridge',
  label: 'Demo Bridge',
  versionLabel: '版本',
  contentLabel: '内容',
  capabilities: { content: false, loaders: false, runtimes: false },
  instanceOptions: [],
  async listVersions() {
    return { versions: [{ id: '1.0.0' }], latestRelease: '1.0.0' }
  },
  async install() {
    return { versionId: '1.0.0' }
  },
  async launch() {
    return { executable: 'cmd.exe', args: ['/c', 'exit 0'] }
  },
}

export default function createAdapter() {
  return adapter
}
`

let engine = null
try {
  await fsp.rm(TMP_ROOT, { recursive: true, force: true })
  await fsp.mkdir(path.join(TMP_ROOT, 'scripts'), { recursive: true })
  const adapterSourceFile = path.join(TMP_ROOT, 'scripts', 'demo-adapter.mjs')
  await fsp.writeFile(adapterSourceFile, ADAPTER_SOURCE, 'utf8')

  const { createEngine } = await import(pathToFileURL(path.join(ROOT, 'lib/core/engine.js')).href)
  engine = createEngine({ config: { dataRoot: DATA_ROOT, downloadConcurrency: 4, retries: 1 }, log: () => {} })
  await engine.init()

  // 1) 指针文件
  await waitFor(async () => fs.existsSync(BRIDGE_POINTER), 5000, '桥接指针文件写出')
  const pointer = JSON.parse(await fsp.readFile(BRIDGE_POINTER, 'utf8'))
  check('写出桥接指针文件', String(pointer.dataRoot) !== '' && path.resolve(String(pointer.dataRoot)) === path.resolve(DATA_ROOT), String(pointer.dataRoot))
  check('指针含 launcher 字段', pointer.launcher === '@local/dsh-launcher', JSON.stringify(pointer.launcher))
  check('指针版本号为 semver', /^\d+\.\d+\.\d+$/.test(String(pointer.version)), String(pointer.version))
  check('指针含 adapters 目录', path.resolve(String(pointer.adaptersDir)) === path.resolve(path.join(DATA_ROOT, 'adapters')), String(pointer.adaptersDir))
  check('指针含 pid', Number.isInteger(pointer.pid), String(pointer.pid))
  check('启动时没有游戏', engine.listGames().length === 0, String(engine.listGames().length))

  // 2) 外部适配器写桥接文件 → 自动热加载
  const adaptersDir = path.join(DATA_ROOT, 'adapters')
  await fsp.mkdir(adaptersDir, { recursive: true })

  // 2.0) 模拟热重载/多引擎实例遗留的注册：旧引擎注册过同名游戏、但它的 dispose 已经不可达。
  //      新引擎加载磁盘来源时必须「接管」注册，否则删除桥接文件后游戏会一直残留。
  const registryModule = await import(pathToFileURL(path.join(ROOT, 'lib/core/registry.js')).href)
  const staleAdapter = {
    id: 'demo-bridge',
    label: 'Stale Demo',
    versionLabel: '版本',
    async listVersions() {
      return { versions: [], latestRelease: null }
    },
    async install() {
      return {}
    },
    async launch() {
      return null
    },
  }
  const staleDispose = registryModule.registerGame(staleAdapter, 'external')
  check('注入遗留注册（模拟旧引擎实例）', registryModule.hasGame('demo-bridge'))

  const bridgeFile = path.join(adaptersDir, 'sublauncher-demo.mjs')
  const sourceUrl = pathToFileURL(adapterSourceFile).href
  await fsp.writeFile(bridgeFile, `export { default } from '${sourceUrl}';\n`, 'utf8')

  const loadedGame = await waitFor(async () => {
    const games = engine.listGames()
    // 注意：初始时存在遗留注册（Stale Demo），必须等热加载完成、标签被磁盘适配器接管后才算加载成功。
    const game = games.find((item) => item.id === 'demo-bridge')
    return game && game.label === 'Demo Bridge' ? game : null
  }, 15000, '引擎自动热加载外部适配器')
  check('热加载出外部游戏', Boolean(loadedGame && loadedGame.id === 'demo-bridge'), JSON.stringify(loadedGame && loadedGame.id))
  check('热加载来源为 external', loadedGame && loadedGame.source === 'external', loadedGame && loadedGame.source)
  check(
    '接管遗留注册（标签来自磁盘适配器）',
    loadedGame && loadedGame.label === 'Demo Bridge',
    loadedGame && loadedGame.label,
  )
  check('遗留注册的 dispose 不应删除新注册', Boolean(staleDispose) && registryModule.hasGame('demo-bridge'))

  const stateSnapshot = await engine.getState()
  const stateGame = stateSnapshot.games.find((game) => game.id === 'demo-bridge')
  check('/state 的 games 含新游戏', Boolean(stateGame), JSON.stringify(stateGame && stateGame.id))

  const versions = await engine.listVersions({ game: 'demo-bridge' })
  check('可查询新游戏的版本', versions && versions.latestRelease === '1.0.0', JSON.stringify(versions && versions.latestRelease))

  // 3) 删除桥接文件 → 自动卸载
  await fsp.rm(bridgeFile, { force: true })
  await waitFor(async () => engine.listGames().every((game) => game.id !== 'demo-bridge'), 15000, '删除桥接文件后自动卸载')
  check('删除桥接文件后游戏消失', engine.listGames().every((game) => game.id !== 'demo-bridge'))

  // 4) dispose 清理指针
  engine.dispose()
  engine = null
  await sleep(300)
  check('dispose 后指针文件被清理', !fs.existsSync(BRIDGE_POINTER))
} catch (error) {
  check('测试过程无未捕获错误', false, String((error && error.message) || error))
} finally {
  try {
    if (engine) engine.dispose()
  } catch {
    /* ignore */
  }
  try {
    await fsp.rm(TMP_ROOT, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
}

const failed = results.filter((item) => !item.ok)
if (failed.length) {
  console.error(`FAIL bridge-test：${failed.length} 项失败（共 ${results.length} 项）`)
  for (const item of failed) console.error(`  - ${item.name}${item.detail ? '：' + item.detail : ''}`)
  process.exit(1)
}
console.log(`PASS bridge-test：${results.length} 项全部通过（指针写出 / 热加载 / 卸载 / 清理）`)
