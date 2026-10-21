// 原版安装与运行期依赖补齐（v3 适配器版）
// 依赖同包模块：lib/version.js（版本 JSON 语义）、lib/zip.js（ZIP 解压）、lib/mirrors.js（镜像候选）、
// lib/util.js（文件工具）。下载器对象 dl 由 adapter 注入（ctx.dl 或 mirrors.makeDownloader(ctx)），
// 本文件不直接 import 核心包任何文件。

import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'

import { writeJson, formatBytes } from './util.js'
import { fetchVersionJson, libraryDependencies, nativesInfo, buildClasspath, primaryJarVersionId } from './version.js'
import { unzipTo } from './zip.js'
import { OFFICIAL, resolveUrlWithContext } from './mirrors.js'

const ASSET_OBJECT_BASE = OFFICIAL.resources
const NOOP_TASK = Object.freeze({ log() {}, items() {}, bytes() {}, setPhase() {} })

/** 取可用的 task（未传时用 no-op，契约 §7）。 */
function tq(task) {
  return task && typeof task === 'object' ? task : NOOP_TASK
}

function log(task, message) {
  try {
    tq(task).log?.(message)
  } catch {
    /* 日志失败不影响主流程 */
  }
}

function items(task, done, total, label) {
  try {
    tq(task).items?.(done, total, label)
  } catch {
    /* 进度失败不影响主流程 */
  }
}

/** 当前平台对应的 version.js env（Windows/x86_64 为常见目标）。 */
export function platformEnv() {
  const osName =
    process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'osx' : 'linux'
  const osArch =
    process.arch === 'x64'
      ? 'x86_64'
      : process.arch === 'arm64'
        ? 'arm64'
        : process.arch === 'ia32'
          ? 'x86'
          : process.arch
  return { osName, osArch, osVersion: os.release() }
}

/** 版本/资源 id 只能作为单层目录名，防御路径穿越。 */
function assertSafeId(id, label = '版本') {
  if (typeof id !== 'string' || !id || /[\\/]/.test(id) || id === '.' || id === '..' || id.includes('..')) {
    throw new Error(`非法的${label} ID：${JSON.stringify(id)}`)
  }
  return id
}

/** 文件是否存在且大小匹配（size 未给出时只判断存在）。 */
async function needsDownload(filePath, size) {
  let st
  try {
    st = await fsp.stat(filePath)
  } catch {
    return true
  }
  if (!st.isFile()) return true
  const expected = Number(size)
  if (Number.isFinite(expected) && expected > 0 && st.size !== expected) return true
  return false
}

/**
 * 经 mirrors 解析出镜像/官方候选后逐个尝试下载；任一成功即返回。
 * ctx 例如 { versionId, kind: 'client' }——客户端 jar 的官方 objects 地址反推不出
 * 版本号，必须靠 ctx.versionId 才能生成 `/version/<id>/client` 镜像候选。
 * dl.downloadFile 自身也会做一次候选回退，二者叠加更稳。
 */
async function downloadResolved(dl, url, destPath, options = {}, ctx = {}) {
  if (!url) throw new Error(`缺少下载地址（目标：${destPath}）`)
  if (typeof dl?.downloadFile !== 'function') throw new Error('下载器不可用：缺少 downloadFile()')
  let candidates = [url]
  try {
    const resolved = resolveUrlWithContext(url, ctx)
    if (Array.isArray(resolved) && resolved.length > 0) candidates = resolved
  } catch {
    candidates = [url]
  }
  if (candidates.length <= 1 && typeof dl.resolveUrls === 'function') {
    try {
      const resolved = dl.resolveUrls(url, ctx)
      if (Array.isArray(resolved) && resolved.length > 0) candidates = resolved
    } catch {
      /* 保持原候选 */
    }
  }
  candidates = Array.from(new Set(candidates.filter((u) => typeof u === 'string' && u)))
  if (candidates.length === 0) candidates = [url]

  let lastError = null
  for (const candidate of candidates) {
    try {
      return await dl.downloadFile(candidate, destPath, options)
    } catch (err) {
      lastError = err
    }
  }
  const detail = lastError?.message || '未知错误'
  throw new Error(`下载失败：${url}\n最后错误：${detail}`)
}

