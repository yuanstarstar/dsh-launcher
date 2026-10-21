// lib/mirrors.js —— 方块游戏（Minecraft）镜像/下载加速规则（适配器自有，核心包保持通用）
//
// 职责（本适配器里唯一允许出现 mojang/bmclapi/forge 等平台名与下载域名的文件）：
//   1) 把官方 Mojang/Forge/NeoForge 下载地址重写成「镜像候选 + 官方兜底」的候选列表；
//   2) 提供 resolveUrl(url) 给核心下载器（ctx.makeDownloader({ resolveUrl })）使用；
//   3) 提供 probeMirrors() 轻量测速，按实测吞吐调整候选顺序并缓存结果；
//   4) 提供 fetchJson / fetchText / downloadFile 三个容错入口（逐个候选源尝试）。
//
// 注意：Fabric/Quilt 元数据、Modrinth API、Adoptium API、Forge promotions 这些
// 「元数据/检索」接口没有可用的国内镜像，resolveUrl 会原样返回，不参与改写。

import { path } from './util.js'
import { formatBytes } from './util.js'

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

export const OFFICIAL = Object.freeze({
  manifest: 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json',
  manifestLegacy: 'https://launchermeta.mojang.com/mc/game/version_manifest_v2.json',
  pistonMeta: 'https://piston-meta.mojang.com/',
  pistonData: 'https://piston-data.mojang.com/v1/objects/',
  libraries: 'https://libraries.minecraft.net/',
  resources: 'https://resources.download.minecraft.net/',
  forgeMaven: 'https://maven.minecraftforge.net/',
  neoforgeMaven: 'https://maven.neoforged.net/releases/',
  forgePromos: 'https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json',
  fabricMeta: 'https://meta.fabricmc.net',
  quiltMeta: 'https://meta.quiltmc.org',
  modrinth: 'https://api.modrinth.com/v2',
  adoptiumApi: 'https://api.adoptium.net',
  adoptiumTuna: 'https://mirrors.tuna.tsinghua.edu.cn/Adoptium',
})

/** bmclapi 与 qlu 镜像（与 v2 实测可用的一致）。 */
export const MIRROR_BASES = Object.freeze([
  { family: 'bmclapi', base: 'https://bmclapi2.bangbang93.com' },
  { family: 'qlu', base: 'https://mirrors4.qlu.edu.cn/bmclapi' },
])

const MANIFEST_PATH = 'mc/game/version_manifest_v2.json'
const DEFAULT_ORDER = {
  manifest: ['bmclapi', 'qlu', 'official'],
  version: ['bmclapi', 'qlu', 'official'],
  client: ['bmclapi', 'qlu', 'official'],
  library: ['qlu', 'bmclapi', 'official'],
  assets: ['bmclapi', 'qlu', 'official'],
}
const KINDS = Object.keys(DEFAULT_ORDER)
const SPEED_TTL_MS = 10 * 60 * 1000
const PROBE_BYTES = 64 * 1024
const PROBE_TIMEOUT_MS = 8000

// 已知可用于测速的小体积静态目标
const PROBE_ASSET_HASH = 'a661b5622172ea1ce1fa9ec78fad484d118e5689'
const PROBE_LIB_PATH = 'net/java/dev/jna/jna/5.13.0/jna-5.13.0.jar'

// ---------------------------------------------------------------------------
// 可变状态（模块级；configureMirrors / probeMirrors 可调整）
// ---------------------------------------------------------------------------

const state = {
  /** 每类资源的源顺序（family 名）；probeMirrors 后会被实测结果重排。 */
  order: { ...DEFAULT_ORDER },
  /** 用户自定义镜像根（例如 https://mirror.example.com），放在候选最前。 */
  customBase: '',
  /** 额外的 NeoForge 镜像根（以 / 结尾），默认用 qlu + bmclapi 的 maven 路径。 */
  extraNeoforgeBase: '',
  /** 最近一次测速结果（probeMirrors）。 */
  speedReport: null,
  /** 同一 URL 的候选缓存（简单 Map，容量上限 512）。 */
  cache: new Map(),
}

