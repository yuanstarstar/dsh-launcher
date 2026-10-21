// lib/version.js —— 方块游戏版本 JSON 语义核心（v3 适配器版）
// 纯逻辑模块：只用 node:path；网络请求经 mirrors.js 的容错入口（镜像优先、官方兜底），
// 因此本文件不出现任何镜像域名，镜像规则集中在 lib/mirrors.js。
import path from 'node:path'

import { OFFICIAL, fetchJson } from './mirrors.js'

/** 官方版本清单候选（顺序由 mirrors.resolveUrl 决定，这里只列官方地址）。 */
export const VERSION_MANIFEST_URLS = [OFFICIAL.manifest, OFFICIAL.manifestLegacy]

/** 规则里 os.version 的缺省值（Windows 10/11 前缀）。 */
const DEFAULT_OS_VERSION = '10.0'

// ---------------------------------------------------------------------------
// 内部小工具
// ---------------------------------------------------------------------------

function asArray(value) {
  return Array.isArray(value) ? value : []
}

/** 返回参数中第一个「非空」值（undefined / null / '' 视为空）。 */
function firstNonEmpty(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && value !== '') return value
  }
  return undefined
}

function hostOsName() {
  if (process.platform === 'win32') return 'windows'
  if (process.platform === 'darwin') return 'osx'
  return 'linux'
}

function hostOsArch() {
  // 与 Mojang 规则里的 arch 命名对齐
  if (process.arch === 'x64') return 'x86_64'
  if (process.arch === 'ia32') return 'x86'
  if (process.arch === 'arm64') return 'arm64'
  if (process.arch === 'arm') return 'arm32'
  return process.arch
}

/** 补全 env 默认值：osName/osArch 取当前进程，osVersion 默认 10.0。 */
function normalizeEnv(env = {}) {
  return {
    osName: env?.osName ?? hostOsName(),
    osArch: env?.osArch ?? hostOsArch(),
    osVersion: String(env?.osVersion ?? DEFAULT_OS_VERSION),
  }
}

/** natives 模板里 ${arch} 的取值：x86_64→64，x86→32，arm64→arm64。 */
function archToken(env) {
  if (env.osArch === 'x86_64') return '64'
  if (env.osArch === 'x86') return '32'
  if (env.osArch === 'arm64') return 'arm64'
  return env.osArch
}

/** 单条 rule 是否命中（features 一律视为不命中；os.name/arch 精确、version 正则）。 */
function ruleMatches(rule, env) {
  if (!rule || typeof rule !== 'object') return false
  // 我们不启用任何 feature，带 features 的规则一律视为不匹配
  if (rule.features && typeof rule.features === 'object' && Object.keys(rule.features).length > 0) return false
  const osRule = rule.os
  if (osRule && typeof osRule === 'object') {
    if (osRule.name !== undefined && osRule.name !== env.osName) return false
    if (osRule.arch !== undefined && osRule.arch !== env.osArch) return false
    if (osRule.version !== undefined) {
      try {
        if (!new RegExp(String(osRule.version)).test(String(env.osVersion))) return false
      } catch {
        // 非法正则：按不匹配处理，别让坏数据炸掉整个启动流程
        return false
      }
    }
  }
  return true
}

/**
 * 规则数组求值：无 rules → true；顺序扫描，命中的 allow 置真、disallow 置假；
 * 有 rules 但一条也没命中 → false（与原版启动器一致）。
 */
function rulesAllow(rules, env) {
  if (!Array.isArray(rules) || rules.length === 0) return true
  let allowed = false
  for (const rule of rules) {
    if (!ruleMatches(rule, env)) continue
    allowed = rule.action === 'allow'
  }
  return allowed
}

/** 解析 maven 坐标 name："group:artifact:version[:classifier][@ext]"。 */
function parseLibraryName(name) {
  if (typeof name !== 'string') return null
  let base = name.trim()
  if (!base) return null
  let ext = 'jar'
  const at = base.lastIndexOf('@')
  if (at > 1) {
    ext = base.slice(at + 1) || 'jar'
    base = base.slice(0, at)
  }
  const parts = base.split(':')
  if (parts.length < 3) return null
  const [group, artifact, version] = parts
  if (!group || !artifact || !version) return null
  return { group, artifact, version, classifier: parts.length >= 4 ? parts[3] : undefined, ext }
}

