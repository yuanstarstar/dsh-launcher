// lib/loaders.js —— 模组加载器版本查询与安装（v3 适配器版）
// Fabric/Quilt 只需下载 profile json；Forge/NeoForge 需要下载官方安装器并用 Java 运行 --installClient。
// 所有下载/请求都走调用方注入的下载器（核心下载器由 adapter 用 mirrors.makeDownloader 创建，
// 镜像地址规则集中在 lib/mirrors.js；本文件只使用 OFFICIAL / MIRROR_BASES 常量）。
import path from 'node:path'
import fsp from 'node:fs/promises'
import readline from 'node:readline'
import { spawn } from 'node:child_process'
import { pathExists, readJson, writeJson } from './util.js'
import { detectJavas } from './java.js'
import { OFFICIAL, MIRROR_BASES, fetchJson as mirrorFetchJson, fetchText as mirrorFetchText } from './mirrors.js'

export const LOADER_TYPES = ['fabric', 'quilt', 'forge', 'neoforge']

const USER_AGENT = 'dsh-mc-adapter/3.0.0'
const FABRIC_META = OFFICIAL.fabricMeta
const QUILT_META = OFFICIAL.quiltMeta
const FORGE_PROMOS_URL = OFFICIAL.forgePromos
const FORGE_MAVEN = OFFICIAL.forgeMaven.replace(/\/+$/, '')
const NEOFORGE_MAVEN = OFFICIAL.neoforgeMaven.replace(/\/+$/, '')
const BMCLAPI = MIRROR_BASES[0].base
const QLU_BMCLAPI = MIRROR_BASES[1].base
const NEO_LEGACY_MC = '1.20.1' // 该版本的 NeoForge 走 net.neoforged:forge:47.1.x

const HEADERS = { 'user-agent': USER_AGENT, accept: 'application/json' }

/** no-op 进度对象（契约 §7：task 可选）。 */
function taskOf(task) {
  return task ?? { log() {}, items() {}, bytes() {}, setPhase() {} }
}

export function loaderLabel(type) {
  return type === 'fabric' ? 'Fabric' : type === 'quilt' ? 'Quilt' : type === 'forge' ? 'Forge' : 'NeoForge'
}

function dedupeVersions(versions) {
  const seen = new Set()
  const out = []
  for (const item of versions) {
    if (!item?.version || seen.has(item.version)) continue
    seen.add(item.version)
    out.push({ version: String(item.version), stable: item.stable !== false })
  }
  return out
}

function versionParts(value) {
  return String(value)
    .split(/[.\-+_]/)
    .filter((part) => part !== '')
    .map((part) => (/^\d+$/.test(part) ? Number(part) : part))
}

/** 版本字符串比较（数字段按数值比较，用于倒序排最新）。 */
export function compareVersionStrings(a, b) {
  const pa = versionParts(a)
  const pb = versionParts(b)
  const len = Math.max(pa.length, pb.length)
  for (let i = 0; i < len; i += 1) {
    const x = pa[i]
    const y = pb[i]
    if (x === undefined) return -1
    if (y === undefined) return 1
    if (typeof x === 'number' && typeof y === 'number') {
      if (x !== y) return x - y
    } else {
      const res = String(x).localeCompare(String(y))
      if (res !== 0) return res
    }
  }
  return 0
}

// ── Fabric / Quilt ────────────────────────────────────────────────────────

/** 对不支持的游戏版本，元数据接口会返回 4xx；视为「没有版本」而不是网络失败。 */
function isClientError(err) {
  return /HTTP 4\d\d/.test(String(err?.message ?? err))
}

async function fetchFabricLoaderVersions(dl, mcVersion) {
  const url = `${FABRIC_META}/v2/versions/loader/${encodeURIComponent(mcVersion)}`
  let data
  try {
    data = await dl.fetchJson(url, { timeoutMs: 20000, headers: HEADERS })
  } catch (err) {
    if (isClientError(err)) return []
    throw new Error(`获取 Fabric 加载器版本列表失败：${err?.message ?? err}`)
  }
  const list = Array.isArray(data) ? data : []
  return dedupeVersions(
    list.map((row) => ({ version: row?.loader?.version, stable: row?.loader?.stable !== false })),
  )
}

/** 版本号是否稳定版（Quilt API 的 loader 里没有 stable 字段，只能按后缀判断）。 */
function isStableVersion(version) {
  return !/-(beta|alpha|pre|rc|snapshot)/i.test(String(version ?? ''))
}

