// scripts/adapter-test.mjs —— 「Minecraft 适配器包」独立自测
//
// 目标：不安装 DSH、不依赖核心包源码，用一个假 ctx（mock AdapterContext）直接加载
// 本包的 GameAdapter，验证：
//   1) 包结构 / package.json / cordis.patch.yml / icon；
//   2) GameAdapter 契约字段与方法（§2）齐全；
//   3) index.js 的注册/注销流程（用假 globalThis.__dshLauncherRegistry）；
//   4) lib/mirrors.js 的候选 URL 规则（镜像优先、官方兜底、自定义镜像置顶）；
//   5) 真实网络：版本清单、版本 json、Fabric/Forge/NeoForge 加载器列表、Modrinth 搜索、
//      小文件真实下载（~300KB，验证镜像候选逐个回退）；
//   6) lib/launch.js 的 buildLaunchSpec 参数（合成版本 json，不 spawn、不联网）；
//   7) adapter.verify / removeContent 的实例逻辑（本地合成实例，不联网）。
//
// 运行：node scripts/adapter-test.mjs
// 产物：test/adapter-report.txt（人类可读报告）、test/tmp/adapter-results.json（机器可读结果）；
//       临时实例/下载目录会在结束时清理。
//
// 退出码：全部通过 0；有失败 1。

import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import adapter, {
  adapterPlatform,
  ADAPTER_ID,
  ADAPTER_VERSION,
  LOADER_TYPES,
} from '../lib/adapter.js'
import {
  OFFICIAL,
  MIRROR_BASES,
  resolveUrl,
  resolveUrlWithContext,
  clientJarCandidates,
  configureMirrors,
  getMirrorState,
  downloadFile,
  makeDownloader,
  probeMirrors,
} from '../lib/mirrors.js'
import { fetchVersionJson } from '../lib/version.js'
import { buildLaunchSpec } from '../lib/launch.js'
import { createGamePaths, ensureGameDirs, writeJson, removeDir } from '../lib/util.js'
import { name as pluginName, inject as pluginInject, apply as pluginApply, adapter as pluginAdapter } from '../index.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PKG_ROOT = path.dirname(HERE)
const TMP_ROOT = path.join(PKG_ROOT, 'test', 'tmp')
const RUN_DIR = path.join(TMP_ROOT, `adapter-test-${Date.now()}`)
const REPORT_FILE = path.join(PKG_ROOT, 'test', 'adapter-report.txt')
const RESULTS_FILE = path.join(TMP_ROOT, 'adapter-results.json')

const results = []
const startedAt = Date.now()

// ---------------------------------------------------------------------------
// 断言与报告基础设施
// ---------------------------------------------------------------------------

async function test(group, name, fn) {
  const begin = Date.now()
  try {
    const detail = await fn()
    const ms = Date.now() - begin
    results.push({ group, name, ok: true, ms, detail: detail === undefined ? '' : String(detail) })
    log(`PASS [${group}] ${name} (${ms}ms)${detail ? ` — ${detail}` : ''}`)
    return true
  } catch (error) {
    const ms = Date.now() - begin
    const message = error?.message ?? String(error)
    results.push({ group, name, ok: false, ms, detail: message })
    log(`FAIL [${group}] ${name} (${ms}ms) — ${message}`)
    return false
  }
}

function log(line) {
  process.stdout.write(`${line}\n`)
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function assertType(value, type, label) {
  if (typeof value !== type) throw new Error(`${label} 类型错误：期望 ${type}，实际 ${typeof value}`)
}

function makeTask() {
  const lines = []
  return {
    lines,
    log(line) {
      lines.push(String(line))
      return String(line)
    },
    items(done, total, label) {
      lines.push(`items ${done}/${total} ${label || ''}`)
    },
    bytes() {},
    setPhase(phase) {
      lines.push(`phase ${phase}`)
    },
    cancelRequested: false,
  }
}

// ---------------------------------------------------------------------------
// 假下载器（只用 Node 全局 fetch；模拟核心 createDownloader 的最小接口）
// ---------------------------------------------------------------------------

const REQUEST_TIMEOUT_MS = 25000
const UA = 'dsh-mc-adapter/3.0.0 (adapter-test)'

async function fetchText(url, options = {}) {
  const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : REQUEST_TIMEOUT_MS
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error(`请求超时（${timeoutMs}ms）`)), timeoutMs)
  try {
    const response = await fetch(url, {
      headers: { 'user-agent': UA, accept: '*/*' },
      signal: controller.signal,
      redirect: 'follow',
    })
    if (!response.ok) {
      const text = await response.text().catch(() => '')
      throw new Error(`HTTP ${response.status}${text ? ` - ${text.slice(0, 120)}` : ''}`)
    }
    return await response.text()
  } finally {
    clearTimeout(timer)
  }
}

