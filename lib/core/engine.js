// DSH启动器 · 通用引擎
// 职责：配置 / 游戏适配器 / 版本与内容查询 / 实例安装与生命周期 / 任务队列 / 配置持久化
// 本文件与核心包其余文件一样：不含任何具体游戏或平台的专用逻辑，一切游戏相关行为由适配器提供。
import path from 'node:path'
import os from 'node:os'
import fsp from 'node:fs/promises'
import { createDownloader } from './http.js'
import { createGameStore } from './game-store.js'
import * as registry from './registry.js'
import { createPaths, ensureDirs, readJson, writeJson, pathExists, timestamp, formatBytes } from './paths.js'
import {
  listInstanceRecords,
  readInstance,
  writeInstance,
  deleteInstanceDir,
  uniqueInstanceId,
  summarizeInstance,
  readInstanceLog,
} from './instances.js'
import { launchProcess, stopProcess, readLogTail, errorMessage } from './launch.js'

const CONFIG_KEYS = ['downloadConcurrency', 'retries']
const DEFAULT_CONFIG = { downloadConcurrency: 16, retries: 3 }
const JOB_LIMIT = 40
const JOB_LOG_LIMIT = 400
// 跨插件桥接：核心与外部适配器插件可能运行在彼此隔离的加载上下文中（无法共享 globalThis），
// 因此核心把数据根路径写到一个双方都可计算出的固定位置，适配器读到后把自己的桥接模块写进
// dataRoot/adapters/；核心轮询该目录并热加载，从而实现「安装适配器后数秒内出现游戏、无需重启」。
// 指针位置每次调用时计算：设置环境变量 DSH_LAUNCHER_BRIDGE_DIR 可隔离到指定目录（测试/多用户）。
function bridgePointerOverrideDir() {
  const raw = process.env.DSH_LAUNCHER_BRIDGE_DIR
  if (raw && String(raw).trim()) return path.resolve(String(raw).trim())
  return ''
}

function bridgePointerFiles() {
  const override = bridgePointerOverrideDir()
  if (override) return [path.join(override, 'bridge.json')]
  const files = []
  try {
    files.push(path.join(os.homedir(), '.dsh-launcher', 'bridge.json'))
  } catch {
    files.push(path.join(process.cwd(), '.dsh-launcher', 'bridge.json'))
  }
  // 适配器包可能以不同方式计算指针位置（家目录 / %APPDATA%），两个位置都写一份，最大化兼容性。
  try {
    const appData = process.env.APPDATA || process.env.LOCALAPPDATA || ''
    if (appData) files.push(path.join(appData, 'dsh-launcher', 'bridge.json'))
  } catch {
    /* 忽略环境变量读取失败 */
  }
  return files
}
const ADAPTER_WATCH_INTERVAL_MS = 2500
const ADAPTER_FILE_PATTERN = /\.(mjs|js)$/i

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function toText(value, fallback = '') {
  if (value == null) return fallback
  if (typeof value === 'string') return value.trim() || fallback
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (typeof value === 'object') {
    for (const key of ['id', 'name', 'title', 'release', 'version', 'label']) {
      if (value[key] !== undefined && value[key] !== null && value[key] !== '') return String(value[key])
    }
  }
  return fallback
}

function clampNumber(value, min, max, fallback) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.round(n)))
}

function rangeNumber(value, min, max, label) {
  const n = Number(value)
  if (!Number.isFinite(n)) throw new Error(label + '必须是数字')
  const rounded = Math.round(n)
  if (rounded < min || rounded > max) throw new Error(label + '必须在 ' + min + '-' + max + ' 之间')
  return rounded
}

function noopTask() {
  return {
    log() {},
    items() {},
    bytes() {},
    setPhase() {},
    cancelRequested: false,
  }
}