async function fetchQuiltLoaderVersions(dl, mcVersion) {
  const url = `${QUILT_META}/v3/versions/loader/${encodeURIComponent(mcVersion)}`
  let data
  try {
    data = await dl.fetchJson(url, { timeoutMs: 20000, headers: HEADERS })
  } catch (err) {
    if (isClientError(err)) return []
    throw new Error(`获取 Quilt 加载器版本列表失败：${err?.message ?? err}`)
  }
  const list = Array.isArray(data) ? data : []
  return dedupeVersions(
    list.map((row) => {
      const version = row?.loader?.version
      const stable = typeof row?.loader?.stable === 'boolean' ? row.loader.stable : isStableVersion(version)
      return { version, stable }
    }),
  )
}

// ── Forge ─────────────────────────────────────────────────────────────────

async function fetchForgePromos(dl) {
  let data
  try {
    data = await dl.fetchJson(FORGE_PROMOS_URL, { timeoutMs: 20000, headers: HEADERS })
  } catch (err) {
    throw new Error(`获取 Forge 版本信息（promotions_slim.json）失败：${err?.message ?? err}`)
  }
  const promos = data?.promos
  if (!promos || typeof promos !== 'object') {
    throw new Error('Forge promotions_slim.json 返回格式异常（缺少 promos）')
  }
  return promos
}

/** 旧版本 promotions 值形如 "10.13.4.1614-1.7.10"，去掉尾巴里的 mc 版本。 */
function normalizeForgePromoValue(value, mcVersion) {
  let version = String(value ?? '').trim()
  if (!version) return ''
  const suffix = `-${mcVersion}`
  if (version.endsWith(suffix)) version = version.slice(0, -suffix.length)
  return version
}

function forgeVersionsFor(promos, mcVersion) {
  const mc = String(mcVersion)
  const byVersion = new Map()
  for (const [key, raw] of Object.entries(promos)) {
    if (key !== mc && !key.startsWith(`${mc}-`)) continue
    const version = normalizeForgePromoValue(raw, mc)
    if (!version) continue
    const stable = Boolean(byVersion.get(version)?.stable) || key === `${mc}-recommended`
    byVersion.set(version, { version, stable })
  }
  return [...byVersion.values()].sort((a, b) => compareVersionStrings(b.version, a.version))
}

async function resolveForgeVersion(dl, mcVersion, explicitVersion, t) {
  const promos = await fetchForgePromos(dl)
  if (explicitVersion) {
    const version = normalizeForgePromoValue(explicitVersion, mcVersion)
    t.log(`使用指定的 Forge 版本：${version}`)
    return version
  }
  const recommended = normalizeForgePromoValue(promos[`${mcVersion}-recommended`], mcVersion)
  const latest = normalizeForgePromoValue(promos[`${mcVersion}-latest`], mcVersion)
  const version = recommended || latest
  if (!version) {
    throw new Error(`Forge 没有支持版本 ${mcVersion} 的加载器（信息源未收录该版本）`)
  }
  t.log(`自动选择 Forge ${version}（${recommended ? '推荐版' : '最新版'}）`)
  return version
}

// ── NeoForge ──────────────────────────────────────────────────────────────

/**
 * Minecraft → NeoForge 版本前缀。
 * 1.21.1→'21.1.'、1.21→'21.0.'、1.20.6→'20.6.'、1.20.4→'20.4.'、1.20.2→'20.2.'；
 * 1.20.1 为 legacy（net.neoforged:forge 47.1.x），返回 null。
 */
export function neoVersionPrefix(mcVersion) {
  const mc = String(mcVersion || '')
  if (mc === NEO_LEGACY_MC) return null
  const m = mc.match(/^1\.(\d+)(?:\.(\d+))?$/)
  if (!m) return null
  const minor = Number(m[1])
  const patch = Number(m[2] ?? 0)
  if (minor >= 21) return `21.${patch}.`
  if (minor === 20 && patch >= 2) return `20.${patch}.`
  return null
}

function neoArtifactPath(mcVersion) {
  return mcVersion === NEO_LEGACY_MC ? 'net/neoforged/forge' : 'net/neoforged/neoforge'
}

/**
 * NeoForge maven-metadata.xml 官方地址。
 * 官方 maven 当前不可达，mirrors.fetchText 会把它改写成 bmclapi / qlu 镜像候选，
 * 官方地址排最后兜底。
 */