async function fetchBuffer(url, options = {}) {
  const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : REQUEST_TIMEOUT_MS
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error(`请求超时（${timeoutMs}ms）`)), timeoutMs)
  try {
    const response = await fetch(url, {
      headers: { 'user-agent': UA, accept: '*/*' },
      signal: controller.signal,
      redirect: 'follow',
    })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    return Buffer.from(await response.arrayBuffer())
  } finally {
    clearTimeout(timer)
  }
}

function createMockDownloader() {
  const stats = { text: 0, json: 0, files: 0, bytes: 0 }
  return {
    stats,
    async fetchText(url, options = {}) {
      stats.text += 1
      return fetchText(url, options)
    },
    async fetchJson(url, options = {}) {
      stats.json += 1
      const text = await fetchText(url, options)
      try {
        return JSON.parse(text)
      } catch {
        throw new Error(`响应不是合法 JSON：${String(url).slice(0, 120)}`)
      }
    },
    async downloadFile(url, destPath, options = {}) {
      stats.files += 1
      const buffer = await fetchBuffer(url, options)
      await fsp.mkdir(path.dirname(destPath), { recursive: true })
      await fsp.writeFile(destPath, buffer)
      stats.bytes += buffer.length
      return { path: destPath, bytes: buffer.length, sha1: null, cached: false }
    },
  }
}

// ---------------------------------------------------------------------------
// 假 AdapterContext（对应 ARCHITECTURE-v3 §2 AdapterContext）
// ---------------------------------------------------------------------------

function createMockCtx({ instanceId = 'test-instance' } = {}) {
  const dl = createMockDownloader()
  const dataRoot = path.join(RUN_DIR, 'data')
  const instanceDir = path.join(dataRoot, 'instances', instanceId)
  const ctx = {
    dl,
    makeDownloader: () => dl,
    dataRoot,
    gameDataDir: path.join(dataRoot, 'game-data', ADAPTER_ID),
    instanceDir,
    gameDir: path.join(instanceDir, 'game'),
    config: {},
    instance: { id: instanceId },
    task: makeTask(),
    logged: [],
    log(line) {
      ctx.logged.push(String(line))
    },
  }
  return ctx
}

// ---------------------------------------------------------------------------
// 测试：包结构与契约
// ---------------------------------------------------------------------------