export function createEngine({ config = {}, log = () => {} } = {}) {
  const dataRoot = config.dataRoot || path.join(process.cwd(), 'data')
  const paths = createPaths(dataRoot)
  const emit = (line) => {
    try {
      log(line)
    } catch {
      /* 忽略日志回调异常 */
    }
  }

  let cfg = { ...DEFAULT_CONFIG }
  let downloader = null
  let store = null
  let initialized = false
  let initPromise = null

  const jobs = new Map()
  const jobOrder = []
  const running = new Map() // instanceId -> { proc, pid, logPath, startedAt, jobId }
  let adapterWatchTimer = null
  let adaptersSignature = null
  let adapterReloading = false

  // ---------- 配置 ----------

  function publicConfig() {
    return { dataRoot: paths.root, downloadConcurrency: cfg.downloadConcurrency, retries: cfg.retries }
  }

  function normalizeConfigPatch(patch, strict = true) {
    const out = {}
    if (!patch || typeof patch !== 'object') return out
    if (patch.downloadConcurrency !== undefined) {
      out.downloadConcurrency = strict
        ? rangeNumber(patch.downloadConcurrency, 1, 32, '下载并发')
        : clampNumber(patch.downloadConcurrency, 1, 32, cfg.downloadConcurrency)
    }
    if (patch.retries !== undefined) {
      out.retries = strict ? rangeNumber(patch.retries, 0, 10, '重试次数') : clampNumber(patch.retries, 0, 10, cfg.retries)
    }
    return out
  }

  function makeDownloader() {
    return createDownloader({
      concurrency: cfg.downloadConcurrency,
      retries: cfg.retries,
      logger: (message) => emit('[下载] ' + message),
    })
  }

  // ---------- 外部适配器桥接与热加载 ----------

  /** 把数据根路径写到固定指针文件，供隔离上下文里的适配器插件读取。 */
  async function publishBridgePointer() {
    const payload = {
      launcher: '@local/dsh-launcher',
      version: '3.1.0',
      dataRoot: paths.root,
      adaptersDir: paths.adapters,
      gamesDir: paths.games,
      pid: process.pid,
      updatedAt: new Date().toISOString(),
    }
    for (const file of bridgePointerFiles()) {
      try {
        await fsp.mkdir(path.dirname(file), { recursive: true })
        await writeJson(file, payload)
      } catch (error) {
        emit('写适配器桥接指针失败（' + file + '）：' + errorMessage(error))
      }
    }
  }

  /** 目录签名（文件名+大小+修改时间），用于检测外部适配器是否新增/更新。 */
  async function computeAdaptersSignature() {
    const parts = []
    for (const dir of [paths.adapters, paths.games]) {
      let names = []
      try {
        names = await fsp.readdir(dir)
      } catch {
        names = []
      }
      for (const name of names.sort()) {
        if (!ADAPTER_FILE_PATTERN.test(name) && !/\.json$/i.test(name)) continue
        try {
          const stat = await fsp.stat(path.join(dir, name))
          parts.push(name + ':' + stat.size + ':' + Math.round(stat.mtimeMs))
        } catch {
          parts.push(name + ':missing')
        }
      }
    }
    return parts.join('|')
  }

  /** 重新加载全部游戏来源（外部适配器 + 用户定义）。 */
  async function reloadGames() {
    if (!store) throw new Error('引擎尚未初始化')
    await store.loadAll({ force: true })
    adaptersSignature = await computeAdaptersSignature()
    return store.list()
  }

  function startAdapterWatch() {
    if (adapterWatchTimer) return
    adapterWatchTimer = setInterval(async () => {
      if (adapterReloading) return
      try {
        const signature = await computeAdaptersSignature()
        if (adaptersSignature === null) {
          adaptersSignature = signature
          return
        }
        if (signature === adaptersSignature) return
        adaptersSignature = signature
        adapterReloading = true
        emit('检测到外部适配器变化，正在热加载…')
        const games = await reloadGames()
        const labels = games.map((game) => game.label).join('、')
        emit('适配器已热加载，当前游戏：' + (labels || '（无）'))
      } catch (error) {
        emit('外部适配器热加载失败：' + errorMessage(error))
      } finally {
        adapterReloading = false
      }
    }, ADAPTER_WATCH_INTERVAL_MS)
    adapterWatchTimer.unref?.()
  }

  function stopAdapterWatch() {
    if (adapterWatchTimer) {
      clearInterval(adapterWatchTimer)
      adapterWatchTimer = null
    }
  }

  async function init() {
    if (initialized) return engineApi()
    if (initPromise) {
      await initPromise
      return engineApi()
    }
    initPromise = (async () => {
      await ensureDirs(paths)
      const saved = await readJson(paths.configFile, null)
      if (saved && typeof saved === 'object') cfg = { ...cfg, ...normalizeConfigPatch(saved, false) }
      downloader = makeDownloader()
      registry.installGlobalRegistry()
      store = createGameStore({ paths, dl: downloader, logger: emit })
      await store.loadAll()
      await publishBridgePointer()
      adaptersSignature = await computeAdaptersSignature()
      startAdapterWatch()
      for (const record of await listInstanceRecords(paths)) {
        if (record.status === 'installing') {
          record.status = 'error'
          record.installError = '上次安装过程被中断，请删除后重新安装'
          await writeInstance(paths, record)
        }
      }
      initialized = true
    })()
    try {
      await initPromise
    } finally {
      initPromise = null
    }
    return engineApi()
  }

  async function setConfig(patch = {}) {
    const next = normalizeConfigPatch(patch)
    if (!Object.keys(next).length) return publicConfig()
    cfg = { ...cfg, ...next }
    downloader = makeDownloader()
    if (store && typeof store.setDownloader === 'function') store.setDownloader(downloader)
    const persisted = {}
    for (const key of CONFIG_KEYS) persisted[key] = cfg[key]
    await writeJson(paths.configFile, persisted)
    return publicConfig()
  }

  // ---------- 适配器上下文 ----------

  function makeCtx({ gameId = '', instance = null, task = noopTask() } = {}) {
    const instanceDir = instance ? paths.instanceDir(instance.id) : undefined
    const gameDir = instance ? paths.instanceGameDir(instance.id) : undefined
    return {
      dl: downloader,
      makeDownloader: (options = {}) => createDownloader({ concurrency: cfg.downloadConcurrency, retries: cfg.retries, logger: (message) => emit('[下载] ' + message), ...options }),
      paths,
      config: { ...cfg },
      dataRoot: paths.root,
      instanceDir,
      gameDir,
      gameDataDir: paths.gameDataDir(gameId),
      task,
      log: (message) => emit(String(message)),
      instance,
    }
  }

  // ---------- 任务 ----------

  function trimJobs() {
    while (jobOrder.length > JOB_LIMIT) {
      const oldest = jobOrder.shift()
      const job = jobs.get(oldest)
      if (job && job.status !== 'running') jobs.delete(oldest)
      else if (job) jobOrder.push(oldest)
    }
  }

  function pushJobLog(job, line) {
    job.log.push(line)
    if (job.log.length > JOB_LOG_LIMIT) job.log.splice(0, job.log.length - JOB_LOG_LIMIT)
  }

  function summarizeJob(job, withLog = false) {
    const summary = {
      id: job.id,
      kind: job.kind,
      title: job.title,
      status: job.status,
      phase: job.phase,
      message: job.message,
      progress: { done: job.progress.done, total: job.progress.total, label: job.progress.label, bytes: job.progress.bytes },
      startedAt: job.startedAt,
      finishedAt: job.finishedAt,
      error: job.error,
      instanceId: job.instanceId,
      result: job.result,
      cancelRequested: !!job.cancelRequested,
    }
    if (withLog) summary.log = job.log.slice(-200)
    return summary
  }

  function newJob(kind, title, instanceId = null) {
    const id = 'job-' + Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-4)
    const job = {
      id,
      kind,
      title,
      status: 'queued',
      phase: 'queued',
      message: '排队中',
      progress: { done: 0, total: 0, label: '', bytes: 0 },
      log: [],
      startedAt: null,
      finishedAt: null,
      error: null,
      instanceId,
      result: null,
      cancelRequested: false,
      promise: null,
    }
    jobs.set(id, job)
    jobOrder.push(id)
    trimJobs()
    return job
  }

  function makeTask(job) {
    return {
      log(line) {
        pushJobLog(job, String(line))
        emit('[任务 ' + job.id + '] ' + String(line))
      },
      items(done, total, label) {
        job.progress.done = Number(done) || 0
        job.progress.total = Number(total) || 0
        if (label) job.progress.label = String(label)
      },
      bytes(count) {
        const n = Number(count)
        if (Number.isFinite(n) && n > 0) job.progress.bytes += n
      },
      setPhase(phase) {
        job.phase = String(phase || '')
        if (typeof phase === 'string' && phase.trim()) job.message = phase
      },
      get cancelRequested() {
        return job.cancelRequested
      },
    }
  }

  function runJob(kind, title, instanceId, fn) {
    const job = newJob(kind, title, instanceId)
    job.promise = (async () => {
      job.status = 'running'
      job.startedAt = Date.now()
      job.phase = 'running'
      job.message = '正在执行'
      try {
        const result = await fn(makeTask(job))
        job.result = result === undefined ? null : result
        job.status = 'succeeded'
        job.phase = 'done'
        job.message = '完成'
        job.finishedAt = Date.now()
        return result
      } catch (error) {
        job.error = errorMessage(error)
        job.status = 'failed'
        job.phase = 'failed'
        job.message = job.error
        job.finishedAt = Date.now()
        pushJobLog(job, '# 失败：' + job.error)
        throw error
      }
    })()
    job.promise.catch(() => {})
    return job
  }

  function listJobs(limit = 20) {
    const list = []
    for (const id of jobOrder) {
      const job = jobs.get(id)
      if (job) list.push(summarizeJob(job))
    }
    return list.slice(-Math.max(1, Number(limit) || 20)).reverse()
  }

  function getJob(jobId) {
    const job = jobs.get(String(jobId))
    if (!job) throw new Error('任务不存在：' + String(jobId))
    return summarizeJob(job, true)
  }

  async function waitJob(jobId, timeoutMs = 120000) {
    const job = jobs.get(String(jobId))
    if (!job) throw new Error('任务不存在：' + String(jobId))
    if (job.status !== 'succeeded' && job.status !== 'failed') {
      await Promise.race([job.promise.catch(() => null), sleep(Math.max(1000, Number(timeoutMs) || 120000))])
    }
    return summarizeJob(job, true)
  }

  async function cancelJob(jobId) {
    const job = jobs.get(String(jobId))
    if (!job) throw new Error('任务不存在：' + String(jobId))
    if (job.status !== 'running' && job.status !== 'queued') {
      return { cancelled: false, jobId: job.id, status: job.status, reason: '任务已结束' }
    }
    job.cancelRequested = true
    pushJobLog(job, '# 已请求取消任务')
    await Promise.race([job.promise.catch(() => null), sleep(8000)])
    return { cancelled: job.status !== 'running' && job.status !== 'queued', jobId: job.id, status: job.status }
  }

  // ---------- 游戏 ----------

  function gameLabel(gameId) {
    const info = registry.listGames().find((item) => item.id === gameId)
    return info ? info.label : gameId
  }

  function listGames() {
    const userDefinitions = store && typeof store.list === 'function' ? store.list() : []
    const providerById = new Map(userDefinitions.map((item) => [item.id, item]))
    return registry.listGames().map((game) => {
      const definition = providerById.get(game.id)
      return definition ? { ...game, providerType: definition.provider, versionLabel: definition.versionLabel || game.versionLabel } : game
    })
  }

  async function addGame(definition = {}) {
    if (!store) await init()
    const entry = await store.add(definition)
    const games = listGames()
    const info = games.find((item) => item.id === (entry && entry.id)) || games.find((item) => item.id === definition.id)
    return { game: info || (entry && entry.game) || entry, ...(entry && entry.definition ? { definition: entry.definition } : {}) }
  }

  async function testGame(definition = {}) {
    if (!store) await init()
    return store.test({ provider: definition.provider, config: definition.config })
  }

  async function removeGame(gameId) {
    if (!store) await init()
    return store.remove(String(gameId))
  }

  // ---------- 查询 ----------

  async function listVersions({ game, force = false } = {}) {
    if (!game) throw new Error('缺少游戏 id：请先调用 launcher_list_games 选择游戏')
    const adapter = registry.getGame(String(game))
    const result = await adapter.listVersions({ ctx: makeCtx({ gameId: String(game) }), force: !!force })
    const versions = Array.isArray(result && result.versions) ? result.versions : []
    const latestRelease = result && result.latestRelease ? String(result.latestRelease) : versions.length ? String(versions[0].id) : ''
    return {
      game: String(game),
      latestRelease,
      count: versions.length,
      versions: versions.slice(0, 500).map((item) => ({
        id: String(item.id),
        label: item.label ? String(item.label) : String(item.id),
        releaseTime: item.releaseTime ? String(item.releaseTime) : null,
      })),
    }
  }

  async function listLoaders({ game, version, type } = {}) {
    if (!game) throw new Error('缺少游戏 id')
    const adapter = registry.getGame(String(game))
    if (typeof adapter.listLoaders !== 'function') throw new Error('该游戏不支持加载器：' + gameLabel(String(game)))
    if (!version) throw new Error('缺少版本号')
    return adapter.listLoaders({ ctx: makeCtx({ gameId: String(game) }), version: String(version), type: type ? String(type) : undefined })
  }

  async function searchContent({ game, query = '', version, loader, limit = 12, offset = 0 } = {}) {
    if (!game) throw new Error('缺少游戏 id')
    const adapter = registry.getGame(String(game))
    if (typeof adapter.searchContent !== 'function') throw new Error('该游戏不支持内容搜索：' + gameLabel(String(game)))
    return adapter.searchContent({ ctx: makeCtx({ gameId: String(game) }), query: String(query), version, loader, limit: Number(limit) || 12, offset: Number(offset) || 0 })
  }

  async function contentVersions({ game, id, version, loader } = {}) {
    if (!game) throw new Error('缺少游戏 id')
    if (!id) throw new Error('缺少内容 id')
    const adapter = registry.getGame(String(game))
    if (typeof adapter.contentVersions !== 'function') throw new Error('该游戏不支持内容搜索：' + gameLabel(String(game)))
    return adapter.contentVersions({ ctx: makeCtx({ gameId: String(game) }), id: String(id), version, loader })
  }

  async function listRuntimes({ game } = {}) {
    if (!game) throw new Error('缺少游戏 id')
    const adapter = registry.getGame(String(game))
    if (typeof adapter.listRuntimes !== 'function') return []
    return adapter.listRuntimes({ ctx: makeCtx({ gameId: String(game) }) })
  }

  // ---------- 实例 ----------

  async function requireInstance(instanceId) {
    const record = await readInstance(paths, String(instanceId))
    if (!record) throw new Error('实例不存在：' + String(instanceId))
    return record
  }

  function contentDirOf(record) {
    return path.join(paths.instanceGameDir(record.id), 'content')
  }

  async function listInstances() {
    const records = await listInstanceRecords(paths)
    const labels = new Map(registry.listGames().map((game) => [game.id, game.label]))
    return records.map((record) => ({
      ...summarizeInstance(record),
      gameLabel: labels.get(record.game) || record.game,
      running: running.has(record.id),
    }))
  }

  async function getInstance(instanceId) {
    const record = await requireInstance(instanceId)
    const adapter = registry.hasGame(record.game) ? registry.getGame(record.game) : null
    const info = { instance: record, game: record.game, gameLabel: registry.hasGame(record.game) ? gameLabel(record.game) : record.game, gameDir: paths.instanceGameDir(record.id), contentDir: contentDirOf(record), logsDir: paths.instanceLogsDir(record.id), running: running.has(record.id), capabilities: adapter && adapter.capabilities ? adapter.capabilities : {} }
    if (adapter && typeof adapter.contentDir === 'function') {
      try {
        info.contentDir = adapter.contentDir({ ctx: makeCtx({ gameId: record.game, instance: record }), instance: record })
      } catch {
        /* 忽略扩展失败 */
      }
    }
    return info
  }

  async function installInstance(spec = {}) {
    if (!initialized) await init()
    const games = listGames()
    if (!games.length) throw new Error('还没有添加游戏：请先添加游戏（launcher_add_game）')
    const gameId = spec.game ? String(spec.game) : games[0].id
    const adapter = registry.getGame(gameId)
    const version = toText(spec.version, '')
    if (!version) throw new Error('缺少版本号：请先查询版本列表（launcher_list_versions）再指定 version')
    if (/^\[object /i.test(version)) throw new Error('版本号无效（收到：' + version + '）：请传版本号字符串，例如 "1.0.0"')
    const name = toText(spec.name, '') || (gameLabel(gameId) + ' ' + version)
    const id = await uniqueInstanceId(paths, name)
    const record = {
      id,
      name,
      game: gameId,
      versionId: version,
      status: 'installing',
      memoryMb: Number.isFinite(Number(spec.memoryMb)) ? Number(spec.memoryMb) : null,
      options: spec.options && typeof spec.options === 'object' ? spec.options : {},
      content: [],
      createdAt: timestamp(),
      updatedAt: timestamp(),
    }
    await writeInstance(paths, record)
    const contentSpecs = Array.isArray(spec.content) ? spec.content : []
    const job = runJob('install', '安装 ' + name, id, async (task) => {
      const ctx = makeCtx({ gameId, instance: record, task })
      task.setPhase('准备安装')
      const result = await adapter.install({ ctx, instance: record, version, options: record.options, content: contentSpecs })
      if (task.cancelRequested) throw new Error('任务已取消')
      record.versionId = result && result.versionId ? String(result.versionId) : version
      record.metadata = result && result.metadata ? result.metadata : {}
      const installedContent =
        result && Array.isArray(result.content)
          ? result.content
          : result && result.metadata && Array.isArray(result.metadata.content)
            ? result.metadata.content
            : null
      if (installedContent) {
        record.content = installedContent.map((item) => (item && typeof item === 'object' ? { ...item } : { filename: String(item) }))
      }
      record.status = 'ready'
      record.installError = null
      await writeInstance(paths, record)
      return { instanceId: id, versionId: record.versionId }
    })
    job.promise.catch(async (error) => {
      record.status = 'error'
      record.installError = errorMessage(error)
      record.updatedAt = timestamp()
      try {
        await writeInstance(paths, record)
      } catch (writeError) {
        emit('写入实例失败：' + errorMessage(writeError))
      }
    })
    return { jobId: job.id, instanceId: id, name, game: gameId }
  }

  async function addContent(instanceId, specs = []) {
    const record = await requireInstance(instanceId)
    const adapter = registry.getGame(record.game)
    if (typeof adapter.addContent !== 'function') throw new Error('该游戏不支持添加内容：' + gameLabel(record.game))
    const ctx = makeCtx({ gameId: record.game, instance: record })
    const result = await adapter.addContent({ ctx, instance: record, specs: Array.isArray(specs) ? specs : [], version: record.versionId, loader: record.options && record.options.loader })
    const added = (result && Array.isArray(result.added) ? result.added : []).map((item) => ({ ...item }))
    record.content = [...record.content, ...added]
    await writeInstance(paths, record)
    return { added, contentCount: record.content.length }
  }

  async function removeContent(instanceId, filename) {
    const record = await requireInstance(instanceId)
    if (!filename) throw new Error('缺少要删除的内容文件名')
    const adapter = registry.getGame(record.game)
    let removed = false
    if (typeof adapter.removeContent === 'function') {
      const result = await adapter.removeContent({ ctx: makeCtx({ gameId: record.game, instance: record }), instance: record, filename: String(filename) })
      removed = !!(result && result.removed)
    }
    const before = record.content.length
    record.content = record.content.filter((item) => String(item.filename || item.name || '') !== String(filename))
    if (record.content.length !== before) removed = true
    await writeInstance(paths, record)
    return { removed, contentCount: record.content.length }
  }

  async function renameInstance(instanceId, name) {
    const record = await requireInstance(instanceId)
    const next = toText(name, '')
    if (!next) throw new Error('新名称不能为空')
    record.name = next
    await writeInstance(paths, record)
    return { instanceId: record.id, name: record.name }
  }

  async function verifyInstance(instanceId) {
    const record = await requireInstance(instanceId)
    const problems = []
    const checks = {}
    const gameDir = paths.instanceGameDir(record.id)
    checks.instanceFile = await pathExists(path.join(paths.instanceDir(record.id), 'instance.json'))
    if (!checks.instanceFile) problems.push('缺少实例记录文件')
    checks.gameDir = await pathExists(gameDir)
    if (!checks.gameDir) problems.push('缺少游戏目录：' + gameDir)
    if (record.status !== 'ready') problems.push('实例状态不是「已就绪」：' + record.status)
    const adapter = registry.hasGame(record.game) ? registry.getGame(record.game) : null
    const base = { instanceId: record.id, ok: problems.length === 0, problems, checks }
    if (!adapter) {
      problems.push('实例所属游戏未注册（可能未安装对应适配器）：' + record.game)
      return { ...base, ok: false, problems }
    }
    if (typeof adapter.verify === 'function') {
      const extra = await adapter.verify({ ctx: makeCtx({ gameId: record.game, instance: record }), instance: record })
      const extraProblems = extra && Array.isArray(extra.problems) ? extra.problems : []
      const mergedProblems = [...problems, ...extraProblems]
      return { instanceId: record.id, ok: mergedProblems.length === 0 && (!extra || extra.ok !== false), problems: mergedProblems, checks: { ...checks, ...(extra && extra.checks ? extra.checks : {}) } }
    }
    return { ...base, ok: problems.length === 0, problems }
  }

  async function deleteInstance(instanceId) {
    const record = await requireInstance(instanceId)
    if (running.has(record.id)) await stop(record.id)
    let lastError = null
    for (let attempt = 0; attempt < 12; attempt += 1) {
      try {
        await deleteInstanceDir(paths, record.id)
        return { deleted: true, instanceId: record.id }
      } catch (error) {
        lastError = error
        const code = error && error.code ? String(error.code) : ''
        if (!['EBUSY', 'EPERM', 'ENOTEMPTY', 'EACCES'].includes(code)) throw error
        await sleep(250 + attempt * 150)
      }
    }
    throw new Error(
      '删除实例失败：目录仍被占用（可能游戏进程尚未完全退出），请稍后重试。' +
        (lastError && lastError.message ? ' 原因：' + lastError.message : ''),
    )
  }

  async function openFolder(instanceId, kind = 'game') {
    const record = await requireInstance(instanceId)
    const adapter = registry.hasGame(record.game) ? registry.getGame(record.game) : null
    const options = { ctx: makeCtx({ gameId: record.game, instance: record }), instance: record, kind: String(kind || 'game') }
    if (adapter && typeof adapter.openFolder === 'function') {
      const result = await adapter.openFolder(options)
      if (result && result.path) {
        await openNativePath(result.path)
        return { opened: true, path: result.path, kind: String(kind || 'game') }
      }
    }
    const target = kind === 'logs' ? paths.instanceLogsDir(record.id) : kind === 'content' ? contentDirOf(record) : paths.instanceGameDir(record.id)
    if (!(await pathExists(target))) throw new Error('目录不存在：' + target)
    await openNativePath(target)
    return { opened: true, path: target, kind: String(kind || 'game') }
  }

  async function openNativePath(target) {
    const { spawn } = await import('node:child_process')
    if (process.platform === 'win32') {
      const child = spawn('explorer.exe', [target], { detached: true, stdio: 'ignore', windowsHide: false })
      child.on('error', () => {})
      child.unref()
      return
    }
    const command = process.platform === 'darwin' ? 'open' : 'xdg-open'
    const child = spawn(command, [target], { detached: true, stdio: 'ignore' })
    child.on('error', () => {})
    child.unref()
  }

  // ---------- 启动 / 停止 ----------

  async function launch(instanceId) {
    if (!initialized) await init()
    const record = await requireInstance(instanceId)
    if (record.status !== 'ready') {
      const reason = record.installError ? '（上次安装失败：' + record.installError + '）' : ''
      throw new Error('实例还没有安装完成，不能启动' + reason + '；若安装失败请删除后重建')
    }
    if (running.has(record.id)) throw new Error('实例正在运行中：' + record.name)
    const adapter = registry.getGame(record.game)
    const job = runJob('launch', '启动 ' + record.name, record.id, async (task) => {
      task.setPhase('准备启动')
      const ctx = makeCtx({ gameId: record.game, instance: record, task })
      const spec = await adapter.launch({ ctx, instance: record })
      if (!spec || !spec.executable) throw new Error('适配器没有返回可启动的程序')
      const logPath = path.join(paths.instanceLogsDir(record.id), 'launch-' + timestamp() + '.log')
      const started = await launchProcess({ spec, logPath })
      const entry = { proc: started.proc, pid: started.proc.pid, logPath, startedAt: started.startedAt, jobId: job.id }
      running.set(record.id, entry)
      started.proc.once('exit', async (code, signal) => {
        const current = running.get(record.id)
        if (current && current.proc === started.proc) running.delete(record.id)
        emit('[游戏] ' + record.id + ' 已退出 code=' + code + ' signal=' + signal)
        try {
          const latest = await readInstance(paths, record.id)
          if (latest) {
            latest.lastExit = { code, signal, at: timestamp() }
            latest.updatedAt = timestamp()
            await writeInstance(paths, latest)
          }
        } catch (error) {
          emit('记录实例退出状态失败：' + errorMessage(error))
        }
      })
      record.lastLaunchAt = timestamp()
      record.playCount = Number(record.playCount || 0) + 1
      await writeInstance(paths, record)
      task.setPhase('已启动')
      await sleep(1500)
      if (started.proc.exitCode !== null && started.proc.exitCode !== 0) {
        const tail = await readLogTail(logPath, 25)
        throw new Error('程序启动后立即退出（exit code ' + started.proc.exitCode + '）' + (tail ? '\n' + tail : ''))
      }
      return { pid: started.proc.pid, executable: spec.executable, logPath, args: Array.isArray(spec.args) ? spec.args : [] }
    })
    return { jobId: job.id }
  }

  async function stop(instanceId) {
    const entry = running.get(String(instanceId))
    if (!entry) return { stopped: false, instanceId: String(instanceId) }
    running.delete(String(instanceId))
    const result = await stopProcess({ pid: entry.pid, proc: entry.proc })
    return { stopped: !!result.stopped, pid: entry.pid, forced: !!result.forced }
  }

  async function getInstanceLog(instanceId, lines = 120) {
    const record = await requireInstance(instanceId)
    return { instanceId: record.id, ...(await readInstanceLog(paths, record.id, lines)) }
  }

  // ---------- 状态 ----------

  function getState() {
    const instances = []
    return {
      config: publicConfig(),
      games: listGames(),
      instances,
      running: [],
      jobs: listJobs(),
    }
  }

  async function getStateAsync() {
    const state = getState()
    state.instances = await listInstances()
    state.running = [...running.keys()]
    return state
  }

  function dispose() {
    stopAdapterWatch()
    // 只清理属于当前进程的指针文件，避免测试/多实例误删其它正在运行的宿主指针。
    for (const file of bridgePointerFiles()) {
      readJson(file, null)
        .then((pointer) => {
          if (pointer && pointer.pid === process.pid) return fsp.rm(file, { force: true })
          return undefined
        })
        .catch(() => {})
    }
    for (const [id, entry] of running.entries()) {
      try {
        entry.proc?.kill?.('SIGTERM')
      } catch {
        /* ignore */
      }
      running.delete(id)
    }
  }

  function activeJobForInstance(instanceId) {
    for (const id of jobOrder) {
      const job = jobs.get(id)
      if (job && job.instanceId === instanceId && (job.status === 'running' || job.status === 'queued')) return job
    }
    return null
  }

  const engineApi = () => ({
    init,
    dispose,
    paths,
    reloadGames,
    publishBridgePointer,
    getConfig: publicConfig,
    setConfig,
    getState: getStateAsync,
    listGames,
    addGame,
    testGame,
    removeGame,
    listVersions,
    listLoaders,
    searchContent,
    contentVersions,
    listRuntimes,
    installInstance,
    listInstances,
    getInstance,
    launch,
    stop,
    deleteInstance,
    renameInstance,
    getInstanceLog,
    verifyInstance,
    openFolder,
    addContent,
    removeContent,
    listJobs,
    getJob,
    waitJob,
    cancelJob,
    activeJobForInstance,
    formatBytes,
    pathsFor: () => paths,
  })

  return engineApi()
}