function neoMetadataOfficialUrl(mcVersion) {
  const artifact = neoArtifactPath(mcVersion)
  return `${NEOFORGE_MAVEN}/${artifact}/maven-metadata.xml`
}

async function fetchNeoForgeMetadata(dl, mcVersion) {
  const officialUrl = neoMetadataOfficialUrl(mcVersion)
  let lastErr = null
  try {
    const xml = await mirrorFetchText(dl, officialUrl, { timeoutMs: 20000, headers: { 'user-agent': USER_AGENT } })
    const versions = [...String(xml ?? '').matchAll(/<version>([^<]+)<\/version>/g)]
      .map((match) => match[1].trim())
      .filter(Boolean)
    if (versions.length) return { url: officialUrl, versions }
    lastErr = new Error('maven-metadata.xml 里没有 <version> 节点')
  } catch (err) {
    lastErr = err
  }
  throw new Error(
    `无法获取 NeoForge 版本元数据（${officialUrl}；镜像与官方均失败）` +
      `${lastErr ? `；最后错误：${lastErr.message}` : ''}`,
  )
}

/** NeoForge legacy（1.20.1）的 maven 版本形如 "1.20.1-47.1.106"，对外版本号去掉 mc 前缀。 */
function normalizeNeoVersion(mcVersion, version) {
  const value = String(version ?? '').trim()
  const prefix = `${mcVersion}-`
  return mcVersion === NEO_LEGACY_MC && value.startsWith(prefix) ? value.slice(prefix.length) : value
}

function neoVersionsFor(mcVersion, metadataVersions) {
  const prefix = neoVersionPrefix(mcVersion)
  let filtered = []
  if (prefix) {
    filtered = metadataVersions.filter((version) => version.startsWith(prefix))
  } else if (mcVersion === NEO_LEGACY_MC) {
    filtered = metadataVersions.filter((version) => version.startsWith(`${NEO_LEGACY_MC}-47.1.`))
  }
  return filtered
    .map((version) => ({
      version: normalizeNeoVersion(mcVersion, version),
      stable: !/-(beta|alpha)/i.test(version),
    }))
    .sort((a, b) => compareVersionStrings(b.version, a.version))
}

// ── 通用：安装器运行 ──────────────────────────────────────────────────────

/** 安装器运行所需的 Java 主版本。 */
export function installerJavaMajor(mcVersion) {
  const m = String(mcVersion || '').match(/^1\.(\d+)(?:\.(\d+))?/)
  if (!m) return 17
  const minor = Number(m[1])
  const patch = Number(m[2] ?? 0)
  if (minor >= 21) return 21
  if (minor === 20 && patch >= 5) return 21
  if (minor >= 17) return 17
  return 8
}

async function ensureLauncherProfilesFile(paths) {
  if (!paths?.launcherProfiles) return
  if (await pathExists(paths.launcherProfiles)) return
  await writeJson(paths.launcherProfiles, { profiles: {}, settings: {}, version: 3 })
}

async function resolveInstallerJava({ getJava, major, t }) {
  if (typeof getJava === 'function') {
    const javaPath = await getJava(major)
    if (!javaPath) throw new Error(`未能取得 Java ${major}，无法运行加载器安装器`)
    return String(javaPath)
  }
  const javas = await detectJavas({})
  const hit = javas.find((java) => java.major === major) ?? javas[0]
  if (!hit) {
    throw new Error(`运行加载器安装器需要 Java ${major}，但本机没有找到可用 Java，请先安装 Java 或设置 javaPath`)
  }
  t.log(`未注入 getJava，改用本机 Java ${hit.major}：${hit.path}`)
  return hit.path
}

/**
 * 运行官方安装器：java -jar installer --installClient <minecraftDir>（cwd = minecraftDir）。
 * stdout/stderr 逐行写入 task.log；返回 { code, signal, tail }，超时/启动失败抛错。
 */