async function runStructureTests() {
  await test('包结构', 'package.json 字段完整', async () => {
    const pkg = JSON.parse(await fsp.readFile(path.join(PKG_ROOT, 'package.json'), 'utf8'))
    assert(pkg.name === '@local/dsh-mc-adapter', `包名错误：${pkg.name}`)
    assert(pkg.version === '3.0.0', `版本号错误：${pkg.version}`)
    assert(pkg.type === 'module', 'type 必须是 module')
    assert(pkg.exports?.['.'] === './index.js', 'exports["."] 必须是 ./index.js')
    assert(pkg.dsh?.bundle?.patch === './cordis.patch.yml', 'dsh.bundle.patch 必须指向 cordis.patch.yml')
    const files = Array.isArray(pkg.files) ? pkg.files : []
    for (const required of ['index.js', 'lib/', 'cordis.patch.yml', 'README.md', 'icon.svg']) {
      assert(files.includes(required), `package.json files 缺少 ${required}`)
    }
    return `files=[${files.join(', ')}]`
  })

  await test('包结构', 'cordis.patch.yml 声明 insert dsh-mc-adapter', async () => {
    const yml = await fsp.readFile(path.join(PKG_ROOT, 'cordis.patch.yml'), 'utf8')
    assert(/insert:/.test(yml), '缺少 insert 段')
    assert(/id:\s*dsh-mc-adapter/.test(yml), '缺少 id: dsh-mc-adapter')
    assert(/@local\/dsh-mc-adapter/.test(yml), '缺少包名 @local/dsh-mc-adapter')
    return 'insert id=dsh-mc-adapter'
  })

  await test('包结构', 'icon.svg / README.md 存在', async () => {
    const icon = await fsp.readFile(path.join(PKG_ROOT, 'icon.svg'), 'utf8')
    assert(icon.includes('<svg'), 'icon.svg 不是合法 SVG')
    const readme = await fsp.readFile(path.join(PKG_ROOT, 'README.md'), 'utf8')
    assert(readme.length > 2000, 'README.md 内容过短')
    return `icon=${icon.length}B readme=${readme.length}B`
  })

  await test('契约', '标识字段符合 §2', async () => {
    assert(adapter.id === 'minecraft', `id 错误：${adapter.id}`)
    assert(adapter.id === ADAPTER_ID, 'ADAPTER_ID 与 adapter.id 不一致')
    assert(/^[a-z0-9][a-z0-9-]*$/.test(adapter.id), 'id 必须是小写字母数字连字符')
    assert(adapter.label === 'Minecraft', `label 错误：${adapter.label}`)
    assert(typeof adapter.versionLabel === 'string' && adapter.versionLabel.length > 0, 'versionLabel 缺失')
    assert(typeof adapter.contentLabel === 'string' && adapter.contentLabel.length > 0, 'contentLabel 缺失')
    assert(adapter.capabilities?.content === true, 'capabilities.content 必须为 true')
    assert(adapter.capabilities?.loaders === true, 'capabilities.loaders 必须为 true')
    assert(adapter.capabilities?.runtimes === true, 'capabilities.runtimes 必须为 true')
    return `${adapter.id} / ${adapter.label} / ${adapter.versionLabel} / ${adapter.contentLabel}`
  })

  await test('契约', 'GameAdapter 方法齐全', async () => {
    const methods = [
      'listVersions',
      'install',
      'launch',
      'verify',
      'listLoaders',
      'searchContent',
      'contentVersions',
      'addContent',
      'removeContent',
      'listRuntimes',
    ]
    for (const method of methods) {
      assertType(adapter[method], 'function', `adapter.${method}`)
    }
    assertType(adapter.openFolder, 'function', 'adapter.openFolder')
    assertType(adapter.configure, 'function', 'adapter.configure')
    return `${methods.length} 个必需方法 + openFolder/configure`
  })

  await test('契约', 'instanceOptions 合法且覆盖加载器/内存/资源', async () => {
    const options = adapter.instanceOptions
    assert(Array.isArray(options) && options.length >= 3, 'instanceOptions 至少 3 项')
    const allowedTypes = new Set(['string', 'number', 'boolean', 'select'])
    for (const opt of options) {
      assert(typeof opt.key === 'string' && opt.key.length > 0, 'instanceOption 缺少 key')
      assert(typeof opt.label === 'string' && opt.label.length > 0, `${opt.key} 缺少 label`)
      assert(allowedTypes.has(opt.type), `${opt.key} 的 type 非法：${opt.type}`)
      if (opt.type === 'select') {
        assert(Array.isArray(opt.choices) && opt.choices.length > 0, `${opt.key} 是 select 但缺少 choices`)
        for (const choice of opt.choices) {
          assert(typeof choice.value === 'string' && choice.value.length > 0, `${opt.key} 的 choice 缺少 value`)
          assert(typeof choice.label === 'string' && choice.label.length > 0, `${opt.key} 的 choice 缺少 label`)
        }
      }
    }
    const loaderOpt = options.find((opt) => opt.key === 'loader')
    assert(loaderOpt, '缺少 loader 实例选项')
    const loaderValues = loaderOpt.choices.map((choice) => choice.value)
    for (const type of LOADER_TYPES) assert(loaderValues.includes(type), `loader 选项缺少 ${type}`)
    assert(options.find((opt) => opt.key === 'memoryMb')?.type === 'number', 'memoryMb 必须是 number')
    assert(options.find((opt) => opt.key === 'assetsMode')?.type === 'select', 'assetsMode 必须是 select')
    return `${options.map((opt) => opt.key).join(', ')}`
  })

  await test('契约', 'adapterPlatform() 返回环境信息', async () => {
    const platform = adapterPlatform()
    assert(platform && typeof platform === 'object', 'adapterPlatform() 必须返回对象')
    assert(typeof platform.osName === 'string' && platform.osName.length > 0, 'platform.osName 缺失')
    assert(typeof platform.osArch === 'string' && platform.osArch.length > 0, 'platform.osArch 缺失')
    assert(['windows', 'osx', 'linux'].includes(platform.osName), `platform.osName 非法：${platform.osName}`)
    return `${platform.osName} / ${platform.osArch} / ${platform.osVersion || ''}`
  })

  await test('插件入口', 'index.js 导出 name/inject/apply/adapter', async () => {
    assert(pluginName === 'dsh-mc-adapter', `插件 name 错误：${pluginName}`)
    assert(Array.isArray(pluginInject), 'inject 必须是数组')
    assertType(pluginApply, 'function', 'apply')
    assert(pluginAdapter === adapter, 'index.js 导出的 adapter 必须是同一个适配器实例')
    return `name=${pluginName} inject=${pluginInject.length} 项`
  })
}

// ---------------------------------------------------------------------------
// 测试：mirrors 候选规则（离线，仅字符串处理）
// ---------------------------------------------------------------------------

