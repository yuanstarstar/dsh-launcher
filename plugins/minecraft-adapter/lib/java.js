// lib/java.js —— Java 运行时检测与按需下载（v3 适配器版）
// 只使用 Node 内置能力；下载/解压分别复用调用方注入的下载器与 lib/zip.js 的 unzipTo。
// 运行时目录由 adapter 传入（gamePaths.runtime / gamePaths.jreCache）。
import path from 'node:path'
import fsp from 'node:fs/promises'
import os from 'node:os'
import { execFile } from 'node:child_process'
import { pathExists, readText } from './util.js'
import { OFFICIAL } from './mirrors.js'

const UA = { 'user-agent': 'dsh-mc-adapter/3.0.0' }
const DETECT_TTL_MS = 5 * 60 * 1000
const JAVA_EXE = process.platform === 'win32' ? 'java.exe' : 'java'

// source 越小越优先（major 相同时：cfg.javaPath / Program Files 的 JDK 排前，PATH 与 .minecraft runtime 靠后）
const SOURCE_PRIORITY = {
  javaPath: 0,
  'program-files': 1,
  localappdata: 2,
  'java-home': 3,
  PATH: 4,
  'minecraft-runtime': 5,
}

/** no-op 进度对象（契约 §7：task 可选）。 */
function taskOf(task) {
  return task ?? { log() {}, items() {}, bytes() {}, setPhase() {} }
}

/** 由完整版本号解析主版本：'17.0.20'→17，'1.8.0_382'→8，'21'→21。 */
export function majorOf(version) {
  const s = String(version || '').trim()
  const m = s.match(/^(\d+)(?:\.(\d+))?/)
  if (!m) return 0
  const a = Number(m[1])
  const b = Number(m[2] ?? 0)
  if (a === 1 && b > 0) return b // 1.8.0_382 → 8
  return a
}

/** execFile 的 Promise 包装，永不 reject。 */
function runExec(file, args, timeoutMs = 12000) {
  return new Promise((resolve) => {
    try {
      execFile(file, args, { windowsHide: true, timeout: timeoutMs, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
        resolve({
          code: err ? (typeof err.code === 'number' ? err.code : -1) : 0,
          stdout: String(stdout ?? ''),
          stderr: String(stderr ?? ''),
        })
      })
    } catch (err) {
      resolve({ code: -1, stdout: '', stderr: String(err?.message ?? err) })
    }
  })
}

function detectVendorFromPath(p) {
  const s = String(p).toLowerCase()
  if (s.includes('adoptium') || s.includes('temurin')) return 'Eclipse Adoptium'
  if (s.includes('corretto')) return 'Amazon Corretto'
  if (s.includes('microsoft')) return 'Microsoft'
  if (s.includes('zulu')) return 'Azul Zulu'
  if (s.includes('graal')) return 'GraalVM'
  if (s.includes('jre-legacy') || s.includes('java-runtime')) return '本机运行时'
  if (s.includes('java')) return 'Oracle/OpenJDK'
  return 'Unknown'
}

function detectVendorFromText(text) {
  const s = String(text || '')
  if (/temurin|adoptium/i.test(s)) return 'Eclipse Adoptium'
  if (/corretto/i.test(s)) return 'Amazon Corretto'
  if (/microsoft/i.test(s)) return 'Microsoft'
  if (/zulu/i.test(s)) return 'Azul Zulu'
  if (/graal/i.test(s)) return 'GraalVM'
  if (/openjdk/i.test(s)) return 'OpenJDK'
  if (/java\(tm\)/i.test(s)) return 'Oracle'
  return ''
}

/**
 * 探测单个 java 可执行文件：返回 { path, major, version, vendor, source:null }，失败返回 null。
 * major/version 优先读 JDK/JRE 根目录的 release 文件，缺失时 spawn `-version` 解析。
 */
