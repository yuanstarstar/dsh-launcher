// catalog-test：推荐目录（catalog）与 GitHub 网页回退路径的离线自测。
// 用法：node scripts/catalog-test.mjs
// 可选：REAL_GITHUB=1 node scripts/catalog-test.mjs 额外验证真实 GitHub（网页 Release + raw catalog + 真实安装）。
import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'

import {
  CATALOG_SCHEMA_VERSION,
  normalizeCatalogEntry,
  parseCatalog,
  annotateCatalog,
  fetchCatalogJson,
  createCatalogLoader,
} from '../lib/core/catalog.js'
import {
  parseGithubTagFromUrl,
  parseReleaseAssetsFromHtml,
  fetchReleaseViaWeb,
  matchAssetPattern,
  selectReleaseAsset,
  createSubLauncherManager,
} from '../lib/core/sublaunchers.js'
import { createPaths, ensureDirs, writeJson, removeDir } from '../lib/core/paths.js'

const TMP = path.join(process.cwd(), 'test', 'tmp', 'catalog-test')
const REAL = process.env.REAL_GITHUB === '1'
const results = []
function check(name, fn) {
  try {
    fn()
    results.push({ name, ok: true })
    console.log('PASS ' + name)
  } catch (error) {
    results.push({ name, ok: false, error: String((error && error.message) || error) })
    console.log('FAIL ' + name + ' —— ' + String((error && error.message) || error))
  }
}
async function checkAsync(name, fn) {
  try {
    await fn()
    results.push({ name, ok: true })
    console.log('PASS ' + name)
  } catch (error) {
    results.push({ name, ok: false, error: String((error && error.message) || error) })
    console.log('FAIL ' + name + ' —— ' + String((error && error.message) || error))
  }
}
function throws(fn, pattern) {
  let message = ''
  try {
    fn()
  } catch (error) {
    message = String((error && error.message) || error)
  }
  assert(message.length > 0, '预期抛错但没有抛')
  if (pattern) assert(pattern.test(message), '错误信息不匹配：' + message)
}
function tmpDataRoot(name) {
  return path.join(TMP, name)
}

// ---------- 1. 条目规整 / 目录解析 ----------
check('normalizeCatalogEntry：repo 来源自动生成 id/label', () => {
  const entry = normalizeCatalogEntry({ repo: 'yuanstarstar/dsh-launcher-minecraft', description: 'd' })
  assert.equal(entry.id, 'dsh-launcher-minecraft')
  assert.equal(entry.repo, 'yuanstarstar/dsh-launcher-minecraft')
  assert.equal(entry.label, 'yuanstarstar/dsh-launcher-minecraft')
  assert.equal(entry.url, '')
})
check('normalizeCatalogEntry：缺来源抛错', () => {
  throws(() => normalizeCatalogEntry({ label: 'x' }), /缺少安装来源/)
})
check('normalizeCatalogEntry：repo 格式非法抛错', () => {
  throws(() => normalizeCatalogEntry({ repo: 'no-slash' }), /repo 格式无效/)
})
check('normalizeCatalogEntry：id 非法抛错', () => {
  throws(() => normalizeCatalogEntry({ repo: 'a/b', id: 'Bad Id!' }), /id 无效/)
})
check('normalizeCatalogEntry：url 来源按文件名生成 id', () => {
  const entry = normalizeCatalogEntry({ url: 'https://example.com/packs/demo-launcher.zip' })
  assert.equal(entry.id, 'demo-launcher-zip')
  assert.equal(entry.url, 'https://example.com/packs/demo-launcher.zip')
})
check('parseCatalog：数组输入自动补 schemaVersion', () => {
  const result = parseCatalog([{ repo: 'a/b' }, { repo: 'c/d' }])
  assert.equal(result.schemaVersion, CATALOG_SCHEMA_VERSION)
  assert.equal(result.entries.length, 2)
})
check('parseCatalog：重复 id 自动去重', () => {
  const result = parseCatalog([{ repo: 'a/b' }, { repo: 'c/b' }])
  assert.deepEqual(
    result.entries.map((entry) => entry.id),
    ['b', 'b-2'],
  )
})
check('parseCatalog：非法 JSON 抛错', () => {
  throws(() => parseCatalog('not-json'), /不是合法 JSON/)
})
check('parseCatalog：schemaVersion 不匹配抛错', () => {
  throws(() => parseCatalog({ schemaVersion: 99, entries: [] }), /不支持的推荐目录版本/)
})
check('annotateCatalog：按 repo 标注已安装 + 可更新', () => {
  const entries = [
    { id: 'minecraft', repo: 'a/b', version: '1.2.0' },
    { id: 'other-launcher', repo: 'c/d', version: '1.0.0' },
  ]
  const annotated = annotateCatalog(entries, [
    { id: 'minecraft', version: '1.1.0', repo: 'a/b' },
    { id: 'other-launcher', version: '1.0.0', repo: 'c/d' },
  ])
  assert.equal(annotated[0].installed, true)
  assert.equal(annotated[0].installedVersion, '1.1.0')
  assert.equal(annotated[0].updateAvailable, true)
  assert.equal(annotated[1].updateAvailable, false)
})
check('annotateCatalog：按 id 兜底匹配', () => {
  const annotated = annotateCatalog([{ id: 'foo-launcher', version: '2.0.0' }], [{ id: 'foo-launcher', version: '2.0.0' }])
  assert.equal(annotated[0].installed, true)
  assert.equal(annotated[0].updateAvailable, false)
})