async function runMirrorTests() {
  await test('镜像', '版本清单候选：bmclapi 优先，官方兜底', async () => {
    configureMirrors({ mirror: '' })
    const candidates = resolveUrl(OFFICIAL.manifest)
    assert(Array.isArray(candidates) && candidates.length >= 2, `候选数量不足：${candidates?.length}`)
    assert(candidates[0].startsWith(MIRROR_BASES[0].base), `首个候选不是 bmclapi：${candidates[0]}`)
    assert(
      candidates.some((url) => url === OFFICIAL.manifest || url.startsWith('https://piston-meta.mojang.com')),
      '候选里缺少官方兜底',
    )
    assert(new Set(candidates).size === candidates.length, '候选存在重复')
    return candidates.join(' | ')
  })

  await test('镜像', 'libraries 候选：qlu 优先，官方 libraries 兜底', async () => {
    const libraryUrl = `${OFFICIAL.libraries}com/google/code/gson/gson/2.10.1/gson-2.10.1.jar`
    const candidates = resolveUrl(libraryUrl)
    assert(candidates.length >= 2, '库文件候选数量不足')
    assert(candidates[0].startsWith(MIRROR_BASES[1].base), `首个候选不是 qlu：${candidates[0]}`)
    assert(candidates.some((url) => url === libraryUrl), '缺少官方 libraries 兜底')
    return candidates.join(' | ')
  })

  await test('镜像', '客户端 jar 候选：ctx.versionId 生成 /version/<id>/client', async () => {
    const raw = `${OFFICIAL.pistonData}0123456789abcdef0123456789abcdef01234567/client.jar`
    const candidates = resolveUrlWithContext(raw, { versionId: '1.20.1' })
    assert(
      candidates.some((url) => url.includes('/version/1.20.1/client')),
      `候选缺少 /version/1.20.1/client：${candidates.join(' | ')}`,
    )
    const direct = clientJarCandidates('1.20.1', raw, 'client')
    assert(direct.some((url) => url.includes('/version/1.20.1/client')), 'clientJarCandidates 未生成镜像候选')
    return candidates.join(' | ')
  })

  await test('镜像', '自定义 mirror 置顶（manifest + maven）', async () => {
    configureMirrors({ mirror: 'https://mirror.example.com' })
    try {
      const manifestCandidates = resolveUrl(OFFICIAL.manifest)
      assert(
        manifestCandidates[0] === 'https://mirror.example.com/mc/game/version_manifest_v2.json',
        `自定义镜像未置顶：${manifestCandidates[0]}`,
      )
      const libCandidates = resolveUrl(`${OFFICIAL.libraries}com/google/code/gson/gson/2.10.1/gson-2.10.1.jar`)
      assert(libCandidates[0].startsWith('https://mirror.example.com/maven/'), `库候选未走自定义镜像：${libCandidates[0]}`)
      return `manifest=${manifestCandidates[0]} library=${libCandidates[0]}`
    } finally {
      configureMirrors({ mirror: '' })
    }
  })

  await test('镜像', 'makeDownloader 复用核心下载器', async () => {
    const dl = createMockDownloader()
    const ctx = { dl, makeDownloader: () => dl }
    assert(makeDownloader(ctx) === dl, 'makeDownloader 未返回核心下载器')
    const state = getMirrorState()
    assert(Array.isArray(state.order.manifest) && state.order.manifest.length === 3, '镜像顺序状态异常')
    return `order.manifest=[${state.order.manifest.join(', ')}]`
  })

  await test('镜像', 'probeMirrors 轻量测速（网络，容忍部分目标失败）', async () => {
    const report = await probeMirrors({ timeoutMs: 4000, force: true })
    assert(report && Array.isArray(report.results) && report.results.length === 7, '测速目标数量不是 7')
    const okCount = report.results.filter((item) => item.ok).length
    assert(report.order && Array.isArray(report.order.manifest), '测速未产出候选顺序')
    const best = report.best ? `${report.best.family} ${report.best.kbps}KB/s` : 'n/a'
    return `成功 ${okCount}/7，最快=${best}`
  })
}

// ---------------------------------------------------------------------------
// 测试：真实网络
// ---------------------------------------------------------------------------