/** 由解析出的 maven 坐标拼相对路径（用 / 分隔）。 */
function mavenPathOf(parsed) {
  const groupPath = String(parsed.group).replace(/\./g, '/')
  const file = `${parsed.artifact}-${parsed.version}${parsed.classifier ? `-${parsed.classifier}` : ''}.${parsed.ext || 'jar'}`
  return `${groupPath}/${parsed.artifact}/${parsed.version}/${file}`
}

/**
 * 从 downloads.artifact.path 反推 classifier（旧格式兼容）：path 形如
 * "org/lwjgl/lwjgl/3.2.1/lwjgl-3.2.1-natives-windows.jar"。
 */
function classifierFromPath(artifactPath, parsed) {
  if (!artifactPath || !parsed) return undefined
  const file = String(artifactPath).split('/').pop() ?? ''
  const prefix = `${parsed.artifact}-${parsed.version}`
  if (!file.startsWith(prefix)) return undefined
  const rest = file.slice(prefix.length).replace(/\.[^.]+$/, '')
  return rest.startsWith('-') ? rest.slice(1) : undefined
}

/** 拼 base URL 与相对路径（保证中间只有一条 /）。 */
function joinUrl(base, relative) {
  if (!base) return undefined
  if (!relative) return String(base)
  const b = String(base)
  return b.endsWith('/') ? `${b}${relative}` : `${b}/${relative}`
}

/** 替换 ${placeholder}；未知占位符原样保留，便于上层发现拼装错误。 */
function substitute(text, vars) {
  return String(text).replace(/\$\{([^}]+)\}/g, (whole, key) => {
    const k = key.trim()
    if (Object.prototype.hasOwnProperty.call(vars, k) && vars[k] !== undefined) return String(vars[k])
    return whole
  })
}

/** 从 classpath 推断 library_directory（NeoForge 等 jvm 参数里会用到）。 */
function inferLibraryDirectory(classpath) {
  if (!classpath) return ''
  const first = String(classpath).split(path.delimiter)[0]
  const segments = first.split(/[\\/]+/).filter(Boolean)
  for (let i = segments.length - 1; i >= 0; i--) {
    if (segments[i].toLowerCase() === 'libraries') return segments.slice(0, i + 1).join(path.sep)
  }
  return ''
}

// ---------------------------------------------------------------------------
// 网络：版本清单 / 版本 json
// ---------------------------------------------------------------------------

/**
 * 拉取版本清单。依次尝试 VERSION_MANIFEST_URLS，经 mirrors.fetchJson 走
 * 「镜像候选 → 官方兜底」，失败换下一个官方地址。
 * @param {{ fetchJson: (url: string) => Promise<any> }} dl
 * @param {{ force?: boolean }} [options] force 预留给调用方的缓存层（本函数不缓存）
 * @returns {Promise<{ latest: { release: string|null, snapshot: string|null },
 *                     versions: { id: string, type: string, url: string, releaseTime: string, sha1: string }[] }>}
 */
export async function fetchManifest(dl, options = {}) {
  if (!dl || typeof dl.fetchJson !== 'function') {
    throw new Error('fetchManifest: 需要带 fetchJson(url) 的下载器对象')
  }
  void options.force // 缓存由调用方（lib/vanilla.js）负责，这里直取
  const errors = []
  for (const url of VERSION_MANIFEST_URLS) {
    try {
      const raw = await fetchJson(dl, url)
      if (!raw || typeof raw !== 'object' || !Array.isArray(raw.versions)) {
        throw new Error('返回内容缺少 versions 数组')
      }
      return {
        latest: {
          release: raw.latest?.release ?? null,
          snapshot: raw.latest?.snapshot ?? null,
        },
        versions: raw.versions
          .filter((v) => v && typeof v === 'object' && typeof v.id === 'string' && v.id)
          .map((v) => ({
            id: v.id,
            type: v.type,
            url: v.url,
            releaseTime: v.releaseTime,
            sha1: v.sha1,
          })),
      }
    } catch (error) {
      errors.push(`${url}: ${error?.message ?? error}`)
    }
  }
  throw new Error(`拉取游戏版本清单失败（已尝试 ${VERSION_MANIFEST_URLS.length} 个地址）：${errors.join('；')}`)
}

