// DSH启动器 · 通用游戏适配器注册表
// 核心包不含任何具体游戏：适配器由「添加游戏」的提供者、外部适配器包或数据目录中的自定义文件注册。

const games = new Map() // id -> { adapter, source }
const VALID_SOURCE = new Set(['user', 'external', 'builtin'])
const REQUIRED_METHODS = ['listVersions', 'install', 'launch']

function fail(message) {
  throw new Error(message)
}

function normalizeSource(source) {
  return VALID_SOURCE.has(source) ? source : 'external'
}

export function validateAdapter(adapter) {
  if (!adapter || typeof adapter !== 'object') fail('游戏适配器无效：必须是对象')
  const id = adapter.id
  if (typeof id !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(id)) fail('游戏适配器 id 无效：' + String(id))
  if (typeof adapter.label !== 'string' || !adapter.label.trim()) fail('游戏适配器 ' + id + ' 缺少 label')
  if (typeof adapter.versionLabel !== 'string' || !adapter.versionLabel.trim()) fail('游戏适配器 ' + id + ' 缺少 versionLabel')
  for (const key of REQUIRED_METHODS) {
    if (typeof adapter[key] !== 'function') fail('游戏适配器 ' + id + ' 缺少 ' + key + ' 方法')
  }
  return adapter
}

export function registerGame(adapter, source = 'external') {
  validateAdapter(adapter)
  if (games.has(adapter.id)) fail('游戏已注册：' + adapter.id)
  games.set(adapter.id, { adapter, source: normalizeSource(source) })
  return function dispose() {
    const current = games.get(adapter.id)
    if (current && current.adapter === adapter) games.delete(adapter.id)
  }
}

export function unregisterGame(id) {
  return games.delete(id)
}

export function hasGame(id) {
  return games.has(id)
}

export function getGame(id) {
  const entry = games.get(id)
  if (!entry) {
    const available = [...games.keys()]
    fail('不支持的游戏：' + String(id) + (available.length ? '（可用：' + available.join('、') + '）' : '（还没有添加任何游戏，请先添加游戏）'))
  }
  return entry.adapter
}

export function getGameInfo(id) {
  const entry = games.get(id)
  if (!entry) return null
  return { adapter: entry.adapter, source: entry.source }
}

export function setSource(id, source) {
  const entry = games.get(id)
  if (!entry) return false
  entry.source = normalizeSource(source)
  return true
}

export function listGames() {
  return [...games.values()].map(({ adapter, source }) => {
    const capabilities = adapter.capabilities && typeof adapter.capabilities === 'object' ? adapter.capabilities : {}
    return {
      id: adapter.id,
      label: adapter.label,
      versionLabel: adapter.versionLabel,
      contentLabel: adapter.contentLabel || '内容',
      capabilities: {
        content: !!capabilities.content,
        loaders: !!capabilities.loaders,
        runtimes: !!capabilities.runtimes,
      },
      instanceOptions: Array.isArray(adapter.instanceOptions) ? adapter.instanceOptions : [],
      source,
    }
  })
}

export function gamesCount() {
  return games.size
}

// 供数据目录中的自定义适配器文件（无法通过包名 import）使用
export function installGlobalRegistry() {
  globalThis.__dshLauncherRegistry = {
    registerGame,
    unregisterGame,
    getGame,
    getGameInfo,
    listGames,
    hasGame,
    gamesCount,
  }
  return function disposeGlobalRegistry() {
    if (globalThis.__dshLauncherRegistry && globalThis.__dshLauncherRegistry.registerGame === registerGame) {
      delete globalThis.__dshLauncherRegistry
    }
  }
}
