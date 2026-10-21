// DSH启动器 v3 · 提供者与下载器自测
//
// 全程离线可跑：用本地 Node http 服务器提供 ZIP 与 versions.json。
// 仅 GitHub 提供者会尝试一次真实网络校验（失败记为 SKIP，不算 FAIL）。
//
// 用法：node scripts/providers-test.mjs
// 输出同时写入 test/providers-report.txt；退出码 0 = 全 PASS（允许 SKIP）。
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import http from 'node:http'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

import { createDownloader } from '../lib/core/http.js'
import { createPaths } from '../lib/core/paths.js'
import {
  PROVIDERS,
  providerSummaries,
  validateDefinition,
  testDefinition,
} from '../lib/core/providers/index.js'
import { extractArchiveToDir, findExecutable, looksLikeZip } from '../lib/core/archive.js'
import { createGameStore } from '../lib/core/game-store.js'
import { hasGame, listGames } from '../lib/core/registry.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const TMP_ROOT = path.join(ROOT, 'test', 'tmp', 'providers-' + Date.now())
const REPORT_FILE = path.join(ROOT, 'test', 'providers-report.txt')
const results = []
let testServer = null
let downloader = null
const stores = []

// ---------- 断言与记录 ----------

function expect(condition, message) {
  if (!condition) throw new Error(message)
}

function expectEqual(actual, expected, message) {
  if (actual !== expected) throw new Error(message + '（实际：' + JSON.stringify(actual) + '，期望：' + JSON.stringify(expected) + '）')
}

function expectThrows(fn, fragment, message) {
  let thrown = null
  try {
    fn()
  } catch (error) {
    thrown = error
  }
  if (!thrown) throw new Error(message + '：预期抛出错误，但没有抛')
  expect(String(thrown.message).includes(fragment), message + '：错误信息不含「' + fragment + '」，实际：' + thrown.message)
  return thrown
}

async function expectRejects(fn, fragment, message) {
  let thrown = null
  try {
    await fn()
  } catch (error) {
    thrown = error
  }
  if (!thrown) throw new Error(message + '：预期抛出错误，但没有抛')
  expect(String(thrown.message).includes(fragment), message + '：错误信息不含「' + fragment + '」，实际：' + thrown.message)
  return thrown
}

async function run(name, fn) {
  try {
    const detail = await fn()
    results.push({ name, status: 'PASS', detail: detail ? String(detail) : '' })
    console.log('  [PASS] ' + name + (detail ? ' —— ' + detail : ''))
  } catch (error) {
    results.push({ name, status: 'FAIL', detail: error && error.message ? error.message : String(error) })
    console.log('  [FAIL] ' + name + ' —— ' + (error && error.stack ? error.stack.split('\n')[0] : error))
  }
}

function skip(name, detail) {
  results.push({ name, status: 'SKIP', detail: String(detail || '') })
  console.log('  [SKIP] ' + name + ' —— ' + detail)
}

// ---------- 极简 ZIP 写入（仅 stored，不压缩；测试用） ----------

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
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data || '')
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

// ---------- 本地测试服务器 ----------

function startServer({ plainZip, wrapperZip, plainSha1, plainSize, wrappedSha1, wrappedSize }) {
  const routes = new Map()
  const server = http.createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1')
    const key = url.pathname
    if (key === '/versions.json') {
      const base = 'http://127.0.0.1:' + server.address().port
      const payload = {
        versions: [
          {
            id: '1.0.0',
            label: '演示版本 1.0.0',
            url: base + '/plain.zip',
            sha1: plainSha1,
            size: plainSize,
            archive: 'zip',
            executable: 'fake.exe',
          },
          {
            id: '2.0.0',
            label: '演示版本 2.0.0（顶层目录）',
            url: base + '/wrapped.zip',
            sha1: wrappedSha1,
            size: wrappedSize,
            archive: 'zip',
            executable: 'fake.exe',
          },
        ],
      }
      const body = Buffer.from(JSON.stringify(payload), 'utf8')
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'content-length': body.length })
      res.end(body)
      return
    }
    const file = routes.get(key)
    if (file) {
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': file.length })
      res.end(file)
      return
    }
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('not found: ' + key)
  })
  routes.set('/plain.zip', plainZip)
  routes.set('/wrapped.zip', wrapperZip)
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve(server))
  })
}