export async function probeJava(javaPath) {
  if (!javaPath) return null
  const file = path.resolve(String(javaPath))
  if (!(await pathExists(file))) return null
  const home = path.dirname(path.dirname(file))
  let version = ''
  let vendor = ''
  const releaseText = await readText(path.join(home, 'release'), '')
  if (releaseText) {
    version = (releaseText.match(/^JAVA_VERSION="([^"]+)"/m) || [])[1] || ''
    vendor = (releaseText.match(/^IMPLEMENTOR="([^"]+)"/m) || [])[1] || ''
  }
  if (!version) {
    const res = await runExec(file, ['-version'], 12000)
    const text = `${res.stdout}\n${res.stderr}`
    version = (text.match(/(?:openjdk|java) version "([^"]+)"/i) || [])[1] || ''
    if (!vendor) vendor = detectVendorFromText(text)
  }
  const major = majorOf(version)
  if (!major) return null
  return {
    path: file,
    major,
    version: version || String(major),
    vendor: vendor || detectVendorFromPath(file),
    source: null,
  }
}

function javaExeFrom(p) {
  const s = String(p).trim().replace(/^"|"$/g, '')
  if (!s) return ''
  if (/^java(\.exe)?$/i.test(path.basename(s))) return s
  return path.join(s, 'bin', JAVA_EXE)
}

async function listDirs(dir) {
  try {
    const entries = await fsp.readdir(dir, { withFileTypes: true })
    return entries.filter((e) => e.isDirectory()).map((e) => path.join(dir, e.name))
  } catch {
    return []
  }
}

/** 在 root 下递归找 bin/java(.exe)，深度受限（Mojang runtime 为 runtime/<id>/<os>/<id>/bin）。 */
async function findJavaExes(root, maxDepth = 5) {
  const out = []
  if (!root) return out
  const walk = async (dir, depth) => {
    if (depth > maxDepth) return
    let entries = []
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        await walk(full, depth + 1)
      } else if (path.basename(dir).toLowerCase() === 'bin' && /^java(\.exe)?$/i.test(entry.name)) {
        out.push(full)
      }
    }
  }
  await walk(root, 0)
  return out
}

/** 枚举全部候选 java 路径（未探测），按 source 优先级排序后按绝对路径去重。 */
async function collectCandidates(cfg) {
  const cands = []
  const add = (file, source) => {
    if (file) cands.push({ file: path.resolve(file), source })
  }

  // 1) 用户配置
  const cfgPath = typeof cfg?.javaPath === 'string' ? cfg.javaPath.trim() : ''
  if (cfgPath) add(javaExeFrom(cfgPath), 'javaPath')

  // 2) Program Files 下的 JDK
  const PF = process.env.ProgramFiles || 'C:\\Program Files'
  const PFx86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)'
  for (const base of [PF, PFx86]) {
    for (const dir of await listDirs(path.join(base, 'Java'))) add(path.join(dir, 'bin', JAVA_EXE), 'program-files')
    for (const dir of await listDirs(path.join(base, 'Eclipse Adoptium'))) add(path.join(dir, 'bin', JAVA_EXE), 'program-files')
    for (const dir of await listDirs(path.join(base, 'Microsoft'))) {
      if (/^jdk/i.test(path.basename(dir))) add(path.join(dir, 'bin', JAVA_EXE), 'program-files')
    }
    for (const dir of await listDirs(path.join(base, 'Amazon Corretto'))) add(path.join(dir, 'bin', JAVA_EXE), 'program-files')
  }

  // 3) 用户目录下 Adoptium
  const LOCALAPPDATA = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local')
  for (const dir of await listDirs(path.join(LOCALAPPDATA, 'Programs', 'Eclipse Adoptium'))) {
    add(path.join(dir, 'bin', JAVA_EXE), 'localappdata')
  }

  // 4) JAVA_HOME
  if (process.env.JAVA_HOME) add(javaExeFrom(process.env.JAVA_HOME), 'java-home')

  // 5) PATH
  for (const raw of String(process.env.PATH || '').split(path.delimiter)) {
    const dir = raw.trim().replace(/^"|"$/g, '')
    if (!dir) continue
    add(path.join(dir, JAVA_EXE), 'PATH')
  }

  // 6) Mojang 启动器自带的 JRE
  const APPDATA = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming')
  for (const exe of await findJavaExes(path.join(APPDATA, '.minecraft', 'runtime'), 5)) {
    add(exe, 'minecraft-runtime')
  }

  const rankOf = (source) => SOURCE_PRIORITY[source] ?? 99
  const byKey = new Map()
  for (const cand of cands) {
    const key = process.platform === 'win32' ? cand.file.toLowerCase() : cand.file
    const prev = byKey.get(key)
    if (!prev || rankOf(cand.source) < rankOf(prev.source)) byKey.set(key, cand)
  }
  return [...byKey.values()].sort((a, b) => rankOf(a.source) - rankOf(b.source))
}