// ---------- 2. 加载器：本地 / 远程 / 回退 ----------
const localRoot = tmpDataRoot('local')
await fsp.rm(localRoot, { recursive: true, force: true })
await ensureDirs(createPaths(localRoot))
await writeJson(path.join(localRoot, 'catalog.json'), {
  schemaVersion: 1,
  entries: [{ id: 'local-launcher', label: '本地条目', repo: 'a/b' }],
})

await checkAsync('目录加载器：数据根 catalog.json', async () => {
  const loader = createCatalogLoader({ paths: createPaths(localRoot), logger: () => {}, getConfig: () => ({}) })
  const result = await loader.load()
  assert.equal(result.entries.length, 1)
  assert.match(result.source, /^local:/)
  assert.equal(result.error, '')
})

await checkAsync('目录加载器：无配置且无本地文件 → 空列表无错误', async () => {
  const emptyRoot = tmpDataRoot('empty')
  await fsp.rm(emptyRoot, { recursive: true, force: true })
  await ensureDirs(createPaths(emptyRoot))
  const loader = createCatalogLoader({ paths: createPaths(emptyRoot), logger: () => {}, getConfig: () => ({}) })
  const result = await loader.load()
  assert.deepEqual(result.entries, [])
  assert.equal(result.error, '')
})

