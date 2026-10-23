import path from 'node:path'
import { readJson } from './paths.js'
import { isUpdateAvailable } from './sublaunchers.js'

/**
 * 推荐目录（catalog）：
 * 本体不含任何具体游戏信息，推荐列表完全来自外部 JSON —— 可以放在任意静态地址
 * （例如 GitHub 仓库里的 raw 文件），也可以在数据根手动放一份 catalog.json。
 *
 * 目录格式（schemaVersion=1）：
 * {
 *   "schemaVersion": 1,
 *   "updatedAt": "2026-10-23",
 *   "entries": [
 *     { "id": "example", "label": "显示名称", "repo": "owner/name",
 *       "description": "一句话介绍", "version": "1.0.0",
 *       "homepage": "https://...", "tags": ["tag"] }
 *   ]
 * }
 *
 * 每个条目必须至少提供 repo / url / file 之一。
 */

export const CATALOG_SCHEMA_VERSION = 1
const MAX_ENTRIES = 50
const MAX_CATALOG_BYTES = 256 * 1024
const CACHE_TTL_MS = 10 * 60 * 1000
const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,40}$/
const REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/

function fail(message) {
  const error = new Error(message)
  error.code = 'CATALOG_INVALID'
  throw error
}

function text(value, fallback = '') {
  if (value == null) return fallback
  if (typeof value === 'string') return value.trim() || fallback
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return fallback
}

