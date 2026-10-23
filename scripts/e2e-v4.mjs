#!/usr/bin/env node
// e2e-v4.mjs —— 端到端验收：本体 + 附属启动器（本地 zip）→ 游戏出现 → 安装实例 → 启动 → 停止 → 删除
//
// 用法：
//   node scripts/e2e-v4.mjs --zip <附属启动器 zip 路径> [--version 1.20.1] [--launch-wait 45000]
//                           [--root test/tmp/e2e-v4-data] [--name e2e-v4] [--assets index] [--keep]
//
// 退出码 0 = 全部通过。
import fsp from 'node:fs/promises'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createEngine } from '../lib/core/engine.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
function argValue(flag, fallback) {
  const index = process.argv.indexOf(flag)
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback
}
const DATA_ROOT = path.resolve(ROOT, argValue('--root', 'test/tmp/e2e-v4-data'))
const ZIP_PATH = path.resolve(ROOT, argValue('--zip', '../dsh-launcher-minecraft/dist/minecraft-launcher-1.0.0.zip'))
const MC_VERSION = argValue('--version', '1.20.1')
const LAUNCH_WAIT = Number(argValue('--launch-wait', '45000'))
const ASSETS_MODE = argValue('--assets', 'index')
const INSTANCE_NAME = argValue('--name', 'e2e-v4')
const KEEP = process.argv.includes('--keep')

process.env.DSH_LAUNCHER_BRIDGE_DIR = path.join(DATA_ROOT, 'bridge')

const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok: Boolean(ok), detail })
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? ' —— ' + detail : ''))
}
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
async function waitFor(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await predicate()
    if (value) return value
    await sleep(500)
  }
  throw new Error('等待超时：' + label)
}
function fail(testName, error) {
  check(testName, false, String((error && error.message) || error))
}
const startedAt = Date.now()