function baseUrl(server) {
  return 'http://127.0.0.1:' + server.address().port
}

// ---------- 环境搭建 ----------

function makeTask(label) {
  return {
    bytes: 0,
    itemsLog: [],
    logs: [],
    cancelRequested: false,
    log(line) {
      this.logs.push(String(line))
    },
    items(done, total, name) {
      this.itemsLog.push({ done, total, name })
    },
    bytesAdd(count) {
      this.bytes += Number(count) || 0
    },
    setPhase(phase) {
      this.logs.push('# ' + phase)
    },
  }
}

async function makeCtx({ paths, dataRoot, gameDir, instance, task }) {
  return {
    dl: downloader,
    makeDownloader: () => downloader,
    paths,
    config: {},
    dataRoot,
    instanceDir: paths.instanceDir(instance),
    gameDir,
    gameDataDir: paths.gameDataDir(instance),
    task: task || makeTask('测试'),
    log: (message) => console.log('    · ' + message),
    instance: { id: instance, game: 'demo', versionId: '1.0.0' },
  }
}

function header(title) {
  console.log('\n' + title)
}

// ---------- 测试主体 ----------

async function main() {
  console.log('DSH启动器 v3 · 提供者自测')
  console.log('时间：' + new Date().toISOString())
  console.log('平台：' + process.platform + ' / Node ' + process.version)
  console.log('临时目录：' + TMP_ROOT)

  await fsp.mkdir(TMP_ROOT, { recursive: true })

  // 准备 ZIP 与本地服务器
  const marker = Buffer.from('provider test marker\n', 'utf8')
  const plainZip = buildZip([
    { name: 'marker.txt', data: marker },
    { name: 'fake.exe', data: Buffer.alloc(0) },
  ])
  const wrapperZip = buildZip([
    { name: 'game-root/marker.txt', data: marker },
    { name: 'game-root/fake.exe', data: Buffer.alloc(0) },
  ])
  const wrappedSha1 = sha1Hex(wrapperZip)
  const wrappedSize = wrapperZip.length
  const plainSha1 = sha1Hex(plainZip)
  const plainSize = plainZip.length
  await fsp.writeFile(path.join(TMP_ROOT, 'plain.zip'), plainZip)
  await fsp.writeFile(path.join(TMP_ROOT, 'wrapped.zip'), wrapperZip)
  await fsp.writeFile(path.join(TMP_ROOT, 'plain.zip.sha1'), plainSha1)

  downloader = createDownloader({ concurrency: 4, retries: 2, logger: () => {} })
  testServer = await startServer({ plainZip, wrapperZip, plainSha1, plainSize, wrappedSha1, wrappedSize })
  const base = baseUrl(testServer)
  const dataRoot = path.join(TMP_ROOT, 'data')
  const paths = createPaths(dataRoot)
  await fsp.mkdir(paths.tmp, { recursive: true })
  await fsp.mkdir(paths.games, { recursive: true })
  await fsp.mkdir(paths.adapters, { recursive: true })
  console.log('本地服务器：' + base)

  // ---------- 1. 定义校验 ----------

  header('1. 定义校验（validateDefinition）')
  await run('合法定义：github', () => {
    const definition = validateDefinition({ label: '演示', provider: 'github', config: { repo: 'owner/game-release' } })
    expectEqual(definition.provider, 'github', 'provider 应为 github')
    expectEqual(definition.versionLabel, '版本', 'versionLabel 默认应为「版本」')
    return 'id 可选、默认 versionLabel 正确'
  })
  await run('合法定义：url（静态列表）', () => {
    const definition = validateDefinition({
      label: '演示',
      provider: 'url',
      config: { versions: [{ id: 's1', url: base + '/plain.zip' }] },
    })
    expect(definition.config.versions.length === 1, 'config.versions 应保留 1 个版本')
    return '静态版本列表'
  })
  await run('合法定义：manual', () => {
    const sysRoot = process.env.SystemRoot || 'C:\\Windows'
    const definition = validateDefinition({
      label: '本机应用',
      provider: 'manual',
      config: { path: path.join(sysRoot, 'System32'), executable: 'notepad.exe' },
    })
    expect(definition.config.manualPath.length > 0, 'manualPath 应已解析')
    return 'manualPath=' + definition.config.manualPath
  })
  await run('异常：提供者不存在', () => {
    expectThrows(
      () => validateDefinition({ label: '演示', provider: 'unknown', config: {} }),
      '不支持的提供者',
      '未知提供者应报错',
    )
    return '中文错误信息'
  })
  await run('异常：缺少 label', () => {
    expectThrows(() => validateDefinition({ provider: 'github', config: { repo: 'a/b' } }), '缺少游戏名称', '缺少 label 应报错')
    return '中文错误信息'
  })
  await run('异常：github repo 格式', () => {
    expectThrows(
      () => validateDefinition({ label: '演示', provider: 'github', config: { repo: 'not-a-repo' } }),
      'repo 格式不正确',
      'repo 格式错误应报错',
    )
    return '中文错误信息'
  })
  await run('异常：url 缺少 jsonUrl/versions', () => {
    expectThrows(
      () => validateDefinition({ label: '演示', provider: 'url', config: {} }),
      '需要 jsonUrl',
      'url 配置为空应报错',
    )
    return '中文错误信息'
  })
  await run('异常：manual 缺少 executable', () => {
    expectThrows(
      () => validateDefinition({ label: '演示', provider: 'manual', config: { path: 'C:\\Windows' } }),
      '需要 executable',
      'manual 缺少 executable 应报错',
    )
    return '中文错误信息'
  })
  await run('异常：manual executable 不能是绝对路径', () => {
    expectThrows(
      () =>
        validateDefinition({
          label: '演示',
          provider: 'manual',
          config: { path: 'C:\\Windows', executable: 'C:\\Windows\\System32\\notepad.exe' },
        }),
      '相对路径',
      '绝对路径 executable 应报错',
    )
    return '中文错误信息'
  })
  await run('providerSummaries 返回 3 个提供者', () => {
    const summaries = providerSummaries()
    expectEqual(summaries.length, 3, '提供者摘要数量')
    const ids = summaries.map((item) => item.id).join(',')
    expectEqual(ids, 'github,url,manual', '提供者顺序')
    for (const summary of summaries) {
      expect(Array.isArray(summary.configFields) && summary.configFields.length > 0, summary.id + ' 应包含 configFields')
    }
    return ids
  })

  // ---------- 2. url 提供者：远程清单全流程 ----------

  header('2. url 提供者：远程清单 → listVersions → install → launch')
  let urlAdapter = null
  let ctx1 = null
  await run('创建适配器并拉取版本列表', async () => {
    const definition = validateDefinition({
      id: 'demo-remote',
      label: '远程演示',
      provider: 'url',
      config: { jsonUrl: base + '/versions.json', executable: 'fake.exe' },
    })
    urlAdapter = PROVIDERS.url.createAdapter(definition)
    ctx1 = await makeCtx({
      paths,
      dataRoot,
      gameDir: paths.instanceGameDir('t-remote'),
      instance: 't-remote',
    })
    await fsp.mkdir(ctx1.gameDir, { recursive: true })
    const listed = await urlAdapter.listVersions({ ctx: ctx1 })
    expectEqual(listed.versions.length, 2, '版本数量')
    expectEqual(listed.versions[0].id, '1.0.0', '第一个版本 id')
    expectEqual(listed.latestRelease, '1.0.0', 'latestRelease')
    return 'versions=' + listed.versions.map((item) => item.id).join(',')
  })
  await run('install 下载 ZIP、解压并写入 metadata', async () => {
    const result = await urlAdapter.install({ ctx: ctx1, instance: ctx1.instance, version: '1.0.0' })
    expectEqual(result.versionId, '1.0.0', 'install 返回 versionId')
    expect(await exists(path.join(ctx1.gameDir, 'marker.txt')), '应解压出 marker.txt')
    expect(await exists(path.join(ctx1.gameDir, 'fake.exe')), '应解压出 fake.exe')
    const metadata = JSON.parse(await fsp.readFile(path.join(ctx1.gameDir, 'metadata.json'), 'utf8'))
    expectEqual(metadata.executable, 'fake.exe', 'metadata.executable 应为相对路径')
    expectEqual(metadata.provider, 'url', 'metadata.provider')
    return 'metadata.executable=' + metadata.executable
  })
  await run('launch 返回绝对可执行文件与工作目录', async () => {
    const spec = await urlAdapter.launch({ ctx: ctx1, instance: ctx1.instance })
    expectEqual(spec.executable, path.join(ctx1.gameDir, 'fake.exe'), 'launch executable 应为绝对路径')
    expectEqual(spec.cwd, ctx1.gameDir, 'launch cwd 应为游戏目录')
    expect(Array.isArray(spec.args), 'launch args 应为数组')
    return spec.executable
  })
  await run('verify 通过', async () => {
    const verified = await urlAdapter.verify({ ctx: ctx1, instance: ctx1.instance })
    expectEqual(verified.ok, true, 'verify 应通过')
    return JSON.stringify(verified)
  })
  await run('安装 2.0.0：ZIP 顶层目录自动 strip', async () => {
    const ctx2 = await makeCtx({ paths, dataRoot, gameDir: paths.instanceGameDir('t-wrapped'), instance: 't-wrapped' })
    await fsp.mkdir(ctx2.gameDir, { recursive: true })
    const result = await urlAdapter.install({ ctx: ctx2, instance: ctx2.instance, version: '2.0.0' })
    expectEqual(result.versionId, '2.0.0', 'install 返回 versionId')
    expect(await exists(path.join(ctx2.gameDir, 'marker.txt')), 'strip 后 marker.txt 应在游戏目录根')
    expect(await exists(path.join(ctx2.gameDir, 'fake.exe')), 'strip 后 fake.exe 应在游戏目录根')
    expect(!(await exists(path.join(ctx2.gameDir, 'game-root'))), '顶层目录应被去掉')
    return 'strip=1'
  })
  await run('testDefinition（url/远程清单）成功', async () => {
    const tested = await testDefinition({ provider: 'url', config: { jsonUrl: base + '/versions.json' }, dl: downloader })
    expectEqual(tested.ok, true, 'testDefinition.ok')
    return tested.detail
  })

  // ---------- 3. url 提供者：静态清单 ----------

  header('3. url 提供者：静态 versions 清单')
  await run('静态清单 add → listVersions → install', async () => {
    const definition = validateDefinition({
      id: 'demo-static',
      label: '静态演示',
      provider: 'url',
      config: {
        versions: [
          {
            id: 's-1.0',
            label: '静态版本',
            url: base + '/plain.zip',
            sha1: plainSha1,
            size: plainSize,
            archive: 'zip',
            executable: 'fake.exe',
          },
        ],
      },
    })
    const adapter = PROVIDERS.url.createAdapter(definition)
    const ctx = await makeCtx({ paths, dataRoot, gameDir: paths.instanceGameDir('t-static'), instance: 't-static' })
    await fsp.mkdir(ctx.gameDir, { recursive: true })
    const listed = await adapter.listVersions({ ctx })
    expectEqual(listed.versions.length, 1, '静态版本数量')
    const result = await adapter.install({ ctx, instance: ctx.instance, version: 's-1.0' })
    expectEqual(result.versionId, 's-1.0', 'install 返回 versionId')
    expect(await exists(path.join(ctx.gameDir, 'fake.exe')), '静态清单安装后应有 fake.exe')
    const spec = await adapter.launch({ ctx, instance: ctx.instance })
    expectEqual(spec.executable, path.join(ctx.gameDir, 'fake.exe'), 'launch executable')
    return 'sha1/size 校验通过，解压正确'
  })

  // ---------- 4. archive.js 单元 ----------

  header('4. archive.js：识别 / 解压 / 找可执行')
  await run('looksLikeZip 正确区分 ZIP 与普通文件', async () => {
    expect(await looksLikeZip(path.join(TMP_ROOT, 'plain.zip')), 'plain.zip 应识别为 ZIP')
    expect(!(await looksLikeZip(path.join(TMP_ROOT, 'plain.zip.sha1'))), '文本文件不应识别为 ZIP')
    return 'magic 判断正确'
  })
  await run('findExecutable：hint 命中与找不到时报错', async () => {
    const dir = paths.instanceGameDir('t-found')
    await fsp.mkdir(dir, { recursive: true })
    await fsp.writeFile(path.join(dir, 'fake.exe'), '')
    const found = await findExecutable(dir, 'fake.exe')
    expectEqual(found, path.join(dir, 'fake.exe'), 'findExecutable(hint)')
    const auto = await findExecutable(dir)
    expectEqual(auto, path.join(dir, 'fake.exe'), 'findExecutable(自动)')
    await expectRejects(() => findExecutable(dir, 'missing.exe'), '可执行文件不存在', 'hint 不存在应报错')
    return '命中 + 中文错误'
  })
  await run('extractArchiveToDir 显式 stripComponents:0', async () => {
    const dest = path.join(TMP_ROOT, 'extract-nostrip')
    await extractArchiveToDir(path.join(TMP_ROOT, 'wrapped.zip'), dest, { stripComponents: 0 })
    expect(await exists(path.join(dest, 'game-root', 'marker.txt')), '不 strip 时应保留 game-root 目录')
    return 'stripComponents:0 生效'
  })

  // ---------- 5. manual 提供者 ----------

  header('5. manual 提供者：登记本机目录')
  const systemRoot = process.env.SystemRoot || 'C:\\Windows'
  const notepad = path.join(systemRoot, 'System32', 'notepad.exe')
  if (process.platform !== 'win32' || !fs.existsSync(notepad)) {
    skip('manual 提供者完整流程', '当前平台没有 notepad.exe')
  } else {
    await run('manual validate/install/launch/verify/testDefinition', async () => {
      const definition = validateDefinition({
        id: 'local-notepad',
        label: '本机应用',
        provider: 'manual',
        config: { path: path.join(systemRoot, 'System32'), executable: 'notepad.exe' },
      })
      const adapter = PROVIDERS.manual.createAdapter(definition)
      const ctx = await makeCtx({ paths, dataRoot, gameDir: paths.instanceGameDir('t-local'), instance: 't-local' })
      await fsp.mkdir(ctx.gameDir, { recursive: true })
      const listed = await adapter.listVersions({ ctx })
      expectEqual(listed.versions[0].id, 'installed', 'manual 版本 id')
      const result = await adapter.install({ ctx, instance: ctx.instance, version: 'installed' })
      expectEqual(result.versionId, 'installed', 'install 返回 versionId')
      expect(await exists(path.join(ctx.gameDir, 'metadata.json')), '应写入 metadata.json')
      const spec = await adapter.launch({ ctx, instance: ctx.instance })
      expectEqual(spec.executable, notepad, 'launch executable 应为 notepad.exe')
      expectEqual(spec.cwd, path.join(systemRoot, 'System32'), 'launch cwd 应为本机目录')
      const verified = await adapter.verify({ ctx, instance: ctx.instance })
      expectEqual(verified.ok, true, 'verify 应通过')
      const tested = await testDefinition({
        provider: 'manual',
        config: { path: path.join(systemRoot, 'System32'), executable: 'notepad.exe' },
        dl: downloader,
      })
      expectEqual(tested.ok, true, 'testDefinition.ok')
      return notepad
    })
  }

  // ---------- 6. github 提供者 ----------

  header('6. github 提供者：校验 + 可选真实网络')
  await run('validateDefinition：合法 github 定义', () => {
    const definition = validateDefinition({
      label: '发布演示',
      provider: 'github',
      config: {
        repo: 'owner/game-release',
        assetPattern: 'windows[_-]?x64\\.zip',
        executable: 'game.exe',
        archive: 'auto',
        assetKind: 'zip',
        args: ['--demo'],
      },
    })
    expectEqual(definition.config.assetKind, 'zip', 'assetKind 保留')
    return 'repo=' + definition.config.repo
  })
  await run('validateDefinition：assetPattern 非法正则', () => {
    expectThrows(
      () =>
        validateDefinition({
          label: '发布演示',
          provider: 'github',
          config: { repo: 'owner/game-release', assetPattern: '([a-z' },
        }),
      'assetPattern',
      '非法正则应报错',
    )
    return '中文错误信息'
  })
  let githubOk = false
  await run('testDefinition：真实访问 api.github.com', async () => {
    const tested = await PROVIDERS.github.testDefinition({ config: { repo: 'nodejs/node' }, dl: downloader })
    if (!tested.ok) {
      const detail = String(tested.detail || '')
      if (/网络|无法|失败|受限|超时|ENOTFOUND|ETIMEDOUT|ECONN/i.test(detail)) {
        skip('github 真实网络校验', detail)
        return
      }
      throw new Error('GitHub 校验失败：' + detail)
    }
    githubOk = true
    return tested.detail
  })
  if (!githubOk) console.log('    （GitHub 真实网络不可用，相关用例已记为 SKIP）')

  // ---------- 7. game-store ----------

  header('7. game-store：添加 / 列表 / 重新加载 / 删除 / 外部适配器')
  await run('add 静态 URL 游戏并落盘', async () => {
    const store = createGameStore({ paths, dl: downloader, logger: (message) => console.log('    · ' + message) })
    stores.push(store)
    await store.loadAll()
    const entry = await store.add({
      provider: 'url',
      label: '存储测试游戏',
      config: {
        versions: [
          {
            id: 'g-1.0',
            url: base + '/plain.zip',
            archive: 'zip',
            executable: 'fake.exe',
          },
        ],
      },
    })
    expect(entry && entry.id, 'add 应返回 id')
    expect(Array.isArray(store.list()), 'list 应返回数组')
    const listed = store.list().find((item) => item.id === entry.id)
    expect(listed, 'list 应包含新游戏')
    expectEqual(listed.provider, 'url', 'list.provider')
    expectEqual(listed.source, 'user', 'list.source')
    expect(fs.existsSync(path.join(paths.games, entry.id + '.json')), '应写入 dataRoot/games/<id>.json')
    store.lastAddedId = entry.id
    return 'id=' + entry.id
  })
  await run('add 缺少 label 时自动推导', async () => {
    const store = stores[0]
    const entry = await store.add({
      provider: 'url',
      config: { versions: [{ id: 'x', url: base + '/plain.zip' }] },
    })
    expect(entry.id, '自动 id 生成')
    expect(entry.game && entry.game.label, '自动 label 生成')
    store.autoId = entry.id
    return 'label=' + entry.game.label + '，id=' + entry.id
  })
  await run('add 重复 id 报错', async () => {
    const store = stores[0]
    await expectRejects(
      () =>
        store.add({
          id: store.lastAddedId,
          provider: 'url',
          label: '重复',
          config: { versions: [{ id: 'x', url: base + '/plain.zip' }] },
        }),
      '游戏已存在',
      '重复 id 应报错',
    )
    return '中文错误信息'
  })
  await run('listVersions 走真实适配器', async () => {
    const store = stores[0]
    const adapter = PROVIDERS.url.createAdapter(store.getDefinition(store.lastAddedId))
    const ctx = await makeCtx({
      paths,
      dataRoot,
      gameDir: paths.instanceGameDir('t-store'),
      instance: 't-store',
    })
    await fsp.mkdir(ctx.gameDir, { recursive: true })
    const listed = await adapter.listVersions({ ctx })
    expectEqual(listed.versions[0].id, 'g-1.0', '版本 id')
    return listed.versions.length + ' 个版本'
  })
  await run('store.test 返回 {ok,detail}', async () => {
    const store = stores[0]
    const tested = await store.test({
      provider: 'url',
      config: { versions: [{ id: 'x', url: base + '/plain.zip' }] },
    })
    expectEqual(tested.ok, true, 'store.test.ok')
    expect(typeof tested.detail === 'string', 'detail 应为字符串')
    return tested.detail
  })
  await run('remove 删除定义与注册', async () => {
    const store = stores[0]
    const autoId = store.autoId
    const removed = await store.remove(autoId)
    expectEqual(removed.removed, true, 'remove 返回值')
    expect(!hasGame(autoId), '注册表应已移除')
    expect(!fs.existsSync(path.join(paths.games, autoId + '.json')), '定义文件应已删除')
    return 'id=' + autoId
  })
  await run('重新加载：持久化的定义仍可被发现', async () => {
    const store = stores[0]
    const keepId = store.lastAddedId
    await store.close()
    const store2 = createGameStore({ paths, dl: downloader, logger: () => {} })
    stores.push(store2)
    await store2.loadAll()
    const listed = store2.list().find((item) => item.id === keepId)
    expect(listed, '重新加载后应包含已保存的游戏')
    expectEqual(listed.provider, 'url', '重新加载后 provider')
    return 'id=' + keepId
  })
  await run('外部适配器：加载与拒绝删除', async () => {
    const adapterFile = path.join(paths.adapters, 'external-demo.mjs')
    await fsp.writeFile(
      adapterFile,
      [
        'export default {',
        "  id: 'external-demo',",
        "  label: '外部适配器演示',",
        "  versionLabel: '版本',",
        '  async listVersions() { return { versions: [{ id: "v1", label: "V1" }], latestRelease: "v1" } },',
        '  async install() { return { versionId: "v1", metadata: {} } },',
        '  async launch() { return { executable: "demo.exe", args: [], cwd: "." } },',
        '}',
        '',
      ].join('\n'),
      'utf8',
    )
    const store3 = createGameStore({ paths, dl: downloader, logger: (message) => console.log('    · ' + message) })
    stores.push(store3)
    await store3.loadAll()
    const listed = store3.list().find((item) => item.id === 'external-demo')
    expect(listed, '应加载外部适配器')
    expectEqual(listed.source, 'external', '外部适配器 source')
    expectEqual(listed.provider, 'external', '外部适配器 provider 标记')
    await expectRejects(() => store3.remove('external-demo'), '外部适配器游戏不能删除', '外部适配器删除应被拒绝')
    return 'external-demo 已加载并拒绝删除'
  })

  // ---------- 汇总 ----------
}

