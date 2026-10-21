// DSH启动器 v3 · 游戏定义存储
//
// 负责把「用户添加的游戏定义」和「外部适配器」桥接到统一注册表：
//   - dataRoot/adapters/*.mjs 外部适配器（default export adapter 或 (helpers) => adapter）
//   - dataRoot/games/*.json   用户通过提供者添加的游戏定义
// 核心包不内置任何具体游戏，一切游戏都从这两处加载。
import fsp from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  registerGame,
  unregisterGame,
  getGameInfo,
  listGames,
  hasGame,
} from './registry.js'
import { PROVIDERS, providerSummaries, validateDefinition, testDefinition } from './providers/index.js'

function fail(message) {
  throw new Error(message)
}

function toIdCandidate(label) {
  const text = String(label || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32)
  return text || 'game'
}

function deriveLabel({ provider, config }) {
  if (provider === 'github' && config && typeof config.repo === 'string' && config.repo.trim()) {
    const parts = config.repo.trim().split('/')
    return parts[parts.length - 1] || 'GitHub 游戏'
  }
  if (provider === 'url' && config) {
    if (typeof config.label === 'string' && config.label.trim()) return config.label.trim()
    if (typeof config.jsonUrl === 'string' && config.jsonUrl.trim()) {
      try {
        return new URL(config.jsonUrl.trim()).hostname
      } catch {
        return 'URL 游戏'
      }
    }
    return 'URL 游戏'
  }
  if (provider === 'manual' && config && typeof config.path === 'string' && config.path.trim()) {
    const base = path.basename(path.resolve(config.path.trim()))
    return base || '本机游戏'
  }
  return '未命名游戏'
}

/** 统一 add() 的入参：既支持 {provider,id,label,config}，也支持完整游戏定义对象。 */
function normalizeAddInput(input) {
  if (!input || typeof input !== 'object') fail('缺少游戏定义')
  const definition = input.definition && typeof input.definition === 'object' ? input.definition : input
  return {
    provider: definition.provider,
    id: definition.id,
    label: typeof definition.label === 'string' ? definition.label.trim() : '',
    versionLabel: definition.versionLabel,
    config: definition.config,
  }
}

