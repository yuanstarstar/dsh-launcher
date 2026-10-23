#!/usr/bin/env node
/**
 * 附属启动器管理模块自测（完全离线，不访问外网）。
 *
 * 覆盖：
 *   1. 版本号 / 资产匹配 / launcher.json 校验等纯函数
 *   2. 本机文件（file）来源安装、清单与加载桥落盘、热加载后游戏出现
 *   3. GitHub 仓库（repo）来源安装 / 检查更新 / 更新（用本地假 GitHub 接口 + 本地 HTTP 服务器提供 zip）
 *   4. 直链（url）来源安装、无下载器时的 fetch 回退
 *   5. 核心版本门槛、重复安装、坏包、缺失参数等错误路径
 *   6. 卸载（删桥 + 删目录 + 删清单 + 热加载后游戏消失）
 *   7. 无 runJob 时的降级路径（同步执行任务体）
 *
 * 运行：node scripts/sublauncher-test.mjs [--keep]
 *   --keep  保留 test/tmp 下的临时目录，便于排查
 */
import fsp from 'node:fs/promises'
import path from 'node:path'
import http from 'node:http'
import crypto from 'node:crypto'
import { fileURLToPath, pathToFileURL } from 'node:url'

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(SCRIPT_DIR, '..')
const CORE_URL = pathToFileURL(path.join(ROOT, 'lib', 'core')).href + '/'
const KEEP = process.argv.includes('--keep')
const STAMP = new Date().toISOString().replace(/[:.]/g, '-')
const TEMP_ROOT = path.join(ROOT, 'test', 'tmp', 'sublauncher-test-' + STAMP)

const { createPaths, ensureDirs, pathExists } = await import(CORE_URL + 'paths.js')
const { createGameStore } = await import(CORE_URL + 'game-store.js')
const { createDownloader } = await import(CORE_URL + 'http.js')
const {
  parseSemver,
  isStrictSemver,
  compareVersion,
  isUpdateAvailable,
  matchAssetPattern,
  selectReleaseAsset,
  validateLauncherManifest,
  createSubLauncherManager,
} = await import(CORE_URL + 'sublaunchers.js')

// ---------------------------------------------------------------------------
// 测试结果统计
// ---------------------------------------------------------------------------

const results = []
let failures = 0

function pass(name, detail) {
  results.push({ name, status: 'PASS', detail: detail ? String(detail) : '' })
  console.log('  [PASS] ' + name + (detail ? ' —— ' + detail : ''))
}

function fail(name, detail) {
  failures += 1
  results.push({ name, status: 'FAIL', detail: detail ? String(detail) : '' })
  console.log('  [FAIL] ' + name + ' —— ' + detail)
}

function check(condition, name, detail) {
  if (condition) pass(name, detail)
  else fail(name, detail || '断言失败')
}

async function expectRejects(fn, pattern, name) {
  try {
    const value = await fn()
    fail(name, '预期抛错，但实际成功：' + JSON.stringify(value).slice(0, 200))
  } catch (error) {
    const message = String((error && error.message) || error)
    if (pattern.test(message)) pass(name, message.slice(0, 120))
    else fail(name, '错误信息不匹配：' + message.slice(0, 200))
  }
}

function section(title) {
  console.log('\n' + title)
}

// ---------------------------------------------------------------------------
// 极简 ZIP 写入（仅 stored，不压缩；测试专用）
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

