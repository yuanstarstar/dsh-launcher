// lib/modrinth.js —— Modrinth 内容检索、版本解析与下载（v3 适配器版）
// 只使用 Node 内置能力；HTTP 走 adapter 注入的下载器（ctx.dl / mirrors.makeDownloader(ctx)）。
// Modrinth API 无国内镜像，mirrors.resolveUrl 对这些 URL 原样返回。
import path from 'node:path'
import fsp from 'node:fs/promises'
import { formatBytes } from './util.js'
import { OFFICIAL } from './mirrors.js'

const MODRINTH_BASE = OFFICIAL.modrinth
const USER_AGENT = 'dsh-mc-adapter/3.0.0 (DSH Launcher Minecraft adapter)'
const HEADERS = { 'user-agent': USER_AGENT, accept: 'application/json' }

/** no-op 进度对象（契约 §7：task 可选）。 */
function taskOf(task) {
  return task ?? { log() {}, items() {}, bytes() {}, setPhase() {} }
}

function assertDownloader(dl) {
  if (!dl || typeof dl.fetchJson !== 'function') {
    throw new Error('缺少下载器（createDownloader），无法访问 Modrinth')
  }
}

/** Modrinth 项目 id 是 8 位 base62；slug 则通常是可读单词。 */
function looksLikeProjectId(value) {
  return /^[A-Za-z0-9]{8}$/.test(String(value || ''))
}

function mapSearchHit(hit) {
  return {
    projectId: hit.project_id,
    slug: hit.slug,
    title: hit.title,
    description: hit.description ?? '',
    iconUrl: hit.icon_url || null,
    downloads: hit.downloads ?? 0,
    follows: hit.follows ?? 0,
    author: hit.author || hit.organization || '',
    categories: hit.categories || hit.display_categories || [],
  }
}

function pickPrimaryFile(version) {
  const files = Array.isArray(version?.files) ? version.files : []
  return files.find((file) => file?.primary) || files[0] || null
}

function mapVersion(version, slugHint = null) {
  const file = pickPrimaryFile(version)
  return {
    versionId: version.id,
    versionNumber: version.version_number ?? '',
    name: version.name ?? version.version_number ?? '',
    datePublished: version.date_published ?? null,
    downloads: version.downloads ?? 0,
    gameVersions: version.game_versions ?? [],
    loaders: version.loaders ?? [],
    filename: file?.filename ?? '',
    url: file?.url ?? '',
    sha1: file?.hashes?.sha1 || null,
    sha256: file?.hashes?.sha256 || null,
    size: file?.size ?? 0,
    featured: Boolean(version.featured),
    versionType: version.version_type ?? 'release',
    projectId: version.project_id ?? null,
    slug: slugHint,
  }
}

/**
 * 搜索 Modrinth 项目。facets：project_type:mod + versions:<mc> + categories:<loader>。
 * 返回 { hits: [{ projectId, slug, title, description, iconUrl, downloads, follows, author, categories }], totalHits }
 */
export async function searchProjects(dl, { query = '', mcVersion, loader, limit = 12, offset = 0 } = {}) {
  assertDownloader(dl)
  const safeLimit = Math.max(1, Math.min(100, Number(limit) || 12))
  const safeOffset = Math.max(0, Number(offset) || 0)
  const facets = [['project_type:mod']]
  if (mcVersion) facets.push([`versions:${mcVersion}`])
  if (loader) facets.push([`categories:${loader}`])

  const params = new URLSearchParams()
  const keyword = String(query ?? '').trim()
  if (keyword) params.set('query', keyword)
  params.set('limit', String(safeLimit))
  params.set('offset', String(safeOffset))
  params.set('facets', JSON.stringify(facets))
  const url = `${MODRINTH_BASE}/search?${params.toString()}`

  let data
  try {
    data = await dl.fetchJson(url, { timeoutMs: 25000, headers: HEADERS })
  } catch (err) {
    throw new Error(`搜索 Modrinth 失败：${err?.message ?? err}`)
  }
  const hits = Array.isArray(data?.hits) ? data.hits.map(mapSearchHit) : []
  return { hits, totalHits: Number(data?.total_hits ?? hits.length) || 0 }
}