/** 允许外部（index.js 的 config.mirror / downloadSource）调整镜像配置。 */
export function configureMirrors(options = {}) {
  if (!options || typeof options !== 'object') return getMirrorState()
  const custom = typeof options.mirror === 'string' ? options.mirror.trim().replace(/\/+$/, '') : ''
  state.customBase = custom
  const neo = typeof options.neoforgeMirror === 'string' ? options.neoforgeMirror.trim() : ''
  state.extraNeoforgeBase = neo
  state.cache.clear()
  return getMirrorState()
}

export function getMirrorState() {
  return {
    order: Object.fromEntries(Object.entries(state.order).map(([kind, list]) => [kind, [...list]])),
    customBase: state.customBase,
    speedReport: state.speedReport ? { ...state.speedReport, results: [...(state.speedReport.results || [])] } : null,
  }
}

/** 测试/重装时重置（不清理用户配置的 customBase）。 */
export function resetMirrorState() {
  state.order = { ...DEFAULT_ORDER }
  state.speedReport = null
  state.cache.clear()
}

// ---------------------------------------------------------------------------
// URL 分类与路径提取
// ---------------------------------------------------------------------------

function parseUrl(raw) {
  try {
    return new URL(String(raw))
  } catch {
    return null
  }
}

function hostOf(raw) {
  return (parseUrl(raw)?.hostname || '').toLowerCase()
}