function crc32(buffer) {
  let c = 0xffffffff
  for (let i = 0; i < buffer.length; i += 1) c = CRC_TABLE[(c ^ buffer[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function buildZip(entries) {
  const locals = []
  const central = []
  let offset = 0
  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, 'utf8')
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data == null ? '' : entry.data)
    const crc = crc32(data)
    const size = data.length
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0, 6)
    local.writeUInt16LE(0, 8)
    local.writeUInt16LE(0, 10)
    local.writeUInt16LE(0, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(size, 18)
    local.writeUInt32LE(size, 22)
    local.writeUInt16LE(nameBuf.length, 26)
    local.writeUInt16LE(0, 28)
    const localRecord = Buffer.concat([local, nameBuf, data])
    const header = Buffer.alloc(46)
    header.writeUInt32LE(0x02014b50, 0)
    header.writeUInt16LE(20, 4)
    header.writeUInt16LE(20, 6)
    header.writeUInt16LE(0, 8)
    header.writeUInt16LE(0, 10)
    header.writeUInt16LE(0, 12)
    header.writeUInt16LE(0, 14)
    header.writeUInt32LE(crc, 16)
    header.writeUInt32LE(size, 20)
    header.writeUInt32LE(size, 24)
    header.writeUInt16LE(nameBuf.length, 28)
    header.writeUInt16LE(0, 30)
    header.writeUInt16LE(0, 32)
    header.writeUInt16LE(0, 34)
    header.writeUInt16LE(0, 36)
    header.writeUInt32LE(0, 38)
    header.writeUInt32LE(offset, 42)
    central.push(Buffer.concat([header, nameBuf]))
    locals.push(localRecord)
    offset += localRecord.length
  }
  const centralBuf = Buffer.concat(central)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(0, 4)
  eocd.writeUInt16LE(0, 6)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(centralBuf.length, 12)
  eocd.writeUInt32LE(offset, 16)
  eocd.writeUInt16LE(0, 20)
  return Buffer.concat([...locals, centralBuf, eocd])
}

function sha1Hex(buffer) {
  return crypto.createHash('sha1').update(buffer).digest('hex')
}

// ---------------------------------------------------------------------------
// 测试包内容
// ---------------------------------------------------------------------------

function adapterSource(adapterId) {
  return `// 演示附属启动器入口（测试包，零外部依赖）
export default function createDemoAdapters() {
  return {
    id: ${JSON.stringify(adapterId)},
    label: '演示游戏',
    versionLabel: '版本',
    contentLabel: '内容',
    capabilities: { content: false, loaders: false, runtimes: false },
    instanceOptions: [],
    async listVersions() {
      return { versions: [{ id: '1.0.0', label: '1.0.0' }], latestRelease: '1.0.0' };
    },
    async install({ version } = {}) {
      return { versionId: version || '1.0.0' };
    },
    async launch() {
      return { executable: 'cmd.exe', args: ['/c', 'exit 0'], cwd: '.' };
    },
  };
}
`
}

function manifestOf(options) {
  return {
    schemaVersion: 1,
    id: options.id,
    label: options.label,
    version: options.version,
    entry: options.entry || 'lib/index.mjs',
    description: options.description || '测试用附属启动器包',
    homepage: options.homepage || 'https://example.invalid/' + options.id,
    ...(options.manifestExtra || {}),
  }
}

function buildPackageZip(options) {
  const manifest = manifestOf(options)
  const entries = [
    { name: 'launcher.json', data: JSON.stringify(manifest, null, 2) },
    { name: options.entry || 'lib/index.mjs', data: adapterSource(options.adapterId) },
    { name: 'assets/marker.txt', data: '附属启动器测试包标记：' + options.id },
  ]
  for (const extra of options.extraEntries || []) entries.push(extra)
  if (options.manifestOverrideText != null) {
    entries[0] = { name: 'launcher.json', data: options.manifestOverrideText }
  }
  return buildZip(entries)
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

const zipDir = path.join(TEMP_ROOT, 'zips')
const dataRoot = path.join(TEMP_ROOT, 'data')
const logs = []
const jobs = []
const serverHits = []
const zipBuffers = new Map()
let jobSequence = 0
let server = null
let serverBase = ''
let downloader = null

function log(line) {
  logs.push(String(line))
}

function fakeFetchJson(url) {
  const target = String(url)
  if (/\/repos\/missing\/missing(\/|$)/.test(target)) {
    const error = new Error('Not Found')
    error.status = 404
    throw error
  }
  if (target.endsWith('/releases/latest')) return Promise.resolve(latestRelease)
  if (/\/repos\/demo\/gh-launcher(\/|$)/.test(target)) {
    return Promise.resolve({ full_name: 'demo/gh-launcher' })
  }
  throw new Error('意外的 GitHub 接口请求：' + target)
}

let latestRelease = null

function makeRelease(version, extraAssets) {
  const fileName = 'gh-launcher-' + version + '.zip'
  const assets = [
    {
      name: fileName,
      browser_download_url: serverBase + '/pkg/' + fileName,
      size: (zipBuffers.get(fileName) || Buffer.alloc(0)).length,
    },
  ]
  for (const asset of extraAssets || []) assets.push(asset)
  return {
    tag_name: 'v' + version,
    name: '演示附属启动器 ' + version,
    assets,
  }
}

function fakeRunJob(kind, title, instanceId, fn) {
  if (typeof instanceId === 'function') {
    fn = instanceId
    instanceId = null
  }
  jobSequence += 1
  const job = {
    id: 'job-' + jobSequence,
    kind,
    title,
    instanceId,
    status: 'queued',
    phase: '排队中',
    progress: {},
    log: [],
  }
  const task = {
    log(line) {
      job.log.push(String(line))
    },
    items(done, total, label) {
      job.progress.done = done
      job.progress.total = total
      job.progress.label = label
    },
    bytes(count) {
      if (Number.isFinite(count) && count > 0) job.progress.bytes = (job.progress.bytes || 0) + count
    },
    setPhase(phase) {
      job.phase = String(phase || '')
    },
    get cancelRequested() {
      return false
    },
  }
  jobs.push(job)
  job.promise = (async () => {
    job.status = 'running'
    try {
      const result = await fn(task)
      job.status = 'succeeded'
      job.result = result
      return result
    } catch (error) {
      job.status = 'failed'
      job.error = error
      throw error
    }
  })()
  job.promise.catch(() => {})
  return job
}

async function startServer() {
  server = http.createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1')
    if (url.pathname === '/health') {
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('ok')
      return
    }
    const name = decodeURIComponent(url.pathname.replace(/^\/pkg\//, ''))
    serverHits.push(name)
    const buffer = zipBuffers.get(name)
    if (!buffer) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('未找到文件：' + name)
      return
    }
    res.writeHead(200, { 'content-type': 'application/zip', 'content-length': buffer.length })
    res.end(buffer)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  serverBase = 'http://127.0.0.1:' + server.address().port
}

async function bootstrapZipFiles() {
  await fsp.mkdir(zipDir, { recursive: true })

  const good = {
    'demo-1.0.0.zip': buildPackageZip({
      id: 'demo-launcher',
      label: '演示启动器',
      version: '1.0.0',
      adapterId: 'demo-game',
    }),
    'plain-1.0.0.zip': buildPackageZip({
      id: 'plain-launcher',
      label: '无任务启动器',
      version: '1.0.0',
      adapterId: 'plain-game',
    }),
    'gh-launcher-1.0.0.zip': buildPackageZip({
      id: 'gh-launcher',
      label: '仓库启动器',
      version: '1.0.0',
      adapterId: 'gh-game',
    }),
    'gh-launcher-1.1.0.zip': buildPackageZip({
      id: 'gh-launcher',
      label: '仓库启动器',
      version: '1.1.0',
      adapterId: 'gh-game',
    }),
    'url-launcher.zip': buildPackageZip({
      id: 'url-launcher',
      label: '直链启动器',
      version: '1.0.0',
      adapterId: 'url-game',
    }),
    'fallback-launcher.zip': buildPackageZip({
      id: 'fallback-launcher',
      label: '回退启动器',
      version: '1.0.0',
      adapterId: 'fallback-game',
    }),
    'future-launcher.zip': buildPackageZip({
      id: 'future-launcher',
      label: '未来启动器',
      version: '1.0.0',
      adapterId: 'future-game',
      manifestExtra: { minCoreVersion: '3.2.1' },
    }),
  }
  for (const [name, buffer] of Object.entries(good)) {
    zipBuffers.set(name, buffer)
    await fsp.writeFile(path.join(zipDir, name), buffer)
  }

  // 坏包（只用于本机文件来源）
  const bad = {
    'missing-manifest.zip': buildZip([{ name: 'lib/index.mjs', data: adapterSource('bad-game') }]),
    'bad-id.zip': buildPackageZip({
      id: 'Demo-Launcher',
      label: '非法 id 启动器',
      version: '1.0.0',
      adapterId: 'bad-game',
    }),
    'entry-missing.zip': buildPackageZip({
      id: 'entry-missing',
      label: '缺入口启动器',
      version: '1.0.0',
      adapterId: 'bad-game',
      entry: 'lib/index.mjs',
      manifestExtra: { entry: 'lib/not-exist.mjs' },
    }),
    'min-core-high.zip': buildPackageZip({
      id: 'min-core-high',
      label: '核心版本过高',
      version: '1.0.0',
      adapterId: 'bad-game',
      manifestExtra: { minCoreVersion: '99.0.0' },
    }),
    'schema2.zip': buildPackageZip({
      id: 'schema2-launcher',
      label: '清单版本过新',
      version: '1.0.0',
      adapterId: 'bad-game',
      manifestExtra: { schemaVersion: 2 },
    }),
    'wrapped.zip': buildZip([
      { name: 'wrapped/launcher.json', data: '{}' },
      { name: 'wrapped/lib/index.mjs', data: adapterSource('bad-game') },
    ]),
    'forbidden.zip': buildPackageZip({
      id: 'forbidden-launcher',
      label: '含禁用目录',
      version: '1.0.0',
      adapterId: 'bad-game',
      extraEntries: [{ name: 'data/save.dat', data: 'x' }],
    }),
    'not-zip.zip': Buffer.from('这不是一个 zip 文件，只是一段普通文本。', 'utf8'),
  }
  for (const [name, buffer] of Object.entries(bad)) {
    await fsp.writeFile(path.join(zipDir, name), buffer)
  }

  // 超过 25MB 上限的包（内容不重要，安装前会先看体积）
  const oversized = Buffer.alloc(25 * 1024 * 1024 + 4096, 0)
  await fsp.writeFile(path.join(zipDir, 'oversized.zip'), oversized)
}

function zipFile(name) {
  return path.join(zipDir, name)
}

function bridgeFileOf(launcherId) {
  return path.join(dataRoot, 'adapters', 'sublauncher-' + launcherId + '.mjs')
}

function launcherDirOf(launcherId, version) {
  return path.join(dataRoot, 'sub-launchers', launcherId, version)
}

async function readRegistry() {
  const file = path.join(dataRoot, 'sub-launchers', 'registry.json')
  if (!(await pathExists(file))) return null
  return JSON.parse(await fsp.readFile(file, 'utf8'))
}

function findGame(gameId) {
  try {
    return (store.list() || []).find((item) => item.id === gameId) || null
  } catch {
    return null
  }
}

let store = null
let manager = null

async function main() {
  console.log('附属启动器管理模块自测')
  console.log('临时目录：' + TEMP_ROOT)

  // -------------------------------------------------------------------------
  section('① 纯函数：版本号 / 资产匹配 / launcher.json 校验')
  // -------------------------------------------------------------------------

  const parsed = parseSemver('v1.2.3-beta.1')
  check(parsed && parsed.major === 1 && parsed.minor === 2 && parsed.patch === 3, 'parseSemver 解析 v 前缀')
  check(Array.isArray(parsed && parsed.prerelease) && parsed.prerelease.join('.') === 'beta.1', 'parseSemver 解析预发布段')
  check(parseSemver('not-a-version') === null, 'parseSemver 非法值返回 null')
  check(parseSemver('1.2') === null, 'parseSemver 缺少 patch 返回 null')
  check(isStrictSemver('1.0.0') === true, 'isStrictSemver 接受 1.0.0')
  check(isStrictSemver('v1.0.0') === false, 'isStrictSemver 拒绝 v 前缀')
  check(isStrictSemver('1.0.0+build.5') === true, 'isStrictSemver 接受 +build 元数据')

  check(compareVersion('1.0.0', '1.0.1') < 0, 'compareVersion 补丁号比较')
  check(compareVersion('2.0.0', '1.9.9') > 0, 'compareVersion 主版本比较')
  check(compareVersion('1.0.0', '1.0.0') === 0, 'compareVersion 相等')
  check(compareVersion('1.0.0-alpha', '1.0.0') < 0, 'compareVersion 预发布小于正式版')
  check(compareVersion('1.0.0-alpha.1', '1.0.0-alpha.2') < 0, 'compareVersion 预发布数字段比较')
  check(compareVersion('1.0.0-alpha', '1.0.0-beta') < 0, 'compareVersion 预发布字母段比较')
  await expectRejects(async () => compareVersion('abc', '1.0.0'), /无法比较版本号/, 'compareVersion 非法输入报错')
  check(isUpdateAvailable('1.0.0', '1.1.0') === true, 'isUpdateAvailable 新版本')
  check(isUpdateAvailable('1.1.0', '1.1.0') === false, 'isUpdateAvailable 同版本')

  check(matchAssetPattern('gh-launcher-1.0.0.zip', '*launcher*.zip') === true, 'matchAssetPattern 通配符命中')
  check(matchAssetPattern('gh-launcher-1.0.0.zip', '*.zip') === true, 'matchAssetPattern 后缀命中')
  check(matchAssetPattern('gh-launcher-1.0.0.zip', '*.tar.gz') === false, 'matchAssetPattern 不命中')
  check(matchAssetPattern('GH-Launcher.ZIP', '*.zip') === true, 'matchAssetPattern 忽略大小写')
  check(matchAssetPattern('anything.zip', '') === true, 'matchAssetPattern 空模式全匹配')

  const releaseFixture = {
    assets: [
      { name: 'notes.txt', browser_download_url: 'https://example.invalid/notes.txt' },
      { name: 'pkg-1.0.0.zip', browser_download_url: 'https://example.invalid/pkg-1.0.0.zip' },
      { name: 'pkg-1.0.0-src.zip', browser_download_url: 'https://example.invalid/pkg-1.0.0-src.zip' },
    ],
  }
  const picked = selectReleaseAsset(releaseFixture)
  check(picked && picked.name === 'pkg-1.0.0.zip', 'selectReleaseAsset 默认取第一个 zip')
  const pickedByPattern = selectReleaseAsset(releaseFixture, '*src.zip')
  check(pickedByPattern && pickedByPattern.name === 'pkg-1.0.0-src.zip', 'selectReleaseAsset 按 assetPattern 选资产')
  await expectRejects(
    async () => selectReleaseAsset({ assets: [{ name: 'a.txt', browser_download_url: 'https://x/a.txt' }] }),
    /没有 zip 资产/,
    'selectReleaseAsset 无 zip 报错',
  )

  const validManifest = {
    schemaVersion: 1,
    id: 'demo-launcher',
    label: '演示启动器',
    version: '1.0.0',
    entry: 'lib/index.mjs',
    minCoreVersion: '3.0.0',
  }
  const normalizedManifest = validateLauncherManifest(validManifest, { coreVersion: '3.2.0' })
  check(normalizedManifest.id === 'demo-launcher' && normalizedManifest.entry === 'lib/index.mjs', 'validateLauncherManifest 正常清单')
  await expectRejects(
    async () => validateLauncherManifest({ ...validManifest, schemaVersion: 2 }),
    /不支持的 launcher\.json 版本/,
    'validateLauncherManifest 拒绝 schemaVersion=2',
  )
  await expectRejects(
    async () => validateLauncherManifest({ ...validManifest, id: 'Demo' }),
    /id 无效/,
    'validateLauncherManifest 拒绝非法 id',
  )
  await expectRejects(
    async () => validateLauncherManifest({ ...validManifest, label: '' }),
    /缺少 label/,
    'validateLauncherManifest 要求 label',
  )
  await expectRejects(
    async () => validateLauncherManifest({ ...validManifest, version: '1.0' }),
    /version 不是合法 semver/,
    'validateLauncherManifest 要求 semver 版本',
  )
  await expectRejects(
    async () => validateLauncherManifest({ ...validManifest, entry: '/abs/index.mjs' }),
    /必须是包内相对路径/,
    'validateLauncherManifest 拒绝绝对 entry',
  )
  await expectRejects(
    async () => validateLauncherManifest({ ...validManifest, entry: '../index.mjs' }),
    /不能包含 \.\/ 或 \.\.\//,
    'validateLauncherManifest 拒绝 ../ entry',
  )
  await expectRejects(
    async () => validateLauncherManifest({ ...validManifest, minCoreVersion: '9.0.0' }, { coreVersion: '3.2.0' }),
    /需要核心版本 >= 9\.0\.0/,
    'validateLauncherManifest 核心版本门槛',
  )
  const fileMap = new Map([
    ['launcher.json', { name: 'launcher.json' }],
    ['lib/index.mjs', { name: 'lib/index.mjs' }],
  ])
  await expectRejects(
    async () => validateLauncherManifest({ ...validManifest, entry: 'lib/nope.mjs' }, { coreVersion: '3.2.0', files: fileMap }),
    /entry 不存在于包内/,
    'validateLauncherManifest 校验 entry 存在',
  )

  // -------------------------------------------------------------------------
  section('② 初始化：临时数据目录 / 本地 HTTP 服务器 / 下载器 / 游戏仓库')
  // -------------------------------------------------------------------------

  await fsp.mkdir(TEMP_ROOT, { recursive: true })
  await bootstrapZipFiles()
  await startServer()

  const realPaths = createPaths(dataRoot)
  await ensureDirs(realPaths)
  check(await pathExists(realPaths.adapters), 'ensureDirs 创建 adapters 目录')
  check(await pathExists(realPaths.subLaunchers), 'ensureDirs 创建 sub-launchers 目录')

  downloader = createDownloader({ concurrency: 4, retries: 2, logger: log })
  store = createGameStore({ paths: realPaths, dl: downloader, logger: log })
  await store.loadAll()
  check((store.list() || []).length === 0, '初始游戏列表为空')

  manager = createSubLauncherManager({
    paths: realPaths,
    dl: downloader,
    logger: log,
    runJob: fakeRunJob,
    reloadGames: async () => {
      await store.loadAll({ force: true })
      return store.list()
    },
    coreVersion: '3.2.0',
    fetchJson: fakeFetchJson,
  })

  // -------------------------------------------------------------------------
  section('③ 本机文件（file）来源安装 + 清单/加载桥落盘 + 热加载')
  // -------------------------------------------------------------------------

  const startedFile = Date.now()
  const installed = await manager.install({ file: zipFile('demo-1.0.0.zip') })
  check(installed.id === 'demo-launcher', 'file 来源安装返回 id', installed.id)
  check(installed.version === '1.0.0', 'file 来源安装返回 version', installed.version)
  check(
    path.resolve(installed.dir) === path.resolve(launcherDirOf('demo-launcher', '1.0.0')),
    '安装目录为 sub-launchers/<id>/<version>',
    installed.dir,
  )
  check(typeof installed.jobId === 'string' && installed.jobId === jobs[0].id, '安装返回 jobId', installed.jobId)
  check(jobs[0].kind === 'sublauncher-install', '任务 kind 为 sublauncher-install', jobs[0].kind)
  check(jobs[0].status === 'succeeded', '安装任务状态 succeeded', jobs[0].status)
  check(jobs[0].log.some((line) => line.includes('包校验通过')), '任务日志含包校验通过')
  check(jobs[0].log.some((line) => line.includes('已注册附属启动器')), '任务日志含注册完成')
  check(jobs[0].phase === '完成', '任务最终阶段为完成', jobs[0].phase)
  check(Date.now() - startedFile < 30000, '本机文件安装耗时合理', Date.now() - startedFile + 'ms')

  check(await pathExists(path.join(installed.dir, 'launcher.json')), '解压后 launcher.json 存在')
  check(await pathExists(path.join(installed.dir, 'lib', 'index.mjs')), '解压后入口模块存在')
  const markerText = await fsp.readFile(path.join(installed.dir, 'assets', 'marker.txt'), 'utf8')
  check(markerText.includes('附属启动器测试包标记：demo-launcher'), '解压后文件内容正确')

  const registryAfterInstall = await readRegistry()
  check(registryAfterInstall && registryAfterInstall.schemaVersion === 1, 'registry.json schemaVersion=1')
  const registryEntry = (registryAfterInstall.launchers || []).find((item) => item.id === 'demo-launcher')
  check(Boolean(registryEntry), 'registry.json 含安装条目')
  check(registryEntry && registryEntry.version === '1.0.0', 'registry.json 版本正确', registryEntry && registryEntry.version)
  check(registryEntry && registryEntry.source === 'file', 'registry.json 记录来源 file')
  check(registryEntry && registryEntry.entry === 'lib/index.mjs', 'registry.json 记录 entry 相对路径')
  check(
    Boolean(registryEntry && registryEntry.installedAt && registryEntry.updatedAt),
    'registry.json 记录安装/更新时间',
  )

  const bridge = await fsp.readFile(bridgeFileOf('demo-launcher'), 'utf8')
  check(bridge.includes('export default async function createSubLauncherAdapters'), '加载桥导出工厂函数')
  check(bridge.includes('lib/index.mjs'), '加载桥指向包内入口模块')
  check(bridge.includes('__subLauncherId'), '加载桥为适配器打归属标记')

  const demoGame = findGame('demo-game')
  check(Boolean(demoGame), '热加载后游戏出现在游戏仓库', demoGame && demoGame.label)
  check(demoGame && demoGame.source === 'external', '热加载的游戏来源为 external')

  const listAfterInstall = await manager.list()
  const listed = listAfterInstall.find((item) => item.id === 'demo-launcher')
  check(Boolean(listed), 'manager.list 返回已安装条目')
  check(
    listed &&
      listed.games.includes('demo-game') &&
      listed.source === 'file' &&
      path.resolve(listed.dir) === path.resolve(installed.dir),
    'manager.list 条目字段完整（games/source/dir）',
  )

  // -------------------------------------------------------------------------
  section('④ 错误路径：重复安装 / 坏包 / 缺失参数')
  // -------------------------------------------------------------------------

  await expectRejects(
    async () => manager.install({ file: zipFile('demo-1.0.0.zip') }),
    /附属启动器已存在：demo-launcher/,
    '重复安装同一 id 报错',
  )
  await expectRejects(
    async () => manager.install({ file: zipFile('missing-manifest.zip') }),
    /缺少 launcher\.json/,
    '缺少 launcher.json 报错',
  )
  await expectRejects(
    async () => manager.install({ file: zipFile('wrapped.zip') }),
    /缺少 launcher\.json/,
    '外层多套一层目录报错',
  )
  await expectRejects(
    async () => manager.install({ file: zipFile('bad-id.zip') }),
    /id 无效/,
    '非法 id 包报错',
  )
  await expectRejects(
    async () => manager.install({ file: zipFile('entry-missing.zip') }),
    /entry 不存在于包内/,
    '入口不存在报错',
  )
  await expectRejects(
    async () => manager.install({ file: zipFile('min-core-high.zip') }),
    /需要核心版本 >= 99\.0\.0/,
    'minCoreVersion 过高报错',
  )
  await expectRejects(
    async () => manager.install({ file: zipFile('schema2.zip') }),
    /不支持的 launcher\.json 版本/,
    'schemaVersion=2 报错',
  )
  await expectRejects(
    async () => manager.install({ file: zipFile('forbidden.zip') }),
    /不允许的路径/,
    '含 data/ 等禁用目录报错',
  )
  await expectRejects(
    async () => manager.install({ file: zipFile('not-zip.zip') }),
    /不是有效的 zip/,
    '非 zip 文件报错',
  )
  await expectRejects(
    async () => manager.install({ file: zipFile('oversized.zip') }),
    /包过大/,
    '超过 25MB 的包报错',
  )
  await expectRejects(
    async () => manager.install({ file: zipFile('does-not-exist.zip') }),
    /本机文件不存在/,
    '本机文件不存在报错',
  )
  await expectRejects(async () => manager.install({}), /缺少安装来源/, '缺少安装来源报错')
  await expectRejects(
    async () => manager.install({ url: 'ftp://example.invalid/pkg.zip' }),
    /只支持 http\/https/,
    '非 http/https 直链报错',
  )
  await expectRejects(
    async () => manager.install({ file: zipFile('demo-1.0.0.zip'), assetPattern: '*.zip' }),
    /assetPattern 只能配合 GitHub 仓库/,
    'assetPattern 缺少 repo 报错',
  )
  await expectRejects(async () => manager.check('demo-launcher'), /不是从 GitHub 仓库安装的/, '本机来源检查更新报错')
  await expectRejects(async () => manager.update('demo-launcher'), /不是从 GitHub 仓库安装的/, '本机来源更新报错')
  await expectRejects(async () => manager.check('missing-launcher'), /附属启动器不存在/, '检查不存在的附属启动器报错')
  await expectRejects(async () => manager.remove('missing-launcher'), /附属启动器不存在/, '卸载不存在的附属启动器报错')

  // 坏包不应留下加载桥或清单条目
  check(!(await pathExists(bridgeFileOf('bad-id'))), '坏包未写入加载桥')
  const registryAfterBad = await readRegistry()
  check((registryAfterBad.launchers || []).length === 1, '坏包未写入安装清单')

  // -------------------------------------------------------------------------
  section('⑤ GitHub 仓库（repo）来源：安装 / 检查更新 / 更新')
  // -------------------------------------------------------------------------

  latestRelease = makeRelease('1.0.0')
  await expectRejects(
    async () => manager.install({ repo: 'demo/gh-launcher', assetPattern: '*.tar.gz' }),
    /没有匹配 assetPattern 的 zip 资产/,
    'assetPattern 未命中报错',
  )
  // GitHub 404 映射用本地 fetch 桩，避免真实网络波动影响离线自测。
  {
    const realFetch = globalThis.fetch
    globalThis.fetch = async () => ({ ok: false, status: 404, url: '', text: async () => 'not found' })
    try {
      await expectRejects(
        async () => manager.install({ repo: 'missing/missing' }),
        /仓库不存在或没有 Release/,
        'GitHub 404 错误映射为中文',
      )
    } finally {
      globalThis.fetch = realFetch
    }
  }
  latestRelease = {
    tag_name: 'v1.0.0',
    name: '只有说明文件',
    assets: [{ name: 'readme.txt', browser_download_url: serverBase + '/pkg/readme.txt' }],
  }
  await expectRejects(async () => manager.install({ repo: 'demo/gh-launcher' }), /没有 zip 资产/, 'Release 无 zip 资产报错')

  latestRelease = makeRelease('1.0.0')
  const installedGithub = await manager.install({ repo: 'demo/gh-launcher' })
  check(installedGithub.id === 'gh-launcher' && installedGithub.version === '1.0.0', 'repo 来源安装成功', installedGithub.version)
  check(serverHits.includes('gh-launcher-1.0.0.zip'), 'repo 来源经由下载器下载 zip')
  const ghRegistry = await readRegistry()
  const ghEntry = (ghRegistry.launchers || []).find((item) => item.id === 'gh-launcher')
  check(ghEntry && ghEntry.source === 'github', '清单记录来源 github')
  check(ghEntry && ghEntry.repo === 'demo/gh-launcher', '清单记录 GitHub 仓库', ghEntry && ghEntry.repo)
  check(Boolean(findGame('gh-game')), 'repo 安装后游戏出现')

  const ghList = await manager.list()
  const ghListed = ghList.find((item) => item.id === 'gh-launcher')
  check(ghListed && ghListed.repo === 'demo/gh-launcher', 'manager.list 条目含 repo')

  const checkBefore = await manager.check('gh-launcher')
  check(
    checkBefore.installedVersion === '1.0.0' && checkBefore.latestVersion === '1.0.0' && checkBefore.updateAvailable === false,
    'check 报告已是最新版本',
    JSON.stringify(checkBefore),
  )

  latestRelease = makeRelease('1.1.0')
  const checkAfter = await manager.check('gh-launcher')
  check(
    checkAfter.installedVersion === '1.0.0' && checkAfter.latestVersion === '1.1.0' && checkAfter.updateAvailable === true,
    'check 发现新版本',
    JSON.stringify(checkAfter),
  )

  const updated = await manager.update('gh-launcher')
  check(updated.id === 'gh-launcher' && updated.version === '1.1.0' && updated.updated === true, '更新成功', updated.version)
  const updateJob = jobs[jobs.length - 1]
  check(updateJob.kind === 'sublauncher-update', '更新任务 kind 为 sublauncher-update', updateJob.kind)
  check(updateJob.status === 'succeeded', '更新任务状态 succeeded')
  check(
    !(await pathExists(launcherDirOf('gh-launcher', '1.0.0'))),
    '更新后旧版本目录已删除',
  )
  check(await pathExists(launcherDirOf('gh-launcher', '1.1.0')), '更新后新版本目录存在')
  const ghRegistryAfter = await readRegistry()
  const ghEntryAfter = (ghRegistryAfter.launchers || []).find((item) => item.id === 'gh-launcher')
  check(ghEntryAfter && ghEntryAfter.version === '1.1.0', '清单版本更新为 1.1.0')
  check(Boolean(findGame('gh-game')), '更新后游戏仍可用于热加载')

  const checkSame = await manager.check('gh-launcher')
  check(checkSame.updateAvailable === false, '更新后 check 报告最新')
  const updateAgain = await manager.update('gh-launcher')
  check(updateAgain.updated === false && updateAgain.version === '1.1.0', '已最新时更新为 no-op', updateAgain.version)

  // -------------------------------------------------------------------------
  section('⑥ 直链（url）来源安装 + 无下载器时的 fetch 回退')
  // -------------------------------------------------------------------------

  const installedUrl = await manager.install({ url: serverBase + '/pkg/url-launcher.zip' })
  check(installedUrl.id === 'url-launcher' && installedUrl.version === '1.0.0', 'url 来源安装成功')
  check(serverHits.includes('url-launcher.zip'), 'url 来源经由下载器下载 zip')
  const urlRegistry = await readRegistry()
  const urlEntry = (urlRegistry.launchers || []).find((item) => item.id === 'url-launcher')
  check(urlEntry && urlEntry.source === 'url', '清单记录来源 url')
  check(urlEntry && String(urlEntry.url || '').startsWith(serverBase), '清单记录直链地址')
  check(Boolean(findGame('url-game')), 'url 安装后游戏出现')

  manager.setDownloader(null)
  const installedFallback = await manager.install({ url: serverBase + '/pkg/fallback-launcher.zip' })
  check(installedFallback.id === 'fallback-launcher', '无下载器时 fetch 回退安装成功')
  check(Boolean(findGame('fallback-game')), '回退安装后游戏出现')
  manager.setDownloader(downloader)

  // -------------------------------------------------------------------------
  section('⑦ 核心版本门槛')
  // -------------------------------------------------------------------------

  await expectRejects(
    async () => manager.install({ file: zipFile('future-launcher.zip') }),
    /需要核心版本 >= 3\.2\.1/,
    '默认核心 3.2.0 拒绝 3.2.1 的包',
  )
  const managerHighCore = createSubLauncherManager({
    paths: realPaths,
    dl: downloader,
    logger: log,
    runJob: fakeRunJob,
    reloadGames: async () => {
      await store.loadAll({ force: true })
      return store.list()
    },
    coreVersion: '3.3.0',
  })
  const installedFuture = await managerHighCore.install({ file: zipFile('future-launcher.zip') })
  check(installedFuture.id === 'future-launcher', '高核心版本可安装 3.2.1 的包')
  const removedFuture = await managerHighCore.remove('future-launcher')
  check(removedFuture.removed === true, '高核心版本管理器可卸载')

  // -------------------------------------------------------------------------
  section('⑧ 无 runJob 时的降级路径')
  // -------------------------------------------------------------------------

  const managerPlain = createSubLauncherManager({
    paths: realPaths,
    dl: downloader,
    logger: log,
    reloadGames: async () => {
      await store.loadAll({ force: true })
      return store.list()
    },
    coreVersion: '3.2.0',
  })
  const installedPlain = await managerPlain.install({ file: zipFile('plain-1.0.0.zip') })
  check(installedPlain.id === 'plain-launcher', '无 runJob 时同步执行安装', installedPlain.id)
  check(installedPlain.jobId === null, '无 runJob 时 jobId 为 null')
  check(Boolean(findGame('plain-game')), '无 runJob 安装后游戏出现')
  const removedPlain = await managerPlain.remove('plain-launcher')
  check(removedPlain.removed === true, '无 runJob 时可卸载')

  // -------------------------------------------------------------------------
  section('⑨ 卸载：删桥 + 删目录 + 删清单 + 热加载后游戏消失')
  // -------------------------------------------------------------------------

  const removedDemo = await manager.remove('demo-launcher')
  check(removedDemo.removed === true, '卸载返回 removed=true')
  check(!(await pathExists(bridgeFileOf('demo-launcher'))), '卸载后加载桥已删除')
  check(!(await pathExists(path.join(dataRoot, 'sub-launchers', 'demo-launcher'))), '卸载后版本目录已删除')
  const registryAfterRemove = await readRegistry()
  check(
    !(registryAfterRemove.launchers || []).some((item) => item.id === 'demo-launcher'),
    '卸载后清单条目已删除',
  )
  check(!findGame('demo-game'), '卸载后热加载的游戏已消失')
  const listAfterRemove = await manager.list()
  check(!listAfterRemove.some((item) => item.id === 'demo-launcher'), '卸载后 manager.list 不再返回')

  // 清理其余附属启动器
  for (const id of ['gh-launcher', 'url-launcher', 'fallback-launcher']) {
    try {
      await manager.remove(id)
    } catch (error) {
      log('清理失败：' + id + '：' + (error && error.message))
    }
  }
  const finalRegistry = await readRegistry()
  check((finalRegistry.launchers || []).length === 0, '清理后安装清单为空')

  return { results, tempRoot: TEMP_ROOT }
}

try {
  const outcome = await main()
  void outcome
} catch (error) {
  failures += 1
  console.error('\n[FATAL] 测试执行异常：' + ((error && error.stack) || error))
} finally {
  try {
    if (downloader && typeof downloader.close === 'function') downloader.close()
  } catch {
    /* 忽略 */
  }
  if (server) {
    await new Promise((resolve) => server.close(resolve)).catch(() => {})
  }
  if (!KEEP) {
    await fsp.rm(TEMP_ROOT, { recursive: true, force: true }).catch(() => {})
  }
}

const total = results.length
const failed = results.filter((item) => item.status === 'FAIL').length
console.log('\n----------------------------------------')
console.log('测试总数：' + total + '，通过：' + (total - failed) + '，失败：' + failed)
console.log('下载器统计：' + JSON.stringify(downloader ? downloader.getStats() : {}))
console.log('任务数：' + jobs.length + '（kind：' + jobs.map((job) => job.kind).join(', ') + '）')
console.log('本地服务器请求：' + serverHits.length + ' 次')
if (KEEP) console.log('临时目录已保留：' + TEMP_ROOT)
console.log((failed === 0 ? 'PASS' : 'FAIL') + ' sublauncher-test')
console.log(failed === 0 ? 'RESULT: ALL PASS' : 'RESULT: FAILED')
process.exit(failed === 0 ? 0 : 1)