/**
 * 拉取某个版本的原始 version json。
 * 先用「piston-meta 官方地址形态」交给 mirrors 解析（候选：bmclapi/qlu 的
 * /version/<id>/json → 官方兜底），全部失败后再查版本清单拿 entry.url 重试。
 * @returns {Promise<object>} 原始 version json
 */
export async function fetchVersionJson(dl, versionId) {
  if (!dl || typeof dl.fetchJson !== 'function') {
    throw new Error('fetchVersionJson: 需要带 fetchJson(url) 的下载器对象')
  }
  const id = String(versionId ?? '').trim()
  if (!id) throw new Error('fetchVersionJson: versionId 不能为空')

  const errors = []
  // mirrors.resolveUrl 会把该地址改写成 bmclapi/qlu 的 /version/<id>/json 候选，
  // 官方原始地址排在最后兜底；这样即使拿不到版本清单也能直接取 version json。
  const directUrl = `${OFFICIAL.pistonMeta}version/${encodeURIComponent(id)}/json`
  try {
    const json = await fetchJson(dl, directUrl)
    if (!json || typeof json !== 'object' || !firstNonEmpty(json.id, json.mainClass)) {
      throw new Error('返回内容不像 version json')
    }
    return json
  } catch (error) {
    errors.push(`直取 ${id}: ${error?.message ?? error}`)
  }

  let manifest
  try {
    manifest = await fetchManifest(dl)
  } catch (error) {
    errors.push(`版本清单: ${error?.message ?? error}`)
    throw new Error(`拉取版本 ${id} 的 JSON 失败：${errors.join('；')}`)
  }
  const entry = manifest.versions.find((v) => v.id === id)
  if (!entry || !entry.url) {
    throw new Error(`拉取版本 ${id} 的 JSON 失败：版本清单中找不到该版本（${errors.join('；')}）`)
  }
  try {
    const json = await fetchJson(dl, entry.url)
    if (!json || typeof json !== 'object' || !firstNonEmpty(json.id, json.mainClass)) {
      throw new Error('返回内容不像 version json')
    }
    return json
  } catch (error) {
    errors.push(`清单地址 ${entry.url}: ${error?.message ?? error}`)
    throw new Error(`拉取版本 ${id} 的 JSON 失败：${errors.join('；')}`)
  }
}

// ---------------------------------------------------------------------------
// 合并（子 → 父）
// ---------------------------------------------------------------------------

/**
 * 合并版本链（jsons 为子 → 父顺序：loader json 在前、原版 json 在后）。
 * 返回契约 §4 约定的 merged 对象；libraries 全部保留（不去重）。
 * @param {object[]} jsons
 */
export function mergeVersionChain(jsons) {
  const chain = asArray(jsons).filter((json) => json && typeof json === 'object')
  const first = chain[0] ?? {}
  const libraries = []
  const game = []
  const jvm = []
  let minecraftArguments

  for (const json of chain) {
    libraries.push(...asArray(json.libraries))
    const args = json.arguments
    if (args && typeof args === 'object') {
      game.push(...asArray(args.game))
      jvm.push(...asArray(args.jvm))
    }
    if (minecraftArguments === undefined && typeof json.minecraftArguments === 'string' && json.minecraftArguments) {
      minecraftArguments = json.minecraftArguments
    }
  }

  // jarVersionId = 链中最后一个带 downloads.client 的父版本 id（无则自身 id）
  let jarVersionId = ''
  for (let i = chain.length - 1; i >= 0; i--) {
    if (chain[i].downloads?.client) {
      jarVersionId = String(chain[i].id ?? '')
      break
    }
  }
  if (!jarVersionId) jarVersionId = String(first.id ?? '')

  // 启动器最低版本取全链最大值（loader 可能要求更高），缺字段健壮
  let minimumLauncherVersion = 0
  for (const json of chain) {
    const n = Number(json.minimumLauncherVersion)
    if (Number.isFinite(n) && n > minimumLauncherVersion) minimumLauncherVersion = n
  }

  const pick = (key) => firstNonEmpty(...chain.map((json) => json[key]))

  return {
    id: String(pick('id') ?? ''),
    type: pick('type') ?? 'release',
    releaseTime: pick('releaseTime'),
    mainClass: pick('mainClass') ?? '',
    libraries,
    arguments: {
      // 子在前拼接；即使全链没有 arguments 也给出空数组，方便上层统一处理
      game,
      jvm,
    },
    minecraftArguments,
    assetIndex: pick('assetIndex'),
    assets: pick('assets'),
    downloads: pick('downloads'),
    javaVersion: pick('javaVersion'),
    logging: pick('logging'),
    minimumLauncherVersion,
    jarVersionId,
    loaderJson: chain.length > 1 ? chain[0] : null,
  }
}

