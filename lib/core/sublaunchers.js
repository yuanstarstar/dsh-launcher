// DSH启动器 v4 · 附属启动器管理（通用）
//
// 附属启动器是独立项目打成的 zip 包：核心只负责「解析来源 → 下载 → 校验 → 解压 → 注册桥接 → 热加载」，
// 不包含任何具体游戏或平台的实现。包格式与存储布局见 docs/ARCHITECTURE.md。
//
// 存储布局（dataRoot 下）：
//   sub-launchers/registry.json                 安装清单
//   sub-launchers/<id>/<version>/...            解压后的包内容（含 launcher.json）
//   adapters/sublauncher-<id>.mjs               核心生成的加载桥（导出包内 entry 的默认导出）
//
// 本文件属于核心包：不得出现任何具体游戏/平台字样。
import fsp from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { pathExists, readJson, writeJson, formatBytes } from './paths.js'
import { listZipEntries, readZipText } from './zip.js'
import { extractArchiveToDir, looksLikeZip } from './archive.js'
import { listGames as registryListGames, getGameInfo } from './registry.js'

const DEFAULT_CORE_VERSION = '3.2.0'
const MAX_ZIP_BYTES = 25 * 1024 * 1024
const MAX_EXTRACT_BYTES = 200 * 1024 * 1024
const MAX_MANIFEST_BYTES = 256 * 1024
const GITHUB_API_BASE = 'https://api.github.com'
const LAUNCHER_ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,40}$/
const REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/
const SEMVER_PATTERN = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/
const FORBIDDEN_SEGMENTS = new Set(['data', 'node_modules', '.git'])
const SOURCE_KINDS = new Set(['github', 'url', 'file'])

// GitHub Release 资产直连在部分网络下会建连超时：按「镜像优先、直连兜底」顺序尝试。
// 镜像只做地址前缀拼接，不改变原始 URL 路径，失败会自动尝试下一个。
const GITHUB_DOWNLOAD_MIRRORS = ['https://gh-proxy.com/', 'https://ghfast.top/', 'https://ghproxy.net/']

/** 生成下载候选地址：GitHub Release 资产返回镜像 + 直连，其它地址原样返回。 */
export function downloadCandidates(url) {
  const raw = text(url)
  if (!raw) return []
  let parsed = null
  try {
    parsed = new URL(raw)
  } catch {
    return [raw]
  }
  const isGithub =
    /(^|\.)github\.com$/i.test(parsed.hostname) || /(^|\.)githubusercontent\.com$/i.test(parsed.hostname)
  if (!isGithub) return [raw]
  return [...GITHUB_DOWNLOAD_MIRRORS.map((prefix) => prefix + raw), raw]
}

function fail(message) {
  throw new Error(message)
}

function errorMessage(error) {
  return error && error.message ? String(error.message) : String(error)
}

function text(value, fallback = '') {
  if (value == null) return fallback
  if (typeof value === 'string') return value.trim() || fallback
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return fallback
}

function toPosixName(name) {
  return String(name == null ? '' : name).replace(/\\/g, '/')
}

function normalizeEntryName(name) {
  return toPosixName(name)
    .replace(/^\.\/+/, '')
    .replace(/\/+$/, '')
}

function isPromiseLike(value) {
  return !!value && typeof value.then === 'function'
}

// ---------------------------------------------------------------------------
// 版本号（简单 semver：major.minor.patch[-prerelease][+build]）
// ---------------------------------------------------------------------------

/** 解析版本号，允许前缀 v（GitHub tag 常见）；非法返回 null。 */
export function parseSemver(value) {
  const raw = text(value)
  if (!raw) return null
  const cleaned = raw.replace(/^[vV]/, '').split('+')[0]
  const match = SEMVER_PATTERN.exec(cleaned)
  if (!match) return null
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ? match[4].split('.') : [],
  }
}

/** 严格 semver（manifest 用，不允许 v 前缀，允许 +build 元数据）。 */
export function isStrictSemver(value) {
  const raw = text(value)
  if (!raw || /^[vV]/.test(raw)) return false
  return SEMVER_PATTERN.test(raw.split('+')[0])
}

/**
 * 比较两个版本号：a<b 返回负数，a>b 返回正数，相等返回 0。
 * 支持预发布版本（1.0.0-alpha < 1.0.0）。
 */
export function compareVersion(a, b) {
  const left = parseSemver(a)
  const right = parseSemver(b)
  if (!left || !right) fail('无法比较版本号：' + String(!left ? a : b))
  for (const key of ['major', 'minor', 'patch']) {
    if (left[key] !== right[key]) return left[key] < right[key] ? -1 : 1
  }
  const aPre = left.prerelease
  const bPre = right.prerelease
  if (!aPre.length && !bPre.length) return 0
  if (!aPre.length) return 1
  if (!bPre.length) return -1
  const length = Math.max(aPre.length, bPre.length)
  for (let index = 0; index < length; index += 1) {
    const x = aPre[index]
    const y = bPre[index]
    if (x === undefined) return -1
    if (y === undefined) return 1
    if (x === y) continue
    const xNumeric = /^\d+$/.test(x)
    const yNumeric = /^\d+$/.test(y)
    if (xNumeric && yNumeric) return Number(x) < Number(y) ? -1 : 1
    if (xNumeric) return -1
    if (yNumeric) return 1
    return x < y ? -1 : 1
  }
  return 0
}

/** 最新版本是否比已安装版本新。 */
export function isUpdateAvailable(installedVersion, latestVersion) {
  return compareVersion(latestVersion, installedVersion) > 0
}

// ---------------------------------------------------------------------------
// 资产匹配（简单通配符：* 任意多字符，? 单个字符，忽略大小写）
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// GitHub 网页解析（回退路径）
// 部分网络环境（公司代理 / 镜像 / 限流）无法访问 api.github.com，但 github.com 网页可用。
// 此时改为解析 releases/latest 的跳转（拿到 tag）与 releases/expanded_assets/<tag> 的附件链接。
// ---------------------------------------------------------------------------

const GITHUB_WEB_BASE = 'https://github.com'
const GITHUB_WEB_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36'