function slugify(value, fallback = 'entry') {
  const slug = text(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
  return ID_PATTERN.test(slug) ? slug : fallback
}

function isHttpUrl(value) {
  try {
    const parsed = new URL(String(value))
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
  } catch {
    return false
  }
}

/** 规整单个目录条目；不合法抛中文错误（带条目序号）。 */
export function normalizeCatalogEntry(raw, index = 0) {
  const prefix = '推荐目录第 ' + (index + 1) + ' 项'
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail(prefix + '无效：必须是 JSON 对象')
  const repo = text(raw.repo)
  const url = text(raw.url)
  const file = text(raw.file)
  if (!repo && !url && !file) fail(prefix + '缺少安装来源：需要 repo / url / file 之一')
  if (repo && !REPO_PATTERN.test(repo)) fail(prefix + '的 repo 格式无效：' + repo + '（应为 owner/name）')
  if (url && !isHttpUrl(url)) fail(prefix + '的 url 不是合法 http(s) 地址：' + url)
  const label = text(raw.label) || repo || path.basename(url || file || '')
  let id = text(raw.id).toLowerCase()
  if (id && !ID_PATTERN.test(id)) fail(prefix + '的 id 无效：' + raw.id + '（小写字母/数字/连字符，2-41 位）')
  if (!id) id = slugify(repo ? repo.split('/')[1] : path.basename(url || file || ''), 'entry-' + (index + 1))
  if (!label) fail(prefix + '缺少 label（显示名称）')
  const tags = Array.isArray(raw.tags)
    ? raw.tags.map((tag) => text(tag)).filter(Boolean).slice(0, 8)
    : text(raw.tags)
      ? [text(raw.tags)]
      : []
  return {
    id,
    label,
    repo: repo || '',
    url: url || '',
    file: file || '',
    description: text(raw.description),
    version: text(raw.version),
    homepage: isHttpUrl(raw.homepage) ? text(raw.homepage) : '',
    tags,
  }
}

/** 解析目录 JSON（数组或 {schemaVersion, entries}），返回规整后的条目数组。 */
export function parseCatalog(raw, options = {}) {
  let payload = raw
  if (typeof payload === 'string') {
    try {
      payload = JSON.parse(payload)
    } catch {
      fail('推荐目录内容不是合法 JSON')
    }
  }
  if (Array.isArray(payload)) payload = { schemaVersion: CATALOG_SCHEMA_VERSION, entries: payload }
  if (!payload || typeof payload !== 'object') fail('推荐目录内容无效：应为 JSON 对象或数组')
  if (payload.schemaVersion !== undefined && Number(payload.schemaVersion) !== CATALOG_SCHEMA_VERSION) {
    fail('不支持的推荐目录版本：' + String(payload.schemaVersion) + '（需要 ' + CATALOG_SCHEMA_VERSION + '）')
  }
  const list = Array.isArray(payload.entries) ? payload.entries : []
  if (list.length > MAX_ENTRIES) fail('推荐目录条目过多（最多 ' + MAX_ENTRIES + ' 条）')
  const entries = []
  const seen = new Set()
  list.forEach((item, index) => {
    const entry = normalizeCatalogEntry(item, index)
    let unique = entry.id
    let n = 2
    while (seen.has(unique)) unique = entry.id + '-' + n++
    entry.id = unique
    seen.add(unique)
    entries.push(entry)
  })
  return {
    schemaVersion: CATALOG_SCHEMA_VERSION,
    updatedAt: text(options.updatedAt || payload.updatedAt),
    entries,
  }
}

/** 给目录条目补上「是否已安装 / 是否有更新」信息（按 repo 或 id 匹配已安装的附属启动器）。 */
export function annotateCatalog(entries, launchers = []) {
  const list = Array.isArray(entries) ? entries : []
  const installed = Array.isArray(launchers) ? launchers : []
  return list.map((entry) => {
    const match = installed.find((item) => {
      if (!item || typeof item !== 'object') return false
      const repo = text(item.repo).toLowerCase()
      if (repo && entry.repo && repo === entry.repo.toLowerCase()) return true
      return text(item.id) === entry.id
    })
    const installedVersion = match ? text(match.version) : ''
    const updateAvailable =
      !!match &&
      !!entry.version &&
      !!installedVersion &&
      /^\d+\.\d+\.\d+/.test(entry.version) &&
      /^\d+\.\d+\.\d+/.test(installedVersion) &&
      isUpdateAvailable(installedVersion, entry.version)
    return {
      ...entry,
      installed: !!match,
      installedVersion,
      updateAvailable,
    }
  })
}

/** 拉取远程目录 JSON（带体积上限，防止异常大文件）。 */
export async function fetchCatalogJson(url, options = {}) {
  const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : 15000
  let response
  try {
    response = await fetch(url, {
      headers: { accept: 'application/json', 'user-agent': 'dsh-launcher/catalog' },
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (error) {
    fail('无法访问推荐目录：' + String((error && error.message) || error))
  }
  if (!response.ok) fail('推荐目录请求失败（HTTP ' + response.status + '）：' + url)
  const raw = Buffer.from(await response.arrayBuffer())
  if (raw.length > MAX_CATALOG_BYTES) fail('推荐目录文件过大（上限 ' + MAX_CATALOG_BYTES + ' 字节）')
  return parseCatalog(raw.toString('utf8'))
}

/**
 * 创建目录加载器：优先远程 config.catalogUrl，其次数据根 catalog.json；空/失败时返回空列表 + 错误说明。
 * 带 10 分钟内存缓存，refresh=true 强制重新读取。
 */
export function createCatalogLoader(options = {}) {
  const paths = options.paths
  const logger = typeof options.logger === 'function' ? options.logger : () => {}
  const getConfig = typeof options.getConfig === 'function' ? options.getConfig : () => options.config || {}
  let cache = null

  async function loadRemote(url) {
    const result = await fetchCatalogJson(url)
    return { ...result, source: 'remote:' + url }
  }

  async function loadLocal() {
    const file = path.join(paths.root, 'catalog.json')
    const raw = await readJson(file, null)
    if (raw == null) return null
    const result = parseCatalog(raw)
    return { ...result, source: 'local:' + file }
  }

  async function load(opts = {}) {
    const now = Date.now()
    const refresh = !!opts.refresh
    if (!refresh && cache && now - cache.at < CACHE_TTL_MS) return cache.value
    const config = getConfig() || {}
    const url = text(config.catalogUrl)
    let value
    if (url) {
      try {
        const result = await loadRemote(url)
        value = { entries: result.entries, updatedAt: result.updatedAt, source: result.source, fetchedAt: new Date().toISOString(), error: '' }
      } catch (error) {
        const detail = String((error && error.message) || error)
        logger('推荐目录加载失败（' + url + '）：' + detail + '；尝试读取数据根 catalog.json')
        try {
          const local = await loadLocal()
          if (local) {
            value = { entries: local.entries, updatedAt: local.updatedAt, source: local.source, fetchedAt: new Date().toISOString(), error: '远程目录不可用（' + detail + '），已使用本地目录' }
          } else {
            value = { entries: [], updatedAt: '', source: 'remote:' + url, fetchedAt: new Date().toISOString(), error: detail }
          }
        } catch {
          value = { entries: [], updatedAt: '', source: 'remote:' + url, fetchedAt: new Date().toISOString(), error: detail }
        }
      }
    } else {
      try {
        const result = await loadLocal()
        value = result
          ? { entries: result.entries, updatedAt: result.updatedAt, source: result.source, fetchedAt: new Date().toISOString(), error: '' }
          : { entries: [], updatedAt: '', source: 'none', fetchedAt: new Date().toISOString(), error: '' }
      } catch (error) {
        value = { entries: [], updatedAt: '', source: 'local', fetchedAt: new Date().toISOString(), error: String((error && error.message) || error) }
      }
    }
    cache = { at: now, value }
    return value
  }

  return { load, clear: () => { cache = null } }
}

export default createCatalogLoader
