/**
 * 注册表契约测试（纯 Node，无网络/无宿主）。
 * 用法：node scripts/registry-test.mjs
 * 退出码 0 = 全部 PASS。
 */
import {
  validateAdapter,
  registerGame,
  unregisterGame,
  hasGame,
  getGame,
  getGameInfo,
  listGames,
  gamesCount,
  installGlobalRegistry,
} from '../lib/core/registry.js'

let pass = 0
let fail = 0
const failures = []

function check(name, fn) {
  try {
    const result = fn()
    if (result === false) throw new Error('返回 false')
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
    return
  }
  throw new Error('期望抛错但没有抛出')
}

const okAdapter = () => ({
  id: 'demo-game',
  label: '演示游戏',
  versionLabel: '版本',
  async listVersions() {
    return { versions: [{ id: '1.0.0' }] }
  },
  async install() {
    return { versionId: '1.0.0' }
  },
  async launch() {
    return { executable: 'C:/demo.exe' }
  },
})

check('validateAdapter 接受合法适配器', () => {
  const adapter = okAdapter()
  if (validateAdapter(adapter) !== adapter) throw new Error('返回值不是原对象')
})

check('validateAdapter 拒绝空对象', () => expectThrow(() => validateAdapter(null), /无效/))
check('validateAdapter 拒绝非法 id', () => expectThrow(() => validateAdapter({ ...okAdapter(), id: 'Bad Id' }), /id 无效/))
check('validateAdapter 拒绝缺 label', () => expectThrow(() => validateAdapter({ ...okAdapter(), label: '' }), /缺少 label/))
check('validateAdapter 拒绝缺 versionLabel', () => expectThrow(() => validateAdapter({ ...okAdapter(), versionLabel: '' }), /缺少 versionLabel/))
check('validateAdapter 拒绝缺 listVersions', () => expectThrow(() => validateAdapter({ ...okAdapter(), listVersions: null }), /缺少 listVersions/))
check('validateAdapter 拒绝缺 install', () => expectThrow(() => validateAdapter({ ...okAdapter(), install: null }), /缺少 install/))
check('validateAdapter 拒绝缺 launch', () => expectThrow(() => validateAdapter({ ...okAdapter(), launch: null }), /缺少 launch/))

check('registerGame 注册后可查询', () => {
  const adapter = okAdapter()
  const dispose = registerGame(adapter, 'user')
  if (!hasGame('demo-game')) throw new Error('hasGame 为 false')
  if (getGame('demo-game') !== adapter) throw new Error('getGame 返回不同对象')
  const info = getGameInfo('demo-game')
  if (info.source !== 'user') throw new Error('source 不是 user：' + info.source)
  if (gamesCount() !== 1) throw new Error('gamesCount 不等于 1')
  dispose()
  if (hasGame('demo-game')) throw new Error('dispose 后仍存在')
})

check('registerGame 重复注册抛错', () => {
  const dispose = registerGame(okAdapter())
  try {
    expectThrow(() => registerGame(okAdapter()), /已注册/)
  } finally {
    dispose()
  }
})

check('getGame 未知 id 抛错并提示可用列表', () => {
  const dispose = registerGame(okAdapter())
  try {
    expectThrow(() => getGame('nope'), /不支持的游戏：nope（可用：demo-game）/)
  } finally {
    dispose()
  }
})

check('getGame 未知 id 且无游戏时提示先添加', () => {
  expectThrow(() => getGame('nope'), /还没有添加任何游戏/)
})

check('unregisterGame 返回布尔并移除', () => {
  const dispose = registerGame(okAdapter())
  if (unregisterGame('demo-game') !== true) throw new Error('第一次注销应为 true')
  if (unregisterGame('demo-game') !== false) throw new Error('第二次注销应为 false')
  dispose()
})

check('listGames 返回统一摘要', () => {
  const adapter = okAdapter()
  adapter.capabilities = { content: true, loaders: false, runtimes: true }
  adapter.instanceOptions = [{ key: 'mode', label: '模式', type: 'select', options: ['a', 'b'] }]
  const dispose = registerGame(adapter, 'external')
  try {
    const games = listGames()
    if (games.length !== 1) throw new Error('长度不是 1')
    const game = games[0]
    if (game.id !== 'demo-game' || game.label !== '演示游戏' || game.versionLabel !== '版本') throw new Error('基础字段错误')
    if (game.contentLabel !== '内容') throw new Error('contentLabel 默认值错误')
    if (!game.capabilities.content || game.capabilities.loaders || !game.capabilities.runtimes) throw new Error('capabilities 归一化错误')
    if (!Array.isArray(game.instanceOptions) || game.instanceOptions.length !== 1) throw new Error('instanceOptions 错误')
    if (game.source !== 'external') throw new Error('source 错误：' + game.source)
  } finally {
    dispose()
  }
})

check('installGlobalRegistry 暴露全局注册表且可清理', () => {
  const dispose = installGlobalRegistry()
  const registry = globalThis.__dshLauncherRegistry
  if (!registry) throw new Error('未设置全局注册表')
  if (typeof registry.registerGame !== 'function') throw new Error('缺 registerGame')
  if (typeof registry.listGames !== 'function') throw new Error('缺 listGames')
  const adapter = okAdapter()
  const unregister = registry.registerGame(adapter, 'external')
  if (!registry.hasGame('demo-game')) throw new Error('全局注册失败')
  unregister()
  dispose()
  if (globalThis.__dshLauncherRegistry) throw new Error('清理后仍存在全局注册表')
})

console.log(`registry-test：${pass} PASS / ${fail} FAIL`)
if (fail) {
  for (const item of failures) console.error('  - ' + item)
  process.exitCode = 1
}