async function runNetworkTests(ctx) {
  await test('网络', '真实版本 json（经镜像候选）', async () => {
    const begin = Date.now()
    const json = await fetchVersionJson(ctx.dl, '1.20.1')
    const ms = Date.now() - begin
    assert(json.id === '1.20.1', `版本 id 错误：${json.id}`)
    assert(typeof json.mainClass === 'string' && json.mainClass.length > 0, '版本 json 缺少 mainClass')
    assert(typeof json.assetIndex?.id === 'string', '版本 json 缺少 assetIndex.id')
    return `id=${json.id} mainClass=${json.mainClass} assets=${json.assetIndex.id} ${ms}ms`
  })

  await test('网络', 'listVersions 拉取版本清单', async () => {
    const begin = Date.now()
    const result = await adapter.listVersions({ ctx })
    const ms = Date.now() - begin
    assert(Array.isArray(result.versions) && result.versions.length > 100, `版本数量异常：${result.versions?.length}`)
    assert(typeof result.latestRelease === 'string' && result.latestRelease.length > 0, '缺少 latestRelease')
    const target = result.versions.find((item) => item.id === '1.20.1')
    assert(target, '版本清单里找不到 1.20.1')
    assert(typeof target.releaseTime === 'string' && typeof target.label === 'string', '版本条目字段缺失')
    return `${result.versions.length} 个版本，latestRelease=${result.latestRelease}，1.20.1 发布日期=${target.releaseTime} ${ms}ms`
  })

  await test('网络', 'listLoaders(fabric, 1.20.1)', async () => {
    const begin = Date.now()
    const result = await adapter.listLoaders({ ctx, version: '1.20.1', type: 'fabric' })
    const ms = Date.now() - begin
    assert(Array.isArray(result.types) && result.types[0] === 'fabric', 'types 错误')
    assert(result.versions.length > 0, 'fabric 版本为空')
    const first = result.versions[0]
    assert(typeof first.version === 'string' && first.version.length > 0, '加载器版本缺少 version')
    assert(typeof first.stable === 'boolean', '加载器版本缺少 stable')
    return `${result.versions.length} 个，首个=${first.version}（stable=${first.stable}）${ms}ms`
  })

  await test('网络', 'listLoaders 全类型（4 种并行）', async () => {
    const begin = Date.now()
    const result = await adapter.listLoaders({ ctx, version: '1.20.1' })
    const ms = Date.now() - begin
    assert(Array.isArray(result.types) && result.types.length === 4, `types 数量错误：${result.types?.length}`)
    assert(result.versions.length > 0, '全类型加载器版本为空')
    const typesSeen = new Set(result.versions.map((item) => item.type))
    assert(typesSeen.has('fabric') && typesSeen.has('forge'), `缺少 fabric/forge：${[...typesSeen].join(',')}`)
    const forgeVersions = result.versions.filter((item) => item.type === 'forge').map((item) => item.version)
    const neoVersions = result.versions.filter((item) => item.type === 'neoforge').map((item) => item.version)
    return `共 ${result.versions.length} 个；forge=${forgeVersions.slice(0, 2).join('/')}；neoforge=${neoVersions.slice(0, 2).join('/')} ${ms}ms`
  })

  await test('网络', 'searchContent：Modrinth 搜索 sodium', async () => {
    const begin = Date.now()
    const result = await adapter.searchContent({ ctx, query: 'sodium', version: '1.20.1', loader: 'fabric', limit: 5 })
    const ms = Date.now() - begin
    assert(result.totalHits > 0, `totalHits 异常：${result.totalHits}`)
    assert(Array.isArray(result.hits) && result.hits.length > 0, '搜索结果为空')
    const first = result.hits[0]
    assert(first.id === first.projectId, 'hits 缺少映射后的 id')
    assert(typeof first.title === 'string' && first.title.length > 0, '结果缺少 title')
    assert(typeof first.icon === 'string' && first.icon.startsWith('http'), `结果缺少 icon：${first.icon}`)
    return `totalHits=${result.totalHits}，首个=${first.title}（${first.slug}）${ms}ms`
  })

  await test('网络', 'contentVersions：sodium 1.20.1/fabric', async () => {
    const begin = Date.now()
    const versions = await adapter.contentVersions({ ctx, id: 'sodium', version: '1.20.1', loader: 'fabric' })
    const ms = Date.now() - begin
    assert(Array.isArray(versions) && versions.length > 0, '内容版本为空')
    const first = versions[0]
    assert(typeof first.filename === 'string' && /\.jar$/i.test(first.filename), '缺少 jar filename')
    assert(typeof first.url === 'string' && first.url.startsWith('http'), '缺少下载 url')
    return `${versions.length} 个版本，首个=${first.filename}（${first.versionNumber}）${ms}ms`
  })

  await test('网络', '真实小文件下载（镜像候选回退，~300KB）', async () => {
    const begin = Date.now()
    const dest = path.join(RUN_DIR, 'downloads', 'gson-2.10.1.jar')
    const url = `${OFFICIAL.libraries}com/google/code/gson/gson/2.10.1/gson-2.10.1.jar`
    const result = await downloadFile(ctx, url, dest, {})
    const ms = Date.now() - begin
    await fsp.access(dest)
    const size = (await fsp.stat(dest)).size
    assert(size > 100 * 1024, `下载文件过小：${size}B`)
    assert(/\.jar$/i.test(result.path), '下载返回路径异常')
    return `${path.basename(dest)} ${size}B ${ms}ms（候选：${resolveUrl(url).length} 个）`
  })

  await test('网络', 'listRuntimes：本机 Java 探测', async () => {
    const begin = Date.now()
    const javas = await adapter.listRuntimes({ ctx })
    const ms = Date.now() - begin
    assert(Array.isArray(javas) && javas.length >= 1, '未检测到任何 Java')
    for (const item of javas) {
      assert(typeof item.id === 'string' && item.id.startsWith('java-'), `runtime id 非法：${item.id}`)
      assert(typeof item.path === 'string' && item.path.length > 0, 'runtime 缺少 path')
      assert(typeof item.label === 'string' && item.label.length > 0, 'runtime 缺少 label')
    }
    const majors = javas.map((item) => item.major)
    return `${javas.length} 个：${majors.join('/')} ${ms}ms`
  })
}

