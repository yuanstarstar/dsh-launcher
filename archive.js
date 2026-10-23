// DSH启动器 v3 · 压缩包与可执行文件工具（通用）
//
// 只做与具体游戏无关的通用操作：
//   - extractArchiveToDir：把 ZIP 解压到目录，自动识别并去掉单一顶层目录（常见打包习惯）；
//   - findExecutable：在解压目录里定位可执行文件；
//   - looksLikeZip：按文件头判断是否为 ZIP（用于 archive:'auto'）。
import fsp from 'node:fs/promises'
import path from 'node:path'
import { listZipEntries, unzipTo } from './zip.js'

const ZIP_SIGNATURES = new Set(['504b0304', '504b0506', '504b0708'])

/** 按文件头判断是否为 ZIP 文件。 */
export async function looksLikeZip(filePath) {
  let handle
  try {
    handle = await fsp.open(path.resolve(String(filePath)), 'r')
    const buffer = Buffer.alloc(4)
    const { bytesRead } = await handle.read(buffer, 0, 4, 0)
    if (bytesRead < 4) return false
    return ZIP_SIGNATURES.has(buffer.toString('hex').toLowerCase())
  } catch {
    return false
  } finally {
    if (handle) await handle.close().catch(() => {})
  }
}

function splitTop(name) {
  const parts = String(name || '')
    .replace(/\\/g, '/')
    .split('/')
    .filter(Boolean)
  return parts
}

/** 若所有文件条目都在同一个顶层目录下，返回该目录名；否则返回 null。 */
async function detectSingleRoot(zipPath) {
  const entries = await listZipEntries(zipPath)
  const tops = new Set()
  let hasRootFile = false
  for (const entry of entries) {
    const parts = splitTop(entry.name)
    if (!parts.length) continue
    if (parts.length === 1) {
      if (!entry.isDirectory) hasRootFile = true
      continue
    }
    tops.add(parts[0])
  }
  if (hasRootFile) return null
  if (tops.size !== 1) return null
  return [...tops][0]
}

/**
 * 解压 ZIP 到目标目录。
 * @param {string} zipPath
 * @param {string} destDir
 * @param {object} [options]
 * @param {number} [options.stripComponents] 去掉路径前 N 段；省略时自动识别单一顶层目录并去掉 1 段
 * @param {(done:number,total:number)=>void} [options.onProgress]
 * @returns {Promise<{destDir:string,entries:number,files:number,stripComponents:number}>}
 */
export async function extractArchiveToDir(zipPath, destDir, options = {}) {
  if (typeof zipPath !== 'string' || !zipPath.trim()) throw new Error('压缩包路径无效：' + String(zipPath))
  if (typeof destDir !== 'string' || !destDir.trim()) throw new Error('解压目标目录无效：' + String(destDir))
  let stripComponents
  if (options.stripComponents != null) {
    stripComponents = Math.max(0, Math.floor(Number(options.stripComponents) || 0))
  } else {
    const root = await detectSingleRoot(zipPath)
    stripComponents = root ? 1 : 0
  }
  const result = await unzipTo(zipPath, destDir, {
    stripComponents,
    onProgress: options.onProgress,
  })
  return {
    destDir: path.resolve(destDir),
    entries: result.entries,
    files: result.files,
    stripComponents,
  }
}

async function listRootFiles(dir) {
  const out = []
  const entries = await fsp.readdir(dir, { withFileTypes: true })
  for (const entry of entries) {
    if (!entry.isFile()) continue
    const full = path.join(dir, entry.name)
    let stat = null
    try {
      stat = await fsp.stat(full)
    } catch {
      continue
    }
    out.push({ name: entry.name, full, stat })
  }
  out.sort((a, b) => a.name.localeCompare(b.name))
  return out
}

/**
 * 在目录中定位可执行文件。
 * @param {string} dir 解压/安装目录
 * @param {string} [hint] 相对路径或绝对路径提示；存在则直接返回其绝对路径
 * @param {object} [options]
 * @param {string} [options.platform] 默认 process.platform
 * @returns {Promise<string>} 可执行文件绝对路径
 */
export async function findExecutable(dir, hint, options = {}) {
  const platform = options.platform || process.platform
  const baseDir = path.resolve(String(dir || '.'))
  const info = await fsp.stat(baseDir).catch(() => null)
  if (!info || !info.isDirectory()) throw new Error('游戏目录不存在：' + baseDir)

  if (hint && String(hint).trim()) {
    const text = String(hint).trim()
    const target = path.isAbsolute(text) ? path.resolve(text) : path.resolve(baseDir, text)
    const targetStat = await fsp.stat(target).catch(() => null)
    if (targetStat && targetStat.isFile()) return target
    throw new Error('配置里指定的可执行文件不存在：' + target)
  }

  const files = await listRootFiles(baseDir)
  const isWin = platform === 'win32'
  if (isWin) {
    const exeFiles = files.filter((item) => /\.exe$/i.test(item.name))
    if (exeFiles.length) return exeFiles[0].full
    const batchFiles = files.filter((item) => /\.(bat|cmd)$/i.test(item.name))
    if (batchFiles.length) {
      throw new Error(
        '游戏目录里只有批处理文件（' + batchFiles[0].name + '），需要命令行解释器才能启动；请在配置里指定真正的可执行文件',
      )
    }
    throw new Error('在游戏目录中找不到 .exe 可执行文件：' + baseDir)
  }

  for (const item of files) {
    if ((item.stat.mode & 0o111) === 0) continue
    if (/\.(so|dll|dylib|zip|jar|txt|json|md)$/i.test(item.name)) continue
    return item.full
  }
  throw new Error('在游戏目录中找不到带执行权限的文件：' + baseDir)
}

export default { extractArchiveToDir, findExecutable, looksLikeZip }