async function runInstaller({ javaPath, installerPath, minecraftDir, task, label, timeoutMs = 20 * 60 * 1000 }) {
  const t = taskOf(task)
  await fsp.mkdir(minecraftDir, { recursive: true })
  return await new Promise((resolve, reject) => {
    let child
    try {
      child = spawn(javaPath, ['-jar', installerPath, '--installClient', minecraftDir], {
        cwd: minecraftDir,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (err) {
      reject(new Error(`启动 ${loaderLabel(label)} 安装器失败：${err?.message ?? err}`))
      return
    }
    const tail = []
    let settled = false
    let timer = null
    let rlOut = null
    let rlErr = null
    const finish = (fn, arg) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      try {
        rlOut?.close()
      } catch {
        /* 忽略 */
      }
      try {
        rlErr?.close()
      } catch {
        /* 忽略 */
      }
      fn(arg)
    }
    const pushLine = (line) => {
      const text = String(line ?? '').replace(/\r$/, '').trim()
      if (!text) return
      tail.push(text)
      if (tail.length > 300) tail.shift()
      t.log(`[${label}] ${text}`)
    }
    const wire = (stream) => {
      const reader = readline.createInterface({ input: stream })
      reader.on('line', pushLine)
      return reader
    }
    if (child.stdout) rlOut = wire(child.stdout)
    if (child.stderr) rlErr = wire(child.stderr)
    timer = setTimeout(() => {
      try {
        child.kill()
      } catch {
        /* 忽略 */
      }
      finish(reject, new Error(`${loaderLabel(label)} 安装器运行超时（${Math.round(timeoutMs / 1000)} 秒）`))
    }, timeoutMs)
    child.on('error', (err) => finish(reject, new Error(`运行 ${loaderLabel(label)} 安装器出错：${err?.message ?? err}`)))
    child.on('exit', (code, signal) => finish(resolve, { code: code ?? -1, signal: signal ?? null, tail }))
  })
}

/** 在 <versions> 下定位加载器产出的 version json（优先期望 id，其次按修改时间扫描）。 */
async function locateLoaderJson({ paths, mcVersion, pattern, sinceMs, expectedId }) {
  const versionsDir = paths.versions
  if (expectedId) {
    const jsonPath = path.join(versionsDir, expectedId, `${expectedId}.json`)
    const json = await readJson(jsonPath, null)
    if (json?.id) return { versionId: expectedId, jsonPath, json }
  }
  let entries = []
  try {
    entries = await fsp.readdir(versionsDir, { withFileTypes: true })
  } catch {
    return null
  }
  const candidates = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const id = entry.name
    if (!pattern.test(id)) continue
    const jsonPath = path.join(versionsDir, id, `${id}.json`)
    try {
      const stat = await fsp.stat(jsonPath)
      if (sinceMs && stat.mtimeMs < sinceMs - 5000) continue
      const json = JSON.parse(await fsp.readFile(jsonPath, 'utf8'))
      if (!json?.id) continue
      if (json.inheritsFrom && mcVersion && json.inheritsFrom !== mcVersion) continue
      candidates.push({ versionId: id, jsonPath, json, mtimeMs: stat.mtimeMs })
    } catch {
      /* 忽略坏文件，继续扫描 */
    }
  }
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs)
  const hit = candidates[0]
  return hit ? { versionId: hit.versionId, jsonPath: hit.jsonPath, json: hit.json } : null
}

// ── 原版 version json（chain[0]）──────────────────────────────────────────

async function loadBaseVersionJson({ dl, paths, mcVersion, t }) {
  if (paths?.versions) {
    const file = path.join(paths.versions, mcVersion, `${mcVersion}.json`)
    const cached = await readJson(file, null)
    if (cached?.id) return cached
  }
  // lib/version.js（同包）优先；缺失时用 mirrors 解析官方 version json 地址（镜像候选自动生成）
  try {
    const versionModule = await import('./version.js')
    if (typeof versionModule.fetchVersionJson === 'function') {
      const json = await versionModule.fetchVersionJson(dl, mcVersion)
      if (json?.id) return json
    }
  } catch {
    /* 模块缺失或不可用，走兜底 */
  }
  t.log(`本地没有原版 ${mcVersion} 的 version json，直接从镜像获取 …`)
  const url = `${OFFICIAL.pistonMeta}version/${encodeURIComponent(mcVersion)}/json`
  try {
    const json = await mirrorFetchJson(dl, url, { timeoutMs: 25000, headers: HEADERS })
    if (json?.id) return json
  } catch (err) {
    throw new Error(`获取原版 ${mcVersion} 的 version json 失败：${err?.message ?? err}`)
  }
  throw new Error(`获取原版 ${mcVersion} 的 version json 失败：返回内容异常`)
}

