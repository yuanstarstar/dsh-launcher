// lib/adapter.js —— 方块游戏（Minecraft）GameAdapter 实现
//
// 严格实现 docs/ARCHITECTURE-v3.md §2 的 GameAdapter 契约：
//   id / label / versionLabel / contentLabel / capabilities / instanceOptions
//   listVersions / install / launch / verify / listLoaders
//   searchContent / contentVersions / addContent / removeContent / listRuntimes
//
// 本文件只依赖同包 lib/*.js 与 Node 内置模块；不 import 核心包任何文件。
// 所有对外错误消息使用中文；所有临时/持久产物都写在 ctx.gameDataDir 或 ctx.gameDir。

import path from 'node:path'

import {
  createGamePaths,
  ensureGameDirs,
  pathExists,
  readJson,
  writeJson,
  removeDir,
  formatBytes,
  taskOf,
  taskLog,
  assertSafeId,
  fsp,
} from './util.js'
import { configureMirrors, makeDownloader, getMirrorState } from './mirrors.js'
import { fetchManifest, mergeVersionChain, javaMajor } from './version.js'
import { installVanilla, ensureRuntimeLibraries, ensureAssets, platformEnv } from './vanilla.js'
import { installLoader, listLoaderVersions, LOADER_TYPES, loaderLabel, installerJavaMajor } from './loaders.js'
import { detectJavas, ensureJava, probeJava } from './java.js'
import { searchProjects, listProjectVersions, resolveMods, downloadMod } from './modrinth.js'
import { buildLaunchSpec } from './launch.js'

const ADAPTER_ID = 'minecraft'
const ADAPTER_VERSION = '3.0.0'

const LOADER_NONE = 'none'
const LOADER_CHOICES = [
  { value: LOADER_NONE, label: '不安装加载器' },
  ...LOADER_TYPES.map((type) => ({ value: type, label: loaderLabel(type) })),
]

const INSTANCE_OPTIONS = Object.freeze([
  {
    key: 'loader',
    label: '模组加载器',
    type: 'select',
    default: LOADER_NONE,
    choices: LOADER_CHOICES,
    description: '安装实例时同时安装的加载器；Fabric/Quilt 只写 profile，Forge/NeoForge 需要运行官方安装器',
  },
  {
    key: 'loaderVersion',
    label: '加载器版本',
    type: 'string',
    default: '',
    description: '留空则自动选择（Fabric/Quilt 优先稳定版，Forge 优先推荐版，NeoForge 优先最新版）',
  },
  {
    key: 'memoryMb',
    label: '内存（MB）',
    type: 'number',
    default: 2048,
    description: '分配给游戏进程的最大堆内存，建议 2048–8192',
  },
  {
    key: 'assetsMode',
    label: '资源文件',
    type: 'select',
    default: 'full',
    choices: [
      { value: 'full', label: '完整下载（含声音等全部资源）' },
      { value: 'index', label: '仅资源索引（按需下载，启动更快）' },
    ],
    description: '完整模式首次安装下载量大；仅索引模式在启动/运行期按需补资源',
  },
  {
    key: 'jvmArgs',
    label: '额外 JVM 参数',
    type: 'string',
    default: '',
    description: '可留空；多个参数用空格分隔（例如 -XX:+UseG1GC）',
  },
])

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

function cfgOf(ctx) {
  return ctx && typeof ctx.config === 'object' && ctx.config ? ctx.config : {}
}

function gamePathsOf(ctx) {
  if (!ctx || typeof ctx.gameDataDir !== 'string' || !ctx.gameDataDir) {
    throw new Error('适配器上下文缺少 gameDataDir（共享游戏数据目录），无法确定安装位置')
  }
  return createGamePaths(ctx.gameDataDir)
}

/** 实例游戏目录：优先核心注入的 ctx.gameDir（instances/<id>/game）。 */
function gameDirOf(ctx) {
  if (ctx && typeof ctx.gameDir === 'string' && ctx.gameDir) return ctx.gameDir
  throw new Error('适配器上下文缺少 gameDir（实例游戏目录）')
}

/** 实例记录：engine 调用时传 {ctx, instance, ...}；ctx.instance 也带一份。 */
function instanceOf(ctx, instance) {
  if (instance && typeof instance === 'object') return instance
  if (ctx && ctx.instance && typeof ctx.instance === 'object') return ctx.instance
  return {}
}

