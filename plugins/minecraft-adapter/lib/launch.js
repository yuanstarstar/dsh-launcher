// lib/launch.js —— 只构建启动参数（v3 适配器版）
//
// 与 v2 的区别：这里**不再 spawn 进程**。核心包 lib/core/launch.js 的 launchProcess()
// 负责真正启动；适配器只返回 { executable, args, cwd, env } 交给核心。
//
// 依赖：lib/version.js（参数构建/版本链合并）、lib/util.js（路径/小工具）。
// 不做任何网络请求：运行库/资源/客户端 jar 由 adapter.launch 在调用本函数前用
// lib/vanilla.js 的 ensure* 函数补齐（保证本函数可离线、可单测）。

import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'

import { pathExists, readJson, taskOf } from './util.js'
import {
  mergeVersionChain,
  buildJvmArgs,
  buildGameArgs,
  buildClasspath,
  javaMajor,
  primaryJarVersionId,
} from './version.js'

const LAUNCHER_BRAND = 'DSH-Launcher'
const LAUNCHER_VERSION = '3.0.0'

/**
 * 离线 UUID：等价于 Java 的 UUID.nameUUIDFromBytes(('OfflinePlayer:'+name).getBytes(UTF_8))。
 * md5 → 8-4-4-4-12，version=3，variant=IETF（标准离线 UUID 格式）。
 */