async function fetchWebText(url) {
  const attempts = 3
  let lastError = null
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    let response = null
    try {
      response = await fetch(url, {
        method: 'GET',
        headers: { 'user-agent': GITHUB_WEB_UA, accept: 'text/html,application/xhtml+xml' },
        redirect: 'follow',
        signal: AbortSignal.timeout(20000),
      })
    } catch (error) {
      lastError = error
      response = null
    }
    if (response && response.ok) {
      return { text: await response.text(), finalUrl: response.url || url }
    }
    if (response) {
      lastError = new Error('HTTP ' + response.status)
      if (response.status !== 429 && response.status < 500) {
        fail('GitHub 网页请求失败（HTTP ' + response.status + '）：' + url)
      }
    }
    if (attempt < attempts) {
      const delay = 700 * attempt + Math.floor(Math.random() * 300)
      await new Promise((resolve) => setTimeout(resolve, delay))
    }
  }
  fail('无法访问 GitHub 网页（已重试 ' + attempts + ' 次）：' + errorMessage(lastError))
}

/** 从 https://github.com/<repo>/releases/tag/<tag> 形式的地址里取出 tag。 */
export function parseGithubTagFromUrl(url) {
  const matched = /\/releases\/tag\/([^/?#]+)/.exec(String(url || ''))
  return matched ? decodeURIComponent(matched[1]) : ''
}

/** 从 GitHub Release 附件页面 HTML 里解析下载链接（/releases/download/<tag>/<file>）。 */
export function parseReleaseAssetsFromHtml(html, tag) {
  const source = String(html || '')
  const assets = new Map()
  const pattern = /href="([^"]*\/releases\/download\/([^/"]+)\/([^/"]+))"/g
  let matched
  while ((matched = pattern.exec(source))) {
    const href = matched[1].split('?')[0]
    const name = decodeURIComponent(matched[3])
    if (!name) continue
    const url = /^https?:/i.test(href) ? href : GITHUB_WEB_BASE + href
    if (!assets.has(name)) assets.set(name, { name, browser_download_url: url, tag: text(tag) })
  }
  return [...assets.values()]
}

/** 通过网页解析指定 tag（不传则取 latest）的 Release 资产列表。 */
export async function fetchReleaseViaWeb(repo, options = {}) {
  let tag = text(options.tag)
  if (!tag) {
    const latest = await fetchWebText(GITHUB_WEB_BASE + '/' + repo + '/releases/latest')
    tag = parseGithubTagFromUrl(latest.finalUrl)
    if (!tag) fail('无法从 GitHub 网页解析最新 Release 版本：' + repo)
  }
  const assetsPage = await fetchWebText(
    GITHUB_WEB_BASE + '/' + repo + '/releases/expanded_assets/' + encodeURIComponent(tag),
  )
  const assets = parseReleaseAssetsFromHtml(assetsPage.text, tag)
  if (!assets.length) {
    fail(
      'GitHub Release 没有可下载的 zip 附件：' +
        repo +
        ' ' +
        tag +
        '（请在仓库 Release 页上传 .zip 资产，或用「zip 下载地址」来源安装）',
    )
  }
  return { tag_name: tag, name: tag, assets, webFallback: true }
}

function escapeRegExp(input) {
  return String(input).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** GitHub Release 资产文件名通配符匹配；pattern 为空视为全部匹配。 */
export function matchAssetPattern(fileName, pattern) {
  const name = text(fileName)
  const glob = text(pattern)
  if (!glob) return true
  const source = '^' + escapeRegExp(glob).replace(/\\\*/g, '.*').replace(/\\\?/g, '.') + '$'
  try {
    return new RegExp(source, 'i').test(name)
  } catch {
    return false
  }
}

/** 从 Release 里选 zip 资产：有 assetPattern 按通配符过滤，否则取第一个 zip。 */
export function selectReleaseAsset(release, assetPattern) {
  const assets = release && Array.isArray(release.assets) ? release.assets : []
  const zips = assets.filter(
    (asset) =>
      asset &&
      typeof asset.name === 'string' &&
      /\.zip$/i.test(asset.name) &&
      (asset.browser_download_url || asset.url),
  )
  if (!zips.length) fail('该 GitHub Release 没有 zip 资产')
  if (text(assetPattern)) {
    const matched = zips.filter((asset) => matchAssetPattern(asset.name, assetPattern))
    if (!matched.length) fail('该 GitHub Release 没有匹配 assetPattern 的 zip 资产：' + text(assetPattern))
    return matched[0]
  }
  return zips[0]
}

// ---------------------------------------------------------------------------
// launcher.json 校验（包格式契约）
// ---------------------------------------------------------------------------

/**
 * 校验 launcher.json 内容，返回规整后的清单对象；不合法抛中文错误。
 * @param {object} manifest 解析后的 launcher.json
 * @param {{coreVersion?:string, files?:Map<string,object>}} [options] files 为包内文件表（用于校验 entry 是否存在）
 */
export function validateLauncherManifest(manifest, options = {}) {
  const coreVersion = text(options.coreVersion) || DEFAULT_CORE_VERSION
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    fail('launcher.json 内容无效：必须是 JSON 对象')
  }
  if (Number(manifest.schemaVersion) !== 1) {
    fail('不支持的 launcher.json 版本：' + String(manifest.schemaVersion) + '（需要 1）')
  }
  const id = text(manifest.id)
  if (!LAUNCHER_ID_PATTERN.test(id)) {
    fail(
      'launcher.json 的 id 无效：' +
        (id || '（空）') +
        '（只允许小写字母、数字和连字符，长度 2-41，且以字母或数字开头）',
    )
  }
  const label = text(manifest.label)
  if (!label) fail('launcher.json 缺少 label（显示名称）')
  const version = text(manifest.version)
  if (!isStrictSemver(version)) {
    fail('launcher.json 的 version 不是合法 semver：' + (version || '（空）') + '（示例 1.0.0）')
  }
  const entry = normalizeEntryName(manifest.entry)
  if (!entry) fail('launcher.json 缺少 entry（入口模块路径）')
  if (entry.startsWith('/') || /^[A-Za-z]:/.test(entry)) {
    fail('launcher.json 的 entry 必须是包内相对路径：' + entry)
  }
  const segments = entry.split('/')
  if (segments.some((segment) => segment === '..' || segment === '.' || segment === '')) {
    fail('launcher.json 的 entry 不能包含 ./ 或 ../ 路径段：' + entry)
  }
  const minCoreVersion = text(manifest.minCoreVersion)
  if (minCoreVersion) {
    if (!isStrictSemver(minCoreVersion)) {
      fail('launcher.json 的 minCoreVersion 不是合法 semver：' + minCoreVersion)
    }
    if (compareVersion(coreVersion, minCoreVersion) < 0) {
      fail('需要核心版本 >= ' + minCoreVersion + '（当前 ' + coreVersion + '），请先升级启动器本体')
    }
  }
  const files = options.files
  if (files && typeof files.has === 'function' && !files.has(entry)) {
    fail('launcher.json 的 entry 不存在于包内：' + entry)
  }
  return {
    schemaVersion: 1,
    id,
    label,
    version,
    entry,
    minCoreVersion: minCoreVersion || null,
    description: text(manifest.description) || null,
    homepage: text(manifest.homepage) || null,
    gamesHint: Array.isArray(manifest.gamesHint)
      ? manifest.gamesHint.map((item) => text(item)).filter(Boolean)
      : [],
  }
}