/** 记录里读合并后的选项（options 优先，其次 metadata）。 */
function optionsOf(record) {
  const fromOptions = record && typeof record.options === 'object' && record.options ? record.options : {}
  const fromMetadata = record && typeof record.metadata === 'object' && record.metadata ? record.metadata : {}
  return { ...fromMetadata, ...fromOptions }
}

function downloaderOf(ctx, extra = {}) {
  return makeDownloader(ctx, extra)
}

async function ensureDataDirs(ctx) {
  const paths = gamePathsOf(ctx)
  await ensureGameDirs(paths)
  return paths
}

/** 写实例目录下的 metadata.json（适配器自己的安装元数据）。 */
async function writeInstanceMetadata(ctx, metadata) {
  const dir = ctx && typeof ctx.instanceDir === 'string' ? ctx.instanceDir : ''
  if (!dir) return null
  const file = path.join(dir, 'metadata.json')
  await writeJson(file, metadata)
  return file
}

async function readInstanceMetadata(ctx) {
  const dir = ctx && typeof ctx.instanceDir === 'string' ? ctx.instanceDir : ''
  if (!dir) return null
  return readJson(path.join(dir, 'metadata.json'), null)
}

/**
 * 合并实例记录与适配器 metadata.json：核心的 instance.json 不一定保存 loader 信息，
 * 安装时我们写进实例目录的 metadata.json 才是权威。record 字段优先。
 */
async function withInstanceMetadata(ctx, instance) {
  const record = instanceOf(ctx, instance)
  const metadata = await readInstanceMetadata(ctx)
  if (!metadata) return record
  const loader = record.loader && record.loader.versionId ? record.loader : metadata.loader || null
  const options = { ...(metadata.options || {}), ...(record.options || {}) }
  return {
    ...metadata,
    ...record,
    versionId: record.versionId || metadata.versionId || '',
    loader,
    options,
    metadata,
  }
}

/** 读实例已安装的版本链（原版 + 可选加载器），返回 merged。 */
async function readMergedVersion(paths, record) {
  const versionId = String(record.versionId || '')
  if (!versionId) throw new Error('实例缺少 versionId（游戏版本），请重新安装该实例')
  assertSafeId(versionId, '游戏版本')
  const baseJson = await readJson(path.join(paths.versions, versionId, `${versionId}.json`), null)
  if (!baseJson) throw new Error(`实例对应的游戏版本文件不存在：${versionId}，请重新安装该实例`)

  let loaderJson = null
  const loaderVersionId = record.loader?.versionId
  if (loaderVersionId) {
    assertSafeId(String(loaderVersionId), '加载器版本')
    loaderJson = await readJson(path.join(paths.versions, loaderVersionId, `${loaderVersionId}.json`), null)
    if (!loaderJson) throw new Error(`实例对应的加载器版本文件不存在：${loaderVersionId}，请重新安装该实例`)
  }
  return loaderJson ? mergeVersionChain([loaderJson, baseJson]) : mergeVersionChain([baseJson])
}

function loaderTypeOf(record) {
  const type = String(record?.loader?.type || optionsOf(record).loader || LOADER_NONE)
  return type === LOADER_NONE ? null : type
}

// ---------------------------------------------------------------------------
// GameAdapter
// ---------------------------------------------------------------------------

