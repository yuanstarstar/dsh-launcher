// DSH启动器 v3 · 手动导入提供者
//
// config: { path:'D:\\Games\\SomeGame', executable:'game.exe', args?, versionLabel? }
// 适用于已经在本机安装好的游戏：不复制任何文件，只记录路径，启动时直接运行。
import fsp from 'node:fs/promises'
import path from 'node:path'
import { findExecutable } from '../archive.js'

export const PROVIDER = {
  id: 'manual',
  label: '手动导入',
  description: '指向本机已安装好的游戏目录，不复制文件，只登记路径并直接启动',
}

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

function resolveManualPath(config) {
  // 兼容两种写法：原始配置用 path，规整后的配置用 manualPath（createAdapter 会再次校验）
  const source = typeof config.path === 'string' && config.path.trim() ? config.path : config.manualPath
  const raw = typeof source === 'string' ? source.trim() : ''
  if (!raw) fail('手动导入需要 path（本机游戏目录或可执行文件所在目录）')
  return path.resolve(raw)
}

/** 校验并规整 config（同步，中文错误）。 */
export function validateConfig(config) {
  if (!config || typeof config !== 'object') fail('配置必须是对象')
  const manualPath = resolveManualPath(config)
  const executable = typeof config.executable === 'string' ? config.executable.trim() : ''
  if (!executable) fail('手动导入需要 executable（可执行文件名，例如 game.exe）')
  if (path.isAbsolute(executable)) fail('executable 请填写游戏目录内的相对路径或文件名：' + executable)
  const args = normalizeArgs(config.args, 'args')
  return { manualPath, executable, args }
}

async function statOrNull(filePath) {
  try {
    return await fsp.stat(filePath)
  } catch {
    return null
  }
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

async function resolveExecutable(config, metadata) {
  const manualPath = metadata && metadata.manualPath ? String(metadata.manualPath) : config.manualPath
  const hint = metadata && metadata.executableHint ? String(metadata.executableHint) : config.executable
  if (!manualPath || !hint) fail('手动导入的实例缺少游戏路径信息，请重新添加')
  if (path.isAbsolute(hint)) {
    const found = await statOrNull(hint)
    if (!found) fail('可执行文件不存在：' + hint)
    return { executable: hint, manualPath }
  }
  const info = await statOrNull(manualPath)
  if (!info || !info.isDirectory()) fail('游戏目录不存在或不是目录：' + manualPath)
  const resolved = await findExecutable(manualPath, hint)
  return { executable: resolved, manualPath }
}

async function installManual(ctx, definition, config) {
  const gameDir = ctx.gameDir
  if (!gameDir) fail('缺少游戏安装目录')
  const info = await statOrNull(config.manualPath)
  if (!info) fail('本机路径不存在：' + config.manualPath)
  if (!info.isDirectory()) fail('本机路径不是目录：' + config.manualPath)
  const executable = await findExecutable(config.manualPath, config.executable)
  const metadata = {
    provider: PROVIDER.id,
    definitionId: definition.id,
    versionId: 'installed',
    label: definition.versionLabel || '已安装',
    manualPath: config.manualPath,
    executableHint: config.executable,
    executable,
    args: config.args,
    importedAt: new Date().toISOString(),
  }
  ctx.log('登记本机游戏：' + config.manualPath)
  await writeMetadata(gameDir, metadata)
  return { versionId: 'installed', metadata }
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
    async listVersions() {
      return { versions: [{ id: 'installed', label: '已安装' }], latestRelease: 'installed' }
    },
    async install({ ctx }) {
      return installManual(ctx, definition, config)
    },
    async launch({ ctx }) {
      const metadata = await readMetadata(ctx.gameDir)
      const resolved = await resolveExecutable(config, metadata)
      const args = (metadata && Array.isArray(metadata.args) && metadata.args.length ? metadata.args : config.args) || []
      return { executable: resolved.executable, args: args.slice(), cwd: resolved.manualPath }
    },
    async verify({ ctx }) {
      const problems = []
      const metadata = await readMetadata(ctx.gameDir)
      const manualPath = metadata && metadata.manualPath ? String(metadata.manualPath) : config.manualPath
      const info = await statOrNull(manualPath)
      if (!info) problems.push('本机路径不存在：' + manualPath)
      else if (!info.isDirectory()) problems.push('本机路径不是目录：' + manualPath)
      else {
        try {
          const hint = metadata && metadata.executableHint ? String(metadata.executableHint) : config.executable
          await findExecutable(manualPath, hint)
        } catch (error) {
          problems.push(error.message)
        }
      }
      return { ok: problems.length === 0, problems }
    },
  }
  return adapter
}

export async function testDefinition({ config }) {
  let normalized
  try {
    normalized = validateConfig(config)
  } catch (error) {
    return { ok: false, detail: error.message }
  }
  const info = await statOrNull(normalized.manualPath)
  if (!info) return { ok: false, detail: '路径不存在：' + normalized.manualPath }
  if (!info.isDirectory()) return { ok: false, detail: '路径不是目录：' + normalized.manualPath }
  try {
    const executable = await findExecutable(normalized.manualPath, normalized.executable)
    return { ok: true, detail: '目录可访问，可执行文件：' + executable }
  } catch (error) {
    return { ok: false, detail: error.message }
  }
}

export default { PROVIDER, validateConfig, createAdapter, testDefinition }