export function createGameStore({ paths, dl, logger } = {}) {
  if (!paths) fail('缺少数据路径（paths）')
  const log = typeof logger === 'function' ? logger : () => {}
  const entries = new Map() // id -> { definition, adapter, source, sourceFile, dispose }
  let loaded = false
  let downloader = dl || null

  const store = {
    // ---------- 生命周期 ----------

    /**
     * 加载全部游戏来源：先外部适配器，再用户定义。
     * 单个文件失败只记录日志，不影响其他游戏；重复调用默认幂等。
     */
    async loadAll({ force = false } = {}) {
      if (loaded && !force) return summarize()
      if (force) await store.close()
      await fsp.mkdir(paths.games, { recursive: true })
      await fsp.mkdir(paths.adapters, { recursive: true })
      let adapterCount = 0
      let definitionCount = 0

      // 1) 外部适配器：允许出现具体游戏逻辑，由用户放进 dataRoot/adapters
      let adapterFiles = []
      try {
        adapterFiles = (await fsp.readdir(paths.adapters)).filter((name) => /\.(mjs|js)$/i.test(name)).sort()
      } catch (error) {
        log('读取外部适配器目录失败：' + (error && error.message ? error.message : error))
      }
      for (const name of adapterFiles) {
        const file = path.join(paths.adapters, name)
        try {
          const loadedModule = await import(pathToFileURL(file).href + '?v=' + Date.now())
          let exported = loadedModule && loadedModule.default
          if (exported == null && loadedModule && loadedModule.adapter) exported = loadedModule.adapter
          const helpers = {
            dl: downloader,
            paths,
            logger: log,
            registerGame,
          }
          let adapters = []
          if (typeof exported === 'function') {
            const produced = await exported(helpers)
            adapters = Array.isArray(produced) ? produced : produced ? [produced] : []
          } else if (Array.isArray(exported)) {
            adapters = exported
          } else if (exported) {
            adapters = [exported]
          }
          if (!adapters.length) {
            log('外部适配器没有导出任何适配器：' + name)
            continue
          }
          for (const adapter of adapters) {
            if (!adapter || typeof adapter !== 'object') {
              log('外部适配器格式无效：' + name)
              continue
            }
            if (hasGame(adapter.id)) {
              log('跳过外部适配器（id 已存在）：' + adapter.id + '（' + name + '）')
              continue
            }
            const dispose = registerGame(adapter, 'external')
            entries.set(adapter.id, {
              definition: null,
              adapter,
              source: 'external',
              sourceFile: name,
              dispose,
            })
            adapterCount += 1
            log('已加载外部适配器：' + adapter.id + '（' + name + '）')
          }
        } catch (error) {
          log('加载外部适配器失败（' + name + '）：' + (error && error.message ? error.message : error))
        }
      }

      // 2) 用户通过提供者添加的游戏定义
      let definitionFiles = []
      try {
        definitionFiles = (await fsp.readdir(paths.games)).filter((name) => /\.json$/i.test(name)).sort()
      } catch (error) {
        log('读取游戏定义目录失败：' + (error && error.message ? error.message : error))
      }
      for (const name of definitionFiles) {
        const file = path.join(paths.games, name)
        try {
          const text = await fsp.readFile(file, 'utf8')
          const raw = JSON.parse(text)
          if (!raw || typeof raw !== 'object') throw new Error('内容不是对象')
          const fileId = path.basename(name, '.json')
          const candidate = { ...raw, id: raw.id != null ? String(raw.id) : fileId }
          if (!candidate.label) candidate.label = deriveLabel(candidate)
          const normalized = validateDefinition(candidate)
          const id = candidate.id
          if (hasGame(id)) {
            log('跳过游戏定义（id 已存在）：' + id + '（' + name + '）')
            continue
          }
          const adapter = PROVIDERS[normalized.provider].createAdapter({ ...normalized, id })
          const dispose = registerGame(adapter, 'user')
          entries.set(id, {
            definition: { ...normalized, id },
            adapter,
            source: 'user',
            sourceFile: name,
            dispose,
          })
          definitionCount += 1
        } catch (error) {
          log('跳过无效游戏定义（' + name + '）：' + (error && error.message ? error.message : error))
        }
      }

      loaded = true
      log('游戏来源加载完成：外部适配器 ' + adapterCount + ' 个，用户定义 ' + definitionCount + ' 个')
      return summarize()

      function summarize() {
        return { games: entries.size, adapters: adapterCount || 0, definitions: definitionCount || 0 }
      }
    },

    // ---------- 查询 ----------

    list() {
      const result = []
      for (const game of listGames()) {
        const entry = entries.get(game.id)
        const definition = entry && entry.definition
        const provider = definition ? definition.provider : 'external'
        result.push({
          id: game.id,
          label: game.label,
          provider,
          providerLabel: definition ? PROVIDERS[provider] && PROVIDERS[provider].label ? PROVIDERS[provider].label : provider : '自定义适配器',
          source: game.source,
          versionLabel: definition ? definition.versionLabel : game.versionLabel || '版本',
          capabilities: game.capabilities,
          instanceOptions: game.instanceOptions,
        })
      }
      return result
    },

    /** 取得某个游戏定义的原始配置（用户定义才有）。 */
    getDefinition(gameId) {
      const entry = entries.get(String(gameId))
      return entry && entry.definition ? JSON.parse(JSON.stringify(entry.definition)) : null
    },

    listProviders() {
      return providerSummaries()
    },

    // ---------- 添加 / 测试 / 删除 ----------

    /** 添加一个由提供者驱动的游戏定义：校验、查重、落盘、注册。 */
    async add(input) {
      if (!loaded) await store.loadAll()
      const raw = normalizeAddInput(input)
      if (!raw.label) raw.label = deriveLabel(raw)
      let normalized
      try {
        normalized = validateDefinition({
          provider: raw.provider,
          label: raw.label,
          versionLabel: raw.versionLabel,
          config: raw.config,
          ...(raw.id ? { id: raw.id } : {}),
        })
      } catch (error) {
        throw new Error('游戏定义无效：' + (error && error.message ? error.message : error))
      }
      const label = normalized.label
      let id = raw.id ? String(raw.id) : ''
      if (id) {
        if (hasGame(id)) throw new Error('游戏已存在：' + id)
      } else {
        const base = toIdCandidate(label)
        id = base
        let serial = 2
        while (hasGame(id)) {
          id = base + '-' + serial
          serial += 1
        }
      }
      const definition = { ...normalized, id }
      if (hasGame(id)) throw new Error('游戏已存在：' + id)
      const file = path.join(paths.games, id + '.json')
      await fsp.mkdir(path.dirname(file), { recursive: true })
      const payload = {
        id,
        label: definition.label,
        provider: definition.provider,
        versionLabel: definition.versionLabel,
        config: definition.config,
      }
      const tmp = file + '.' + process.pid + '.' + Date.now() + '.tmp'
      await fsp.writeFile(tmp, JSON.stringify(payload, null, 2), 'utf8')
      await fsp.rename(tmp, file)
      let dispose
      try {
        const adapter = PROVIDERS[definition.provider].createAdapter(definition)
        dispose = registerGame(adapter, 'user')
        entries.set(id, { definition, adapter, source: 'user', sourceFile: id + '.json', dispose })
      } catch (error) {
        await fsp.rm(file, { force: true }).catch(() => {})
        throw error
      }
      log('已添加游戏：' + id + '（' + definition.label + '，提供者 ' + definition.provider + '）')
      const summary = store.list().find((item) => item.id === id)
      return { id, game: summary || null, definition }
    },

    /** 真实校验提供者配置（供「测试连接」使用）。 */
    async test({ provider, config } = {}) {
      if (!downloader) return { ok: false, detail: '下载器未就绪，无法进行网络校验' }
      return testDefinition({ provider, config, dl: downloader, logger: log })
    },

    /** 删除用户添加的游戏定义；外部适配器来源拒绝删除。 */
    async remove(gameId) {
      const id = String(gameId)
      const entry = entries.get(id)
      const info = entry || getGameInfo(id)
      if (!info) throw new Error('游戏不存在：' + id)
      if (entry && entry.source === 'external') throw new Error('外部适配器游戏不能删除')
      const registered = getGameInfo(id)
      if (registered && registered.source === 'external') throw new Error('外部适配器游戏不能删除')
      if (entry && typeof entry.dispose === 'function') {
        try {
          entry.dispose()
        } catch {
          /* 注销失败也继续清理 */
        }
      } else {
        unregisterGame(id)
      }
      entries.delete(id)
      await fsp.rm(path.join(paths.games, id + '.json'), { force: true }).catch(() => {})
      log('已删除游戏：' + id)
      return { removed: true, id }
    },

    /** 配置变更后替换下载器实例（尚未安装的定义会在下次安装时使用新实例）。 */
    setDownloader(next) {
      downloader = next || null
    },

    /** 注销本存储注册的全部游戏（外部适配器也会注销，加载状态重置）。 */
    async close() {
      for (const [id, entry] of entries) {
        try {
          if (typeof entry.dispose === 'function') entry.dispose()
          else unregisterGame(id)
        } catch {
          /* 忽略注销异常 */
        }
      }
      entries.clear()
      loaded = false
    },
  }

  return store
}

export default createGameStore