// ── 各加载器安装 ──────────────────────────────────────────────────────────

async function installFabricLike({ dl, paths, mcVersion, type, version, t }) {
  const label = loaderLabel(type)
  const metaBase = type === 'fabric' ? FABRIC_META : QUILT_META
  const metaVersion = type === 'fabric' ? 'v2' : 'v3'

  let chosen = version ? String(version) : ''
  if (!chosen) {
    t.log(`查询 ${label} 支持版本 ${mcVersion} 的加载器版本 …`)
    const list = await listLoaderVersions({ dl, mcVersion, type })
    if (!list.versions.length) {
      throw new Error(`${label} 没有支持版本 ${mcVersion} 的加载器版本${list.note ? `：${list.note}` : ''}`)
    }
    const stable = list.versions.find((item) => item.stable) ?? list.versions[0]
    chosen = stable.version
    t.log(`自动选择 ${label} ${chosen}${stable.stable ? '（稳定版）' : ''}`)
  }

  t.log(`获取 ${label} ${chosen} 的 profile json …`)
  const profileUrl =
    `${metaBase}/${metaVersion}/versions/loader/${encodeURIComponent(mcVersion)}/` +
    `${encodeURIComponent(chosen)}/profile/json`
  let profile
  try {
    profile = await dl.fetchJson(profileUrl, { timeoutMs: 25000, headers: HEADERS })
  } catch (err) {
    throw new Error(`获取 ${label} ${chosen} 的 profile 失败：${err?.message ?? err}`)
  }
  if (!profile || typeof profile !== 'object' || !profile.mainClass) {
    throw new Error(`${label} ${chosen} 的 profile json 内容异常（缺少 mainClass）`)
  }
  const fallbackId = `${type === 'fabric' ? 'fabric' : 'quilt'}-loader-${chosen}-${mcVersion}`
  const versionId = String(profile.id || fallbackId)
  profile.id = versionId

  const baseJson = await loadBaseVersionJson({ dl, paths, mcVersion, t })
  const jsonPath = path.join(paths.versions, versionId, `${versionId}.json`)
  await writeJson(jsonPath, profile)
  t.log(`${label} ${chosen} 安装完成，version id：${versionId}`)
  return { type, version: chosen, versionId, jsonPath, chain: [baseJson, profile] }
}

async function installForge({ dl, paths, mcVersion, version, getJava, t }) {
  const chosen = await resolveForgeVersion(dl, mcVersion, version, t)
  const installerName = `forge-${mcVersion}-${chosen}-installer.jar`
  const installerUrl =
    `${FORGE_MAVEN}/net/minecraftforge/forge/${encodeURIComponent(`${mcVersion}-${chosen}`)}/` +
    `${encodeURIComponent(installerName)}`
  await fsp.mkdir(paths.installers, { recursive: true })
  const installerPath = path.join(paths.installers, installerName)
  t.log(`下载 Forge ${chosen} 安装器：${installerUrl}`)
  let installer
  try {
    installer = await dl.downloadFile(installerUrl, installerPath, { task: t, timeoutMs: 180000, attempts: 3 })
  } catch (err) {
    throw new Error(`下载 Forge 安装器失败：${err?.message ?? err}`)
  }
  t.log(`Forge 安装器就绪（${installer.bytes} 字节）：${installer.path}`)

  await ensureLauncherProfilesFile(paths)
  const javaMajorNeeded = installerJavaMajor(mcVersion)
  const javaPath = await resolveInstallerJava({ getJava, major: javaMajorNeeded, t })
  t.log(`运行 Forge 安装器（Java ${javaMajorNeeded}）：${javaPath} -jar ${installer.path} --installClient ${paths.minecraft}`)
  const startedAt = Date.now()
  const run = await runInstaller({
    javaPath,
    installerPath: installer.path,
    minecraftDir: paths.minecraft,
    task: t,
    label: 'forge',
  })
  if (run.code !== 0) {
    throw new Error(
      `Forge 安装器失败（退出码 ${run.code}${run.signal ? `，信号 ${run.signal}` : ''}）；` +
        `日志尾部：\n${run.tail.slice(-20).join('\n')}`,
    )
  }
  const found = await locateLoaderJson({
    paths,
    mcVersion,
    pattern: /forge/i,
    sinceMs: startedAt,
    expectedId: `${mcVersion}-forge-${chosen}`,
  })
  if (!found) {
    throw new Error(`Forge 安装器已退出，但未在 ${paths.versions} 下找到 Forge 的 version json，安装可能未完成`)
  }
  const baseJson = await loadBaseVersionJson({ dl, paths, mcVersion, t })
  t.log(`Forge ${chosen} 安装完成，version id：${found.versionId}`)
  return { type: 'forge', version: chosen, versionId: found.versionId, jsonPath: found.jsonPath, chain: [baseJson, found.json] }
}

