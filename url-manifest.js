// DSH启动器 v3 · URL 清单提供者
//
// config: { jsonUrl?, versions?: Array<{id,url,sha1?,size?,archive?,executable?,args?}>,
//           executable?, args?, archive? }
// 版本清单可以从远程 JSON 拉取（30 分钟缓存），也可以是静态数组。
import fsp from 'node:fs/promises'
import path from 'node:path'
import { extractArchiveToDir, findExecutable, looksLikeZip } from '../archive.js'

export const PROVIDER = {
  id: 'url',
  label: 'URL 清单',
  description: '从远程 JSON 清单或静态版本列表下载游戏文件（支持 ZIP 压缩包与单文件）',
}

const ARCHIVE_MODES = new Set(['auto', 'zip', 'none'])
const LIST_CACHE_TTL_MS = 30 * 60 * 1000
const listCache = new Map() // jsonUrl -> { at, versions }

function fail(message) {
  throw new Error(message)
}

function normalizeArgs(value, label) {
  if (value == null) return []
  if (!Array.isArray(value)) fail(label + '必须是字符串数组')
  return value.map((item) => {
    if (typeof item !== 'string') fail(label + '里只能放字符串')
    return item
  })
}

function normalizeVersionEntry(entry, indexLabel) {
  if (!entry || typeof entry !== 'object') fail(indexLabel + '无效：必须是对象')
  const id = entry.id != null ? String(entry.id).trim() : ''
  if (!id) fail(indexLabel + '缺少 id')
  const url = typeof entry.url === 'string' ? entry.url.trim() : ''
  if (!url) fail(indexLabel + '缺少 url')
  if (!/^https?:\/\//i.test(url)) fail(indexLabel + '的 url 必须是 http(s) 地址：' + url)
  const sha1 = entry.sha1 != null ? String(entry.sha1).trim().toLowerCase() : ''
  if (sha1 && !/^[0-9a-f]{40}$/.test(sha1)) fail(indexLabel + '的 sha1 无效：' + entry.sha1)
  const size = entry.size != null ? Math.max(0, Math.floor(Number(entry.size) || 0)) : 0
  const archive = entry.archive != null ? String(entry.archive) : ''
  if (archive && !ARCHIVE_MODES.has(archive)) fail(indexLabel + '的 archive 只能是 auto/zip/none')
  return {
    id,
    label: entry.label != null ? String(entry.label) : id,
    url,
    sha1: sha1 || null,
    size: size || 0,
    archive: archive || null,
    executable: entry.executable != null ? String(entry.executable) : '',
    args: normalizeArgs(entry.args, indexLabel + ' 的 args'),
  }
}

function parseVersionList(payload, sourceLabel) {
  const raw = Array.isArray(payload) ? payload : payload && Array.isArray(payload.versions) ? payload.versions : null
  if (!raw) fail(sourceLabel + ' 里没有 versions 数组')
  if (!raw.length) fail(sourceLabel + ' 中没有任何版本')
  const seen = new Set()
  const versions = []
  raw.forEach((entry, index) => {
    const normalized = normalizeVersionEntry(entry, sourceLabel + ' 第 ' + (index + 1) + ' 个版本')
    if (seen.has(normalized.id)) return
    seen.add(normalized.id)
    versions.push(normalized)
  })
  if (!versions.length) fail(sourceLabel + ' 中没有任何有效版本')
  return versions
}

/** 校验并规整 config（同步，中文错误）。 */
export function validateConfig(config) {
  if (!config || typeof config !== 'object') fail('配置必须是对象')
  const jsonUrl = typeof config.jsonUrl === 'string' ? config.jsonUrl.trim() : ''
  if (jsonUrl && !/^https?:\/\//i.test(jsonUrl)) fail('jsonUrl 必须是 http(s) 地址：' + jsonUrl)
  let versions = null
  if (config.versions != null) {
    versions = parseVersionList(config.versions, 'versions')
  }
  if (!jsonUrl && !versions) fail('URL 清单需要 jsonUrl（远程清单）或 versions（静态版本列表）之一')
  const executable = config.executable != null ? String(config.executable).trim() : ''
  const archive = config.archive != null ? String(config.archive) : 'auto'
  if (!ARCHIVE_MODES.has(archive)) fail('archive 只能是 auto/zip/none')
  const args = normalizeArgs(config.args, 'args')
  return { jsonUrl: jsonUrl || null, versions, executable, archive, args }
}

async function loadVersions(config, dl, { force = false } = {}) {
  if (config.versions && config.versions.length) {
    return config.versions.map((entry) => ({ ...entry }))
  }
  const jsonUrl = config.jsonUrl
  const cached = listCache.get(jsonUrl)
  if (!force && cached && Date.now() - cached.at < LIST_CACHE_TTL_MS) {
    return cached.versions.map((entry) => ({ ...entry }))
  }
  const payload = await dl.fetchJson(jsonUrl, { timeoutMs: 20000 })
  const versions = parseVersionList(payload, '远程清单 ' + jsonUrl)
  listCache.set(jsonUrl, { at: Date.now(), versions })
  return versions.map((entry) => ({ ...entry }))
}

async function readMetadata(gameDir) {
  try {
    const text = await fsp.readFile(path.join(gameDir, 'metadata.json'), 'utf8')
    const parsed = JSON.parse(text)
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

async function writeMetadata(gameDir, metadata) {
  await fsp.mkdir(gameDir, { recursive: true })
  const file = path.join(gameDir, 'metadata.json')
  const tmp = file + '.' + process.pid + '.' + Date.now() + '.tmp'
  await fsp.writeFile(tmp, JSON.stringify(metadata, null, 2), 'utf8')
  await fsp.rename(tmp, file)
}

async function exists(filePath) {
  try {
    await fsp.access(filePath)
    return true
  } catch {
    return false
  }
}

function fileBaseName(urlText, fallback) {
  try {
    const name = new URL(urlText).pathname.split('/').filter(Boolean).pop() || ''
    const decoded = decodeURIComponent(name)
    return decoded || fallback
  } catch {
    return fallback
  }
}

function temporaryFile(ctx, suffix) {
  const root = ctx.paths && ctx.paths.tmp ? ctx.paths.tmp : path.join(ctx.dataRoot || process.cwd(), 'tmp')
  const stamp = String(Date.now()) + '-' + Math.random().toString(36).slice(2, 8)
  return path.join(root, 'download-' + stamp + (suffix || '.bin'))
}

function archiveOf(entry, config) {
  const mode = (entry && entry.archive) || config.archive || 'auto'
  return ARCHIVE_MODES.has(mode) ? mode : 'auto'
}

async function installVersion(ctx, definition, config, version) {
  const versions = await loadVersions(config, ctx.dl, { force: true })
  const entry = versions.find((item) => item.id === String(version))
  if (!entry) fail('找不到版本：' + String(version))
  const gameDir = ctx.gameDir
  if (!gameDir) fail('缺少游戏安装目录')
  await fsp.mkdir(gameDir, { recursive: true })
  const tmpFile = temporaryFile(ctx, '.tmp')
  await fsp.mkdir(path.dirname(tmpFile), { recursive: true })
  ctx.log('下载 ' + (entry.label || entry.id) + '（' + entry.url + '）')
  try {
    await ctx.dl.downloadFile(entry.url, tmpFile, {
      sha1: entry.sha1 || undefined,
      size: entry.size || undefined,
      task: ctx.task,
      quiet: true,
    })
    const mode = archiveOf(entry, config)
    const useZip = mode === 'zip' || (mode === 'auto' && (await looksLikeZip(tmpFile)))
    let executable = ''
    let archiveKind = 'none'
    if (useZip) {
      archiveKind = 'zip'
      ctx.log('解压压缩包到游戏目录')
      await extractArchiveToDir(tmpFile, gameDir, {
        onProgress: (done, total) => {
          if (ctx.task && typeof ctx.task.items === 'function') ctx.task.items(done, total, '解压文件')
        },
      })
      const hint = entry.executable || config.executable
      executable = path.relative(gameDir, await findExecutable(gameDir, hint))
    } else {
      archiveKind = 'file'
      const hint = entry.executable || config.executable
      const destName = hint || fileBaseName(entry.url, definition.id + '.bin')
      const dest = path.isAbsolute(destName) ? destName : path.join(gameDir, destName)
      await fsp.mkdir(path.dirname(dest), { recursive: true })
      await fsp.rename(tmpFile, dest).catch(async () => {
        await fsp.copyFile(tmpFile, dest)
        await fsp.rm(tmpFile, { force: true })
      })
      executable = path.relative(gameDir, dest)
    }
    const metadata = {
      provider: PROVIDER.id,
      definitionId: definition.id,
      versionId: entry.id,
      label: entry.label || entry.id,
      executable,
      args: entry.args && entry.args.length ? entry.args : config.args,
      archive: archiveKind,
      url: entry.url,
      installedAt: new Date().toISOString(),
    }
    await writeMetadata(gameDir, metadata)
    return { versionId: entry.id, metadata }
  } finally {
    await fsp.rm(tmpFile, { force: true }).catch(() => {})
  }
}

export function createAdapter(definition) {
  if (!definition || typeof definition !== 'object') fail('游戏定义无效')
  const config = validateConfig(definition.config)
  const adapter = {
    id: definition.id,
    label: definition.label,
    versionLabel: definition.versionLabel || '版本',
    contentLabel: '内容',
    capabilities: { content: false, loaders: false, runtimes: false },
    instanceOptions: [],
    async listVersions({ ctx, force }) {
      const versions = await loadVersions(config, ctx.dl, { force })
      return {
        versions: versions.map((entry) => ({ id: entry.id, label: entry.label })),
        latestRelease: versions[0] ? versions[0].id : undefined,
      }
    },
    async install({ ctx, version }) {
      return installVersion(ctx, definition, config, version)
    },
    async launch({ ctx }) {
      const gameDir = ctx.gameDir
      const metadata = await readMetadata(gameDir)
      const executableInfo = metadata && metadata.executable ? metadata.executable : config.executable
      if (!executableInfo) fail('实例缺少可执行文件信息，请重新安装游戏')
      const executable = path.isAbsolute(executableInfo)
        ? executableInfo
        : path.resolve(gameDir, executableInfo)
      if (!(await exists(executable))) fail('可执行文件不存在：' + executable + '（请重新安装游戏）')
      const args = (metadata && Array.isArray(metadata.args) && metadata.args.length ? metadata.args : config.args) || []
      return { executable, args: args.slice(), cwd: gameDir }
    },
    async verify({ ctx }) {
      const problems = []
      const gameDir = ctx.gameDir
      if (!(await exists(gameDir))) problems.push('游戏目录不存在：' + gameDir)
      const metadata = await readMetadata(gameDir)
      const info = metadata && metadata.executable ? metadata.executable : config.executable
      if (!info) problems.push('缺少可执行文件信息（metadata.json）')
      else {
        const executable = path.isAbsolute(info) ? info : path.resolve(gameDir, info)
        if (!(await exists(executable))) problems.push('可执行文件不存在：' + executable)
      }
      return { ok: problems.length === 0, problems }
    },
  }
  return adapter
}

export async function testDefinition({ config, dl }) {
  let normalized
  try {
    normalized = validateConfig(config)
  } catch (error) {
    return { ok: false, detail: error.message }
  }
  if (normalized.versions) {
    return { ok: true, detail: '静态版本列表可用（' + normalized.versions.length + ' 个版本）' }
  }
  try {
    const payload = await dl.fetchJson(normalized.jsonUrl, { timeoutMs: 20000 })
    const versions = parseVersionList(payload, '远程清单 ' + normalized.jsonUrl)
    return { ok: true, detail: '远程清单可用（' + versions.length + ' 个版本）' }
  } catch (error) {
    return { ok: false, detail: '无法读取远程清单：' + (error && error.message ? error.message : error) }
  }
}

export default { PROVIDER, validateConfig, createAdapter, testDefinition }