function kindOfUrl(raw) {
  const parsed = parseUrl(raw)
  if (!parsed) return 'other'
  const p = parsed.pathname
  const host = parsed.hostname.toLowerCase()
  if (/version_manifest/i.test(p)) return 'manifest'
  if (host === 'piston-meta.mojang.com' && /\/v1\/packages\//i.test(p)) return 'version'
  if (/\/version\/[^/]+\/json\/?$/i.test(p)) return 'version'
  if (/\/version\/[^/]+\/(client|server)$/i.test(p)) return 'client'
  if (/\/objects\/[0-9a-f]{40}\/(client|server)\.jar$/i.test(p)) return 'client'
  if (host === 'resources.download.minecraft.net') return 'assets'
  if (/\/assets\/[0-9a-f]{2}\/[0-9a-f]{40}$/i.test(p)) return 'assets'
  if (host === 'libraries.minecraft.net') return 'library'
  if (host === 'maven.minecraftforge.net' || host === 'maven.neoforged.net') return 'library'
  if (/\/maven\//i.test(p)) return 'library'
  if (/bmclapi/i.test(host) || /qn\.edu\.cn$/i.test(host) || /qlu\.edu\.cn$/i.test(host)) {
    if (/\.(jar|zip|pom|xml|json|txt)$/i.test(p)) return 'library'
  }
  return 'other'
}

function versionIdOf(raw) {
  const parsed = parseUrl(raw)
  if (!parsed) return ''
  const m = /\/version\/([^/]+)\/json\/?$/i.exec(parsed.pathname)
  if (m) return decodeURIComponent(m[1])
  if (/\/v1\/packages\//i.test(parsed.pathname)) {
    const file = parsed.pathname.split('/').pop() || ''
    return file.replace(/\.json$/i, '')
  }
  return ''
}

function clientInfoOf(raw) {
  const parsed = parseUrl(raw)
  if (!parsed) return null
  const m = /\/version\/([^/]+)\/(client|server)$/i.exec(parsed.pathname)
  if (m) return { versionId: decodeURIComponent(m[1]), kind: m[2].toLowerCase() }
  const data = /\/objects\/[0-9a-f]{40}\/(client|server)\.jar$/i.exec(parsed.pathname)
  if (data) return { versionId: '', kind: data[1].toLowerCase() }
  return null
}

function mavenPathOf(raw) {
  const text = String(raw || '')
  if (text.startsWith(OFFICIAL.libraries)) return text.slice(OFFICIAL.libraries.length)
  if (text.startsWith(OFFICIAL.neoforgeMaven)) return text.slice(OFFICIAL.neoforgeMaven.length)
  if (text.startsWith(OFFICIAL.forgeMaven)) return text.slice(OFFICIAL.forgeMaven.length)
  const parsed = parseUrl(text)
  if (!parsed) return ''
  const p = parsed.pathname.replace(/^\/+/, '')
  const at = p.indexOf('/maven/')
  if (at >= 0) return p.slice(at + '/maven/'.length)
  if (/bmclapi/i.test(parsed.hostname) || /qlu\.edu\.cn$/i.test(parsed.hostname)) {
    const seg = p.indexOf('/bmclapi/')
    const prefix = seg >= 0 ? '/bmclapi/' : '/'
    const idx = p.indexOf(prefix)
    return idx >= 0 ? p.slice(idx + prefix.length) : p
  }
  return p
}

function assetsPathOf(raw) {
  const text = String(raw || '')
  if (text.startsWith(OFFICIAL.resources)) return text.slice(OFFICIAL.resources.length)
  const parsed = parseUrl(text)
  if (!parsed) return ''
  const p = parsed.pathname.replace(/^\/+/, '')
  if (p.startsWith('assets/')) return p.slice('assets/'.length)
  const at = p.indexOf('/assets/')
  if (at >= 0) return p.slice(at + '/assets/'.length)
  return p
}

function trimBase(base) {
  return String(base || '').trim().replace(/\/+$/, '')
}

/** 是否是已知的版本清单地址（官方或镜像）。 */
function isManifestUrl(raw) {
  const parsed = parseUrl(raw)
  if (!parsed) return false
  return /version_manifest/i.test(parsed.pathname)
}

function knownFamilies() {
  return ['bmclapi', 'qlu', 'official']
}

/** 某 family 对应的镜像根；official 返回 ''。 */
function baseOf(family) {
  if (family === 'official') return ''
  const found = MIRROR_BASES.find((item) => item.family === family)
  return found ? found.base : ''
}

/** 按 state.order[kind] 排序候选（保持未知 family 在最后）。 */
function orderByKind(entries, kind) {
  const order = state.order[kind] || DEFAULT_ORDER[kind] || knownFamilies()
  const rankOf = (family) => {
    if (family === 'custom') return -1 // 用户自定义镜像根排最前
    const at = order.indexOf(family)
    return at < 0 ? order.length + 1 : at
  }
  return [...entries]
    .map((entry, index) => ({ ...entry, index, rank: rankOf(entry.family) }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map((entry) => entry.url)
}

function dedupe(list) {
  const seen = new Set()
  const out = []
  for (const item of list) {
    if (typeof item !== 'string' || !item) continue
    if (seen.has(item)) continue
    seen.add(item)
    out.push(item)
  }
  return out
}

/** 合并自定义镜像根提供的候选（放在最前）。 */
function withCustom(familyEntries) {
  if (!state.customBase) return familyEntries
  const custom = state.customBase
  const extra = []
  for (const entry of familyEntries) {
    if (entry.family !== 'official') continue
    // 只有镜像类路径能套自定义根：maven / assets / version / manifest
    const pathText = entry.path
    if (!pathText) continue
    extra.push({ family: 'custom', url: pathText.startsWith('maven/') ? `${custom}/maven/${pathText.slice(6)}` : `${custom}/${pathText}` })
  }
  return [...extra, ...familyEntries]
}

// ---------------------------------------------------------------------------
// resolveUrl：核心入口
// ---------------------------------------------------------------------------

/**
 * 把官方下载地址解析成候选地址数组（镜像优先、官方兜底）。
 * 供核心下载器：ctx.makeDownloader({ resolveUrl })；同步函数，无网络。
 */
export function resolveUrl(url) {
  const raw = String(url || '')
  if (!raw) return []
  const cached = state.cache.get(raw)
  if (cached) return [...cached]

  const kind = kindOfUrl(raw)
  let out = [raw]

  try {
    if (kind === 'manifest' && isManifestUrl(raw)) {
      const entries = []
      for (const family of knownFamilies()) {
        const base = baseOf(family)
        entries.push({ family, path: MANIFEST_PATH, url: base ? `${base}/${MANIFEST_PATH}` : OFFICIAL.manifest })
      }
      out = orderByKind(withCustom(entries), 'manifest')
      if (!out.includes(raw)) out.push(raw)
      if (raw !== OFFICIAL.manifest) out = dedupe([raw, ...out])
    } else if (kind === 'version') {
      const versionId = versionIdOf(raw)
      if (versionId) {
        const entries = []
        for (const family of knownFamilies()) {
          const base = baseOf(family)
          entries.push({
            family,
            path: `version/${encodeURIComponent(versionId)}/json`,
            url: base ? `${base}/version/${encodeURIComponent(versionId)}/json` : raw,
          })
        }
        out = orderByKind(withCustom(entries), 'version')
        out = dedupe(out)
      } else {
        out = [raw]
      }
    } else if (kind === 'client') {
      const info = clientInfoOf(raw)
      if (info?.versionId) {
        const entries = []
        for (const family of knownFamilies()) {
          const base = baseOf(family)
          entries.push({
            family,
            path: `version/${encodeURIComponent(info.versionId)}/${info.kind}`,
            url: base ? `${base}/version/${encodeURIComponent(info.versionId)}/${info.kind}` : raw,
          })
        }
        out = orderByKind(withCustom(entries), 'client')
        out = dedupe(out)
      } else {
        // 官方 /objects/<sha>/client.jar 无法从 URL 反推版本号：客户端 jar 由
        // mirrors.clientJarCandidates(versionId, ...) 显式处理。
        out = [raw]
      }
    } else if (kind === 'library') {
      const mavenPath = mavenPathOf(raw)
      if (mavenPath) {
        const entries = []
        for (const family of knownFamilies()) {
          const base = baseOf(family)
          entries.push({ family, path: `maven/${mavenPath}`, url: base ? (family === 'qlu' ? `${base}/${mavenPath}` : `${base}/maven/${mavenPath}`) : raw })
        }
        out = orderByKind(withCustom(entries), 'library')
        out = dedupe(out)
      }
    } else if (kind === 'assets') {
      const p = assetsPathOf(raw)
      if (p) {
        const entries = []
        for (const family of knownFamilies()) {
          const base = baseOf(family)
          entries.push({ family, path: `assets/${p}`, url: base ? `${base}/assets/${p}` : raw })
        }
        out = orderByKind(withCustom(entries), 'assets')
        out = dedupe(out)
      }
    } else if (kind === 'other') {
      // NeoForge 安装器：官方 maven 不可达，先走镜像（qlu 的 /bmclapi 根或 bmclapi 的 /maven 根）。
      const text = raw
      if (text.startsWith(OFFICIAL.neoforgeMaven)) {
        const rel = text.slice(OFFICIAL.neoforgeMaven.length)
        const entries = []
        for (const family of knownFamilies()) {
          const base = baseOf(family)
          if (!base) continue
          entries.push({ family, path: rel, url: family === 'qlu' ? `${base}/${rel}` : `${base}/maven/${rel}` })
        }
        entries.push({ family: 'official', path: rel, url: raw })
        out = orderByKind(entries, 'library')
        out = dedupe(out)
      }
    }
  } catch {
    out = [raw]
  }

  out = dedupe(out)
  if (state.cache.size > 512) state.cache.clear()
  state.cache.set(raw, out)
  return [...out]
}

/**
 * 带上下文解析（核心下载器的 resolveUrl 不带 ctx）：目前用于客户端 jar
 * （官方 objects URL 反推不出游戏版本 id）。下载入口内部会用它。
 */
export function resolveUrlWithContext(url, ctx = {}) {
  const info = clientInfoOf(String(url || ''))
  if (info && !info.versionId) {
    const versionId = ctx && typeof ctx.versionId === 'string' ? ctx.versionId.trim() : ''
    if (!versionId) return resolveUrl(url)
    return clientJarCandidates(versionId, url, info.kind)
  }
  return resolveUrl(url)
}

/** 客户端 jar 的候选地址（bmclapi /version/<id>/client 无需知道 objects 哈希）。 */
export function clientJarCandidates(versionId, raw, kind = 'client') {
  const candidateKind = kind === 'server' ? 'server' : 'client'
  const entries = []
  for (const family of knownFamilies()) {
    const base = baseOf(family)
    entries.push({
      family,
      path: `version/${encodeURIComponent(versionId)}/${candidateKind}`,
      url: base ? `${base}/version/${encodeURIComponent(versionId)}/${candidateKind}` : String(raw || ''),
    })
  }
  const ordered = orderByKind(entries, 'client')
  return dedupe([...ordered, String(raw || '')].filter(Boolean))
}

// ---------------------------------------------------------------------------
// 容错请求入口
// ---------------------------------------------------------------------------

function isCancelledError(error) {
  const text = String(error?.message ?? error ?? '')
  return /任务已取消|已取消|aborted|ABORT_ERR|cancelled/i.test(text)
}

/** 逐个候选源尝试 fetchJson；任何一源成功即返回。 */
export async function fetchJson(dl, url, opts = {}) {
  if (!dl || typeof dl.fetchJson !== 'function') {
    throw new Error('缺少下载器（fetchJson），无法请求：' + String(url))
  }
  const candidates = resolveUrlWithContext(url, opts.ctx || {})
  const errors = []
  for (const candidate of candidates) {
    try {
      return await dl.fetchJson(candidate, { timeoutMs: 25000, ...opts })
    } catch (error) {
      if (isCancelledError(error)) throw error
      errors.push(`${candidate}: ${error?.message ?? error}`)
    }
  }
  throw new Error(`请求失败：${String(url)}（已尝试 ${candidates.length} 个候选源）${errors.length ? `；${errors.join(' ；')}` : ''}`)
}

/** 逐个候选源尝试 fetchText（NeoForge maven-metadata.xml 等场景）。 */
export async function fetchText(dl, url, opts = {}) {
  if (!dl || typeof dl.fetchText !== 'function') {
    throw new Error('缺少下载器（fetchText），无法请求：' + String(url))
  }
  const candidates = resolveUrlWithContext(url, opts.ctx || {})
  const errors = []
  for (const candidate of candidates) {
    try {
      return await dl.fetchText(candidate, { timeoutMs: 25000, ...opts })
    } catch (error) {
      if (isCancelledError(error)) throw error
      errors.push(`${candidate}: ${error?.message ?? error}`)
    }
  }
  throw new Error(`请求失败：${String(url)}（已尝试 ${candidates.length} 个候选源）${errors.length ? `；${errors.join(' ；')}` : ''}`)
}

// ---------------------------------------------------------------------------
// 下载器/文件下载
// ---------------------------------------------------------------------------

const downloaderCache = new WeakMap()

/** 取「带镜像解析」的下载器（核心 ctx.makeDownloader({resolveUrl})）；失败时退回 ctx.dl。 */
export function makeDownloader(ctx, extra = {}) {
  if (!ctx || typeof ctx !== 'object') throw new Error('缺少适配器上下文 ctx，无法创建下载器')
  const key = ctx.dl || ctx
  if (typeof ctx.makeDownloader === 'function') {
    try {
      const created = ctx.makeDownloader({ resolveUrl, ...extra })
      if (created) return created
    } catch {
      /* 退回 ctx.dl */
    }
  }
  if (ctx.dl) return ctx.dl
  throw new Error('缺少下载器（ctx.dl / ctx.makeDownloader），无法下载文件')
}

/** 文件下载：显式按候选源逐个尝试，确保镜像优先（核心下载器内部也会做一次）。 */
export async function downloadFile(ctx, url, destPath, opts = {}) {
  const dl = makeDownloader(ctx)
  if (typeof dl.downloadFile !== 'function') throw new Error('下载器不可用：缺少 downloadFile()')
  const candidates = resolveUrlWithContext(url, opts.ctx || {})
  if (!candidates.length) candidates.push(String(url))
  const errors = []
  for (const candidate of candidates) {
    try {
      return await dl.downloadFile(candidate, destPath, opts)
    } catch (error) {
      if (isCancelledError(error)) throw error
      errors.push(`${error?.message ?? error}`)
    }
  }
  const detail = errors.length ? `；最后错误：${errors[errors.length - 1]}` : ''
  throw new Error(`下载失败：${path.basename(String(destPath))}（已尝试 ${candidates.length} 个源：${candidates.join('、')}）${detail}`)
}

// ---------------------------------------------------------------------------
// 轻量测速：64KB Range 探测，按实测吞吐重排候选顺序
// ---------------------------------------------------------------------------

function probeTargets() {
  return [
    { family: 'bmclapi', url: `${baseOf('bmclapi')}/${MANIFEST_PATH}` },
    { family: 'qlu', url: `${baseOf('qlu')}/${PROBE_LIB_PATH}` },
    { family: 'bmclapi-lib', url: `${baseOf('bmclapi')}/maven/${PROBE_LIB_PATH}` },
    { family: 'official', url: OFFICIAL.manifest },
    { family: 'official-lib', url: `${OFFICIAL.libraries}${PROBE_LIB_PATH}` },
    { family: 'bmclapi-asset', url: `${baseOf('bmclapi')}/assets/${PROBE_ASSET_HASH.slice(0, 2)}/${PROBE_ASSET_HASH}` },
    { family: 'official-asset', url: `${OFFICIAL.resources}${PROBE_ASSET_HASH.slice(0, 2)}/${PROBE_ASSET_HASH}` },
  ]
}

async function probeOne(target, timeoutMs) {
  const startedAt = Date.now()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(target.url, {
      headers: { range: `bytes=0-${PROBE_BYTES - 1}`, 'accept-encoding': 'identity', 'user-agent': 'dsh-mc-adapter/3.0.0' },
      signal: controller.signal,
    })
    if (!response.ok && response.status !== 206) {
      throw new Error(`HTTP ${response.status}`)
    }
    let got = 0
    for await (const chunk of response.body ?? []) {
      got += chunk.length
      if (got >= PROBE_BYTES) break
    }
    const ms = Math.max(1, Date.now() - startedAt)
    return { ...target, ok: true, bytes: got, ms, kbps: got / 1024 / (ms / 1000) }
  } catch (error) {
    return { ...target, ok: false, bytes: 0, ms: Date.now() - startedAt, kbps: 0, error: String(error?.message ?? error) }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 轻量测速并重排候选顺序（结果缓存 10 分钟）。
 * @param {{timeoutMs?:number, force?:boolean, logger?:(line:string)=>void}} [options]
 */
export async function probeMirrors(options = {}) {
  const timeoutMs = Math.max(1000, Math.min(30000, Number(options.timeoutMs) || PROBE_TIMEOUT_MS))
  const report = state.speedReport
  if (!options.force && report && Date.now() - report.at < SPEED_TTL_MS) return report

  const results = await Promise.all(probeTargets().map((target) => probeOne(target, timeoutMs)))
  const byFamily = new Map()
  for (const item of results) {
    const family = item.family.split('-')[0] === 'official' ? 'official' : item.family.split('-')[0]
    const prev = byFamily.get(family)
    if (!prev || item.kbps > prev.kbps) byFamily.set(family, { family, kbps: item.kbps, ok: item.ok })
  }
  const measured = [...byFamily.values()].sort((a, b) => b.kbps - a.kbps).map((item) => item.family)
  for (const kind of KINDS) {
    const defaults = DEFAULT_ORDER[kind]
    const merged = [...measured, ...defaults].filter((family, index, list) => list.indexOf(family) === index)
    state.order[kind] = merged
  }
  const top = results.filter((item) => item.ok).sort((a, b) => b.kbps - a.kbps)[0] || null
  const reportValue = {
    at: Date.now(),
    timeoutMs,
    order: Object.fromEntries(Object.entries(state.order).map(([kind, list]) => [kind, [...list]])),
    best: top ? { family: top.family, kbps: Math.round(top.kbps), ms: top.ms } : null,
    results: results.map((item) => ({ family: item.family, url: item.url, ok: item.ok, kbps: Math.round(item.kbps || 0), ms: item.ms, error: item.error || undefined })),
    summary: results.map((item) => `${item.family}=${item.ok ? `${formatBytes(item.bytes)}/${item.ms}ms` : `失败(${item.error})`}`).join('，'),
  }
  state.speedReport = reportValue
  state.cache.clear()
  try {
    options.logger?.(`镜像测速：${reportValue.summary}`)
  } catch {
    /* 忽略日志异常 */
  }
  return reportValue
}
