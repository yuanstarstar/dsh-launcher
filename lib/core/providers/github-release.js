// DSH启动器 v3 · GitHub Releases 提供者
//
// config: { repo:'owner/name', assetPattern?, executable?, archive?:'auto'|'zip'|'none',
//           args?, assetKind?:'auto'|'zip'|'file' }
// 版本 = release 的 tag_name，安装时从该 release 的附件中挑一个下载。
import fsp from 'node:fs/promises'
import path from 'node:path'
import { extractArchiveToDir, findExecutable, looksLikeZip } from '../archive.js'

export const PROVIDER = {
  id: 'github',
  label: 'GitHub Releases',
  description: '从 GitHub 仓库的发布附件安装游戏（支持 ZIP 或单文件），自动读取版本列表',
}

const API_BASE = 'https://api.github.com'
const ARCHIVE_MODES = new Set(['auto', 'zip', 'none'])
const ASSET_KINDS = new Set(['auto', 'zip', 'file'])
const RELEASE_CACHE_TTL_MS = 5 * 60 * 1000
const releaseCache = new Map() // repo -> { at, releases }
const API_ACCEPT = 'application/vnd.github+json'

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

/** 校验并规整 config（同步，中文错误）。 */
export function validateConfig(config) {
  if (!config || typeof config !== 'object') fail('配置必须是对象')
  const repo = typeof config.repo === 'string' ? config.repo.trim() : ''
  if (!repo) fail('GitHub 提供者需要 repo（格式：owner/name）')
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) fail('repo 格式不正确，应为 owner/name：' + repo)
  let assetPattern = ''
  if (config.assetPattern != null && String(config.assetPattern).trim() !== '') {
    assetPattern = String(config.assetPattern)
    try {
      // 编译一次以便尽早发现语法错误
      // eslint-disable-next-line no-new
      new RegExp(assetPattern)
    } catch {
      fail('assetPattern 不是有效的正则表达式：' + assetPattern)
    }
  }
  const executable = config.executable != null ? String(config.executable).trim() : ''
  const archive = config.archive != null ? String(config.archive) : 'auto'
  if (!ARCHIVE_MODES.has(archive)) fail('archive 只能是 auto/zip/none')
  const assetKind = config.assetKind != null ? String(config.assetKind) : 'auto'
  if (!ASSET_KINDS.has(assetKind)) fail('assetKind 只能是 auto/zip/file')
  const args = normalizeArgs(config.args, 'args')
  return { repo, assetPattern, executable, archive, assetKind, args }
}

function apiError(error, repo) {
  const status = error && Number(error.status)
  if (status === 401) return new Error('GitHub API 认证失败（HTTP 401），请稍后重试')
  if (status === 403 || status === 429) {
    return new Error('GitHub API 访问受限（HTTP ' + status + '），可能触发了限流，请稍后再试')
  }
  if (status === 404) return new Error('仓库不存在或无权访问：' + repo)
  const message = error && error.message ? error.message : String(error)
  return new Error('请求 GitHub 失败（' + repo + '）：' + message)
}

async function fetchJsonOrThrow(dl, url, repo) {
  try {
    return await dl.fetchJson(url, { timeoutMs: 20000, headers: { accept: API_ACCEPT } })
  } catch (error) {
    throw apiError(error, repo)
  }
}

function normalizeRelease(release) {
  if (!release || typeof release !== 'object') return null
  const tag = release.tag_name != null ? String(release.tag_name).trim() : ''
  if (!tag) return null
  const assets = Array.isArray(release.assets)
    ? release.assets
        .filter((asset) => asset && typeof asset === 'object' && asset.name && asset.browser_download_url)
        .map((asset) => ({
          name: String(asset.name),
          url: String(asset.browser_download_url),
          size: Math.max(0, Math.floor(Number(asset.size) || 0)),
          contentType: asset.content_type ? String(asset.content_type) : '',
        }))
    : []
  return {
    id: tag,
    label: release.name != null && String(release.name).trim() ? String(release.name) : tag,
    releaseTime: release.published_at || null,
    prerelease: Boolean(release.prerelease),
    assets,
  }
}

async function loadReleases(config, dl, { force = false } = {}) {
  const cached = releaseCache.get(config.repo)
  if (!force && cached && Date.now() - cached.at < RELEASE_CACHE_TTL_MS) {
    return cached.releases
  }
  const url = API_BASE + '/repos/' + config.repo + '/releases?per_page=50'
  const payload = await fetchJsonOrThrow(dl, url, config.repo)
  if (!Array.isArray(payload)) throw new Error('GitHub 返回的数据不是版本列表（' + config.repo + '）')
  const releases = payload
    .filter((release) => release && !release.draft)
    .map(normalizeRelease)
    .filter(Boolean)
  releaseCache.set(config.repo, { at: Date.now(), releases })
  return releases
}

