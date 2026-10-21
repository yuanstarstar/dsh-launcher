// lib/util.js —— 适配器内部文件工具与「方块游戏数据目录」布局
// 说明：v3 核心包只提供 dataRoot/instances 等通用路径；本适配器自己的版本/库/资源/运行时
// 全部落在 ctx.gameDataDir（dataRoot/game-data/minecraft），这里集中生成该目录下的路径。
// 该文件不含任何网络逻辑与宿主依赖，可独立测试。
import path from 'node:path'
import fs from 'node:fs'
import fsp from 'node:fs/promises'

/**
 * 由共享游戏数据目录（ctx.gameDataDir）生成适配器使用的全部路径。
 * 布局（均为通用名，不含宿主可见的具体游戏品牌）：
 *   <gameDataDir>/
 *     versions/<versionId>/<versionId>.json|.jar
 *     libraries/...（maven 布局）
 *     assets/{indexes,objects,log_configs}
 *     runtime/jre-<major>/
 *     launcher_profiles.json（Forge/NeoForge 安装器要求）
 *     cache/{installers,jre,manifests}
 */
export function createGamePaths(gameDataDir) {
  if (typeof gameDataDir !== 'string' || !gameDataDir.trim()) {
    throw new Error('缺少共享游戏数据目录（ctx.gameDataDir）')
  }
  const root = path.resolve(gameDataDir.trim())
  const assets = path.join(root, 'assets')
  const cache = path.join(root, 'cache')
  return {
    root,
    // 加载器安装器的 --installClient 目标（安装器会把 versions/libraries 写到该目录下）
    minecraft: root,
    versions: path.join(root, 'versions'),
    libraries: path.join(root, 'libraries'),
    assets,
    assetIndexes: path.join(assets, 'indexes'),
    assetsObjects: path.join(assets, 'objects'),
    logConfigs: path.join(assets, 'log_configs'),
    launcherProfiles: path.join(root, 'launcher_profiles.json'),
    runtime: path.join(root, 'runtime'),
    cache,
    installers: path.join(cache, 'installers'),
    manifests: path.join(cache, 'manifests'),
    jreCache: path.join(cache, 'jre'),
  }
}

/** 确保适配器全部标准目录存在。 */
export async function ensureGameDirs(paths) {
  if (!paths?.root) throw new Error('ensureGameDirs 缺少 paths')
  const dirs = [
    paths.root,
    paths.versions,
    paths.libraries,
    paths.assets,
    paths.assetIndexes,
    paths.assetsObjects,
    paths.logConfigs,
    paths.runtime,
    paths.cache,
    paths.installers,
    paths.manifests,
    paths.jreCache,
  ]
  for (const dir of dirs) await fsp.mkdir(dir, { recursive: true })
  return paths
}

export async function pathExists(p) {
  try {
    await fsp.access(p)
    return true
  } catch {
    return false
  }
}

export async function readJson(file, fallback = null) {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8'))
  } catch {
    return fallback
  }
}

/** 原子写 JSON（先写临时文件再 rename，避免半截文件）。 */
export async function writeJson(file, value) {
  const dir = path.dirname(file)
  await fsp.mkdir(dir, { recursive: true })
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  await fsp.writeFile(tmp, JSON.stringify(value, null, 2), 'utf8')
  await fsp.rename(tmp, file)
  return value
}

export async function readText(file, fallback = '') {
  try {
    return await fsp.readFile(file, 'utf8')
  } catch {
    return fallback
  }
}

/** 移除目录（尽力而为）。 */
export async function removeDir(dir) {
  await fsp.rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
}

/** yyyyMMdd-HHmmss 时间戳。 */
export function timestamp(date = new Date()) {
  const p = (n) => String(n).padStart(2, '0')
  return (
    `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}` +
    `-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`
  )
}

/** 格式化字节数为人类可读。 */
export function formatBytes(bytes) {
  const n = Number(bytes) || 0
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`
}

/** no-op 进度对象（适配器方法允许不传 task）。 */
export const NOOP_TASK = Object.freeze({
  log() {},
  items() {},
  bytes() {},
  setPhase() {},
  cancelRequested: false,
})

export function taskOf(task) {
  return task && typeof task === 'object' ? task : NOOP_TASK
}

/** 安全写日志：进度对象的 log 抛错不影响主流程。 */
export function taskLog(task, message) {
  try {
    taskOf(task).log?.(String(message))
  } catch {
    /* 忽略 */
  }
}

/** 路径 id 只允许作为单层目录名（防御路径穿越）。 */
export function assertSafeId(id, label = '版本') {
  if (typeof id !== 'string' || !id || id === '.' || id === '..' || /[\\/]/.test(id) || id.includes('..')) {
    throw new Error(`非法的${label} ID：${JSON.stringify(id)}`)
  }
  return id
}

/** 目录下直接子目录的绝对路径列表（失败返回空数组）。 */
export async function listDirs(parent) {
  try {
    const entries = await fsp.readdir(parent, { withFileTypes: true })
    return entries.filter((entry) => entry.isDirectory()).map((entry) => path.join(parent, entry.name))
  } catch {
    return []
  }
}

export { fs, fsp, path }