/**
 * 并行批量下载运行库/本地库（下载引擎 §2 契约逐条走 dl.downloadMany）。
 * 旧下载器或测试桩没有 downloadMany 时，自动回退到原来的「逐文件串行 await」路径，
 * 因此不影响兼容性；错误信息带文件名与候选源，便于定位是哪个 maven artifact 失败。
 * items 元素：{ url, dest, sha1, size, ctx?, name? }
 * 返回 { total, downloaded, cached, failed, bytes }。
 */
async function downloadManyResolved(dl, list, { task, label, quiet } = {}) {
  const batch = (Array.isArray(list) ? list : []).filter((item) => item && item.url && item.dest)
  if (batch.length === 0) return { total: 0, downloaded: 0, cached: 0, failed: [], bytes: 0 }

  if (typeof dl?.downloadMany === 'function') {
    const result = await dl.downloadMany(batch, { task, label, quiet })
    if (Array.isArray(result?.failed) && result.failed.length > 0) {
      const detail = result.failed
        .map((failure) => {
          const name = failure?.name || (failure?.dest ? path.basename(String(failure.dest)) : '未知文件')
          return `${name}: ${failure?.error || '下载失败'}`
        })
        .join('；')
      throw new Error(`并行下载失败（${result.failed.length}/${result.total ?? batch.length}）：${detail}`)
    }
    return result
  }

  // 兼容路径：旧实现没有 downloadMany，保持原串行语义（含逐文件候选源回退）。
  let downloaded = 0
  let bytes = 0
  for (const item of batch) {
    const name = item.name || path.basename(item.dest)
    try {
      const result = await downloadResolved(
        dl,
        item.url,
        item.dest,
        { sha1: item.sha1, size: item.size, task, quiet },
        item.ctx || {},
      )
      downloaded += 1
      bytes += Number(result?.bytes) || 0
    } catch (error) {
      let candidates = [item.url]
      try {
        const resolved = typeof dl?.resolveUrls === 'function' ? dl.resolveUrls(item.url, item.ctx || {}) : null
        if (Array.isArray(resolved) && resolved.length > 0) candidates = resolved
      } catch {
        candidates = [item.url]
      }
      throw new Error(
        `下载失败：${name}（候选源：${candidates.join(' , ')}）；最后错误：${error?.message || error}`,
      )
    }
    items(task, downloaded, batch.length, label || '下载库')
  }
  return { total: batch.length, downloaded, cached: 0, failed: [], bytes }
}

/** 把 extra 追加到 classpath 字符串末尾（去重、保持原顺序，Windows 用 ';'）。 */
function appendClasspath(classpath, extra) {
  const entries = String(classpath || '')
    .split(path.delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean)
  const seen = new Set(entries.map((entry) => entry.toLowerCase()))
  for (const raw of [extra]) {
    if (!raw) continue
    const entry = path.resolve(String(raw))
    if (seen.has(entry.toLowerCase())) continue
    seen.add(entry.toLowerCase())
    entries.push(entry)
  }
  return entries.join(path.delimiter)
}

function normalizeZipName(name) {
  return String(name || '')
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
}

/** natives 解压过滤器：排除 extract.exclude 前缀（默认 META-INF/），并跳过目录项。 */
function nativeEntryFilter(extractExclude) {
  const raw = Array.isArray(extractExclude) && extractExclude.length > 0 ? extractExclude : ['META-INF/']
  const prefixes = raw.map((p) => normalizeZipName(p)).filter(Boolean)
  return (entry) => {
    if (!entry) return false
    if (entry.isDirectory) return false
    const name = normalizeZipName(entry.name)
    if (!name) return false
    for (const prefix of prefixes) {
      if (name === prefix || name.startsWith(prefix)) return false
      // 兼容省略结尾斜杠的写法（如 META-INF）
      const withSlash = prefix.endsWith('/') ? prefix : `${prefix}/`
      if (name.startsWith(withSlash)) return false
    }
    return true
  }
}

/** 把 natives jar 解压到目标目录（覆盖写）。 */
async function extractNativeJar(jarPath, nativesDir, extractExclude, task) {
  log(task, `解压本地库：${path.basename(jarPath)}`)
  const result = await unzipTo(jarPath, nativesDir, {
    filter: nativeEntryFilter(extractExclude),
    overwrite: true,
    onProgress: (done, total) => items(task, done, total, `解压本地库 ${path.basename(jarPath)}`),
  })
  return result
}