function isZipAsset(asset) {
  return /\.zip$/i.test(asset.name) || /zip/i.test(asset.contentType)
}

function pickAsset(release, config) {
  let candidates = release.assets.slice()
  if (config.assetKind === 'zip') candidates = candidates.filter(isZipAsset)
  else if (config.assetKind === 'file') candidates = candidates.filter((asset) => !isZipAsset(asset))
  if (config.assetPattern) {
    let pattern = null
    try {
      pattern = new RegExp(config.assetPattern)
    } catch {
      pattern = null
    }
    if (pattern) candidates = candidates.filter((asset) => pattern.test(asset.name))
  }
  if (!candidates.length) {
    const rule = []
    if (config.assetPattern) rule.push('匹配规则 ' + config.assetPattern)
    if (config.assetKind !== 'auto') rule.push('附件类型 ' + config.assetKind)
    throw new Error(
      '版本 ' + release.id + ' 没有可用的下载附件' + (rule.length ? '（' + rule.join('，') + '）' : ''),
    )
  }
  if (config.assetKind === 'auto') {
    const zip = candidates.find(isZipAsset)
    if (zip) return zip
  }
  return candidates[0]
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

function temporaryFile(ctx, suffix) {
  const root = ctx.paths && ctx.paths.tmp ? ctx.paths.tmp : path.join(ctx.dataRoot || process.cwd(), 'tmp')
  const stamp = String(Date.now()) + '-' + Math.random().toString(36).slice(2, 8)
  return path.join(root, 'download-' + stamp + (suffix || '.bin'))
}

async function installVersion(ctx, definition, config, version) {
  const releases = await loadReleases(config, ctx.dl, { force: true })
  let release = releases.find((item) => item.id === String(version))
  if (!release) {
    const url = API_BASE + '/repos/' + config.repo + '/releases/tags/' + encodeURIComponent(String(version))
    const payload = await fetchJsonOrThrow(ctx.dl, url, config.repo)
    release = normalizeRelease(payload)
    if (!release) fail('找不到版本：' + String(version))
  }
  const asset = pickAsset(release, config)
  const gameDir = ctx.gameDir
  if (!gameDir) fail('缺少游戏安装目录')
  await fsp.mkdir(gameDir, { recursive: true })
  const tmpFile = temporaryFile(ctx, '.tmp')
  await fsp.mkdir(path.dirname(tmpFile), { recursive: true })
  ctx.log('下载 ' + (release.label || release.id) + ' 的附件 ' + asset.name)
  try {
    await ctx.dl.downloadFile(asset.url, tmpFile, {
      size: asset.size || undefined,
      task: ctx.task,
      quiet: true,
    })
    const mode = config.archive
    const useZip = mode === 'zip' || (mode === 'auto' && isZipAsset(asset) && (await looksLikeZip(tmpFile)))
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
      executable = path.relative(gameDir, await findExecutable(gameDir, config.executable))
    } else {
      archiveKind = 'file'
      const destName = config.executable || asset.name
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
      versionId: release.id,
      label: release.label || release.id,
      executable,
      args: config.args,
      archive: archiveKind,
      repo: config.repo,
      asset: { name: asset.name, url: asset.url, size: asset.size },
      installedAt: new Date().toISOString(),
    }
    await writeMetadata(gameDir, metadata)
    return { versionId: release.id, metadata }
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
      const releases = await loadReleases(config, ctx.dl, { force })
      return {
        versions: releases.map((release) => ({
          id: release.id,
          label: release.label,
          releaseTime: release.releaseTime,
          prerelease: release.prerelease,
        })),
        latestRelease: releases.length ? releases[0].id : undefined,
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
  try {
    const info = await fetchJsonOrThrow(dl, API_BASE + '/repos/' + normalized.repo, normalized.repo)
    const fullName = info && info.full_name ? String(info.full_name) : normalized.repo
    const branch = info && info.default_branch ? String(info.default_branch) : '未知'
    return { ok: true, detail: '仓库可访问：' + fullName + '（默认分支 ' + branch + '）' }
  } catch (error) {
    return { ok: false, detail: error.message }
  }
}

export default { PROVIDER, validateConfig, createAdapter, testDefinition }
