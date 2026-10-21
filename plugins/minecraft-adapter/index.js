// index.js —— 可选「Minecraft 适配器包」的 DSH 插件入口
//
// 本包只做一件事：把 Minecraft 的 GameAdapter 注册进 DSH启动器 核心包的游戏注册表。
// 用户不安装它，启动器就只是通用框架；安装后启动器里才出现 Minecraft。
//
// 注册表获取顺序（架构文档 §2）：
//   1) globalThis.__dshLauncherRegistry（核心包安装时会挂载，最可靠，避免跨包 import）；
//   2) 动态 import 核心包的 registry 子路径（核心 package.json exports 已暴露 ./lib/core/registry.js）；
//   3) 动态 import 核心包主入口（可能 re-export 注册函数）。
// 全部失败 → 用中文警告提示先安装「DSH启动器」，插件保持未激活（不抛异常，避免阻断宿主启动）。

import adapter from './lib/adapter.js'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const name = 'dsh-mc-adapter'
export const inject = []

const LOG_PREFIX = '[Minecraft 适配器]'

/** 从模块导出里找出注册表接口（兼容 default / registry 嵌套导出）。 */
function pickRegistry(candidate) {
  if (!candidate || typeof candidate !== 'object') return null
  if (typeof candidate.registerGame === 'function') return candidate
  if (candidate.registry && typeof candidate.registry.registerGame === 'function') return candidate.registry
  if (candidate.default && typeof candidate.default.registerGame === 'function') return candidate.default
  if (candidate.default?.registry && typeof candidate.default.registry.registerGame === 'function') {
    return candidate.default.registry
  }
  return null
}

/** 查找游戏注册表；找不到返回 null。 */
async function resolveRegistry() {
  // 1) 全局注册表（核心包 installGlobalRegistry() 挂载）
  const globalRegistry = pickRegistry(globalThis.__dshLauncherRegistry)
  if (globalRegistry) return { registry: globalRegistry, via: 'globalThis.__dshLauncherRegistry' }

  // 2) 动态 import 核心包（先试明确的 registry 子路径，再试主入口）
  const specifiers = [
    '@local/dsh-launcher/lib/core/registry.js',
    '@local/dsh-launcher/lib/core/registry',
    '@local/dsh-launcher',
  ]
  for (const specifier of specifiers) {
    try {
      const mod = await import(specifier)
      const registry = pickRegistry(mod)
      if (registry) return { registry, via: `import('${specifier}')` }
    } catch {
      /* 未安装核心包或子路径不可导出：继续尝试下一个 */
    }
  }
  return null
}

// ---------- 跨插件文件桥接 ----------
//
// DSH 中不同插件包可能运行在彼此隔离的加载上下文里（globalThis 不共享，也无法跨包 import），
// 因此这里采用文件桥接：核心包把「数据根路径」写在固定指针文件里，本适配器读取后把自己的
// 适配器模块写入 <dataRoot>/adapters/ 下；核心包轮询该目录并热加载，不需要重启 DSH。

const BRIDGE_FILE_NAME = 'adapter-' + adapter.id + '.mjs'
const ADAPTER_MODULE_FILE = fileURLToPath(new URL('./lib/adapter.js', import.meta.url))

function homeDir() {
  try {
    return os.homedir()
  } catch {
    return ''
  }
}

/** 计算核心包桥接指针文件的候选路径（按优先级）。 */
function bridgePointerCandidates(adapterConfig) {
  const candidates = []
  if (adapterConfig && typeof adapterConfig.launcherDataRoot === 'string' && adapterConfig.launcherDataRoot.trim()) {
    candidates.push(adapterConfig.launcherDataRoot.trim())
  }
  // 测试/多实例隔离：核心包与适配器都支持 DSH_LAUNCHER_BRIDGE_DIR 覆盖指针目录。
  const overrideDir = process.env.DSH_LAUNCHER_BRIDGE_DIR
  if (overrideDir && String(overrideDir).trim()) candidates.push(path.join(path.resolve(String(overrideDir).trim()), 'bridge.json'))
  const home = homeDir()
  if (home) candidates.push(path.join(home, '.dsh-launcher', 'bridge.json'))
  const appData = process.env.APPDATA || process.env.LOCALAPPDATA || ''
  if (appData) candidates.push(path.join(appData, 'dsh-launcher', 'bridge.json'))
  return candidates
}

/** 读取核心包数据根；失败返回 null。 */
async function readBridgePointer(adapterConfig) {
  for (const candidate of bridgePointerCandidates(adapterConfig)) {
    try {
      let dataRoot = ''
      if (/\.json$/i.test(candidate)) {
        const parsed = JSON.parse(await fsp.readFile(candidate, 'utf8'))
        if (parsed && typeof parsed.dataRoot === 'string' && parsed.dataRoot.trim()) dataRoot = parsed.dataRoot.trim()
      } else {
        dataRoot = candidate
      }
      if (dataRoot) return { dataRoot, pointer: candidate }
    } catch {
      /* 尝试下一个候选位置 */
    }
  }
  return null
}

/**
 * 把适配器桥接模块写入核心包的数据目录。
 * 返回 { file, dataRoot }；找不到核心包或写入失败返回 null。
 */