/** 确保 <assetIndexes>/<id>.json 存在；返回 { indexPath, index }。 */
async function ensureAssetIndexFile({ dl, paths, info, task }) {
  const assetIndexId = assertSafeId(info?.id, '资源索引')
  const indexPath = path.join(paths.assetIndexes, `${assetIndexId}.json`)
  const indexSize = Number(info?.size) > 0 ? Number(info.size) : undefined

  const need = await needsDownload(indexPath, indexSize)
  if (need) {
    log(task, `下载资源索引：${assetIndexId}（${indexSize ? formatBytes(indexSize) : '大小未知'}）`)
    if (!info?.url) throw new Error(`资源索引 ${assetIndexId} 不存在，且版本文件未提供下载地址`)
    await downloadResolved(dl, info.url, indexPath, {
      sha1: info.sha1,
      size: indexSize,
      task,
    })
  } else {
    log(task, `资源索引已存在：${indexPath}`)
  }

  let index
  try {
    index = JSON.parse(await fsp.readFile(indexPath, 'utf8'))
  } catch (err) {
    // 文件损坏（常见于半截下载）：删掉重下一次
    log(task, `资源索引损坏，重新下载：${err?.message || err}`)
    await fsp.rm(indexPath, { force: true })
    if (!info?.url) throw new Error(`资源索引 ${assetIndexId} 损坏且版本文件未提供下载地址`)
    await downloadResolved(dl, info.url, indexPath, { sha1: info.sha1, size: indexSize, task })
    index = JSON.parse(await fsp.readFile(indexPath, 'utf8'))
  }
  return { indexPath, index }
}

/**
 * 批量补齐资源对象（objects）。并发交给 dl 内部队列（契约 §2），这里只做小批并发提交。
 * 返回 { total, missing, downloaded }。
 */
async function ensureAssetObjects({ dl, paths, index, task }) {
  const objects = index && typeof index === 'object' && index.objects ? index.objects : {}
  const entries = Object.entries(objects).filter(([, obj]) => obj && typeof obj.hash === 'string')
  const total = entries.length
  if (total === 0) {
    log(task, '资源索引中没有对象，跳过资源对象下载')
    return { total: 0, missing: 0, downloaded: 0 }
  }

  // 先筛出缺失的（已存在且大小正确的不再发起请求）
  const missing = []
  for (const [name, obj] of entries) {
    const hash = obj.hash
    const dest = path.join(paths.assetsObjects, hash.slice(0, 2), hash)
    if (await needsDownload(dest, obj.size)) missing.push({ name, hash, size: obj.size, dest })
  }

  log(task, `资源对象：共 ${total} 个，缺失 ${missing.length} 个`)
  const alreadyPresent = total - missing.length
  let downloaded = 0

  if (missing.length > 0) {
    // 并行能力交给下载引擎（§2 契约）：一次提交全部缺失对象，由 dl.downloadMany 用
    // 内部队列/分片/重试完成；旧下载器没有 downloadMany 时 helper 自动回退逐文件串行。
    const missingItems = missing.map((item) => ({
      url: `${ASSET_OBJECT_BASE}${item.hash.slice(0, 2)}/${item.hash}`,
      dest: item.dest,
      sha1: item.hash,
      size: item.size,
      name: item.name || `${item.hash.slice(0, 2)}/${item.hash}`,
    }))
    // 进度按「全量对象」上报（已存在的对象也算完成），用户看到的仍是 total 个对象；
    // bytes 增量与取消异常原样透传，取消时 downloadMany 会抛回「任务已取消」。
    const progressTask = task
      ? {
          bytes: (n) => task.bytes?.(n),
          items: (done) => items(task, alreadyPresent + done, total, '下载资源对象'),
          log: (line) => log(task, line),
          setPhase: (phase) => task.setPhase?.(phase),
        }
      : undefined
    const result = await downloadManyResolved(dl, missingItems, {
      task: progressTask,
      label: '下载资源对象',
      quiet: true,
    })
    downloaded = Number(result?.downloaded) || 0
    items(task, alreadyPresent + downloaded, total, '下载资源对象')
    log(task, `下载资源对象完成（缺失 ${missing.length} 个已处理，共 ${total} 个对象）`)
  } else {
    items(task, total, total, '下载资源对象')
    log(task, `资源对象已全部就绪 (${total}/${total})`)
  }
  return { total, missing: missing.length, downloaded }
}