function offlineUuid(name) {
  const seed = `OfflinePlayer:${String(name ?? '')}`
  const bytes = crypto.createHash('md5').update(seed, 'utf8').digest()
  bytes[6] = (bytes[6] & 0x0f) | 0x30 // version 3
  bytes[8] = (bytes[8] & 0x3f) | 0x80 // variant 10xx
  const hex = bytes.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/** 离线用户名：系统用户名清洗到 [A-Za-z0-9_]{1,16}，空则 Player。 */
function offlineUsername() {
  let raw = ''
  try {
    raw = os.userInfo().username || ''
  } catch {
    raw = process.env.USERNAME || process.env.USER || ''
  }
  const cleaned = String(raw).replace(/[^A-Za-z0-9_]/g, '').slice(0, 16)
  return cleaned || 'Player'
}

async function readVersionJson(versionDir, versionId, label) {
  const file = path.join(versionDir, versionId, `${versionId}.json`)
  try {
    return await readJson(file)
  } catch (error) {
    throw new Error(`读取${label}版本文件失败（${file}）：${error?.message || error}；请重新安装该实例。`)
  }
}

/** 找到版本 logging 配置（安装时已下载到 logConfigs），用于替换 JVM 参数里的 ${path}。 */
async function resolveLogConfigPath(merged, paths) {
  const fileId = merged?.logging?.client?.file?.id
  if (!fileId) return null
  const name = String(fileId)
  const candidates = [
    path.join(paths.logConfigs, name),
    path.join(paths.logConfigs, name.endsWith('.xml') ? name : `${name}.xml`),
  ]
  for (const candidate of candidates) {
    if (await pathExists(candidate)) return candidate
  }
  return null
}

/** buildJvmArgs 不处理 ${path}；有日志配置就替换，没有就丢弃该参数避免把字面量传给 JVM。 */
function applyLogConfigToJvmArgs(args, logConfigPath) {
  const output = []
  for (const arg of args) {
    if (typeof arg !== 'string' || !arg.includes('${path}')) {
      output.push(arg)
      continue
    }
    if (logConfigPath) output.push(arg.replace(/\$\{path\}/g, logConfigPath))
    // 无 ${path} 可替换时丢弃该参数
  }
  return output
}

function appendClasspath(classpath, extra) {
  const parts = String(classpath || '')
    .split(path.delimiter)
    .filter(Boolean)
  if (extra && !parts.includes(extra)) parts.push(extra)
  return parts.join(path.delimiter)
}

function collectExtraJvmArgs(instance) {
  const extraJvmArgs = []
  if (Array.isArray(instance?.jvmArgs)) {
    for (const arg of instance.jvmArgs) if (typeof arg === 'string' && arg.trim()) extraJvmArgs.push(arg.trim())
  } else if (typeof instance?.jvmArgs === 'string' && instance.jvmArgs.trim()) {
    for (const arg of instance.jvmArgs.trim().split(/\s+/)) extraJvmArgs.push(arg)
  }
  return extraJvmArgs
}

/**
 * 构建启动参数（不 spawn、不下载）。
 *
 * @param {object} opts
 * @param {object} opts.paths    适配器游戏数据目录（lib/util.js createGamePaths() 的结果）
 * @param {object} opts.instance 实例记录（至少含 versionId；可选 loader/memoryMb/jvmArgs）
 * @param {string} [opts.gameDir] 实例游戏目录（默认 paths.instances/<id> 不存在时退回 paths.root）
 * @param {string} opts.javaPath  java 可执行文件绝对路径（由 adapter 用 ensureJava 解析）
 * @param {object} [opts.task]   核心进度对象（仅用于日志）
 * @returns {Promise<{executable:string,args:string[],cwd:string,env:Record<string,string>}>}
 */
export async function buildLaunchSpec({ paths, instance, gameDir, javaPath, task } = {}) {
  if (!paths?.versions) throw new Error('buildLaunchSpec 缺少 paths（请传入 createGamePaths() 的结果）')
  if (!instance || typeof instance !== 'object') throw new Error('buildLaunchSpec 缺少实例记录 instance')
  if (!instance.versionId) throw new Error('实例缺少 versionId，无法确定原版版本')
  if (!javaPath || typeof javaPath !== 'string') {
    throw new Error('buildLaunchSpec 缺少 javaPath（应先用 ensureJava 解析出 java 可执行文件路径）')
  }
  const t = taskOf(task)
  const cwd = gameDir || instance.gameDir || paths.instances || paths.root

  // 1) 版本链：原版 + 可选加载器
  const baseJson = await readVersionJson(paths.versions, instance.versionId, '原版')
  const loaderVersionId = instance.loader?.versionId
  let merged
  if (loaderVersionId) {
    const loaderJson = await readVersionJson(paths.versions, loaderVersionId, '加载器')
    merged = mergeVersionChain([loaderJson, baseJson])
  } else {
    merged = mergeVersionChain([baseJson])
  }
  const major = javaMajor(merged)
  t.log?.(`构建启动参数：${merged.id || instance.versionId}${loaderVersionId ? `（加载器 ${loaderVersionId}）` : ''}`)

  // 2) 内存与额外 JVM 参数（与原版启动器行为兼容）
  const memoryMb = Number(instance.memoryMb) > 0 ? Math.round(Number(instance.memoryMb)) : 2048
  const xmsMb = Math.min(Math.round(memoryMb / 2), 2048)
  const extraJvmArgs = collectExtraJvmArgs(instance)
  extraJvmArgs.push(
    `-Xmx${memoryMb}M`,
    `-Xms${xmsMb}M`,
    '-Dfile.encoding=UTF-8',
    `-Dminecraft.launcher.brand=${LAUNCHER_BRAND}`,
    `-Dminecraft.launcher.version=${LAUNCHER_VERSION}`,
  )
  // 这些参数只在对应 Java 版本以上可用，低版本加了会导致启动失败
  if (major >= 17) extraJvmArgs.push('--enable-native-access=ALL-UNNAMED')
  if (major >= 24) extraJvmArgs.push('--sun-misc-unsafe-memory-access=allow')

  // 3) 类路径 + natives + 日志配置
  const nativesDir = path.join(cwd, 'natives')
  const jarId = primaryJarVersionId(merged)
  const clientJarPath = jarId ? path.join(paths.versions, jarId, `${jarId}.jar`) : ''
  const classpath = appendClasspath(buildClasspath(merged, paths.libraries, {}), clientJarPath)

  const logConfigPath = await resolveLogConfigPath(merged, paths)
  const jvmArgs = applyLogConfigToJvmArgs(
    buildJvmArgs(merged, {
      classpath,
      nativesDir,
      launcherName: LAUNCHER_BRAND,
      launcherVersion: LAUNCHER_VERSION,
      launcherBrand: LAUNCHER_BRAND,
      extraJvmArgs,
    }),
    logConfigPath,
  )

  // 4) 游戏参数（离线账号；与 v2 行为一致）
  const username = offlineUsername()
  const uuid = offlineUuid(username)
  const gameArgs = buildGameArgs(merged, {
    username,
    uuid,
    accessToken: uuid,
    userType: 'legacy',
    versionType: merged.type || 'release',
    gameDir: cwd,
    assetsDir: paths.assets,
    assetIndex: merged.assetIndex?.id,
    width: Number(instance.width) || 854,
    height: Number(instance.height) || 480,
    serverAddress: instance.serverAddress,
    serverPort: instance.serverPort,
  })

  // java 语法：java <jvm 选项> -cp <cp> <mainClass> <游戏参数>
  const mainClass = merged.mainClass || 'net.minecraft.client.main.Main'
  const args = [...jvmArgs, mainClass, ...gameArgs].filter((arg) => typeof arg === 'string' && arg.length > 0)

  // 5) 环境变量：清掉会污染 JVM 参数的变量（核心 launchProcess 会原样使用）
  const env = { ...process.env }
  delete env.JAVA_TOOL_OPTIONS
  delete env._JAVA_OPTIONS

  return { executable: javaPath, args, cwd, env }
}