async function installNeoForge({ dl, paths, mcVersion, version, getJava, t }) {
  const neoPrefix = neoVersionPrefix(mcVersion)
  const legacy = mcVersion === NEO_LEGACY_MC
  if (!neoPrefix && !legacy) {
    throw new Error(`NeoForge 不支持版本 ${mcVersion}（支持 1.20.2 及以上，或 1.20.1 legacy 版）`)
  }

  let chosen = version ? normalizeNeoVersion(mcVersion, version) : ''
  if (!chosen) {
    t.log(`查询 NeoForge 支持版本 ${mcVersion} 的加载器版本 …`)
    const list = await listLoaderVersions({ dl, mcVersion, type: 'neoforge' })
    if (!list.versions.length) {
      throw new Error(`NeoForge 没有支持版本 ${mcVersion} 的加载器版本${list.note ? `：${list.note}` : ''}`)
    }
    chosen = list.versions[0].version
    t.log(`自动选择 NeoForge ${chosen}`)
  }

  const artifact = neoArtifactPath(mcVersion)
  // legacy 1.20.1 的 maven 坐标带着 mc 前缀：1.20.1-47.1.x
  const mavenVersion = legacy ? `${mcVersion}-${chosen}` : chosen
  const installerName = legacy ? `forge-${mavenVersion}-installer.jar` : `neoforge-${chosen}-installer.jar`
  const officialUrl = `${NEOFORGE_MAVEN}/${artifact}/${encodeURIComponent(mavenVersion)}/${encodeURIComponent(installerName)}`
  const qluUrl = `${QLU_BMCLAPI}/${artifact}/${encodeURIComponent(mavenVersion)}/${encodeURIComponent(installerName)}`
  await fsp.mkdir(paths.installers, { recursive: true })
  const installerPath = path.join(paths.installers, installerName)

  // 安装器下载：qlu 镜像优先，官方兜底（官方 maven 当前大概率不可达）
  t.log(`下载 NeoForge ${chosen} 安装器：${qluUrl}`)
  let installer
  try {
    installer = await dl.downloadFile(qluUrl, installerPath, { task: t, timeoutMs: 180000, attempts: 2 })
  } catch (mirrorErr) {
    t.log(`镜像下载 NeoForge 安装器失败：${mirrorErr?.message ?? mirrorErr}，改用官方地址`)
    try {
      installer = await dl.downloadFile(officialUrl, installerPath, { task: t, timeoutMs: 180000, attempts: 1 })
    } catch (officialErr) {
      throw new Error(
        `下载 NeoForge 安装器失败（镜像：${mirrorErr?.message ?? mirrorErr}；官方：${officialErr?.message ?? officialErr}）`,
      )
    }
  }
  t.log(`NeoForge 安装器就绪（${installer.bytes} 字节）：${installer.path}`)

  await ensureLauncherProfilesFile(paths)
  const javaMajorNeeded = installerJavaMajor(mcVersion)
  const javaPath = await resolveInstallerJava({ getJava, major: javaMajorNeeded, t })
  t.log(`运行 NeoForge 安装器（Java ${javaMajorNeeded}）：${javaPath} -jar ${installer.path} --installClient ${paths.minecraft}`)
  const startedAt = Date.now()
  const neoHint = 'NeoForge 官方 maven 当前不可达，请改用 Forge/Fabric，或稍后重试'
  let run
  try {
    run = await runInstaller({
      javaPath,
      installerPath: installer.path,
      minecraftDir: paths.minecraft,
      task: t,
      label: 'neoforge',
    })
  } catch (err) {
    t.log(`提示：${neoHint}`)
    throw new Error(`NeoForge 安装器运行失败：${err?.message ?? err}（${neoHint}）`)
  }
  if (run.code !== 0) {
    t.log(`提示：${neoHint}`)
    throw new Error(
      `NeoForge 安装器失败（退出码 ${run.code}${run.signal ? `，信号 ${run.signal}` : ''}）：` +
        `安装器运行期需要访问 maven.neoforged.net，本机当前不可达；${neoHint}。日志尾部：\n` +
        run.tail.slice(-20).join('\n'),
    )
  }
  const found = await locateLoaderJson({
    paths,
    mcVersion,
    pattern: /(neoforge|forge)/i,
    sinceMs: startedAt,
  })
  if (!found) {
    throw new Error(`NeoForge 安装器已退出，但未在 ${paths.versions} 下找到 version json，安装可能未完成`)
  }
  const baseJson = await loadBaseVersionJson({ dl, paths, mcVersion, t })
  t.log(`NeoForge ${chosen} 安装完成，version id：${found.versionId}`)
  return {
    type: 'neoforge',
    version: chosen,
    versionId: found.versionId,
    jsonPath: found.jsonPath,
    chain: [baseJson, found.json],
  }
}