/**
 * 安装指定原版版本（契约 §5）。
 * @param {object} opts
 * @param {object} opts.dl          下载器（§2）
 * @param {object} opts.paths       createPaths() 结果（§1）
 * @param {string} opts.versionId   原版版本 id（如 '1.20.1'）
 * @param {string} [opts.assetsMode] 'full'（下载全部对象）| 'index'（只下索引）
 * @param {object} [opts.task]      进度对象（§7）
 * @param {object|null} [opts.json] 已预取的版本 JSON（可选，省一次网络请求）
 */
export async function installVanilla({
  dl,
  paths,
  versionId,
  assetsMode = 'full',
  task,
  json: preloadedJson = null,
} = {}) {
  assertSafeId(versionId)
  if (!dl) throw new Error('installVanilla 缺少下载器 dl')
  if (!paths?.versions) throw new Error('installVanilla 缺少 paths')

  const mode = assetsMode === 'full' ? 'full' : 'index'
  const versionDir = path.join(paths.versions, versionId)
  const jsonPath = path.join(versionDir, `${versionId}.json`)
  const jarPath = path.join(versionDir, `${versionId}.jar`)
  const nativesDir = path.join(versionDir, 'natives')
  await fsp.mkdir(versionDir, { recursive: true })

  // 1) 版本 JSON ----------------------------------------------------------
  log(task, `读取版本清单：${versionId}`)
  const versionJson = preloadedJson ?? (await fetchVersionJson(dl, versionId))
  if (!versionJson || typeof versionJson !== 'object') {
    throw new Error(`版本 ${versionId} 的 JSON 无效`)
  }
  log(task, `写入版本文件：${jsonPath}`)
  await writeJson(jsonPath, versionJson) // 原子写（tmp + rename）

  // 2) 客户端 jar ---------------------------------------------------------
  const client = versionJson.downloads?.client
  if (client?.url) {
    const clientSize = Number(client.size) > 0 ? Number(client.size) : undefined
    const clientSha1 = client.sha1 || undefined
    if (!(await needsDownload(jarPath, clientSize))) {
      log(task, `客户端已存在：${formatBytes((await fsp.stat(jarPath)).size)}`)
    } else {
      log(task, `下载客户端 ${clientSize ? formatBytes(clientSize) : '（大小未知）'}`)
      const result = await downloadResolved(
        dl,
        client.url,
        jarPath,
        { sha1: clientSha1, size: clientSize, task },
        { versionId, kind: 'client' },
      )
      log(task, `客户端就绪：${formatBytes(result?.bytes ?? clientSize ?? 0)}`)
    }
  } else {
    log(task, `版本 ${versionId} 未提供客户端下载信息（downloads.client）`)
  }

  // 3) 运行库 + natives ---------------------------------------------------
  const env = platformEnv()
  const libraries = libraryDependencies(versionJson, env) || []
  const totalLibs = libraries.length
  log(task, `校验运行库（${totalLibs} 个）`)

  const libResults = []
  const libItems = []
  for (const dep of libraries) {
    const mavenPath = dep?.mavenPath
    if (!mavenPath) continue
    const dest = path.join(paths.libraries, mavenPath)
    const info = dep.download && dep.download.url ? dep.download : null
    libResults.push({ name: dep.name, path: dest, url: info?.url ?? dep.url ?? null })
    if (!info) {
      log(task, `跳过无下载信息的库：${dep.name || mavenPath}`)
      continue
    }
    libItems.push({ url: info.url, dest, sha1: info.sha1, size: info.size, name: dep.name || mavenPath })
  }
  if (libItems.length > 0) {
    log(task, `并行下载运行库（${libItems.length} 个，共 ${totalLibs} 个）`)
    await downloadManyResolved(dl, libItems, { task, label: '下载库' })
  }
  items(task, totalLibs, totalLibs, '下载库')
  log(task, `下载库完成 (${totalLibs}/${totalLibs})`)

  const natives = nativesInfo(versionJson, env) || []
  const nativeResults = []
  // 无论是否有 natives 都建目录：旧格式版本需要解压，新格式（1.20.1）目录留空但契约要求路径可用
  await fsp.mkdir(nativesDir, { recursive: true })
  if (natives.length > 0) {
    log(task, `下载并解压本地库（natives，${natives.length} 个）`)
    // 先并行下载缺失/待校验的 natives jar，再串行解压（解压是 CPU/磁盘开销，串行即可）。
    const nativeItems = []
    for (const native of natives) {
      const dest = path.join(paths.libraries, native.mavenPath)
      const url = native.url || native.download?.url
      const sha1 = native.sha1 || native.download?.sha1
      const size = native.size || native.download?.size
      if (!url) {
        log(task, `本地库缺少下载地址，跳过：${native.name}`)
        continue
      }
      nativeItems.push({ url, dest, sha1, size, name: native.name || native.mavenPath })
    }
    if (nativeItems.length > 0) {
      await downloadManyResolved(dl, nativeItems, { task, label: '下载本地库' })
    }
    let doneNatives = 0
    for (const native of natives) {
      const dest = path.join(paths.libraries, native.mavenPath)
      if (!(await needsDownload(dest))) {
        await extractNativeJar(dest, nativesDir, native.extractExclude, task)
      }
      doneNatives += 1
      items(task, doneNatives, natives.length, '解压本地库')
    }
    nativeResults.push(...natives.map((n) => n.name))
  } else {
    log(task, '该版本没有需要解压的 natives 库')
  }

  // 4) 资源（索引 + 可选对象） --------------------------------------------
  let assetIndex = { id: null, path: null }
  let assets = { total: 0, downloaded: 0 }
  if (versionJson.assetIndex?.id) {
    const ensured = await ensureAssetIndexFile({
      dl,
      paths,
      info: versionJson.assetIndex,
      task,
    })
    assetIndex = { id: versionJson.assetIndex.id, path: ensured.indexPath }
    if (mode === 'full') {
      assets = await ensureAssetObjects({
        dl,
        paths,
        index: ensured.index,
        task,
      })
      assets = { total: assets.total, downloaded: assets.downloaded }
    } else {
      assets = { total: ensured.index?.objects ? Object.keys(ensured.index.objects).length : 0, downloaded: 0 }
      log(task, `资源索引已就绪（assetsMode=index，跳过对象下载，共 ${assets.total} 个对象）`)
    }
  } else {
    log(task, '版本未提供 assetIndex，跳过资源下载')
  }

  // 5) logging 配置 -------------------------------------------------------
  const logFile = versionJson.logging?.client?.file
  if (logFile?.url) {
    const rawId = String(logFile.id || `${versionId}.xml`)
    const fileName = rawId.endsWith('.xml') ? rawId : `${rawId}.xml`
    const dest = path.join(paths.logConfigs, path.basename(fileName))
    log(task, `下载日志配置：${path.basename(fileName)}`)
    await downloadResolved(dl, logFile.url, dest, {
      sha1: logFile.sha1,
      size: logFile.size,
      task,
    })
  }

  // 6) 返回前校验客户端 jar ----------------------------------------------
  if (await needsDownload(jarPath)) {
    throw new Error(`原版安装失败：客户端 jar 不存在或大小不符（${jarPath}）`)
  }

  log(task, `原版安装完成：${versionId}`)
  return {
    versionId,
    jsonPath,
    jarPath,
    libraries: libResults,
    nativesDir,
    nativeLibraries: nativeResults,
    assetIndex,
    assets,
    json: versionJson,
  }
}

