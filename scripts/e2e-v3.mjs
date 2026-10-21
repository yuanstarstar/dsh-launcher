#!/usr/bin/env node
// v3 端到端验收：核心引擎（零游戏知识）+ 可选适配器包（真实网络 / 真实进程）。
// 用法：
//   node scripts/e2e-v3.mjs
//   node scripts/e2e-v3.mjs --root test/tmp/e2e-v3-data --version 1.20.1 --loader fabric --content sodium --launch-wait 45000
// 退出码 0 表示全部 PASS。
import path from 'node:path'
import fsp from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

import { createEngine } from '../lib/core/engine.js'
import { registerGame, unregisterGame } from '../lib/core/registry.js'
import adapter from '../plugins/minecraft-adapter/lib/adapter.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function parseArgs(argv) {
  const out = { root: 'test/tmp/e2e-v3-data', version: '1.20.1', loader: 'fabric', content: 'sodium', assets: 'index', launchWait: 45000, installTimeout: 900000, keep: false, name: 'e2e-v3' }
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    const next = argv[i + 1]
    if (token === '--root') out.root = next, i += 1
    else if (token === '--version') out.version = next, i += 1
    else if (token === '--loader') out.loader = next, i += 1
    else if (token === '--content') out.content = next, i += 1
    else if (token === '--assets') out.assets = next, i += 1
    else if (token === '--launch-wait') out.launchWait = Number(next), i += 1
    else if (token === '--install-timeout') out.installTimeout = Number(next), i += 1
    else if (token === '--name') out.name = next, i += 1
    else if (token === '--keep') out.keep = true
  }
  return out
}

const args = parseArgs(process.argv.slice(2))
const dataRoot = path.resolve(ROOT, args.root)
// 测试隔离：桥接指针写到临时数据根下，不覆盖真实宿主的 ~/.dsh-launcher/bridge.json。
process.env.DSH_LAUNCHER_BRIDGE_DIR = path.join(dataRoot, 'bridge')
const contentSpecs = args.content ? args.content.split(',').map((slug) => ({ slug: slug.trim() })).filter((item) => item.slug) : []
const checks = []
const failures = []