// ── 对外 API ──────────────────────────────────────────────────────────────

/**
 * 列出某 Minecraft 版本可用的加载器版本。
 * 返回 { type, versions: [{ version, stable }], note? }
 */
export async function listLoaderVersions({ dl, mcVersion, type } = {}) {
  const mc = String(mcVersion ?? '').trim()
  const kind = String(type ?? '').trim()
  if (!mc) throw new Error('缺少游戏版本号（例如 1.20.1）')
  if (!LOADER_TYPES.includes(kind)) {
    throw new Error(`不支持的加载器类型：${kind}（可选 ${LOADER_TYPES.join('/')}）`)
  }
  if (!dl || typeof dl.fetchJson !== 'function') {
    throw new Error('缺少下载器（createDownloader），无法查询加载器版本')
  }

  if (kind === 'fabric' || kind === 'quilt') {
    const versions =
      kind === 'fabric' ? await fetchFabricLoaderVersions(dl, mc) : await fetchQuiltLoaderVersions(dl, mc)
    return {
      type: kind,
      versions,
      note: versions.length ? undefined : `${loaderLabel(kind)} 没有发布支持版本 ${mc} 的加载器版本`,
    }
  }

  if (kind === 'forge') {
    const promos = await fetchForgePromos(dl)
    const versions = forgeVersionsFor(promos, mc)
    return {
      type: kind,
      versions,
      note: versions.length ? undefined : `Forge 信息源里没有版本 ${mc} 的信息（旧版本可能未收录）`,
    }
  }

  // neoforge
  if (!neoVersionPrefix(mc) && mc !== NEO_LEGACY_MC) {
    return { type: kind, versions: [], note: `NeoForge 不支持版本 ${mc}（支持 1.20.2 及以上，或 1.20.1 legacy 版）` }
  }
  const metadata = await fetchNeoForgeMetadata(dl, mc)
  const versions = neoVersionsFor(mc, metadata.versions)
  return {
    type: kind,
    versions,
    note: versions.length ? undefined : `NeoForge 信息源中没有版本 ${mc} 对应的加载器`,
  }
}

/**
 * 安装加载器。fabric/quilt 只写 profile json；forge/neoforge 还需运行官方安装器。
 * 返回 { type, version, versionId, jsonPath, chain: [baseVersionJson, loaderVersionJson] }
 */
export async function installLoader({ dl, paths, mcVersion, type, version = null, getJava, task } = {}) {
  const t = taskOf(task)
  const mc = String(mcVersion ?? '').trim()
  const kind = String(type ?? '').trim()
  if (!mc) throw new Error('缺少游戏版本号（例如 1.20.1）')
  if (!LOADER_TYPES.includes(kind)) {
    throw new Error(`不支持的加载器类型：${kind}（可选 ${LOADER_TYPES.join('/')}）`)
  }
  if (!paths?.versions || !paths?.installers) throw new Error('缺少 paths 参数（createPaths 的返回值）')
  if (!dl || typeof dl.downloadFile !== 'function') throw new Error('缺少下载器（createDownloader），无法安装加载器')

  t.setPhase('加载器')
  if (kind === 'fabric' || kind === 'quilt') {
    return await installFabricLike({ dl, paths, mcVersion: mc, type: kind, version, t })
  }
  if (kind === 'forge') {
    return await installForge({ dl, paths, mcVersion: mc, version, getJava, t })
  }
  return await installNeoForge({ dl, paths, mcVersion: mc, version, getJava, t })
}