// ---------------------------------------------------------------------------
// 规则
// ---------------------------------------------------------------------------

/**
 * 判断某个 library 在当前环境是否启用。
 * @param {{ rules?: any[] }} lib
 * @param {{ osName?: string, osArch?: string, osVersion?: string }} [env]
 */
export function isLibraryAllowed(lib, env = {}) {
  if (!lib || typeof lib !== 'object') return false
  return rulesAllow(lib.rules, normalizeEnv(env))
}

// ---------------------------------------------------------------------------
// 库 / natives
// ---------------------------------------------------------------------------

/**
 * 列出需要下载并放进 classpath 的库（按规则过滤 + 按 group:artifact[:classifier] 去重，子优先）。
 * @returns {{ name: string, mavenPath: string, url?: string, sha1?: string, size?: number,
 *             isNative: boolean, download: { url: string, sha1?: string, size?: number } | null }[]}
 */
export function libraryDependencies(merged, env = {}) {
  const e = normalizeEnv(env)
  const out = []
  const seen = new Set()

  for (const lib of asArray(merged?.libraries)) {
    if (!lib || typeof lib !== 'object') continue
    if (!isLibraryAllowed(lib, e)) continue

    const parsed = parseLibraryName(lib.name)
    const artifact = lib.downloads?.artifact
    let mavenPath
    let url
    let sha1
    let size
    let classifier = parsed?.classifier

    if (artifact && typeof artifact === 'object') {
      // 新格式：downloads.artifact 为准
      mavenPath = artifact.path || (parsed ? mavenPathOf(parsed) : undefined)
      if (!classifier) classifier = classifierFromPath(artifact.path, parsed)
      url = artifact.url
      sha1 = artifact.sha1
      size = artifact.size
    } else if (parsed) {
      // 旧格式：lib.url + mavenPath 拼接
      mavenPath = mavenPathOf(parsed)
      if (lib.url) {
        url = joinUrl(lib.url, mavenPath)
        sha1 = lib.sha1
        size = lib.size
      }
    }
    if (!mavenPath) continue // 无法确定下载路径的条目直接跳过（健壮性）

    const isNative = Boolean(lib.natives && typeof lib.natives === 'object' && !Array.isArray(lib.natives))
    // 去重键：group:artifact[:classifier]；classifier 取 name 解析值（旧式 natives 的 classifier 由 OS 决定，不参与键）
    const key = parsed
      ? `${parsed.group}:${parsed.artifact}${classifier ? `:${classifier}` : ''}`
      : String(mavenPath)
    if (seen.has(key)) continue
    seen.add(key)

    out.push({
      name: lib.name,
      mavenPath: String(mavenPath).replace(/\\/g, '/'),
      url,
      sha1,
      size,
      isNative,
      download: url ? { url, sha1, size } : null,
    })
  }

  return out
}