/**
 * 启动前补库：对 merged 链（§4）下载缺失运行库、解压 natives，返回 classpath（契约 §5）。
 */
export async function ensureRuntimeLibraries({ dl, paths, merged, nativesDir, task } = {}) {
  if (!merged) throw new Error('ensureRuntimeLibraries 缺少 merged 版本对象')
  if (!paths?.libraries) throw new Error('ensureRuntimeLibraries 缺少 paths')
  const env = platformEnv()
  const deps = libraryDependencies(merged, env) || []
  const totalLibs = deps.length
  log(task, `校验运行库（${totalLibs} 个）`)

  const libItems = []
  let missingLibs = 0
  for (const dep of deps) {
    const mavenPath = dep?.mavenPath
    if (!mavenPath) continue
    const dest = path.join(paths.libraries, mavenPath)
    const info = dep.download && dep.download.url ? dep.download : null
    if (!info) continue
    const need = await needsDownload(dest, info.size)
    if (need) missingLibs += 1
    libItems.push({ url: info.url, dest, sha1: info.sha1, size: info.size, name: dep.name || mavenPath })
  }
  if (missingLibs > 0) log(task, `补下运行库 ${missingLibs} 个`)
  if (libItems.length > 0) {
    await downloadManyResolved(dl, libItems, { task, label: '下载库' })
  }
  items(task, totalLibs, totalLibs, '下载库')
  log(task, `下载库完成 (${totalLibs}/${totalLibs})`)

  const natives = nativesInfo(merged, env) || []
  const targetNatives =
    nativesDir ||
    path.join(paths.versions, assertSafeId(merged.jarVersionId || merged.id, '版本'), 'natives')
  await fsp.mkdir(targetNatives, { recursive: true })

  const nativeItems = []
  for (const native of natives) {
    const dest = path.join(paths.libraries, native.mavenPath)
    const url = native.url || native.download?.url
    const sha1 = native.sha1 || native.download?.sha1
    const size = native.size || native.download?.size
    if (!url) continue
    nativeItems.push({ url, dest, sha1, size, name: native.name || native.mavenPath })
  }
  if (nativeItems.length > 0) {
    await downloadManyResolved(dl, nativeItems, { task, label: '下载本地库' })
  }
  let doneNatives = 0
  for (const native of natives) {
    const dest = path.join(paths.libraries, native.mavenPath)
    if (!(await needsDownload(dest))) {
      await extractNativeJar(dest, targetNatives, native.extractExclude, task)
    }
    doneNatives += 1
    items(task, doneNatives, natives.length, '解压本地库')
    log(task, `本地库 ${doneNatives}/${natives.length}：${native.name}`)
  }

  // 原版 client jar 不在 libraries 里（buildClasspath 按契约只含库），但原版 mainClass 与
  // Fabric KnotClient 都要求它在 classpath 上，否则 "Could not find or load main class"。
  // 因此这里负责补下缺失的 client jar 并追加到 classpath 末尾（契约 §5 语义内的运行期补库）。
  const jarId = assertSafeId(primaryJarVersionId(merged) || merged.id, '版本')
  const clientJarPath = path.join(paths.versions, jarId, `${jarId}.jar`)
  if (await needsDownload(clientJarPath)) {
    const client = merged.downloads?.client
    if (client?.url && typeof dl?.downloadFile === 'function') {
      log(task, `补下原版客户端 jar：${jarId}`)
      await fsp.mkdir(path.dirname(clientJarPath), { recursive: true })
      await downloadResolved(
        dl,
        client.url,
        clientJarPath,
        { sha1: client.sha1, size: client.size, task },
        { versionId: jarId, kind: 'client' },
      )
    } else {
      log(task, `警告：原版客户端 jar 缺失且当前版本无 downloads.client，classpath 将不含原版 jar`)
    }
  }

  const classpath = appendClasspath(buildClasspath(merged, paths.libraries, env), clientJarPath)
  if (!(await needsDownload(clientJarPath))) {
    log(task, `classpath 已追加原版客户端 jar：${path.basename(clientJarPath)}`)
  }
  return { classpath, nativesDir: targetNatives, clientJarPath }
}

/**
 * 启动前补资源：确保资源索引存在；mode==='full' 时补齐 objects（契约 §5）。
 */
export async function ensureAssets({ dl, paths, merged, mode = 'index', task } = {}) {
  if (!merged) throw new Error('ensureAssets 缺少 merged 版本对象')
  if (!paths?.assets) throw new Error('ensureAssets 缺少 paths')
  const info = merged.assetIndex
  if (!info?.id) {
    log(task, '版本未提供 assetIndex，跳过资源检查')
    return { indexPath: null, assetIndexId: null, assets: { total: 0, downloaded: 0 } }
  }

  const ensured = await ensureAssetIndexFile({ dl, paths, info, task })
  let assets = { total: 0, downloaded: 0 }
  if (mode === 'full') {
    const result = await ensureAssetObjects({ dl, paths, index: ensured.index, task })
    assets = { total: result.total, downloaded: result.downloaded }
  } else {
    const total = ensured.index?.objects ? Object.keys(ensured.index.objects).length : 0
    assets = { total, downloaded: 0 }
    log(task, `资源索引已就绪（assetsMode=index，共 ${total} 个对象）`)
  }
  return { indexPath: ensured.indexPath, assetIndexId: info.id, assets }
}