async function exists(filePath) {
  try {
    await fsp.access(filePath)
    return true
  } catch {
    return false
  }
}

async function writeReport() {
  const passed = results.filter((item) => item.status === 'PASS').length
  const failed = results.filter((item) => item.status === 'FAIL').length
  const skipped = results.filter((item) => item.status === 'SKIP').length
  const lines = []
  lines.push('DSH启动器 v3 · 提供者自测报告')
  lines.push('时间：' + new Date().toISOString())
  lines.push('平台：' + process.platform + ' / Node ' + process.version)
  lines.push('汇总：PASS ' + passed + ' / FAIL ' + failed + ' / SKIP ' + skipped)
  lines.push('')
  for (const item of results) {
    lines.push('[' + item.status + '] ' + item.name + (item.detail ? ' —— ' + item.detail : ''))
  }
  lines.push('')
  const text = lines.join('\n') + '\n'
  try {
    await fsp.mkdir(path.dirname(REPORT_FILE), { recursive: true })
    await fsp.writeFile(REPORT_FILE, text, 'utf8')
  } catch (error) {
    console.error('写入报告失败：' + (error && error.message ? error.message : error))
  }
  console.log('\n================ 汇总 ================')
  console.log('PASS ' + passed + ' / FAIL ' + failed + ' / SKIP ' + skipped)
  console.log('报告已写入：' + REPORT_FILE)
  if (failed > 0) {
    console.log('\n失败用例：')
    for (const item of results.filter((entry) => entry.status === 'FAIL')) console.log('  - ' + item.name + '：' + item.detail)
  }
  return failed
}

async function cleanup() {
  for (const store of stores) {
    try {
      await store.close()
    } catch {
      /* 忽略 */
    }
  }
  try {
    if (downloader) downloader.close()
  } catch {
    /* 忽略 */
  }
  if (testServer) {
    await new Promise((resolve) => testServer.close(resolve))
  }
  await fsp.rm(TMP_ROOT, { recursive: true, force: true }).catch(() => {})
}

let exitCode = 1
try {
  await main()
  const failed = await writeReport()
  exitCode = failed > 0 ? 1 : 0
  if (failed === 0) console.log('RESULT: ALL PASS' + (results.some((item) => item.status === 'SKIP') ? '（含 SKIP）' : ''))
  else console.log('RESULT: FAIL ' + failed)
} catch (error) {
  results.push({ name: '自测主流程', status: 'FAIL', detail: error && error.message ? error.message : String(error) })
  console.error('自测主流程异常：' + (error && error.stack ? error.stack : error))
  try {
    await writeReport()
  } catch {
    /* 忽略 */
  }
  exitCode = 1
} finally {
  await cleanup()
}
process.exitCode = exitCode