/** 校验包内路径与体积上限，返回 { files: Map<name,entry>, totalBytes }。 */
function inspectPackageEntries(entries) {
  const files = new Map()
  let totalBytes = 0
  for (const entry of entries) {
    if (!entry || entry.isDirectory) continue
    const name = normalizeEntryName(entry.name)
    if (!name) continue
    for (const segment of name.split('/')) {
      if (FORBIDDEN_SEGMENTS.has(segment.toLowerCase())) {
        fail('附属启动器包包含不允许的路径：' + name + '（不能包含 data/、node_modules/、.git/）')
      }
    }
    totalBytes += Number(entry.size) || 0
    files.set(name, entry)
  }
  if (totalBytes > MAX_EXTRACT_BYTES) {
    fail(
      '附属启动器包解压后过大（' +
        formatBytes(totalBytes) +
        ' > 上限 ' +
        formatBytes(MAX_EXTRACT_BYTES) +
        '）',
    )
  }
  return { files, totalBytes }
}

// ---------------------------------------------------------------------------
// 注册表
// ---------------------------------------------------------------------------

function normalizeRegistry(raw) {
  const registry = { schemaVersion: 1, launchers: [] }
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.launchers)) return registry
  for (const item of raw.launchers) {
    if (!item || typeof item !== 'object') continue
    const id = text(item.id)
    if (!id) continue
    const version = text(item.version)
    const entry = normalizeEntryName(item.entry)
    registry.launchers.push({
      id,
      label: text(item.label) || id,
      version,
      entry,
      source: SOURCE_KINDS.has(text(item.source)) ? text(item.source) : 'file',
      repo: text(item.repo) || undefined,
      url: text(item.url) || undefined,
      assetPattern: text(item.assetPattern) || undefined,
      description: text(item.description) || undefined,
      homepage: text(item.homepage) || undefined,
      minCoreVersion: text(item.minCoreVersion) || undefined,
      installedAt: text(item.installedAt) || null,
      updatedAt: text(item.updatedAt) || null,
      dir: text(item.dir) || path.posix.join(id, version),
    })
  }
  return registry
}

// ---------------------------------------------------------------------------
// 管理器
// ---------------------------------------------------------------------------

/**
 * 创建附属启动器管理器。
 * @param {object} options
 * @param {object} options.paths 数据路径（lib/core/paths.js 的 createPaths 返回值）
 * @param {object} [options.dl] 下载器（lib/core/http.js 的 createDownloader 返回值）
 * @param {(line:string)=>void} [options.logger] 日志回调
 * @param {Function} [options.runJob] 任务包装：真实签名 (kind,title,instanceId,fn)->{id,promise}；
 *                                    也兼容 (kind,title,fn)->Promise 与 (kind,{title},fn)->Promise
 * @param {()=>Promise<any>} [options.reloadGames] 热加载回调（engine 的 reloadGames）
 * @param {string} [options.coreVersion] 核心版本（semver），默认 3.2.0
 * @param {(url:string,opts?:object)=>Promise<any>} [options.fetchJson] 可选的 HTTP JSON 实现（测试/自定义）
 * @param {()=>Array<any>} [options.listGames] 可选的游戏列表回调（默认读核心注册表）
 */