export const adapter = {
  id: ADAPTER_ID,
  label: 'Minecraft',
  versionLabel: '游戏版本',
  contentLabel: '模组',
  capabilities: Object.freeze({ content: true, loaders: true, runtimes: true }),
  instanceOptions: INSTANCE_OPTIONS,

  /** 应用适配器级配置（由 index.js 在 apply 时调用；也可由核心按 config 调 configure）。 */
  configure(config = {}) {
    configureMirrors({
      mirror: config.mirror,
      neoforgeMirror: config.neoforgeMirror,
    })
    return getMirrorState()
  },

  async listVersions({ ctx, force } = {}) {
    const dl = downloaderOf(ctx)
    let manifest
    try {
      manifest = await fetchManifest(dl, { force: Boolean(force) })
    } catch (error) {
      throw new Error(`获取游戏版本列表失败：${error?.message ?? error}`)
    }
    const versions = manifest.versions.map((item) => ({
      id: item.id,
      label: item.type === 'release' ? item.id : `${item.id}（${item.type === 'snapshot' ? '快照' : item.type}）`,
      releaseTime: item.releaseTime,
      type: item.type,
    }))
    return { versions, latestRelease: manifest.latest.release || null }
  },

  async install({ ctx, instance, version, options, content } = {}) {
    const t = taskOf(ctx?.task)
    const record = instanceOf(ctx, instance)
    const opts = { ...optionsOf(record), ...(options && typeof options === 'object' ? options : {}) }
    const versionId = String(version || record.versionId || '').trim()
    if (!versionId) throw new Error('安装失败：没有指定要安装的游戏版本')
    assertSafeId(versionId, '游戏版本')

    const paths = await ensureDataDirs(ctx)
    const dl = downloaderOf(ctx)
    const cfg = cfgOf(ctx)
    const assetsMode = opts.assetsMode === 'index' ? 'index' : cfg.assetsMode === 'index' ? 'index' : 'full'
    t.setPhase?.('安装游戏文件')
    taskLog(t, `开始安装 ${versionId}（资源模式：${assetsMode === 'full' ? '完整' : '仅索引'}）`)

    let vanilla
    try {
      vanilla = await installVanilla({ dl, paths, versionId, assetsMode, task: t })
    } catch (error) {
      throw new Error(`安装游戏版本 ${versionId} 失败：${error?.message ?? error}`)
    }

    // 可选：同时安装加载器
    let loaderResult = null
    const loaderType = String(opts.loader || LOADER_NONE)
    if (loaderType !== LOADER_NONE) {
      if (!LOADER_TYPES.includes(loaderType)) {
        throw new Error(`不支持的加载器类型：${loaderType}（可用：${LOADER_TYPES.join('/')}）`)
      }
      t.setPhase?.(`安装 ${loaderLabel(loaderType)}`)
      taskLog(t, `安装加载器 ${loaderLabel(loaderType)} …`)
      try {
        loaderResult = await installLoader({
          dl,
          paths,
          mcVersion: versionId,
          type: loaderType,
          version: opts.loaderVersion ? String(opts.loaderVersion) : null,
          getJava: async (major) => {
            const java = await ensureJava({ major, cfg, dl, paths, task: t })
            return java.path
          },
          task: t,
        })
      } catch (error) {
        throw new Error(`安装 ${loaderLabel(loaderType)} 失败：${error?.message ?? error}`)
      }
    }

    // 可选：安装时附带内容（模组）
    let contentAdded = []
    const contentSpecs = Array.isArray(content) ? content : Array.isArray(opts.content) ? opts.content : []
    if (contentSpecs.length > 0) {
      t.setPhase?.('安装内容')
      const added = await adapter.addContent({
        ctx,
        instance: { ...record, versionId, loader: loaderResult ? { type: loaderResult.type, version: loaderResult.version, versionId: loaderResult.versionId } : record.loader },
        specs: contentSpecs,
        version: versionId,
        loader: loaderResult?.type || loaderTypeOf(record),
        options: opts,
      })
      contentAdded = added?.added || []
    }

    const merged = loaderResult?.chain
      ? mergeVersionChain([loaderResult.chain[1], loaderResult.chain[0]])
      : mergeVersionChain([vanilla.json])
    const major = javaMajor(merged)
    const metadata = {
      adapter: ADAPTER_ID,
      adapterVersion: ADAPTER_VERSION,
      versionId,
      assetsMode,
      installedAt: new Date().toISOString(),
      javaMajor: major,
      loader: loaderResult
        ? { type: loaderResult.type, version: loaderResult.version, versionId: loaderResult.versionId }
        : null,
      content: contentAdded,
      files: {
        versionJson: vanilla.jsonPath,
        clientJar: vanilla.jarPath,
        libraries: vanilla.libraries,
      },
      // 实例选项回写，launch/verify 与核心 UI 共用
      options: {
        loader: loaderResult ? loaderResult.type : loaderType,
        loaderVersion: loaderResult ? loaderResult.version : opts.loaderVersion || '',
        memoryMb: Number(opts.memoryMb) || Number(cfg.defaultMemoryMb) || 2048,
        assetsMode,
        jvmArgs: typeof opts.jvmArgs === 'string' ? opts.jvmArgs : '',
      },
    }
    await writeInstanceMetadata(ctx, metadata)
    taskLog(t, `安装完成：${versionId}${loaderResult ? `（${loaderLabel(loaderResult.type)} ${loaderResult.version}）` : ''}`)
    return { versionId, metadata }
  },

  async launch({ ctx, instance } = {}) {
    const t = taskOf(ctx?.task)
    const record = await withInstanceMetadata(ctx, instance)
    const paths = gamePathsOf(ctx)
    const dl = downloaderOf(ctx)
    const gameDir = gameDirOf(ctx)
    const cfg = cfgOf(ctx)
    await fsp.mkdir(path.join(gameDir, 'logs'), { recursive: true })

    const merged = await readMergedVersion(paths, record)
    const major = javaMajor(merged)
    const opts = optionsOf(record)
    const assetsMode = opts.assetsMode === 'index' ? 'index' : 'full'

    t.setPhase?.('准备运行库')
    taskLog(t, '检查并补齐运行库/资源文件 …')
    await ensureRuntimeLibraries({ dl, paths, merged, nativesDir: path.join(gameDir, 'natives'), task: t })
    await ensureAssets({ dl, paths, merged, mode: assetsMode, task: t })

    t.setPhase?.('准备 Java')
    let java
    try {
      java = await ensureJava({
        major,
        cfg: { ...cfg, javaPath: record.javaPath || cfg.javaPath },
        dl,
        paths,
        task: t,
      })
    } catch (error) {
      throw new Error(`准备 Java ${major} 失败：${error?.message ?? error}`)
    }

    t.setPhase?.('构建启动参数')
    const spec = await buildLaunchSpec({
      paths,
      instance: { ...record, ...opts },
      gameDir,
      javaPath: java.path,
      task: t,
    })
    taskLog(t, `Java：${java.path}（major=${java.major ?? major}），工作目录：${gameDir}`)
    return spec
  },

  async verify({ ctx, instance } = {}) {
    const record = await withInstanceMetadata(ctx, instance)
    const paths = gamePathsOf(ctx)
    // 核心 engine.verifyInstance 用对象展开合并 checks（{...coreChecks, ...extra.checks}），
    // 因此这里返回对象：{ 检查名: { ok, detail } }。
    const checks = {}
    const problems = []
    const addCheck = (name, ok, detail) => {
      checks[name] = { ok: Boolean(ok), detail: detail || '' }
      if (!ok) problems.push(detail || name)
    }

    const versionId = String(record.versionId || '')
    addCheck('gameVersion', versionId !== '', versionId ? `游戏版本：${versionId}` : '实例缺少 versionId')
    if (versionId) {
      const versionJson = path.join(paths.versions, versionId, `${versionId}.json`)
      const versionJar = path.join(paths.versions, versionId, `${versionId}.jar`)
      addCheck('versionJson', await pathExists(versionJson), versionJson)
      addCheck('clientJar', await pathExists(versionJar), versionJar)
    }
    const loaderVersionId = record.loader?.versionId
    if (loaderVersionId) {
      const loaderJson = path.join(paths.versions, loaderVersionId, `${loaderVersionId}.json`)
      addCheck('loaderJson', await pathExists(loaderJson), loaderJson)
    }

    let merged = null
    try {
      merged = await readMergedVersion(paths, record)
      addCheck('versionChain', true, `版本链可读（${merged.id || versionId}）`)
    } catch (error) {
      addCheck('versionChain', false, `版本链不可读：${error?.message ?? error}`)
    }

    if (merged) {
      const major = javaMajor(merged)
      let javaHit = null
      try {
        const javas = await detectJavas({ cfg: cfgOf(ctx) })
        javaHit = javas.find((item) => item.major === major) || null
      } catch {
        javaHit = null
      }
      addCheck(
        'java',
        Boolean(javaHit),
        javaHit ? `Java ${major}：${javaHit.path}` : `未找到 Java ${major}（启动时会尝试自动下载）`,
      )
      const jarId = String(merged.jarVersionId || merged.id || '')
      if (jarId) {
        const jar = path.join(paths.versions, jarId, `${jarId}.jar`)
        addCheck('gameJar', await pathExists(jar), jar)
      }
      const indexId = merged.assetIndex?.id || merged.assets
      if (indexId) {
        const indexFile = path.join(paths.assetIndexes, String(indexId).endsWith('.json') ? String(indexId) : `${indexId}.json`)
        addCheck('assetIndex', await pathExists(indexFile), indexFile)
      }
    }

    const metadata = await readInstanceMetadata(ctx)
    if (metadata) addCheck('metadata', true, `适配器元数据：${metadata.versionId || ''}`)
    return { ok: problems.length === 0, problems, checks }
  },

  async listLoaders({ ctx, version, type } = {}) {
    const t = taskOf(ctx?.task)
    const dl = downloaderOf(ctx)
    const mcVersion = String(version || '').trim()
    if (!mcVersion) throw new Error('查询加载器版本需要提供游戏版本（version）')
    const wanted = String(type || '').trim()
    const types = wanted ? [wanted] : [...LOADER_TYPES]
    for (const item of types) {
      if (!LOADER_TYPES.includes(item)) throw new Error(`不支持的加载器类型：${item}（可用：${LOADER_TYPES.join('/')}）`)
    }

    if (wanted) {
      try {
        const result = await listLoaderVersions({ dl, mcVersion, type: wanted })
        return { types, versions: result.versions, note: result.note }
      } catch (error) {
        throw new Error(`查询 ${loaderLabel(wanted)} 版本失败：${error?.message ?? error}`)
      }
    }

    // 未指定类型：并行查询全部，失败的类型只记 note
    const settled = await Promise.all(
      types.map(async (item) => {
        try {
          const result = await listLoaderVersions({ dl, mcVersion, type: item })
          return { type: item, versions: result.versions, note: result.note }
        } catch (error) {
          return { type: item, versions: [], note: `查询失败：${error?.message ?? error}` }
        }
      }),
    )
    const versions = []
    const notes = []
    for (const item of settled) {
      if (item.note) notes.push(`${loaderLabel(item.type)}：${item.note}`)
      for (const v of item.versions) versions.push({ ...v, type: item.type })
    }
    t.log?.(`加载器版本：${versions.length} 个（${types.map(loaderLabel).join('、')}）`)
    return { types, versions, note: notes.length ? notes.join('；') : undefined }
  },

  async searchContent({ ctx, query, version, loader, limit, offset } = {}) {
    const dl = downloaderOf(ctx)
    const result = await searchProjects(dl, {
      query: String(query || ''),
      mcVersion: version ? String(version) : '',
      loader: loader ? String(loader) : '',
      limit: Number(limit) > 0 ? Math.min(Number(limit), 50) : 12,
      offset: Number(offset) > 0 ? Number(offset) : 0,
    })
    return {
      totalHits: result.totalHits,
      hits: result.hits.map((hit) => ({
        ...hit,
        id: hit.projectId,
        title: hit.title,
        subtitle: hit.description,
        icon: hit.iconUrl,
      })),
    }
  },

  async contentVersions({ ctx, id, version, loader } = {}) {
    const projectId = String(id || '').trim()
    if (!projectId) throw new Error('查询内容版本需要提供项目 id 或 slug')
    const dl = downloaderOf(ctx)
    return listProjectVersions(dl, projectId, {
      mcVersion: version ? String(version) : '',
      loader: loader ? String(loader) : '',
    })
  },

  async addContent({ ctx, instance, specs, version, loader, options } = {}) {
    const t = taskOf(ctx?.task)
    const record = instanceOf(ctx, instance)
    const opts = { ...optionsOf(record), ...(options && typeof options === 'object' ? options : {}) }
    const list = Array.isArray(specs) ? specs.filter(Boolean) : []
    if (list.length === 0) return { added: [] }
    const dl = downloaderOf(ctx)
    const gameDir = gameDirOf(ctx)
    const modsDir = path.join(gameDir, 'mods')
    await fsp.mkdir(modsDir, { recursive: true })

    const mcVersion = String(version || record.versionId || '').trim()
    const loaderType = String(loader || loaderTypeOf(record) || '').trim()
    t.setPhase?.('解析内容')
    let resolved
    try {
      resolved = await resolveMods(dl, {
        mcVersion,
        loader: loaderType || null,
        mods: list,
        task: t,
      })
    } catch (error) {
      throw new Error(`解析要安装的内容失败：${error?.message ?? error}`)
    }

    t.setPhase?.('下载内容')
    const added = []
    for (const mod of resolved) {
      try {
        const result = await downloadMod(dl, mod, modsDir, t)
        added.push({
          filename: result.filename,
          path: result.path,
          bytes: result.bytes,
          slug: mod.slug,
          projectId: mod.projectId,
          title: mod.title,
          versionId: mod.versionId,
          versionNumber: mod.versionNumber,
        })
        taskLog(t, `已安装内容：${mod.title || mod.slug}（${result.filename}，${formatBytes(result.bytes)}）`)
      } catch (error) {
        throw new Error(`下载内容「${mod.title || mod.slug}」失败：${error?.message ?? error}`)
      }
    }

    // 回写实例 metadata 的 content 列表（尽力而为，失败不影响安装结果）
    const metadata = await readInstanceMetadata(ctx)
    if (metadata) {
      metadata.content = [...(Array.isArray(metadata.content) ? metadata.content : []), ...added]
      metadata.updatedAt = new Date().toISOString()
      await writeInstanceMetadata(ctx, metadata)
    }
    return { added }
  },

  async removeContent({ ctx, instance, filename } = {}) {
    const record = instanceOf(ctx, instance)
    const name = path.basename(String(filename || '').trim())
    if (!name) throw new Error('删除内容需要提供文件名（filename）')
    const gameDir = gameDirOf(ctx)
    const file = path.join(gameDir, 'mods', name)
    let removed = false
    try {
      await fsp.rm(file, { force: false })
      removed = true
    } catch {
      removed = false
    }
    if (!removed) return { removed: false }

    const metadata = await readInstanceMetadata(ctx)
    if (metadata && Array.isArray(metadata.content)) {
      metadata.content = metadata.content.filter((item) => item.filename !== name)
      metadata.updatedAt = new Date().toISOString()
      await writeInstanceMetadata(ctx, metadata)
    }
    void record
    return { removed: true }
  },

  async listRuntimes({ ctx } = {}) {
    const cfg = cfgOf(ctx)
    const paths = gamePathsOf(ctx)
    const seen = new Set()
    const runtimes = []
    const push = (item) => {
      if (!item?.path) return
      const key = String(item.path).toLowerCase()
      if (seen.has(key)) return
      seen.add(key)
      const major = Number(item.major) || null
      runtimes.push({
        id: major ? `java-${major}` : `java-${runtimes.length + 1}`,
        label: major ? `Java ${major}` : 'Java',
        path: item.path,
        version: item.version || null,
        major,
        vendor: item.vendor || null,
        source: item.source || null,
      })
    }

    try {
      const detected = await detectJavas({ cfg })
      for (const item of detected) push(item)
    } catch {
      /* 探测失败继续扫描已下载运行时 */
    }

    // 已由适配器下载的运行时（paths.runtime/jre-<major>/bin/java.exe）
    try {
      const entries = await fsp.readdir(paths.runtime, { withFileTypes: true })
      const exe = process.platform === 'win32' ? 'java.exe' : 'java'
      for (const entry of entries) {
        if (!entry.isDirectory()) continue
        const candidate = path.join(paths.runtime, entry.name, 'bin', exe)
        if (!(await pathExists(candidate))) continue
        const majorHit = String(entry.name).match(/^jre-(\d+)$/)
        let major = majorHit ? Number(majorHit[1]) : null
        let version = null
        try {
          const probed = await probeJava(candidate)
          major = probed?.major ?? major
          version = probed?.version ?? null
        } catch {
          /* release 文件缺失时用目录名 */
        }
        push({ path: candidate, major, version, vendor: 'Eclipse Adoptium', source: 'adapter-runtime' })
      }
    } catch {
      /* runtime 目录不存在 */
    }

    runtimes.sort((a, b) => (b.major || 0) - (a.major || 0))
    return runtimes
  },

  /** 可选方法：核心 UI 的「打开实例文件夹」按钮（kind=game|content|logs）。 */
  async openFolder({ ctx, instance, kind } = {}) {
    const record = instanceOf(ctx, instance)
    const instanceDir = ctx && typeof ctx.instanceDir === 'string' ? ctx.instanceDir : ''
    const gameDir = ctx && typeof ctx.gameDir === 'string' && ctx.gameDir ? ctx.gameDir : ''
    const wanted = String(kind || 'game').trim()

    if (wanted === 'content') {
      const base = gameDir || instanceDir
      if (base) return { path: path.join(base, 'mods') }
    } else if (wanted === 'logs') {
      const id = record?.id
      const paths = ctx?.paths
      if (id && paths && typeof paths.instanceLogsDir === 'function') {
        try {
          return { path: paths.instanceLogsDir(id) }
        } catch {
          /* 回退到实例目录 */
        }
      }
      if (instanceDir) return { path: path.join(instanceDir, 'logs') }
    } else if (gameDir) {
      return { path: gameDir }
    } else if (instanceDir) {
      return { path: instanceDir }
    }

    return { path: gamePathsOf(ctx).root }
  },
}

/** 平台判断（部分 UI 可能读取）。 */
export function adapterPlatform() {
  return platformEnv()
}

export { ADAPTER_ID, ADAPTER_VERSION, LOADER_NONE, LOADER_CHOICES, LOADER_TYPES, installerJavaMajor, removeDir, taskLog }
export default adapter