/**
 * 列出需要解压到 natives 目录的原生库（只认 lib.natives 旧格式）。
 * 说明：1.19+ 的版本 json 已不再使用 lib.natives，原生 jar 直接以
 * ":natives-windows" 这类 classifier 出现在 libraries 里并随 classpath 加载，
 * 因此对 1.20.1 这类版本本函数返回空数组是正确行为（详见 test/version-report.md）。
 * @returns {{ name: string, mavenPath: string, url?: string, sha1?: string, size?: number,
 *             classifier: string, extractExclude: string[] }[]}
 */
export function nativesInfo(merged, env = {}) {
  const e = normalizeEnv(env)
  const out = []
  const seen = new Set()

  for (const lib of asArray(merged?.libraries)) {
    if (!lib || typeof lib !== 'object') continue
    if (!isLibraryAllowed(lib, e)) continue
    const template = lib.natives?.[e.osName]
    if (typeof template !== 'string' || !template) continue

    const classifier = template.replace(/\$\{arch\}/g, archToken(e))
    const parsed = parseLibraryName(lib.name)
    const classifiers = lib.downloads?.classifiers
    const artifact =
      classifiers && typeof classifiers === 'object'
        ? (classifiers[classifier] ?? (template !== classifier ? classifiers[template] : undefined))
        : undefined

    let mavenPath
    let url
    let sha1
    let size
    if (artifact && typeof artifact === 'object') {
      mavenPath = artifact.path || (parsed ? mavenPathOf({ ...parsed, classifier }) : undefined)
      url = artifact.url
      sha1 = artifact.sha1
      size = artifact.size
    } else if (parsed) {
      // 旧格式兜底：按解析后的 classifier 拼 mavenPath；lib.url 存在时拼下载地址
      mavenPath = mavenPathOf({ group: parsed.group, artifact: parsed.artifact, version: parsed.version, classifier, ext: 'jar' })
      if (lib.url) {
        url = joinUrl(lib.url, mavenPath)
        sha1 = lib.sha1
        size = lib.size
      }
    }
    if (!mavenPath) continue

    const normalized = String(mavenPath).replace(/\\/g, '/')
    if (seen.has(normalized)) continue
    seen.add(normalized)

    out.push({
      name: lib.name,
      mavenPath: normalized,
      url,
      sha1,
      size,
      classifier,
      extractExclude: Array.isArray(lib.extract?.exclude) ? lib.extract.exclude : ['META-INF/'],
    })
  }

  return out
}

// ---------------------------------------------------------------------------
// 启动参数
// ---------------------------------------------------------------------------

/**
 * 拼 classpath：libraryDependencies 顺序，Windows 用 ';' 连接，绝对路径。
 * 注意：client jar 不在 libraries 里，调用方（launch.js）需自行把
 * <versions>/<jarVersionId>/<jarVersionId>.jar 追加到 classpath 末尾。
 */
export function buildClasspath(merged, librariesDir, env = {}) {
  const separator = path.delimiter
  const baseDir = String(librariesDir ?? '')
  const entries = libraryDependencies(merged, env).map((dep) =>
    path.resolve(baseDir, ...String(dep.mavenPath).split('/')),
  )
  return entries.join(separator)
}

/**
 * 构造 JVM 参数。
 * ctx: { classpath, nativesDir, launcherName, launcherVersion, launcherBrand,
 *        versionName, libraryDirectory, extraJvmArgs, env }
 */
export function buildJvmArgs(merged, ctx = {}) {
  const e = normalizeEnv(ctx.env ?? {})
  const classpath = String(ctx.classpath ?? '')
  const nativesDir = String(ctx.nativesDir ?? '')
  const extraJvmArgs = asArray(ctx.extraJvmArgs).filter((arg) => typeof arg === 'string')
  const vars = {
    classpath,
    natives_directory: nativesDir,
    launcher_name: ctx.launcherName ?? 'DSH-Launcher',
    launcher_version: ctx.launcherVersion ?? '1.0.0',
    version_name: ctx.versionName ?? String(merged?.id ?? ''),
    library_directory: ctx.libraryDirectory ?? ctx.librariesDir ?? inferLibraryDirectory(classpath),
    classpath_separator: path.delimiter,
  }

  const jvm = merged?.arguments?.jvm
  if (Array.isArray(jvm) && jvm.length > 0) {
    const out = []
    const push = (value) => {
      if (typeof value !== 'string') return
      const replaced = substitute(value, vars)
      if (replaced !== '') out.push(replaced) // JVM 参数为空串会被 java 当非法选项，过滤掉
    }
    for (const entry of jvm) {
      if (typeof entry === 'string') {
        push(entry)
        continue
      }
      if (!entry || typeof entry !== 'object' || entry.value === undefined) continue
      if (!rulesAllow(entry.rules, e)) continue // features 一律按 false 处理（见 ruleMatches）
      for (const value of Array.isArray(entry.value) ? entry.value : [entry.value]) push(value)
    }
    return [...out, ...extraJvmArgs]
  }

  // 旧版（只有 minecraftArguments）兜底：显式给 natives + classpath
  return [`-Djava.library.path=${nativesDir}`, '-cp', classpath, ...extraJvmArgs]
}