let serverPayload = { schemaVersion: 1, entries: [{ id: 'remote-launcher', label: '远程条目', repo: 'r/x' }] }
const server = http.createServer((req, res) => {
  if (req.url.startsWith('/catalog.json')) {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify(serverPayload))
    return
  }
  res.writeHead(404)
  res.end('not found')
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port
const remoteUrl = 'http://127.0.0.1:' + port + '/catalog.json'
const remoteRoot = tmpDataRoot('remote')
await fsp.rm(remoteRoot, { recursive: true, force: true })
await ensureDirs(createPaths(remoteRoot))

await checkAsync('目录加载器：远程 catalogUrl + 缓存 + refresh', async () => {
  const loader = createCatalogLoader({ paths: createPaths(remoteRoot), logger: () => {}, getConfig: () => ({ catalogUrl: remoteUrl }) })
  const first = await loader.load()
  assert.equal(first.entries.length, 1)
  assert.match(first.source, /^remote:/)
  serverPayload = { schemaVersion: 1, entries: [{ id: 'remote-launcher', label: '远程条目', repo: 'r/x' }, { id: 'second-launcher', label: '第二条', repo: 'r/y' }] }
  const cached = await loader.load()
  assert.equal(cached.entries.length, 1, '缓存期内应返回缓存')
  const refreshed = await loader.load({ refresh: true })
  assert.equal(refreshed.entries.length, 2, 'refresh 应重新拉取')
})

const fallbackRoot = tmpDataRoot('fallback')
await fsp.rm(fallbackRoot, { recursive: true, force: true })
await ensureDirs(createPaths(fallbackRoot))
await writeJson(path.join(fallbackRoot, 'catalog.json'), {
  schemaVersion: 1,
  entries: [{ id: 'fallback-launcher', label: '回退条目', repo: 'f/b' }],
})
await checkAsync('目录加载器：远程失败回退本地 catalog.json', async () => {
  const loader = createCatalogLoader({
    paths: createPaths(fallbackRoot),
    logger: () => {},
    getConfig: () => ({ catalogUrl: 'http://127.0.0.1:1/catalog.json' }),
  })
  const result = await loader.load()
  assert.equal(result.entries.length, 1)
  assert.match(result.source, /^local:/)
  assert.match(result.error, /已使用本地目录/)
})

await checkAsync('fetchCatalogJson：真实解析远程 JSON', async () => {
  serverPayload = { schemaVersion: 1, entries: [{ id: 'one-launcher', label: '一', repo: 'a/one' }] }
  const result = await fetchCatalogJson(remoteUrl + '?v=2')
  assert.equal(result.entries.length, 1)
})
server.close()

// ---------- 3. GitHub 网页回退解析 ----------
check('parseGithubTagFromUrl：tag 提取', () => {
  assert.equal(parseGithubTagFromUrl('https://github.com/o/r/releases/tag/v1.2.3'), 'v1.2.3')
  assert.equal(parseGithubTagFromUrl('https://github.com/o/r/releases/latest'), '')
})
check('parseReleaseAssetsFromHtml：解析 releases/download 链接', () => {
  const html = `
    <a href="/o/r/releases/download/v1.0.0/pack-one.zip">pack-one.zip</a>
    <a href="/o/r/releases/download/v1.0.0/notes.txt?download=1">notes.txt</a>
    <a href="https://github.com/o/r/releases/download/v1.0.0/pack-two.zip">pack-two.zip</a>`
  const assets = parseReleaseAssetsFromHtml(html, 'v1.0.0')
  assert.equal(assets.length, 3)
  assert.equal(assets[0].browser_download_url, 'https://github.com/o/r/releases/download/v1.0.0/pack-one.zip')
})
check('selectReleaseAsset + matchAssetPattern', () => {
  const release = {
    assets: [
      { name: 'notes.txt', browser_download_url: 'https://x/notes.txt' },
      { name: 'launcher-win.zip', browser_download_url: 'https://x/launcher-win.zip' },
      { name: 'launcher-linux.zip', browser_download_url: 'https://x/launcher-linux.zip' },
    ],
  }
  assert.equal(selectReleaseAsset(release).name, 'launcher-win.zip')
  assert.equal(selectReleaseAsset(release, '*-linux.zip').name, 'launcher-linux.zip')
  assert.equal(matchAssetPattern('launcher-win.zip', 'launcher-*.zip'), true)
  assert.equal(matchAssetPattern('launcher-win.zip', 'other-*.zip'), false)
})

// ---------- 4. 可选：真实 GitHub ----------
// 真实网络可能是离线/限流环境：网络不可达记 SKIP，不算失败；逻辑正确性由离线用例覆盖。
const skipped = []
async function checkReal(name, fn) {
  try {
    await fn()
    results.push({ name, ok: true })
    console.log('PASS ' + name)
  } catch (error) {
    const message = String((error && error.message) || error)
    if (/无法访问|请求失败|fetch failed|abort|timeout|网络/i.test(message)) {
      skipped.push(name + '：' + message)
      console.log('SKIP ' + name + ' —— ' + message)
    } else {
      results.push({ name, ok: false, error: message })
      console.log('FAIL ' + name + ' —— ' + message)
    }
  }
}
if (REAL) {
  await checkReal('真实 GitHub：raw catalog.json 可解析（仓库未上传 catalog.json 时跳过）', async () => {
    const url = 'https://raw.githubusercontent.com/yuanstarstar/dsh-launcher-minecraft/main/catalog.json'
    let result
    try {
      result = await fetchCatalogJson(url)
    } catch (error) {
      if (/HTTP 404/.test(String((error && error.message) || error))) {
        throw new Error('无法访问（仓库尚未上传 catalog.json）：HTTP 404')
      }
      throw error
    }
    assert(result.entries.length >= 1, '目录条目为空')
    assert(result.entries.some((entry) => entry.id === 'minecraft'), '缺少 minecraft 条目')
  })

  await checkReal('真实 GitHub：网页 Release 回退可解析 zip 资产', async () => {
    const release = await fetchReleaseViaWeb('yuanstarstar/dsh-launcher-minecraft')
    assert.match(release.tag_name, /^\d+\.\d+\.\d+/)
    const asset = selectReleaseAsset(release)
    assert(/\.zip$/i.test(asset.name), '资产不是 zip：' + asset.name)
  })

  await checkReal('真实 GitHub：从 repo 安装附属启动器到临时数据根', async () => {
    const root = tmpDataRoot('real-install')
    await fsp.rm(root, { recursive: true, force: true })
    const paths = createPaths(root)
    await ensureDirs(paths)
    const jobs = []
    const manager = createSubLauncherManager({
      paths,
      dl: { fetchJson: async () => ({}) },
      logger: () => {},
      coreVersion: '3.3.0',
      reloadGames: async () => [],
      runJob: (kind, title, instanceId, fn) => {
        const task = { log: () => {}, items: () => {}, bytes: () => {}, setPhase: () => {}, cancelRequested: false }
        const promise = Promise.resolve().then(() => fn(task))
        jobs.push({ kind, title, instanceId, promise })
        return { id: 'job-' + jobs.length, promise }
      },
    })
    const result = await manager.install({ repo: 'yuanstarstar/dsh-launcher-minecraft', wait: true })
    assert.equal(result.id, 'minecraft')
    assert.match(result.version, /^\d+\.\d+\.\d+/)
    const installed = await manager.list()
    assert(installed.some((item) => item.id === 'minecraft'), '安装后列表缺少 minecraft')
    await removeDir(root)
    console.log('REAL GitHub 安装完成：minecraft ' + result.version)
  })
}

// ---------- 收尾 ----------
await removeDir(TMP)
const failed = results.filter((item) => !item.ok)
console.log('catalog-test：' + (results.length - failed.length) + ' PASS / ' + failed.length + ' FAIL' + (skipped.length ? ' / ' + skipped.length + ' SKIP' : '') + (REAL ? '（含真实 GitHub）' : '（离线）'))
if (failed.length) {
  for (const item of failed) console.error('  - ' + item.name + '：' + item.error)
  process.exitCode = 1
} else {
  console.log('RESULT: ALL PASS')
}