let engine = null
let instanceId = null
try {
  if (!fs.existsSync(ZIP_PATH)) throw new Error('找不到附属启动器 zip：' + ZIP_PATH)
  await fsp.rm(DATA_ROOT, { recursive: true, force: true })
  engine = createEngine({ config: { dataRoot: DATA_ROOT, downloadConcurrency: 16, retries: 3 }, log: () => {} })
  await engine.init()
  check('引擎初始化', true)

  // 1) 安装附属启动器（本机 zip 来源）
  const install = await engine.installSubLauncher({ file: ZIP_PATH })
  check('附属启动器安装任务已创建', Boolean(install && install.jobId), install && install.jobId)
  const subJob = await engine.waitJob(install.jobId, 120000)
  check('附属启动器安装成功', subJob.status === 'succeeded', subJob.error || subJob.status)
  const launchers = await engine.listSubLaunchers()
  check('已登记附属启动器', launchers.some((item) => item.id === 'minecraft'), JSON.stringify(launchers.map((item) => item.id)))
  const minecraft = launchers.find((item) => item.id === 'minecraft')
  check('附属启动器版本', Boolean(minecraft && /^\d+\.\d+\.\d+$/.test(String(minecraft.version))), minecraft && minecraft.version)

  // 2) 游戏自动出现（热加载）
  const game = await waitFor(async () => {
    const games = engine.listGames()
    return games.find((item) => item.id === 'minecraft') || null
  }, 20000, '游戏自动出现')
  check('游戏自动出现在列表', Boolean(game), game && game.label)
  check('游戏来源为 external', game && game.source === 'external', game && game.source)

  // 3) 版本清单
  const versions = await engine.listVersions({ game: 'minecraft' })
  check('最新稳定版本号为字符串', typeof versions.latestRelease === 'string' && versions.latestRelease.length > 0, versions.latestRelease)
  const versionList = Array.isArray(versions.versions) ? versions.versions : []
  check('版本清单非空', versionList.length > 0, `count=${versions.count}`)
  check('目标版本存在', versionList.some((item) => item.id === MC_VERSION), MC_VERSION)

  // 4) 安装实例（会真实下载游戏本体，首次较慢）
  const installStart = Date.now()
  const installed = await engine.installInstance({
    game: 'minecraft',
    version: MC_VERSION,
    name: INSTANCE_NAME,
    options: { loader: 'none', memoryMb: 2048, assetsMode: ASSETS_MODE },
  })
  instanceId = installed.instanceId
  check('实例安装任务已创建', Boolean(installed.jobId), installed.jobId)
  const job = await engine.waitJob(installed.jobId, 900000)
  check('实例安装成功', job.status === 'succeeded', job.error || job.status)
  console.log(`  安装耗时：${((Date.now() - installStart) / 1000).toFixed(1)}s`)

  // 5) 实例详情/校验
  const detail = await engine.getInstance(instanceId)
  check('实例状态 ready', detail.instance.status === 'ready', detail.instance.status)
  check('实例版本号正确', detail.instance.versionId === MC_VERSION, detail.instance.versionId)
  check('实例的下载器目录存在', fs.existsSync(detail.gameDir), detail.gameDir)
  const verify = await engine.verifyInstance(instanceId)
  check('实例校验通过', verify.ok === true, JSON.stringify(verify.problems || []).slice(0, 200))

  // 6) 启动
  const launched = await engine.launch(instanceId)
  const launchJob = await engine.waitJob(launched.jobId, 60000)
  check('启动任务成功', launchJob.status === 'succeeded', launchJob.error || launchJob.status)
  const pid = launchJob.result && launchJob.result.pid
  check('进程已启动', Number.isInteger(pid) && pid > 0, String(pid))

  // 7) 等日志证据（真实游戏进程）
  const evidence = await waitFor(async () => {
    const log = await engine.getInstanceLog(instanceId, 400)
    const text = String(log.text || (log.lines || []).join('\n'))
    if (/Setting user|Backend library|OpenAL initialized|Sound engine started|LWJGL/.test(text)) return text
    return null
  }, LAUNCH_WAIT, '游戏启动日志证据')
  check('日志出现启动证据', /Setting user|Backend library|OpenAL initialized|Sound engine started|LWJGL/.test(evidence))
  const running = await engine.getState()
  check('运行中列表包含实例', (running.running || []).includes(instanceId), JSON.stringify(running.running))

  // 8) 停止并删除
  const stopped = await engine.stop(instanceId)
  check('停止成功', stopped && stopped.stopped === true, JSON.stringify(stopped))
  await sleep(500)
  const stateAfter = await engine.getState()
  check('实例已不在运行中', !(stateAfter.running || []).includes(instanceId), JSON.stringify(stateAfter.running))
  if (!KEEP) {
    await engine.deleteInstance(instanceId)
    instanceId = null
    const stateFinal = await engine.getState()
    check('实例已删除', stateFinal.instances.length === 0, String(stateFinal.instances.length))
  }
} catch (error) {
  check('端到端流程无异常', false, String((error && error.message) || error))
} finally {
  try {
    if (engine && instanceId && !KEEP) {
      await engine.stop(instanceId).catch(() => {})
      await engine.deleteInstance(instanceId).catch(() => {})
    }
  } catch {
    /* ignore */
  }
  try {
    if (engine) engine.dispose()
  } catch {
    /* ignore */
  }
  if (!KEEP) await fsp.rm(DATA_ROOT, { recursive: true, force: true }).catch(() => {})
}

const failed = results.filter((item) => !item.ok)
const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1)
if (failed.length) {
  console.error(`FAIL e2e-v4：${failed.length} 项失败（共 ${results.length} 项，${elapsed}s）`)
  for (const item of failed) console.error(`  - ${item.name}${item.detail ? '：' + item.detail : ''}`)
  process.exit(1)
}
console.log(`PASS e2e-v4：${results.length} 项全部通过（${elapsed}s）`)