let _detectCache = null // { key, at, list }

/**
 * 检测本机 Java。返回 [{ path, major, version, vendor, source }]（按 major 降序，同 major 按来源优先级）。
 * 结果内存缓存 5 分钟（force:true 清缓存）。
 */
export async function detectJavas({ cfg = {}, force = false } = {}) {
  const key = String(cfg?.javaPath || '')
  const now = Date.now()
  if (!force && _detectCache && _detectCache.key === key && now - _detectCache.at < DETECT_TTL_MS) {
    return _detectCache.list.map((j) => ({ ...j }))
  }
  const candidates = await collectCandidates(cfg)
  const found = []
  for (const cand of candidates) {
    const probed = await probeJava(cand.file)
    if (!probed) continue
    found.push({ ...probed, source: cand.source })
  }
  const rankOf = (source) => SOURCE_PRIORITY[source] ?? 99
  found.sort((a, b) => b.major - a.major || rankOf(a.source) - rankOf(b.source))
  _detectCache = { key, at: Date.now(), list: found }
  return found.map((j) => ({ ...j }))
}

function sanitizeFileName(name) {
  const base = path.basename(String(name || 'jre.zip'))
  const safe = base.replace(/[^\w.\-+]/g, '_')
  return safe || 'jre.zip'
}

/** 从文件名里抽出版本号数字数组，用于挑最新。 */
function versionNumbersOf(name) {
  const m = String(name).match(/(\d+)[._](\d+)[._](\d+)(?:[._](\d+))?/)
  if (!m) return [0, 0, 0, 0]
  return [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4] ?? 0)]
}

function compareNamesDesc(a, b) {
  const va = versionNumbersOf(a.name)
  const vb = versionNumbersOf(b.name)
  for (let i = 0; i < 4; i += 1) {
    if (va[i] !== vb[i]) return vb[i] - va[i]
  }
  return 0
}

/** 收集 Adoptium JRE 下载候选：① API（GitHub）② 清华镜像目录页。 */
async function collectAdoptiumCandidates(dl, major) {
  const out = []
  try {
    const apiUrl =
      `${OFFICIAL.adoptiumApi}/v3/assets/latest/${major}/hotspot` +
      `?architecture=x64&image_type=jre&os=windows&vendor=eclipse`
    const data = await dl.fetchJson(apiUrl, { timeoutMs: 25000, headers: UA })
    const pkg = Array.isArray(data) ? data[0]?.binary?.package : null
    if (pkg?.link) out.push({ url: pkg.link, name: pkg.name || `OpenJDK${major}-jre_x64_windows.zip`, mirror: false })
  } catch {
    /* 忽略，继续尝试镜像 */
  }
  try {
    const dirUrl = `${OFFICIAL.adoptiumTuna}/${major}/jre/x64/windows/`
    const html = await dl.fetchText(dirUrl, { timeoutMs: 25000, headers: UA })
    const links = []
    const re = /href="([^"]+\.zip)"/gi
    let m
    while ((m = re.exec(html)) !== null) {
      const raw = m[1]
      if (!/jre/i.test(raw)) continue
      const href = /^https?:/i.test(raw) ? raw : new URL(raw, dirUrl).href
      links.push({ url: href, name: sanitizeFileName(decodeURIComponent(new URL(href).pathname)) })
    }
    links.sort(compareNamesDesc)
    if (links[0]) out.push({ ...links[0], mirror: true })
  } catch {
    /* 镜像不可用则只有 API */
  }
  return out
}

/**
 * 确保某主版本 Java 可用：先找本机，再找已下载的 runtime，最后从 Adoptium 下载 JRE 并解压。
 * 返回 { path, major, version, vendor, source }。
 */