/**
 * 列出项目版本（可按 mcVersion / loader 过滤）。
 * 返回 [{ versionId, versionNumber, name, datePublished, downloads, gameVersions, loaders,
 *          filename, url, sha1, size, featured, projectId, slug }]
 */
export async function listProjectVersions(dl, idOrSlug, { mcVersion, loader } = {}) {
  assertDownloader(dl)
  const id = String(idOrSlug ?? '').trim()
  if (!id) throw new Error('缺少 Modrinth 项目 id/slug')
  const params = []
  if (mcVersion) params.push(`game_versions=${encodeURIComponent(JSON.stringify([String(mcVersion)]))}`)
  if (loader) params.push(`loaders=${encodeURIComponent(JSON.stringify([String(loader)]))}`)
  const url = `${MODRINTH_BASE}/project/${encodeURIComponent(id)}/version${params.length ? `?${params.join('&')}` : ''}`
  let list
  try {
    list = await dl.fetchJson(url, { timeoutMs: 25000, headers: HEADERS })
  } catch (err) {
    throw new Error(`获取 Modrinth 项目「${id}」的版本列表失败：${err?.message ?? err}`)
  }
  if (!Array.isArray(list)) {
    throw new Error(`Modrinth 项目「${id}」的版本列表返回格式异常`)
  }
  const slugHint = looksLikeProjectId(id) ? null : id
  return list.map((version) => mapVersion(version, slugHint))
}

async function fetchProject(dl, idOrSlug) {
  try {
    const data = await dl.fetchJson(`${MODRINTH_BASE}/project/${encodeURIComponent(idOrSlug)}`, {
      timeoutMs: 25000,
      headers: HEADERS,
    })
    if (!data?.id) throw new Error('返回内容缺少 id')
    return {
      projectId: data.id,
      slug: data.slug || null,
      title: data.title || data.slug || data.id,
      iconUrl: data.icon_url || null,
    }
  } catch (err) {
    throw new Error(`找不到 Modrinth 项目「${idOrSlug}」：${err?.message ?? err}`)
  }
}

async function fetchVersionById(dl, versionId) {
  try {
    return await dl.fetchJson(`${MODRINTH_BASE}/version/${encodeURIComponent(versionId)}`, {
      timeoutMs: 25000,
      headers: HEADERS,
    })
  } catch (err) {
    throw new Error(`找不到 Modrinth 版本「${versionId}」：${err?.message ?? err}`)
  }
}

function versionMatches(version, { mcVersion, loader }) {
  if (mcVersion) {
    const games = Array.isArray(version.gameVersions) ? version.gameVersions : []
    if (games.length && !games.includes(String(mcVersion))) return false
  }
  if (loader) {
    const loaders = Array.isArray(version.loaders) ? version.loaders : []
    if (loaders.length && !loaders.includes(String(loader))) return false
  }
  return true
}

const VERSION_TYPE_RANK = { release: 3, beta: 2, alpha: 1 }

/**
 * 选择版本：默认「最新优先」——优先正式版（release），再按发布日期倒序；
 * featured 仅作为同日期时的次要排序标记，不再压过更新版本。
 */
function pickBestVersion(versions, filters) {
  const matched = versions.filter((version) => versionMatches(version, filters))
  const rankOf = (v) => VERSION_TYPE_RANK[String(v.versionType || 'release')] || 0
  const sorted = [...matched].sort(
    (a, b) =>
      rankOf(b) - rankOf(a) ||
      (Date.parse(b.datePublished || 0) || 0) - (Date.parse(a.datePublished || 0) || 0) ||
      Number(Boolean(b.featured)) - Number(Boolean(a.featured)) ||
      (b.downloads || 0) - (a.downloads || 0),
  )
  return sorted[0] ?? null
}

function toResolved(version, project) {
  if (!version?.url) {
    throw new Error(`版本 ${version?.versionId ?? '?'} 没有可下载的文件`)
  }
  return {
    slug: project?.slug ?? version.slug ?? null,
    projectId: version.projectId ?? project?.projectId ?? null,
    title: project?.title ?? version.slug ?? version.name ?? '',
    versionId: version.versionId,
    versionNumber: version.versionNumber,
    filename: version.filename,
    url: version.url,
    sha1: version.sha1,
    size: version.size,
    gameVersions: version.gameVersions,
    loaders: version.loaders,
  }
}