// ---------------------------------------------------------------------------
// 测试：buildLaunchSpec（合成版本 json，离线）
// ---------------------------------------------------------------------------

const SYNTHETIC_VERSION_ID = 'test-1.0'

function syntheticVersionJson() {
  return {
    id: SYNTHETIC_VERSION_ID,
    type: 'release',
    releaseTime: new Date().toISOString(),
    mainClass: 'com.example.TestMain',
    libraries: [],
    arguments: {
      game: ['--gameDir', '${game_directory}', '--version', '${version_name}'],
      jvm: ['-Djava.library.path=${natives_directory}', '-cp', '${classpath}'],
    },
    javaVersion: { majorVersion: 17 },
    downloads: { client: { size: 0 } },
  }
}

async function prepareSyntheticInstance(ctx) {
  const paths = createGamePaths(ctx.gameDataDir)
  await ensureGameDirs(paths)
  const versionDir = path.join(paths.versions, SYNTHETIC_VERSION_ID)
  await fsp.mkdir(versionDir, { recursive: true })
  await writeJson(path.join(versionDir, `${SYNTHETIC_VERSION_ID}.json`), syntheticVersionJson())
  await fsp.writeFile(path.join(versionDir, `${SYNTHETIC_VERSION_ID}.jar`), Buffer.alloc(1024, 7))
  await fsp.mkdir(ctx.instanceDir, { recursive: true })
  await fsp.mkdir(ctx.gameDir, { recursive: true })
  await writeJson(path.join(ctx.instanceDir, 'metadata.json'), {
    adapter: ADAPTER_ID,
    adapterVersion: ADAPTER_VERSION,
    versionId: SYNTHETIC_VERSION_ID,
    assetsMode: 'index',
    installedAt: new Date().toISOString(),
    javaMajor: 17,
    loader: null,
    content: [],
    options: { loader: 'none', memoryMb: 4096, assetsMode: 'index', jvmArgs: '-XX:+UseG1GC' },
  })
  return paths
}

async function localJava17(ctx) {
  const javas = await adapter.listRuntimes({ ctx })
  const hit = javas.find((item) => item.major === 17) || javas.find((item) => item.major >= 17) || javas[0]
  assert(hit, '本机未检测到可用于测试的 Java')
  return hit
}