/**
 * 构造游戏参数。
 * ctx: { username, uuid, accessToken, userType, versionType, versionName, gameDir, assetsDir,
 *        assetIndex, width, height, serverAddress, serverPort, clientId, authXuid, env }
 */
export function buildGameArgs(merged, ctx = {}) {
  const e = normalizeEnv(ctx.env ?? {})
  const width = ctx.width ?? 854
  const height = ctx.height ?? 480
  const accessToken = ctx.accessToken ?? ''
  const clientId = ctx.clientId ?? ctx.clientid ?? ''
  const xuid = ctx.authXuid ?? ctx.xuid ?? ''
  const vars = {
    auth_player_name: ctx.username ?? '',
    auth_uuid: ctx.uuid ?? '',
    auth_access_token: accessToken,
    auth_session: ctx.authSession ?? `token:${accessToken}`,
    user_type: ctx.userType ?? 'legacy',
    version_name: ctx.versionName ?? String(merged?.id ?? ''),
    version_type: ctx.versionType ?? merged?.type ?? 'release',
    game_directory: ctx.gameDir ?? '',
    assets_root: ctx.assetsDir ?? '',
    assets_index_name: ctx.assetIndex ?? merged?.assetIndex?.id ?? merged?.assets ?? '',
    auth_xuid: xuid,
    clientid: clientId,
    user_properties: ctx.userProperties ?? '{}',
    resolution_width: String(width),
    resolution_height: String(height),
  }

  const out = []
  const push = (value) => {
    if (typeof value !== 'string') return
    out.push(substitute(value, vars))
  }
  const pushConditional = (entry) => {
    if (!entry || typeof entry !== 'object' || entry.value === undefined) return
    if (!rulesAllow(entry.rules, e)) return
    for (const value of Array.isArray(entry.value) ? entry.value : [entry.value]) push(value)
  }

  const game = merged?.arguments?.game
  if (Array.isArray(game) && game.length > 0) {
    for (const entry of game) {
      if (typeof entry === 'string') push(entry)
      else pushConditional(entry)
    }
  } else if (typeof merged?.minecraftArguments === 'string' && merged.minecraftArguments.trim()) {
    for (const token of merged.minecraftArguments.trim().split(/\s+/)) push(token)
  }

  // 分辨率：条件分支（has_custom_resolution feature）一律跳过，这里统一补
  if (!out.includes('--width') && !out.includes('--height')) {
    out.push('--width', String(width), '--height', String(height))
  }

  // 直连服务器：参数里没有 --server 时才补
  if (ctx.serverAddress && !out.includes('--server')) {
    out.push('--server', String(ctx.serverAddress), '--port', String(ctx.serverPort ?? 25565))
  }

  return out
}

// ---------------------------------------------------------------------------
// Java / jar 版本
// ---------------------------------------------------------------------------

/** 需要的 Java 主版本号（缺省 8）。 */
export function javaMajor(merged) {
  const major = Number(merged?.javaVersion?.majorVersion)
  return Number.isFinite(major) && major > 0 ? major : 8
}

/** 原版 client jar 对应的版本 id（缺省回落 merged.id）。 */
export function primaryJarVersionId(merged) {
  return String(merged?.jarVersionId || merged?.id || '')
}