export function createSubLauncherManager(options = {}) {
  const paths = options && options.paths
  if (!paths || typeof paths !== 'object') fail('缺少数据路径（paths）')
  const subRoot = path.resolve(
    text(paths.subLaunchers) || path.join(String(paths.root || ''), 'sub-launchers'),
  )
  if (!paths.root && !paths.subLaunchers) fail('数据路径缺少 root（paths.root）')
  const adaptersDir = path.resolve(text(paths.adapters) || path.join(String(paths.root), 'adapters'))
  const registryFile = path.resolve(
    text(paths.subLauncherRegistry) || path.join(subRoot, 'registry.json'),
  )
  const tmpDir = path.resolve(text(paths.tmp) || path.join(String(paths.root || ''), 'tmp'))

  const coreVersion = text(options.coreVersion) || DEFAULT_CORE_VERSION
  if (!parseSemver(coreVersion)) fail('核心版本号无效：' + coreVersion)
  const logger = typeof options.logger === 'function' ? options.logger : null
  const runJob = typeof options.runJob === 'function' ? options.runJob : null
  const reloadGames = typeof options.reloadGames === 'function' ? options.reloadGames : null
  const fetchJsonOption = typeof options.fetchJson === 'function' ? options.fetchJson : null
  const listGamesOption = typeof options.listGames === 'function' ? options.listGames : null

  let dlRef = options.dl || null
  let writeChain = Promise.resolve()

  function logLine(line) {
    try {
      if (logger) logger('[附属启动器] ' + line)
    } catch {
      /* 忽略日志回调异常 */
    }
  }

  function taskLog(task, line) {
    try {
      if (task && typeof task.log === 'function') task.log(line)
    } catch {
      /* 忽略日志回调异常 */
    }
  }

  function taskPhase(task, phase) {
    try {
      if (task && typeof task.setPhase === 'function') task.setPhase(phase)
    } catch {
      /* 忽略进度回调异常 */
    }
  }

  function taskItems(task, done, total, label) {
    try {
      if (task && typeof task.items === 'function') task.items(done, total, label)
    } catch {
      /* 忽略进度回调异常 */
    }
  }

  function assertNotCancelled(task) {
    if (task && task.cancelRequested) fail('任务已取消')
  }

  // ---------- 写操作串行化（注册表读-改-写） ----------

  function withWriteLock(work) {
    const run = writeChain.then(work, work)
    writeChain = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  // ---------- 路径推导 ----------

  function launcherDirAbs(item) {
    const relative = text(item && item.dir) || path.posix.join(text(item && item.id), text(item && item.version))
    return path.resolve(subRoot, relative)
  }

  function bridgeFileOf(launcherId) {
    return path.join(adaptersDir, 'sublauncher-' + launcherId + '.mjs')
  }

  // ---------- 注册表读写 ----------

  async function readRegistry({ strict = false } = {}) {
    if (!(await pathExists(registryFile))) return { schemaVersion: 1, launchers: [] }
    const raw = await readJson(registryFile, null)
    if (raw === null || raw === undefined) {
      const message = '附属启动器注册表无效或无法读取：' + registryFile
      if (strict) fail(message)
      logLine('警告：' + message + '（按空表处理）')
      return { schemaVersion: 1, launchers: [] }
    }
    return normalizeRegistry(raw)
  }

  async function writeRegistry(registry) {
    await writeJson(registryFile, {
      schemaVersion: 1,
      launchers: registry.launchers.map((item) => {
        const record = {
          id: item.id,
          label: item.label,
          version: item.version,
          entry: item.entry,
          source: item.source,
          installedAt: item.installedAt,
          updatedAt: item.updatedAt,
          dir: item.dir,
        }
        if (item.repo) record.repo = item.repo
        if (item.url) record.url = item.url
        if (item.assetPattern) record.assetPattern = item.assetPattern
        if (item.description) record.description = item.description
        if (item.homepage) record.homepage = item.homepage
        if (item.minCoreVersion) record.minCoreVersion = item.minCoreVersion
        return record
      }),
    })
  }

  // ---------- 游戏归属（加载桥给适配器打标记，这里按标记归组） ----------

  function currentGames() {
    if (listGamesOption) {
      try {
        const produced = listGamesOption()
        if (Array.isArray(produced)) return produced
      } catch {
        /* 回退到核心注册表 */
      }
    }
    try {
      return registryListGames()
    } catch {
      return []
    }
  }

  function gamesOfLauncher(launcherId) {
    const ids = []
    for (const game of currentGames()) {
      if (!game || typeof game.id !== 'string') continue
      if (game.source !== 'external') continue
      let adapter = null
      try {
        const info = getGameInfo(game.id)
        adapter = info && info.adapter ? info.adapter : null
      } catch {
        adapter = null
      }
      if (adapter && adapter.__subLauncherId === launcherId) ids.push(game.id)
    }
    return ids
  }

  // ---------- HTTP JSON（GitHub API） ----------

  function githubHeaders() {
    return {
      accept: 'application/vnd.github+json',
      'user-agent': 'dsh-launcher/' + coreVersion,
    }
  }

  function githubApiError(status, detail) {
    const suffix = text(detail) ? '：' + text(detail) : ''
    if (status === 401) return 'GitHub 接口认证失败（缺少或无效的 token）' + suffix
    if (status === 403 || status === 429) return 'GitHub 接口访问受限或因请求过多被限流，请稍后再试' + suffix
    if (status === 404) return 'GitHub 仓库不存在或没有 Release' + suffix
    if (status >= 500) return 'GitHub 接口暂时不可用（HTTP ' + status + '），请稍后再试'
    return 'GitHub 接口请求失败（HTTP ' + (status || '未知') + '）' + suffix
  }

  async function fetchGitHubJson(url, detailHint) {
    if (fetchJsonOption) {
      try {
        return await fetchJsonOption(url, { headers: githubHeaders() })
      } catch (error) {
        fail(githubApiError(Number(error && error.status) || 0, detailHint || errorMessage(error)))
      }
    }
    if (dlRef && typeof dlRef.fetchJson === 'function') {
      try {
        return await dlRef.fetchJson(url, { headers: githubHeaders(), timeoutMs: 20000 })
      } catch (error) {
        fail(githubApiError(Number(error && error.status) || 0, detailHint || errorMessage(error)))
      }
    }
    let response
    try {
      response = await fetch(url, {
        method: 'GET',
        headers: githubHeaders(),
        signal: AbortSignal.timeout(20000),
      })
    } catch (error) {
      fail('无法访问 GitHub：' + errorMessage(error))
    }
    if (!response.ok) {
      let detail = ''
      try {
        detail = String(await response.text()).slice(0, 160)
      } catch {
        detail = ''
      }
      fail(githubApiError(response.status, detail || detailHint))
    }
    try {
      return await response.json()
    } catch {
      fail('GitHub 接口返回内容不是合法 JSON')
    }
  }

  async function fetchLatestRelease(repo, options = {}) {
    const wantedTag = text(options.tag)
    if (wantedTag) {
      // 指定版本：走网页解析（API 的按 tag 查询同样依赖 api.github.com，不可用时无收益）
      try {
        return await fetchReleaseViaWeb(repo, { tag: wantedTag })
      } catch (error) {
        fail('读取 GitHub Release 失败（' + repo + ' ' + wantedTag + '）：' + errorMessage(error))
      }
    }
    const url = GITHUB_API_BASE + '/repos/' + repo + '/releases/latest'
    try {
      const data = await fetchGitHubJson(url, repo)
      if (data && typeof data === 'object' && Array.isArray(data.assets)) return data
      logLine('GitHub 接口返回数据缺少资产列表，改用网页解析：' + repo)
    } catch (error) {
      // 接口明确判定「仓库不存在或没有 Release」时不再回退网页（网页只会得到同样的 404）。
      if (/仓库不存在或没有 Release/.test(errorMessage(error))) fail(errorMessage(error))
      logLine('GitHub 接口不可用，改用网页解析：' + errorMessage(error))
    }
    try {
      return await fetchReleaseViaWeb(repo)
    } catch (error) {
      fail('读取 GitHub Release 失败（' + repo + '）：' + errorMessage(error))
    }
  }

  // ---------- 来源解析 ----------

  function trimSource(value) {
    return typeof value === 'string' ? value.trim() : ''
  }

  function normalizeRepo(raw) {
    let repo = trimSource(raw)
    repo = repo.replace(/^https?:\/\/github\.com\//i, '').replace(/\.git$/i, '')
    repo = repo.replace(/^\/+|\/+$/g, '')
    if (!repo) fail('缺少 GitHub 仓库（repo），格式应为 owner/name')
    if (!REPO_PATTERN.test(repo)) fail('GitHub 仓库格式无效：' + repo + '（应为 owner/name）')
    return repo
  }

  function normalizeDownloadUrl(raw) {
    const value = trimSource(raw)
    if (!value) fail('缺少 zip 下载地址（url）')
    let parsed
    try {
      parsed = new URL(value)
    } catch {
      fail('zip 下载地址无效：' + value)
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      fail('zip 下载地址只支持 http/https：' + value)
    }
    return parsed.href
  }

  async function normalizeLocalFile(raw) {
    const value = trimSource(raw)
    if (!value) fail('缺少本机文件路径（file）')
    const absolute = path.resolve(value)
    const info = await fsp.stat(absolute).catch(() => null)
    if (!info || !info.isFile()) fail('本机文件不存在或不是文件：' + absolute)
    return absolute
  }

  function describeSpec(spec) {
    if (!spec || typeof spec !== 'object') return '未指定来源'
    const repo = trimSource(spec.repo)
    if (repo) return repo
    const url = trimSource(spec.url)
    if (url) return url.length > 64 ? url.slice(0, 61) + '…' : url
    const file = trimSource(spec.file)
    if (file) return path.basename(file)
    return '未指定来源'
  }

  async function resolveSource(spec, task) {
    if (!spec || typeof spec !== 'object') fail('缺少安装参数')
    const rawRepo = trimSource(spec.repo)
    const rawUrl = trimSource(spec.url)
    const rawFile = trimSource(spec.file)
    const provided = [rawRepo && 'repo', rawUrl && 'url', rawFile && 'file'].filter(Boolean)
    if (!provided.length) {
      fail('缺少安装来源：请提供 GitHub 仓库（repo）、zip 地址（url）或本机文件（file）')
    }
    if (provided.length > 1) {
      logLine('安装参数包含多个来源（' + provided.join('、') + '），按 repo → url → file 顺序使用第一个')
    }
    const assetPattern = trimSource(spec.assetPattern)
    if (assetPattern && !rawRepo) fail('assetPattern 只能配合 GitHub 仓库（repo）来源使用')

    if (rawRepo) {
      const repo = normalizeRepo(rawRepo)
      taskLog(task, '解析安装来源：GitHub 仓库 ' + repo)
      const release = await fetchLatestRelease(repo, { tag: trimSource(spec.tag) })
      const tag = text(release.tag_name || release.name)
      const asset = selectReleaseAsset(release, assetPattern)
      const url = text(asset.browser_download_url || asset.url)
      if (!url) fail('GitHub Release 资产缺少下载地址：' + text(asset.name))
      taskLog(task, '选择 Release 资产：' + text(asset.name) + (tag ? '（版本 ' + tag + '）' : ''))
      return {
        kind: 'github',
        repo,
        url,
        assetPattern: assetPattern || null,
        tag,
        assetName: text(asset.name),
        label: text(release.name) || repo,
      }
    }

    if (rawUrl) {
      const url = normalizeDownloadUrl(rawUrl)
      taskLog(task, '解析安装来源：zip 地址 ' + url)
      return { kind: 'url', url, label: url }
    }

    const file = await normalizeLocalFile(rawFile)
    taskLog(task, '解析安装来源：本机文件 ' + file)
    return { kind: 'file', file, label: path.basename(file) }
  }

  // ---------- 下载 ----------

  async function downloadWithFetch(url, destFile, task) {
    let response
    try {
      response = await fetch(url, { method: 'GET', signal: AbortSignal.timeout(180000) })
    } catch (error) {
      fail('下载附属启动器包失败：' + errorMessage(error))
    }
    if (!response.ok) fail('下载附属启动器包失败（HTTP ' + response.status + '）：' + url)
    let handle = null
    try {
      handle = await fsp.open(destFile, 'w')
      let received = 0
      for await (const chunk of response.body || []) {
        const buffer = Buffer.from(chunk)
        received += buffer.length
        if (received > MAX_ZIP_BYTES) {
          fail('附属启动器包过大（超过上限 ' + formatBytes(MAX_ZIP_BYTES) + '）')
        }
        await handle.write(buffer)
        try {
          if (task && typeof task.bytes === 'function') task.bytes(buffer.length)
        } catch {
          /* 忽略进度回调异常 */
        }
      }
    } finally {
      if (handle) await handle.close().catch(() => {})
    }
  }

  /**
   * 准备 zip 文件：本机文件直接用；远程地址下载到临时目录。
   * 返回 { file, temp, size }，temp=true 时调用方负责清理。
   */
  async function preparePackageFile(source, task) {
    if (source.kind === 'file') {
      const info = await fsp.stat(source.file).catch(() => null)
      if (!info || !info.isFile()) fail('本机文件不存在或不是文件：' + source.file)
      if (info.size > MAX_ZIP_BYTES) {
        fail(
          '附属启动器包过大（' + formatBytes(info.size) + ' > 上限 ' + formatBytes(MAX_ZIP_BYTES) + '）',
        )
      }
      return { file: source.file, temp: false, size: info.size }
    }
    await fsp.mkdir(tmpDir, { recursive: true })
    const tempFile = path.join(
      tmpDir,
      'sublauncher-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8) + '.zip',
    )
    taskPhase(task, '下载附属启动器包')
    const candidates = downloadCandidates(source.url)
    taskLog(task, '开始下载：' + source.url + (candidates.length > 1 ? '（' + candidates.length + ' 个候选地址）' : ''))
    const errors = []
    let info = null
    for (let index = 0; index < candidates.length; index += 1) {
      const candidate = candidates[index]
      const label = candidate === source.url ? '直连' : new URL(candidate).hostname
      try {
        await fsp.rm(tempFile, { force: true }).catch(() => {})
        if (candidate === source.url && dlRef && typeof dlRef.downloadFile === 'function') {
          await dlRef.downloadFile(source.url, tempFile, { task, quiet: true })
        } else {
          await downloadWithFetch(candidate, tempFile, task)
        }
        const stat = await fsp.stat(tempFile).catch(() => null)
        if (!stat || !stat.isFile() || stat.size === 0) throw new Error('下载结果为空或文件不存在')
        if (stat.size > MAX_ZIP_BYTES) {
          await fsp.rm(tempFile, { force: true }).catch(() => {})
          fail('附属启动器包过大（' + formatBytes(stat.size) + ' > 上限 ' + formatBytes(MAX_ZIP_BYTES) + '）')
        }
        info = stat
        taskLog(task, '下载完成（' + label + '）：' + formatBytes(stat.size))
        break
      } catch (error) {
        errors.push(label + '：' + errorMessage(error))
        if (index < candidates.length - 1) {
          taskLog(task, '下载失败，切换下一个地址：' + label + '（' + errorMessage(error) + '）')
        }
      }
    }
    if (!info) {
      await fsp.rm(tempFile, { force: true }).catch(() => {})
      fail('下载附属启动器包失败：已尝试 ' + candidates.length + ' 个地址（' + errors.join('；') + '）')
    }
    taskLog(task, '下载完成：' + formatBytes(info.size))
    return { file: tempFile, temp: true, size: info.size }
  }

  // ---------- 加载桥 ----------

  async function writeBridge(item, launcherDirAbs) {
    const entryAbs = path.join(launcherDirAbs, item.entry)
    if (!(await pathExists(entryAbs))) fail('入口模块不存在：' + entryAbs)
    const entryUrl = pathToFileURL(entryAbs).href
    const bridgeFile = bridgeFileOf(item.id)
    const lines = [
      '// 由核心自动生成的附属启动器加载桥，请勿手动编辑。',
      '// 包内容更新后核心会重写本文件；删除本文件等同于卸载该附属启动器。',
      'import factory from ' + JSON.stringify(entryUrl),
      'const LAUNCHER_ID = ' + JSON.stringify(item.id),
      'function tag(adapter) {',
      '  try {',
      '    adapter.__subLauncherId = LAUNCHER_ID',
      '  } catch {',
      '    /* 适配器不可写时忽略标记 */',
      '  }',
      '  return adapter',
      '}',
      'export default async function createSubLauncherAdapters(helpers) {',
      '  const produced = typeof factory === "function" ? await factory(helpers) : factory',
      '  const list = Array.isArray(produced) ? produced : produced ? [produced] : []',
      '  return list.map((adapter) => tag(adapter))',
      '}',
      '',
    ]
    await fsp.mkdir(adaptersDir, { recursive: true })
    const temp = bridgeFile + '.' + process.pid + '.' + Date.now() + '.tmp'
    await fsp.writeFile(temp, lines.join('\n'), 'utf8')
    await fsp.rename(temp, bridgeFile)
    return bridgeFile
  }

  async function reload() {
    if (!reloadGames) {
      logLine('未提供 reloadGames 回调，附属启动器将在下次加载时生效')
      return
    }
    try {
      await reloadGames()
    } catch (error) {
      logLine('热加载失败：' + errorMessage(error) + '（文件已写入，稍后会自动加载）')
    }
  }

  // ---------- 安装 / 更新（核心流程） ----------

  async function installFromSource(source, task, { mode = 'install', existing = null } = {}) {
    let packageFile = null
    let extractDir = null
    try {
      packageFile = await preparePackageFile(source, task)
      assertNotCancelled(task)

      taskPhase(task, '校验包内容')
      if (!(await looksLikeZip(packageFile.file))) {
        fail('下载的文件不是有效的 zip 压缩包：' + (source.url || packageFile.file))
      }
      const entries = await listZipEntries(packageFile.file)
      const { files, totalBytes } = inspectPackageEntries(entries)
      const manifestEntry = files.get('launcher.json')
      if (!manifestEntry) {
        fail(
          '附属启动器包缺少 launcher.json（zip 根目录必须直接包含该文件，不要在外面再套一层文件夹）',
        )
      }
      const manifestText = await readZipText(packageFile.file, manifestEntry.name)
      if (!manifestText) fail('launcher.json 内容为空')
      if (Buffer.byteLength(manifestText, 'utf8') > MAX_MANIFEST_BYTES) fail('launcher.json 过大')
      let rawManifest
      try {
        rawManifest = JSON.parse(manifestText)
      } catch (error) {
        fail('launcher.json 不是合法 JSON：' + errorMessage(error))
      }
      const manifest = validateLauncherManifest(rawManifest, { coreVersion, files })
      taskLog(
        task,
        '包校验通过：' +
          manifest.label +
          ' ' +
          manifest.version +
          '（id=' +
          manifest.id +
          '，entry=' +
          manifest.entry +
          '，解压后 ' +
          formatBytes(totalBytes) +
          '）',
      )
      assertNotCancelled(task)
      taskItems(task, 0, 0, '安装附属启动器')

      return await withWriteLock(async () => {
        const registry = await readRegistry({ strict: true })
        const current = registry.launchers.find((item) => item.id === manifest.id) || null

        if (mode === 'install' && current) {
          fail(
            '附属启动器已存在：' +
              manifest.id +
              '（已安装版本 ' +
              current.version +
              '），如需更新请使用更新功能，或先删除后重新安装',
          )
        }
        if (mode === 'update') {
          if (!existing) fail('更新失败：缺少已安装的附属启动器信息')
          if (manifest.id !== existing.id) {
            fail('附属启动器 id 不匹配：包内 id 为 ' + manifest.id + '，已安装为 ' + existing.id)
          }
          if (compareVersion(manifest.version, existing.version) <= 0) {
            taskLog(task, '远程版本 ' + manifest.version + ' 不高于已安装版本 ' + existing.version + '，跳过更新')
            taskPhase(task, '完成')
            return {
              id: existing.id,
              version: existing.version,
              dir: launcherDirAbs(existing),
              updated: false,
              label: existing.label,
            }
          }
        }

        taskPhase(task, '解压附属启动器包')
        await fsp.mkdir(tmpDir, { recursive: true })
        extractDir = path.join(
          tmpDir,
          'sublauncher-extract-' + manifest.id + '-' + Date.now(),
        )
        await fsp.rm(extractDir, { recursive: true, force: true })
        await extractArchiveToDir(packageFile.file, extractDir, {
          stripComponents: 0,
          onProgress: (done, total) => taskItems(task, done, total, '解压附属启动器'),
        })
        assertNotCancelled(task)
        if (!(await pathExists(path.join(extractDir, 'launcher.json')))) {
          fail('解压后缺少 launcher.json，附属启动器包可能已损坏')
        }

        const finalDir = path.join(subRoot, manifest.id, manifest.version)
        await fsp.mkdir(path.dirname(finalDir), { recursive: true })
        await fsp.rm(finalDir, { recursive: true, force: true })
        try {
          await fsp.rename(extractDir, finalDir)
        } catch {
          await fsp.cp(extractDir, finalDir, { recursive: true })
          await fsp.rm(extractDir, { recursive: true, force: true })
        }
        extractDir = null

        taskPhase(task, '注册附属启动器')
        const now = new Date().toISOString()
        const item = {
          id: manifest.id,
          label: manifest.label,
          version: manifest.version,
          entry: manifest.entry,
          source: source.kind,
          installedAt: current && current.installedAt ? current.installedAt : now,
          updatedAt: now,
          dir: path.posix.join(manifest.id, manifest.version),
        }
        if (source.kind === 'github' && source.repo) item.repo = source.repo
        if (source.kind === 'github' && source.assetPattern) item.assetPattern = source.assetPattern
        if (source.kind === 'url' && source.url) item.url = source.url
        if (manifest.description) item.description = manifest.description
        if (manifest.homepage) item.homepage = manifest.homepage
        if (manifest.minCoreVersion) item.minCoreVersion = manifest.minCoreVersion

        const nextLaunchers = current
          ? registry.launchers.map((entry) => (entry.id === item.id ? item : entry))
          : [...registry.launchers, item]
        await writeRegistry({ schemaVersion: 1, launchers: nextLaunchers })
        taskLog(task, '已更新安装清单：sub-launchers/registry.json')

        const bridgeFile = await writeBridge(item, finalDir)
        taskLog(task, '已写入加载桥：' + path.relative(String(paths.root || subRoot), bridgeFile))

        await reload()
        taskLog(task, '已注册附属启动器：' + item.label + ' ' + item.version)

        if (mode === 'update' && existing) {
          const oldDir = launcherDirAbs(existing)
          if (path.resolve(oldDir) !== path.resolve(finalDir)) {
            await fsp.rm(oldDir, { recursive: true, force: true }).catch(() => {})
            const parent = path.dirname(oldDir)
            try {
              const left = await fsp.readdir(parent)
              if (!left.length) await fsp.rm(parent, { recursive: true, force: true })
            } catch {
              /* 旧目录清理失败不影响安装结果 */
            }
            taskLog(task, '已删除旧版本目录：' + path.relative(subRoot, oldDir))
          }
        }

        if (!gamesOfLauncher(item.id).length) {
          logLine(
            '警告：附属启动器 ' +
              item.id +
              ' 安装完成，但暂未检测到它注册的游戏（请确认包内入口导出了适配器）',
          )
        }
        taskPhase(task, '完成')
        return {
          id: item.id,
          version: item.version,
          dir: finalDir,
          updated: mode === 'update',
          label: item.label,
        }
      })
    } finally {
      if (packageFile && packageFile.temp) {
        await fsp.rm(packageFile.file, { force: true }).catch(() => {})
      }
      if (extractDir) {
        await fsp.rm(extractDir, { recursive: true, force: true }).catch(() => {})
      }
    }
  }

  // ---------- 任务包装（兼容多种 runJob 形态） ----------

  function createFallbackTask(title) {
    return {
      log(line) {
        logLine(String(line))
      },
      items() {
        /* 无任务队列时无进度 */
      },
      bytes() {
        /* 无任务队列时无进度 */
      },
      setPhase(phase) {
        logLine('阶段：' + String(phase || ''))
      },
      cancelRequested: false,
      title,
    }
  }

  function startJob(kind, title, work) {
    if (!runJob) {
      const task = createFallbackTask(title)
      const promise = Promise.resolve().then(() => work(task))
      promise.catch(() => {})
      return { jobId: null, promise }
    }
    const arity = typeof runJob.length === 'number' ? runJob.length : 0
    let args
    if (arity >= 4) args = [kind, title, null, work]
    else if (arity === 3) args = [kind, title, work]
    else args = [kind, { title }, work]
    let started
    try {
      started = runJob(...args)
    } catch (error) {
      fail('任务启动失败：' + errorMessage(error))
    }
    if (isPromiseLike(started)) {
      const promise = Promise.resolve(started)
      promise.catch(() => {})
      return { jobId: null, promise }
    }
    if (!started || typeof started !== 'object') fail('任务启动失败：runJob 没有返回任务对象')
    const jobId = text(started.id || started.jobId) || null
    const promise = isPromiseLike(started.promise) ? Promise.resolve(started.promise) : Promise.resolve(started)
    promise.catch(() => {})
    return { jobId, promise }
  }

  async function waitResult(started, options, kind) {
    if (options && options.wait === false) return started
    const result = await started.promise
    return { ...result, jobId: started.jobId }
  }

  // ---------- 公开接口 ----------

  /** 列出已安装的附属启动器（含其注册的游戏 id）。 */
  async function list() {
    const registry = await readRegistry()
    const result = []
    for (const item of registry.launchers) {
      const dirAbs = launcherDirAbs(item)
      if (!(await pathExists(path.join(dirAbs, 'launcher.json')))) {
        logLine('警告：附属启动器目录缺少 launcher.json：' + item.id + '（' + dirAbs + '）')
      }
      const entry = {
        id: item.id,
        label: item.label,
        version: item.version,
        entry: item.entry,
        source: item.source,
        installedAt: item.installedAt,
        updatedAt: item.updatedAt,
        dir: dirAbs,
        games: gamesOfLauncher(item.id),
      }
      if (item.repo) entry.repo = item.repo
      if (item.url) entry.url = item.url
      result.push(entry)
    }
    return result
  }

  /**
   * 安装附属启动器。
   * @param {{repo?:string,url?:string,file?:string,assetPattern?:string}} spec 安装来源（至少一个）
   * @param {{wait?:boolean}} [options] wait=false 时立即返回 { jobId, promise }
   * @returns {Promise<{jobId:string|null,id:string,version:string,dir:string}>}
   */
  async function install(spec, options = {}) {
    const started = startJob(
      'sublauncher-install',
      '安装附属启动器：' + describeSpec(spec),
      (task) => prepareAndInstall(spec, task),
    )
    return waitResult(started, options, 'install')
  }

  async function prepareAndInstall(spec, task) {
    const source = await resolveSource(spec, task)
    return installFromSource(source, task, { mode: 'install' })
  }

  /** 立即返回任务句柄的安装（供 engine 的 installSubLauncher 使用）。 */
  async function startInstall(spec) {
    return install(spec, { wait: false })
  }

  /** 检查更新（需要 GitHub 仓库来源）。 */
  async function check(id) {
    const launcherId = text(id)
    if (!launcherId) fail('缺少附属启动器 id')
    const registry = await readRegistry()
    const item = registry.launchers.find((entry) => entry.id === launcherId)
    if (!item) fail('附属启动器不存在：' + launcherId)
    if (!item.repo) {
      fail('该附属启动器不是从 GitHub 仓库安装的（缺少仓库信息），无法检查更新：' + launcherId)
    }
    const release = await fetchLatestRelease(item.repo)
    const tag = text(release.tag_name || release.name)
    if (!tag) fail('GitHub Release 缺少版本标签，无法检查更新：' + item.repo)
    const latestVersion = tag.replace(/^[vV]/, '').trim()
    if (!parseSemver(latestVersion)) fail('GitHub 最新版本号无法解析：' + tag)
    return {
      id: launcherId,
      installedVersion: item.version,
      latestVersion,
      updateAvailable: isUpdateAvailable(item.version, latestVersion),
      repo: item.repo,
    }
  }

  /**
   * 更新附属启动器（需 GitHub 仓库来源）。
   * @param {string} id
   * @param {{wait?:boolean}} [options]
   */
  async function update(id, options = {}) {
    const launcherId = text(id)
    if (!launcherId) fail('缺少附属启动器 id')
    const started = startJob(
      'sublauncher-update',
      '更新附属启动器：' + launcherId,
      (task) => prepareAndUpdate(launcherId, task),
    )
    return waitResult(started, options, 'update')
  }

  async function prepareAndUpdate(launcherId, task) {
    const registry = await readRegistry()
    const item = registry.launchers.find((entry) => entry.id === launcherId)
    if (!item) fail('附属启动器不存在：' + launcherId)
    if (!item.repo) {
      fail('该附属启动器不是从 GitHub 仓库安装的（缺少仓库信息），无法更新：' + launcherId)
    }
    taskLog(task, '检查更新：' + item.label + '（已安装 ' + item.version + '）')
    const info = await check(launcherId)
    if (!info.updateAvailable) {
      taskLog(task, '已是最新版本：' + item.version)
      taskPhase(task, '完成')
      return {
        id: item.id,
        version: item.version,
        dir: launcherDirAbs(item),
        updated: false,
        latestVersion: info.latestVersion,
        label: item.label,
      }
    }
    taskLog(task, '发现新版本：' + info.latestVersion + '（当前 ' + item.version + '）')
    const source = await resolveSource({ repo: item.repo, assetPattern: item.assetPattern }, task)
    return installFromSource(source, task, { mode: 'update', existing: item })
  }

  /** 立即返回任务句柄的更新（供 engine 的 updateSubLauncher 使用）。 */
  async function startUpdate(id) {
    return update(id, { wait: false })
  }

  /** 卸载附属启动器（删桥 + 删目录 + 删清单条目 + 热加载）。 */
  async function remove(id) {
    const launcherId = text(id)
    if (!launcherId) fail('缺少附属启动器 id')
    return withWriteLock(async () => {
      const registry = await readRegistry({ strict: true })
      const item = registry.launchers.find((entry) => entry.id === launcherId)
      if (!item) fail('附属启动器不存在：' + launcherId)
      await fsp.rm(bridgeFileOf(launcherId), { force: true }).catch(() => {})
      await fsp.rm(path.join(subRoot, launcherId), { recursive: true, force: true }).catch(() => {})
      await writeRegistry({
        schemaVersion: 1,
        launchers: registry.launchers.filter((entry) => entry.id !== launcherId),
      })
      logLine('已卸载附属启动器：' + launcherId)
      await reload()
      return { removed: true }
    })
  }

  /** 配置变更后替换下载器实例。 */
  function setDownloader(next) {
    dlRef = next || null
  }

  return {
    list,
    install,
    startInstall,
    check,
    update,
    startUpdate,
    remove,
    setDownloader,
  }
}

export default createSubLauncherManager