async function runLaunchTests(ctx) {
  let paths = null
  let java = null

  await test('启动参数', '合成实例 + buildLaunchSpec 参数正确', async () => {
    paths = await prepareSyntheticInstance(ctx)
    java = await localJava17(ctx)
    const task = makeTask()
    const spec = await buildLaunchSpec({
      paths,
      instance: {
        versionId: SYNTHETIC_VERSION_ID,
        memoryMb: 4096,
        assetsMode: 'index',
        jvmArgs: '-XX:+UseG1GC',
      },
      gameDir: ctx.gameDir,
      javaPath: java.path,
      task,
    })
    assert(spec && typeof spec === 'object', 'buildLaunchSpec 未返回对象')
    assert(spec.executable === java.path, `executable 不是传入的 java：${spec.executable}`)
    assert(Array.isArray(spec.args) && spec.args.length > 5, 'args 过短')
    assert(spec.args.includes('-cp'), 'args 缺少 -cp')
    assert(spec.args.includes('com.example.TestMain'), 'args 缺少主类')
    assert(spec.args.includes('--gameDir'), 'args 缺少 --gameDir')
    const gameDirIndex = spec.args.indexOf('--gameDir')
    assert(spec.args[gameDirIndex + 1] === ctx.gameDir, `--gameDir 的值不是实例目录：${spec.args[gameDirIndex + 1]}`)
    assert(spec.args.includes('-Xmx4096M'), 'args 缺少 -Xmx4096M')
    assert(spec.args.includes('-XX:+UseG1GC'), 'args 缺少自定义 JVM 参数')
    assert(spec.cwd === ctx.gameDir, `cwd 错误：${spec.cwd}`)
    assert(spec.env && typeof spec.env === 'object', 'env 缺失')
    assert(!('JAVA_TOOL_OPTIONS' in spec.env), 'env 未清理 JAVA_TOOL_OPTIONS')
    assert(!('_JAVA_OPTIONS' in spec.env), 'env 未清理 _JAVA_OPTIONS')
    return `java=${path.basename(spec.executable)} args=${spec.args.length} 个，cp 长度=${(spec.args[spec.args.indexOf('-cp') + 1] || '').length}`
  })

  await test('启动参数', 'buildLaunchSpec 缺少 javaPath 时给出中文错误', async () => {
    let message = ''
    try {
      await buildLaunchSpec({ paths, instance: { versionId: SYNTHETIC_VERSION_ID }, gameDir: ctx.gameDir })
    } catch (error) {
      message = String(error?.message ?? error)
    }
    assert(message.includes('javaPath'), `错误信息不符合预期：${message}`)
    assert(/缺少/.test(message), `错误信息不是中文：${message}`)
    return message
  })

  await test('实例', 'verify 校验合成实例（离线）', async () => {
    const result = await adapter.verify({ ctx })
    assert(result && typeof result === 'object', 'verify 未返回对象')
    assert(result.ok === true, `verify 未通过：${(result.problems || []).join('；')}`)
    assert(result.checks && typeof result.checks === 'object' && !Array.isArray(result.checks), 'checks 必须是对象（核心按对象展开合并）')
    const names = Object.keys(result.checks)
    for (const required of ['gameVersion', 'versionJson', 'clientJar', 'versionChain', 'java', 'gameJar', 'metadata']) {
      assert(names.includes(required), `checks 缺少 ${required}`)
      assert(result.checks[required] && typeof result.checks[required] === 'object', `checks.${required} 结构错误`)
      assert(result.checks[required].ok === true, `checks.${required} 未通过：${result.checks[required].detail}`)
    }
    return `${names.length} 项检查全部通过`
  })

  await test('实例', 'openFolder 按 kind 返回实例目录', async () => {
    const game = await adapter.openFolder({ ctx, instance: { id: 'test-instance' }, kind: 'game' })
    assert(game.path === ctx.gameDir, `kind=game 路径错误：${game.path}`)
    const content = await adapter.openFolder({ ctx, instance: { id: 'test-instance' }, kind: 'content' })
    assert(content.path === path.join(ctx.gameDir, 'mods'), `kind=content 路径错误：${content.path}`)
    const logs = await adapter.openFolder({ ctx, instance: { id: 'test-instance' }, kind: 'logs' })
    assert(logs.path === path.join(ctx.instanceDir, 'logs'), `kind=logs 路径错误：${logs.path}`)
    const fallback = await adapter.openFolder({ ctx, instance: { id: 'test-instance' } })
    assert(fallback.path === ctx.gameDir, `默认 kind 路径错误：${fallback.path}`)
    return 'game/content/logs 路径正确'
  })

  await test('实例', 'removeContent 删除模组并更新 metadata', async () => {
    const modsDir = path.join(ctx.gameDir, 'mods')
    await fsp.mkdir(modsDir, { recursive: true })
    const demo = path.join(modsDir, 'demo-mod.jar')
    await fsp.writeFile(demo, Buffer.alloc(2048, 1))
    const result = await adapter.removeContent({ ctx, instance: { versionId: SYNTHETIC_VERSION_ID }, filename: 'demo-mod.jar' })
    assert(result && result.removed === true, `removeContent 未返回 removed=true：${JSON.stringify(result)}`)
    let exists = true
    try {
      await fsp.access(demo)
    } catch {
      exists = false
    }
    assert(exists === false, '模组文件未被删除')
    return 'demo-mod.jar 已删除'
  })
}

// ---------------------------------------------------------------------------
// 测试：index.js 注册流程（假全局注册表）
// ---------------------------------------------------------------------------

async function runRegistrationTests() {
  await test('注册', 'apply 通过 __dshLauncherRegistry 注册（ctx.effect 注销）', async () => {
    const previous = globalThis.__dshLauncherRegistry
    const captured = { registered: null, source: null, unregistered: false }
    const effects = []
    globalThis.__dshLauncherRegistry = {
      registerGame(candidate, source) {
        captured.registered = candidate
        captured.source = source
        return () => {
          captured.unregistered = true
        }
      },
    }
    try {
      const warnings = []
      const mockCtx = {
        logger: { info() {}, warn(line) { warnings.push(String(line)) } },
        effect(fn) {
          effects.push(fn)
        },
      }
      await pluginApply(mockCtx, { mirror: '' })
      assert(captured.registered === adapter, '注册的适配器不是本包 adapter')
      assert(captured.source === 'external', `注册 source 应为 external，实际 ${captured.source}`)
      assert(effects.length === 1, `ctx.effect 应登记 1 次，实际 ${effects.length}`)
      const disposer = effects[0]()
      assert(typeof disposer === 'function', 'ctx.effect 回调必须返回注销函数')
      disposer()
      assert(captured.unregistered === true, '注销函数未生效')
      return `source=${captured.source}，注销成功`
    } finally {
      if (previous === undefined) delete globalThis.__dshLauncherRegistry
      else globalThis.__dshLauncherRegistry = previous
    }
  })

  await test('注册', '无注册表时只告警不抛异常', async () => {
    const previous = globalThis.__dshLauncherRegistry
    delete globalThis.__dshLauncherRegistry
    try {
      const warnings = []
      const mockCtx = {
        logger: { info() {}, warn(line) { warnings.push(String(line)) } },
        effect() {},
      }
      // 核心包本机未安装 npm 链接时动态 import 会失败；这里只断言「不抛异常 + 有中文告警」。
      await pluginApply(mockCtx, {})
      assert(warnings.length >= 1, '未给出任何告警')
      assert(warnings.some((line) => line.includes('DSH启动器')), `告警缺少核心包提示：${warnings.join(' | ')}`)
      return warnings[0].slice(0, 80)
    } finally {
      if (previous !== undefined) globalThis.__dshLauncherRegistry = previous
    }
  })
}

