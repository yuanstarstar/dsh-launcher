// DSH启动器 · 数据布局与文件工具（通用，无游戏专用逻辑）
import path from 'node:path'
import fs from 'node:fs'
import fsp from 'node:fs/promises'

export function createPaths(dataRoot) {
  if (typeof dataRoot !== 'string' || !dataRoot.trim()) throw new Error('数据目录无效：' + String(dataRoot))
  const root = path.resolve(dataRoot.trim())
  return {
    root,
    configFile: path.join(root, 'config.json'),
    games: path.join(root, 'games'),
    adapters: path.join(root, 'adapters'),
    instances: path.join(root, 'instances'),
    cache: path.join(root, 'cache'),
    downloads: path.join(root, 'cache', 'downloads'),
    manifests: path.join(root, 'cache', 'manifests'),
    tmp: path.join(root, 'tmp'),
    gameDataRoot: path.join(root, 'game-data'),
    instanceDir(id) {
      return path.join(root, 'instances', String(id))
    },
    instanceGameDir(id) {
      return path.join(root, 'instances', String(id), 'game')
    },
    instanceLogsDir(id) {
      return path.join(root, 'instances', String(id), 'logs')
    },
    gameDataDir(adapterId) {
      return path.join(root, 'game-data', String(adapterId))
    },
  }
}

export async function ensureDirs(paths) {
  const dirs = [paths.root, paths.games, paths.adapters, paths.instances, paths.cache, paths.downloads, paths.manifests, paths.tmp, paths.gameDataRoot]
  for (const dir of dirs) await fsp.mkdir(dir, { recursive: true })
  return paths
}

export async function pathExists(target) {
  try {
    await fsp.access(target)
    return true
  } catch {
    return false
  }
}

export async function readJson(file, fallback = null) {
  try {
    const text = await fsp.readFile(file, 'utf8')
    return JSON.parse(text.replace(/^\uFEFF/, ''))
  } catch {
    return fallback
  }
}

export async function writeJson(file, value) {
  await fsp.mkdir(path.dirname(file), { recursive: true })
  const tmp = file + '.' + process.pid + '.' + Date.now() + '.tmp'
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

export async function removeDir(target) {
  await fsp.rm(target, { recursive: true, force: true, maxRetries: 3 })
}

export function slugify(name, fallback = 'instance') {
  const raw = String(name == null ? '' : name)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
  return raw || fallback
}

export function timestamp(date = new Date()) {
  const p = (n) => String(n).padStart(2, '0')
  return date.getFullYear() + p(date.getMonth() + 1) + p(date.getDate()) + '-' + p(date.getHours()) + p(date.getMinutes()) + p(date.getSeconds())
}

export function timeLabel(date = new Date()) {
  const p = (n) => String(n).padStart(2, '0')
  return p(date.getHours()) + ':' + p(date.getMinutes()) + ':' + p(date.getSeconds())
}

export function formatBytes(bytes) {
  const n = Number(bytes)
  if (!Number.isFinite(n) || n <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = n
  let index = 0
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024
    index += 1
  }
  return (value >= 100 || index === 0 ? value.toFixed(0) : value.toFixed(1)) + ' ' + units[index]
}

export function fileExistsSync(target) {
  try {
    return fs.existsSync(target)
  } catch {
    return false
  }
}