async function resolveOne(dl, spec, filters) {
  // 1) 直接指定 versionId
  if (spec.versionId) {
    const raw = await fetchVersionById(dl, spec.versionId)
    const mapped = mapVersion(raw, null)
    let project = null
    try {
      project = await fetchProject(dl, raw.project_id)
    } catch {
      project = null
    }
    return toResolved(mapped, project)
  }

  // 2) slug / projectId
  const idOrSlug = spec.projectId ? String(spec.projectId) : String(spec.slug ?? '').trim()
  if (!idOrSlug) throw new Error('Mod 描述需要 slug / projectId / versionId 之一')
  const project = await fetchProject(dl, idOrSlug)
  const versions = await listProjectVersions(dl, project.projectId || idOrSlug, filters)
  const best = pickBestVersion(versions, filters)
  if (!best) {
    throw new Error(
      `项目「${project.title}」没有匹配版本 ${filters.mcVersion || '任意'} / ` +
        `加载器 ${filters.loader || '任意'} 的版本`,
    )
  }
  return toResolved(best, project)
}

/**
 * 把 [{ slug | projectId | versionId }] 解析成可下载的 Mod 描述列表。
 * 返回 [{ slug, projectId, title, versionId, versionNumber, filename, url, sha1, size }]
 */
export async function resolveMods(dl, { mcVersion, loader, mods = [], task } = {}) {
  assertDownloader(dl)
  const t = taskOf(task)
  const filters = { mcVersion: mcVersion ? String(mcVersion) : null, loader: loader ? String(loader) : null }
  const list = Array.isArray(mods) ? mods : []
  const out = []
  for (let i = 0; i < list.length; i += 1) {
    const spec = list[i] ?? {}
    const label = spec.slug || spec.projectId || spec.versionId || JSON.stringify(spec)
    t.items(i, list.length, `解析 Mod (${i}/${list.length})`)
    t.log(`解析 Mod：${label}`)
    try {
      out.push(await resolveOne(dl, spec, filters))
    } catch (err) {
      throw new Error(`解析 Mod「${label}」失败：${err?.message ?? err}`)
    }
  }
  t.items(list.length, list.length, `解析 Mod (${list.length}/${list.length})`)
  return out
}

function sanitizeFileName(name) {
  const base = path.basename(String(name || 'mod.jar'))
  const safe = base.replace(/[\\/:*?"<>|]/g, '_').trim()
  return safe || 'mod.jar'
}

/**
 * 下载 Mod 到 modsDir（带 sha1/size 校验；已存在且校验通过则复用）。
 * 返回 { path, filename, bytes }
 */
export async function downloadMod(dl, mod, modsDir, task) {
  const t = taskOf(task)
  if (!dl || typeof dl.downloadFile !== 'function') {
    throw new Error('缺少下载器（createDownloader），无法下载 Mod')
  }
  if (!mod?.url) throw new Error('Mod 缺少下载地址（url）')
  if (!modsDir) throw new Error('缺少 Mod 存放目录（modsDir）')
  let fallbackName = 'mod.jar'
  try {
    fallbackName = decodeURIComponent(new URL(mod.url).pathname)
  } catch {
    /* 用默认名 */
  }
  const filename = sanitizeFileName(mod.filename || fallbackName)
  await fsp.mkdir(modsDir, { recursive: true })
  const dest = path.join(modsDir, filename)
  t.log(`下载 Mod：${filename}`)
  let res
  try {
    res = await dl.downloadFile(mod.url, dest, {
      sha1: mod.sha1 || undefined,
      size: mod.size || undefined,
      task,
    })
  } catch (err) {
    throw new Error(`下载 Mod「${filename}」失败：${err?.message ?? err}`)
  }
  t.log(`Mod 下载完成：${filename}（${formatBytes(res.bytes)}${res.cached ? '，已存在' : ''}）`)
  return { path: dest, filename, bytes: res.bytes }
}