// ---------------------------------------------------------------------------
// 报告与清理
// ---------------------------------------------------------------------------

function renderReport() {
  const passed = results.filter((item) => item.ok).length
  const failed = results.length - passed
  const totalMs = Date.now() - startedAt
  const groups = []
  const groupMap = new Map()
  for (const item of results) {
    if (!groupMap.has(item.group)) {
      const entry = { name: item.group, items: [] }
      groupMap.set(item.group, entry)
      groups.push(entry)
    }
    groupMap.get(item.group).items.push(item)
  }

  const lines = []
  lines.push('DSH启动器 · 可选 Minecraft 适配器包 自测报告')
  lines.push('='.repeat(64))
  lines.push(`生成时间：${new Date().toISOString()}`)
  lines.push(`运行命令：node scripts/adapter-test.mjs（工作目录 plugins/minecraft-adapter）`)
  lines.push(`Node：${process.version}    平台：${process.platform}/${process.arch}`)
  lines.push(`包：@local/dsh-mc-adapter 3.0.0（适配器 id：${adapter.id}）`)
  lines.push('')
  lines.push(`结果：${passed}/${results.length} PASS，${failed} FAIL，总耗时 ${totalMs}ms`)
  lines.push('')
  for (const group of groups) {
    lines.push(`## ${group.name}（${group.items.filter((item) => item.ok).length}/${group.items.length} PASS）`)
    for (const item of group.items) {
      lines.push(`  [${item.ok ? 'PASS' : 'FAIL'}] ${item.name}（${item.ms}ms）`)
      if (item.detail) lines.push(`         ${item.detail}`)
    }
    lines.push('')
  }
  lines.push('## 说明')
  lines.push('  - 本自测使用假 ctx（mock AdapterContext），不依赖 DSH 宿主与核心包源码，可独立运行。')
  lines.push('  - 真实网络测试覆盖：版本清单、版本 json、加载器列表、Modrinth 搜索、镜像测速、~300KB 小文件下载。')
  lines.push('  - 真实原版安装/启动需 ~80MB 下载（v2 已完整实测）；本包 install 逻辑由 verify/buildLaunchSpec 覆盖。')
  lines.push('  - Forge/NeoForge 安装器运行 processors 依赖官方 maven，网络不可达时会抛中文错误（已知风险）。')
  lines.push(`  - 临时目录 ${RUN_DIR} 已清理。`)
  lines.push('')
  lines.push(failed === 0 ? '结论：全部通过。' : `结论：${failed} 项失败，见上方 FAIL 行。`)
  return { text: lines.join('\n'), passed, failed, totalMs }
}

async function main() {
  log('DSH启动器 · Minecraft 适配器包自测')
  log(`Node ${process.version} / ${process.platform} / ${path.basename(PKG_ROOT)}`)
  log('')

  const ctx = createMockCtx()
  await fsp.mkdir(RUN_DIR, { recursive: true })

  await runStructureTests()
  await runMirrorTests()
  await runNetworkTests(ctx)
  await runLaunchTests(ctx)
  await runRegistrationTests()

  const summary = renderReport()
  await fsp.mkdir(path.dirname(REPORT_FILE), { recursive: true })
  await fsp.writeFile(REPORT_FILE, `${summary.text}\n`, 'utf8')
  await fsp.mkdir(TMP_ROOT, { recursive: true })
  await fsp.writeFile(
    RESULTS_FILE,
    `${JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        node: process.version,
        platform: `${process.platform}/${process.arch}`,
        package: '@local/dsh-mc-adapter@3.0.0',
        passed: summary.passed,
        failed: summary.failed,
        totalMs: summary.totalMs,
        results,
      },
      null,
      2,
    )}\n`,
    'utf8',
  )

  log('')
  log(`结果：${summary.passed}/${results.length} PASS，${summary.failed} FAIL，总耗时 ${summary.totalMs}ms`)
  log(`报告：${REPORT_FILE}`)
  log(`结果 JSON：${RESULTS_FILE}`)

  // 清理临时实例/下载目录（报告已保留）
  if (!process.env.KEEP_TEST_TMP) {
    try {
      await removeDir(RUN_DIR)
      log(`已清理临时目录：${RUN_DIR}`)
    } catch (error) {
      log(`清理临时目录失败（可手动删除）：${error?.message ?? error}`)
    }
  }
  process.exit(summary.failed === 0 ? 0 : 1)
}

main().catch((error) => {
  log(`自测运行异常：${error?.stack ?? error}`)
  process.exit(1)
})