function check(name, condition, detail = '') {
  const passed = Boolean(condition)
  checks.push({ name, passed, detail })
  console.log(`[${passed ? 'PASS' : 'FAIL'}] ${name}${detail ? ' —— ' + detail : ''}`)
  if (!passed) failures.push(name)
  return passed
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function readTail(file, maxBytes = 256 * 1024) {
  try {
    const stat = await fsp.stat(file)
    const start = Math.max(0, stat.size - maxBytes)
    const handle = await fsp.open(file, 'r')
    try {
      const buffer = Buffer.alloc(stat.size - start)
      await handle.read(buffer, 0, buffer.length, start)
      return buffer.toString('utf8')
    } finally {
      await handle.close()
    }
  } catch {
    return ''
  }
}

async function waitJob(engine, jobId, timeoutMs, label) {
  const startedAt = Date.now()
  let lastPrintAt = 0
  for (;;) {
    const job = await engine.getJob(jobId)
    if (!job) throw new Error('任务不存在：' + jobId)
    const now = Date.now()
    if (now - lastPrintAt > 5000) {
      lastPrintAt = now
      const progress = job.progress || {}
      const percent = progress.total ? Math.round((progress.done / progress.total) * 100) : null
      console.log(`[${label}] ${job.status} | ${job.phase || ''}${job.message ? ' | ' + job.message : ''}${percent !== null ? ' | ' + percent + '%' : ''}${progress.bytes ? ' | ' + (progress.bytes / 1048576).toFixed(1) + 'MB' : ''}`)
    }
    if (job.status === 'succeeded' || job.status === 'failed') return job
    if (now - startedAt > timeoutMs) throw new Error(label + '超时（' + Math.round(timeoutMs / 1000) + 's）：' + jobId)
    await sleep(1000)
  }
}

async function main() {
  console.log('=== DSH启动器 v3 E2E（核心 + 可选适配器）===')
  console.log('数据目录：' + dataRoot)
  console.log('参数：version=' + args.version + ' loader=' + args.loader + ' content=' + (args.content || '(无)') + ' assets=' + args.assets)

  await fsp.rm(dataRoot, { recursive: true, force: true })
  adapter.configure({})
  registerGame(adapter, 'external')

  const engine = createEngine({
    config: { dataRoot, downloadConcurrency: 16, retries: 2 },
    log: (line) => {
      if (process.env.E2E_VERBOSE) console.log('  ' + line)
    },
  })
  await engine.init()
  try {
    const games = await engine.listGames()
    check('注册表中有适配器游戏', games.some((game) => game.id === 'minecraft'), 'games=' + games.map((game) => game.id).join(','))
    check('游戏来自外部适配器', games.some((game) => game.id === 'minecraft' && game.source === 'external'))

    const versions = await engine.listVersions({ game: 'minecraft' })
    check('版本列表 latestRelease 是字符串', typeof versions.latestRelease === 'string' && versions.latestRelease.length > 0, 'latestRelease=' + versions.latestRelease)
    check('版本列表数量 > 100', Number(versions.count) > 100, 'count=' + versions.count)
    const versionEntry = (versions.versions || []).find((item) => item.id === args.version)
    check('目标版本存在：' + args.version, Boolean(versionEntry), versionEntry ? versionEntry.id : '（前 500 条里没有）')

    if (args.loader) {
      const loaders = await engine.listLoaders({ game: 'minecraft', version: args.version, type: args.loader })
      const list = loaders.versions || loaders.items || []
      check('加载器列表非空（' + args.loader + '）', list.length > 0, 'count=' + list.length + ' 首个=' + (list[0] && (list[0].version || list[0].id)))
    }

    if (contentSpecs.length) {
      const found = await engine.searchContent({ game: 'minecraft', query: args.content, version: args.version, loader: args.loader, limit: 8 })
      check('内容搜索有结果（' + args.content + '）', Array.isArray(found.hits) && found.hits.length > 0, 'hits=' + (found.hits ? found.hits.length : 0))
      const slug = (found.hits && found.hits[0] && (found.hits[0].slug || found.hits[0].projectId)) || args.content
      const project = await engine.contentVersions({ game: 'minecraft', id: slug, version: args.version, loader: args.loader })
      const projectVersions = Array.isArray(project) ? project : project && Array.isArray(project.versions) ? project.versions : []
      check('内容版本列表非空', projectVersions.length > 0, 'versions=' + projectVersions.length)
    }

    console.log('\n--- 安装实例 ---')
    const options = { loader: args.loader || 'none', loaderVersion: '', memoryMb: 2048, assetsMode: args.assets }
    const installStartedAt = Date.now()
    const install = await engine.installInstance({ game: 'minecraft', version: args.version, name: args.name, memoryMb: 2048, options, content: contentSpecs })
    check('安装返回 jobId/instanceId', Boolean(install.jobId && install.instanceId), 'jobId=' + install.jobId + ' instanceId=' + install.instanceId)
    const installJob = await waitJob(engine, install.jobId, args.installTimeout, 'install')
    check('安装任务成功', installJob.status === 'succeeded', installJob.error || '')
    const installSeconds = (Date.now() - installStartedAt) / 1000
    console.log('安装耗时：' + installSeconds.toFixed(1) + 's')

    const detail = await engine.getInstance(install.instanceId)
    check('实例状态 ready', detail.instance && detail.instance.status === 'ready', 'status=' + (detail.instance && detail.instance.status) + ' err=' + (detail.instance && detail.instance.installError))
    check('实例版本号正确', detail.instance && detail.instance.versionId === args.version, 'versionId=' + (detail.instance && detail.instance.versionId))
    check('实例游戏目录存在', Boolean(detail.gameDir), detail.gameDir)
    if (contentSpecs.length) {
      const installedContent = detail.instance && Array.isArray(detail.instance.content) ? detail.instance.content : []
      check('实例内容数 >= 1', installedContent.length >= 1, 'content=' + installedContent.length)
    }

    const verified = await engine.verifyInstance(install.instanceId)
    check('实例校验通过', verified.ok === true, JSON.stringify(verified.problems || []).slice(0, 200))

    console.log('\n--- 启动实例 ---')
    const launch = await engine.launch(install.instanceId)
    const launchJob = await waitJob(engine, launch.jobId, 180000, 'launch')
    check('启动任务成功', launchJob.status === 'succeeded', launchJob.error || '')
    const launchResult = (launchJob.result || {})
    check('启动返回 pid 与日志路径', Boolean(launchResult.pid && launchResult.logPath), 'pid=' + launchResult.pid)
    const stateAfterLaunch = await engine.getState()
    check('运行列表中包含实例', Array.isArray(stateAfterLaunch.running) && stateAfterLaunch.running.includes(install.instanceId), 'running=' + JSON.stringify(stateAfterLaunch.running))

    const markers = ['Setting user', 'Backend library', 'OpenAL initialized', 'Sound engine started', 'LWJGL']
    const deadline = Date.now() + Number(args.launchWait)
    let logText = ''
    let hit = []
    while (Date.now() < deadline) {
      logText = await readTail(launchResult.logPath || '')
      hit = markers.filter((marker) => logText.includes(marker))
      if (hit.length >= 2) break
      await sleep(2000)
    }
    check('启动日志包含运行证据', hit.length >= 2, '命中：' + hit.join(' / '))
    if (hit.length < 2) console.log(logText.split(/\r?\n/).slice(-20).join('\n'))

    console.log('\n--- 停止实例 ---')
    const stop = await engine.stop(install.instanceId)
    await sleep(500)
    const stateAfterStop = await engine.getState()
    check('停止后不在运行列表', Array.isArray(stateAfterStop.running) && !stateAfterStop.running.includes(install.instanceId), 'stopped=' + JSON.stringify(stop))

    console.log('\n--- 删除实例 ---')
    const removed = await engine.deleteInstance(install.instanceId)
    check('实例已删除', removed && removed.deleted === true, JSON.stringify(removed))
    const remaining = await engine.listInstances()
    check('实例列表为空', Array.isArray(remaining) && remaining.length === 0, 'remaining=' + (remaining ? remaining.length : '?'))
  } finally {
    engine.dispose()
    unregisterGame('minecraft')
  }

  const passCount = checks.filter((item) => item.passed).length
  console.log('\n================ 汇总 ================')
  console.log(`E2E：PASS ${passCount} / FAIL ${failures.length}`)
  if (failures.length) {
    console.log('失败项：' + failures.join(' | '))
    console.log('数据目录保留以便排查：' + dataRoot)
    process.exitCode = 1
  } else {
    console.log('数据目录：' + dataRoot + '（可用 --keep 前自行清理）')
    process.exitCode = 0
  }
}

main().catch((error) => {
  console.error('E2E 失败：' + (error && error.stack ? error.stack : error))
  process.exitCode = 1
})