export async function ensureJava({ major, cfg = {}, dl, paths, task } = {}) {
  const t = taskOf(task)
  const wanted = Number(major)
  if (!Number.isFinite(wanted) || wanted <= 0) {
    throw new Error(`需要有效的 Java 主版本号（例如 17/21），收到：${String(major)}`)
  }
  t.setPhase?.('Java')
  t.log(`检查本机 Java ${wanted} …`)

  // 1) 本机已安装
  const javas = await detectJavas({ cfg })
  const hit = javas.find((j) => j.major === wanted)
  if (hit) {
    t.log(`使用本机 Java ${hit.major}（${hit.version}，${hit.source}）：${hit.path}`)
    return { path: hit.path, major: hit.major, version: hit.version, vendor: hit.vendor, source: hit.source }
  }

  // 2) 之前下载到 runtime/jre-<major> 的
  if (paths?.runtime) {
    const exe = path.join(paths.runtime, `jre-${wanted}`, 'bin', JAVA_EXE)
    if (await pathExists(exe)) {
      const probed = await probeJava(exe)
      if (probed && probed.major === wanted) {
        t.log(`使用已下载的 Java ${wanted}：${exe}`)
        return { ...probed, source: 'downloaded' }
      }
    }
  }

  // 3) 下载 Adoptium JRE
  if (!dl || typeof dl.downloadFile !== 'function') {
    throw new Error(`本机缺少 Java ${wanted}，且没有可用下载器（createDownloader）来下载运行时`)
  }
  if (!paths?.runtime || !paths?.jreCache) {
    throw new Error(`本机缺少 Java ${wanted}，且缺少 paths.runtime / paths.jreCache，无法下载并安装运行时`)
  }
  t.log(`本机缺少 Java ${wanted}，改为从 Adoptium 下载 JRE …`)
  const candidates = await collectAdoptiumCandidates(dl, wanted)
  if (!candidates.length) {
    throw new Error(`本机缺少 Java ${wanted}，且 Adoptium API 与清华镜像均未取到 JRE ${wanted} 的下载地址`)
  }
  await fsp.mkdir(paths.jreCache, { recursive: true })

  let zipPath = ''
  let lastErr = null
  for (const cand of candidates) {
    const dest = path.join(paths.jreCache, sanitizeFileName(cand.name))
    try {
      t.log(`下载 Java ${wanted}（${cand.mirror ? '清华镜像' : 'Adoptium API'}）：${cand.url}`)
      const res = await dl.downloadFile(cand.url, dest, { task, timeoutMs: 240000, attempts: 3 })
      zipPath = res.path
      t.log(`Java ${wanted} 下载完成：${zipPath}`)
      break
    } catch (err) {
      lastErr = err
      t.log(`Java ${wanted} 下载失败：${err?.message ?? err}`)
    }
  }
  if (!zipPath) {
    throw new Error(`下载 Java ${wanted} 失败：${lastErr?.message ?? '没有可用的下载地址'}`)
  }

  // 4) 解压到 runtime/jre-<major>
  let unzipTo
  try {
    ;({ unzipTo } = await import('./zip.js'))
  } catch {
    throw new Error('缺少 lib/zip.js（由 core-io 提供），无法解压 Java 运行时')
  }
  const destDir = path.join(paths.runtime, `jre-${wanted}`)
  await fsp.mkdir(destDir, { recursive: true })
  t.log(`解压 Java ${wanted} 到 ${destDir} …`)
  await unzipTo(zipPath, destDir, {
    stripComponents: 1,
    onProgress: (done, total) => {
      if (total) t.items(done, total, `解压 Java (${done}/${total})`)
    },
  })

  let exe = path.join(destDir, 'bin', JAVA_EXE)
  if (!(await pathExists(exe))) {
    const found = await findJavaExes(destDir, 3)
    if (found[0]) exe = found[0]
  }
  if (!(await pathExists(exe))) {
    throw new Error(`Java ${wanted} 解压后未找到 bin/${JAVA_EXE}（目录：${destDir}）`)
  }
  const probed = await probeJava(exe)
  if (!probed) {
    throw new Error(`Java ${wanted} 解压后无法执行：${exe}`)
  }
  if (probed.major !== wanted) {
    t.log(`警告：下载到的 Java 主版本为 ${probed.major}，与期望的 ${wanted} 不一致`)
  }
  t.log(`Java ${probed.major} 就绪：${exe}`)
  return {
    path: exe,
    major: probed.major,
    version: probed.version,
    vendor: probed.vendor || 'Eclipse Adoptium',
    source: 'downloaded',
  }
}