async function writeAdapterBridge(adapterConfig, log) {
  const pointer = await readBridgePointer(adapterConfig)
  if (!pointer) {
    log('warn', '未找到 DSH启动器 核心包的数据目录指针（~/.dsh-launcher/bridge.json），无法写入桥接文件')
    return null
  }
  const adaptersDir = path.join(pointer.dataRoot, 'adapters')
  const file = path.join(adaptersDir, BRIDGE_FILE_NAME)
  const header = [
    '// 自动生成：由 Minecraft 适配器包写入，用于把游戏适配器桥接给 DSH启动器 核心包。',
    '// 核心包会轮询本目录并热加载；删除本文件即可让核心卸载该游戏（重新安装适配器包会自动重建）。',
    'import adapter from ' + JSON.stringify(pathToFileURL(ADAPTER_MODULE_FILE).href),
    'export default adapter',
    '',
  ].join('\n')
  try {
    await fsp.mkdir(adaptersDir, { recursive: true })
    let current = ''
    try {
      current = await fsp.readFile(file, 'utf8')
    } catch {
      current = ''
    }
    if (current !== header) {
      const tmp = file + '.' + process.pid + '.tmp'
      await fsp.writeFile(tmp, header, 'utf8')
      await fsp.rename(tmp, file)
      log('info', '已写入适配器桥接文件：' + file)
    }
    return { file, dataRoot: pointer.dataRoot }
  } catch (error) {
    log('warn', '写入适配器桥接文件失败（' + file + '）：' + (error?.message ?? error))
    return null
  }
}

/** 删除桥接文件（插件卸载时调用）。 */
async function removeAdapterBridge(written) {
  if (!written || typeof written.file !== 'string') return
  try {
    await fsp.rm(written.file, { force: true })
  } catch {
    /* 忽略删除失败 */
  }
}

/**
 * DSH 插件入口。
 * @param {object} ctx  Cordis 插件上下文（提供 effect / logger / config）
 * @param {object} [config] 适配器配置：{ dataRoot?, downloadSource?, mirror?, neoforgeMirror?, concurrency? }
 */
export async function apply(ctx, config = {}) {
  const adapterConfig = config && typeof config === 'object' ? config : {}
  const logger = ctx?.logger ?? null
  const log = (level, message) => {
    try {
      const fn = logger?.[level]
      if (typeof fn === 'function') fn.call(logger, `${LOG_PREFIX} ${message}`)
    } catch {
      /* 日志失败不影响插件 */
    }
  }

  // 镜像/测速配置在适配器内部生效（核心下载器保持通用，由适配器注入 resolveUrl）
  try {
    adapter.configure(adapterConfig)
  } catch (error) {
    log('warn', `镜像配置失败（使用默认值）：${error?.message ?? error}`)
  }

  /** 注册适配器；成功返回注销函数，失败（如 id 已注册）返回 null。 */
  const registerWith = (resolved) => {
    try {
      const dispose = resolved.registry.registerGame(adapter, 'external')
      log('info', `已注册游戏：Minecraft（来源：${resolved.via}），能力：内容/加载器/运行时`)
      return typeof dispose === 'function' ? dispose : null
    } catch (error) {
      log('warn', `注册 Minecraft 游戏失败：${error?.message ?? error}`)
      return null
    }
  }

  let dispose = null
  let retryTimer = null
  let stopped = false
  let bridgeWritten = null

  const resolved = await resolveRegistry()
  if (resolved) {
    dispose = registerWith(resolved)
  } else {
    // 核心包与本包可能加载在隔离上下文里：优先走文件桥接（无需重启 DSH）
    bridgeWritten = await writeAdapterBridge(adapterConfig, log)
    if (bridgeWritten) {
      log('info', '已通过文件桥接向 DSH启动器 注册游戏：核心包将在数秒内自动热加载，无需重启')
    } else {
      // 插件加载顺序不保证核心包先激活：这里短暂重试（每 2 秒一次，最多 60 秒）。
      // 每次重试同时尝试全局注册表与文件桥接，谁先可用就注册谁。
      log(
        'warn',
        '暂未找到 DSH启动器 的游戏注册表：请先安装「DSH启动器」核心包（@local/dsh-launcher）。将在 60 秒内持续重试注册（含文件桥接）。',
      )
      const RETRY_DELAY_MS = 2000
      const MAX_RETRIES = 30
      let retries = 0
      const scheduleRetry = () => {
        if (stopped || dispose || bridgeWritten) return
        if (retries >= MAX_RETRIES) {
          log('warn', '仍未找到 DSH启动器 的游戏注册表，Minecraft 适配器保持未激活；安装核心包后请重启 DSH。')
          return
        }
        retries += 1
        retryTimer = setTimeout(async () => {
          retryTimer = null
          if (stopped || dispose || bridgeWritten) return
          const found = await resolveRegistry()
          if (found) {
            dispose = registerWith(found)
            return
          }
          const bridge = await writeAdapterBridge(adapterConfig, log)
          if (bridge) {
            bridgeWritten = bridge
            log('info', '已通过文件桥接向 DSH启动器 注册游戏：核心包将在数秒内自动热加载，无需重启')
            return
          }
          scheduleRetry()
        }, RETRY_DELAY_MS)
        retryTimer.unref?.()
      }
      scheduleRetry()
    }
  }

  if (typeof ctx?.effect === 'function') {
    ctx.effect(() => () => {
      stopped = true
      if (retryTimer) {
        clearTimeout(retryTimer)
        retryTimer = null
      }
      if (bridgeWritten) {
        // 移除桥接文件后，核心包会在下一次轮询时自动卸载该游戏
        void removeAdapterBridge(bridgeWritten)
        bridgeWritten = null
      }
      if (typeof dispose === 'function') {
        try {
          dispose()
        } catch {
          /* 注销失败忽略 */
        }
      }
    })
  } else if (typeof dispose === 'function') {
    log('warn', '当前插件上下文不支持 effect()，卸载插件时可能需要重启 DSH 才能注销 Minecraft 游戏')
  } else if (retryTimer) {
    log('warn', '当前插件上下文不支持 effect()，无法在卸载时清理注册重试定时器（进程退出时自动结束）')
  }
}

export { adapter }
export default { name, inject, apply, adapter }
