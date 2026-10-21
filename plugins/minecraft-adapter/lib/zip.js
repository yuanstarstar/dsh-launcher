// lib/zip.js —— 纯 Node ZIP 读取/解压（零依赖 ESM，仅 node:fs / node:path / node:zlib）
//
// 契约：docs/CONTRACT.md §3。
// 实现方式：从文件尾部最多 128KB 内找 EOCD -> 读中央目录 -> 按需读本地文件头 + 压缩数据。
// 支持 store(0) / deflate(8)；信任中央目录里的 size（兼容 flag bit3 data descriptor）；
// UTF-8 文件名（flag bit11），否则按 CP437 解码；反斜杠统一转 '/'；拒绝 '..' 路径穿越。
// 内存逐 entry 处理（最大 entry 有多大就占多大），可解压 49MB 级 Adoptium JRE zip。
import fsp from 'node:fs/promises'
import path from 'node:path'
import zlib from 'node:zlib'

const SIG_LOCAL = 0x04034b50 // 本地文件头
const SIG_CENTRAL = 0x02014b50 // 中央目录项
const SIG_EOCD = 0x06054b50 // 目录结尾记录
const SIG_CD_SIGNATURE = 0x05054b50 // 中央目录数字签名（忽略）
const EOCD_SCAN_LIMIT = 128 * 1024 // 从尾部最多扫描 128KB 找 EOCD
const FLAG_ENCRYPTED = 0x0001
const FLAG_UTF8 = 0x0800
const EXT_ATTR_DIRECTORY = 0x10

// CP437 0x80-0xFF 的高半区（非 UTF-8 标志的老 zip 文件名编码）
const CP437_HIGH =
  'ÇüéâäàåçêëèïîìÄÅ' +
  'ÉæÆôöòûùÿÖÜ¢£¥₧ƒ' +
  'áíóúñÑªº¿⌐¬½¼¡«»' +
  '░▒▓│┤╡╢╖╕╣║╗╝╜╛┐' +
  '└┴┬├─┼╞╟╚╔╩╦╠═╬╧' +
  '╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀' +
  'αßΓπΣσµτΦΘΩδ∞φε∩' +
  '≡±≥≤⌠⌡÷≈°∙·√ⁿ²■\u00a0'

/* ----------------------------------------------------------------------------
 * 基础工具
 * ------------------------------------------------------------------------- */

function decodeEntryName(buf, flags) {
  if ((flags & FLAG_UTF8) !== 0) return buf.toString('utf8')
  let out = ''
  for (const byte of buf) out += byte < 0x80 ? String.fromCharCode(byte) : CP437_HIGH[byte - 0x80]
  return out
}

/** 统一分隔符：反斜杠转 '/'，去掉开头的 './'。 */
function normalizeEntryName(name) {
  return String(name || '')
    .replace(/\\/g, '/')
    .replace(/^(\.\/)+/, '')
}

async function statOrNull(file) {
  try {
    return await fsp.stat(file)
  } catch {
    return null
  }
}

/** 从指定偏移精确读取 length 字节；读不满视为文件损坏。 */
async function readAt(fh, position, length, zipPath) {
  const buf = Buffer.alloc(length)
  let off = 0
  while (off < length) {
    const { bytesRead } = await fh.read(buf, off, length - off, position + off)
    if (bytesRead === 0) {
      throw new Error(`ZIP 文件不完整：偏移 ${position + off} 处无法继续读取（${zipPath}）`)
    }
    off += bytesRead
  }
  return buf
}

/* ----------------------------------------------------------------------------
 * EOCD 与中央目录
 * ------------------------------------------------------------------------- */

/** 从文件尾部扫描 EOCD 并解析（拒绝 ZIP64 / 分卷，契约 §3）。 */
async function readEocd(fh, fileSize, zipPath) {
  if (fileSize < 22) throw new Error(`不是有效的 ZIP 文件（大小仅 ${fileSize} B）：${zipPath}`)
  const scanLen = Math.min(fileSize, EOCD_SCAN_LIMIT)
  const buf = Buffer.alloc(scanLen)
  let off = 0
  while (off < scanLen) {
    const { bytesRead } = await fh.read(buf, off, scanLen - off, fileSize - scanLen + off)
    if (bytesRead === 0) break
    off += bytesRead
  }
  for (let i = scanLen - 22; i >= 0; i -= 1) {
    if (buf.readUInt32LE(i) !== SIG_EOCD) continue
    const commentLen = buf.readUInt16LE(i + 20)
    // EOCD 必须正好结束在文件末尾（注释长度自洽），否则是数据里碰巧出现的签名
    if (i + 22 + commentLen !== scanLen) continue
    const diskNumber = buf.readUInt16LE(i + 4)
    const cdDisk = buf.readUInt16LE(i + 6)
    const totalEntries = buf.readUInt16LE(i + 10)
    const cdSize = buf.readUInt32LE(i + 12)
    const cdOffset = buf.readUInt32LE(i + 16)
    if (totalEntries === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
      throw new Error(`不支持 ZIP64 格式的压缩包（请用标准 ZIP）：${zipPath}`)
    }
    if (diskNumber !== 0 || cdDisk !== 0) {
      throw new Error(`不支持分卷 ZIP（多磁盘）压缩包：${zipPath}`)
    }
    return { totalEntries, cdSize, cdOffset }
  }
  throw new Error(`不是有效的 ZIP 文件（尾部 ${Math.round(scanLen / 1024)}KB 内未找到 EOCD，可能损坏或为 ZIP64）：${zipPath}`)
}

/** 解析中央目录，返回内部条目（含 localOffset 等字段）。 */
async function readCentralDirectory(fh, eocd, zipPath) {
  if (eocd.cdSize === 0) {
    if (eocd.totalEntries !== 0) {
      throw new Error(`ZIP 中央目录为空但条目数声明为 ${eocd.totalEntries}：${zipPath}`)
    }
    return []
  }
  const cd = await readAt(fh, eocd.cdOffset, eocd.cdSize, zipPath)
  const entries = []
  let p = 0
  while (p + 46 <= cd.length) {
    const sig = cd.readUInt32LE(p)
    if (sig === SIG_CD_SIGNATURE) break // 中央目录数字签名，直接忽略
    if (sig !== SIG_CENTRAL) {
      throw new Error(`ZIP 中央目录损坏（偏移 ${p} 处签名异常）：${zipPath}`)
    }
    const flags = cd.readUInt16LE(p + 8)
    const method = cd.readUInt16LE(p + 10)
    const compressedSize = cd.readUInt32LE(p + 20)
    const size = cd.readUInt32LE(p + 24)
    const nameLen = cd.readUInt16LE(p + 28)
    const extraLen = cd.readUInt16LE(p + 30)
    const commentLen = cd.readUInt16LE(p + 32)
    const externalAttr = cd.readUInt32LE(p + 38)
    const localOffset = cd.readUInt32LE(p + 42)
    if (p + 46 + nameLen > cd.length) {
      throw new Error(`ZIP 中央目录条目损坏（文件名越界）：${zipPath}`)
    }
    if (size === 0xffffffff || compressedSize === 0xffffffff || localOffset === 0xffffffff) {
      throw new Error(`不支持 ZIP64 格式的压缩包（条目 ${p} 使用 64 位字段）：${zipPath}`)
    }
    const rawName = decodeEntryName(cd.subarray(p + 46, p + 46 + nameLen), flags)
    const name = normalizeEntryName(rawName)
    const isDirectory = name.endsWith('/') || (externalAttr & EXT_ATTR_DIRECTORY) !== 0
    entries.push({ name, rawName, flags, method, compressedSize, size, localOffset, isDirectory })
    p += 46 + nameLen + extraLen + commentLen
  }
  if (entries.length !== eocd.totalEntries) {
    throw new Error(`ZIP 中央目录条目数不符：EOCD 声明 ${eocd.totalEntries}，实际解析到 ${entries.length}（${zipPath}）`)
  }
  return entries
}

/** 打开文件并读取 ZIP 索引（调用方负责关闭 fh）。 */
async function readZipIndex(fh, zipPath) {
  const stat = await fh.stat()
  const eocd = await readEocd(fh, stat.size, zipPath)
  const entries = await readCentralDirectory(fh, eocd, zipPath)
  return entries
}

/* ----------------------------------------------------------------------------
 * 读取单个条目内容
 * ------------------------------------------------------------------------- */

function findEntry(entries, entryName) {
  const wanted = normalizeEntryName(entryName)
  if (!wanted) return null
  let exact = entries.find((e) => e.name === wanted)
  if (exact) return exact
  // 大小写不敏感兜底（Windows 上生成的 zip 偶有大小写差异）
  const lower = wanted.toLowerCase()
  exact = entries.find((e) => e.name.toLowerCase() === lower)
  return exact || null
}

/** 读取条目的原始内容（按中央目录 size 校验输出大小）。 */
async function readEntryBuffer(fh, entry, zipPath) {
  if (entry.flags & FLAG_ENCRYPTED) {
    throw new Error(`不支持加密的 ZIP 条目（请用标准 zip）：${entry.name}（${zipPath}）`)
  }
  const local = await readAt(fh, entry.localOffset, 30, zipPath)
  if (local.readUInt32LE(0) !== SIG_LOCAL) {
    throw new Error(`ZIP 本地文件头损坏：${entry.name}（${zipPath}）`)
  }
  const nameLen = local.readUInt16LE(26)
  const extraLen = local.readUInt16LE(28)
  const dataOffset = entry.localOffset + 30 + nameLen + extraLen
  if (entry.compressedSize === 0) {
    if (entry.size !== 0) throw new Error(`ZIP 条目大小异常（压缩数据为 0 但原始大小非 0）：${entry.name}（${zipPath}）`)
    return Buffer.alloc(0)
  }
  const compressed = await readAt(fh, dataOffset, entry.compressedSize, zipPath)
  let data
  if (entry.method === 0) {
    data = compressed
  } else if (entry.method === 8) {
    try {
      data = zlib.inflateRawSync(compressed, entry.size > 0 ? { maxOutputLength: entry.size } : undefined)
    } catch (err) {
      throw new Error(`解压失败（deflate）：${entry.name}（${zipPath}）— ${(err && err.message) || err}`)
    }
  } else {
    throw new Error(`不支持的 ZIP 压缩算法 method=${entry.method}：${entry.name}（${zipPath}）`)
  }
  if (entry.size > 0 && data.length !== entry.size) {
    throw new Error(`ZIP 条目解压后大小不符：期望 ${entry.size} B，实际 ${data.length} B（${entry.name}）`)
  }
  return data
}

/** 把条目名按 stripComponents 截断；返回 '' 表示该条目应跳过。 */
function stripEntryName(name, stripComponents) {
  const parts = name.split('/').filter(Boolean)
  return parts.slice(stripComponents).join('/')
}

/** 计算解压目标路径，并防御路径穿越（拒绝写到 destRoot 之外）。 */
function safeJoin(destRoot, relName, originalName) {
  const root = path.resolve(destRoot)
  const target = path.resolve(root, relName)
  const prefix = root.endsWith(path.sep) ? root : root + path.sep
  if (target !== root && !target.startsWith(prefix)) {
    throw new Error(`ZIP 条目路径越界，已拒绝解压：${originalName}`)
  }
  return target
}

async function exists(file) {
  try {
    await fsp.access(file)
    return true
  } catch {
    return false
  }
}

/* ----------------------------------------------------------------------------
 * 对外 API（契约 §3）
 * ------------------------------------------------------------------------- */

/**
 * 列出 zip 内所有条目。
 * @returns {Promise<Array<{name:string,size:number,compressedSize:number,method:number,isDirectory:boolean}>>}
 */
export async function listZipEntries(zipPath) {
  const file = path.resolve(zipPath)
  let fh
  try {
    fh = await fsp.open(file, 'r')
  } catch (err) {
    throw new Error(`无法打开 ZIP 文件：${file} — ${(err && err.message) || err}`)
  }
  try {
    const entries = await readZipIndex(fh, file)
    return entries.map((e) => ({
      name: e.name,
      size: e.size,
      compressedSize: e.compressedSize,
      method: e.method,
      isDirectory: e.isDirectory,
    }))
  } finally {
    await fh.close().catch(() => {})
  }
}

/**
 * 解压全部（或经 filter 筛选的）条目到 destDir。
 * @param {object} [options]
 * @param {(entry:object)=>boolean} [options.filter] 条目过滤器（在 stripComponents 之前执行）
 * @param {number} [options.stripComponents=0] 去掉路径前 N 段（JRE zip 用 1）
 * @param {boolean} [options.overwrite=true] 目标文件已存在时是否覆盖
 * @param {(done:number,total:number)=>void} [options.onProgress] 进度回调
 * @returns {Promise<{entries:number,files:number}>} entries=匹配并处理的条目数，files=实际写出的文件数
 */
export async function unzipTo(zipPath, destDir, options = {}) {
  const file = path.resolve(zipPath)
  const destRoot = path.resolve(destDir)
  const filter = typeof options.filter === 'function' ? options.filter : () => true
  const stripComponents = Math.max(0, Math.floor(Number(options.stripComponents) || 0))
  const overwrite = options.overwrite !== false
  const onProgress = typeof options.onProgress === 'function' ? options.onProgress : null

  let fh
  try {
    fh = await fsp.open(file, 'r')
  } catch (err) {
    throw new Error(`无法打开 ZIP 文件：${file} — ${(err && err.message) || err}`)
  }
  try {
    const allEntries = await readZipIndex(fh, file)
    const matched = []
    for (const entry of allEntries) {
      const publicEntry = {
        name: entry.name,
        size: entry.size,
        compressedSize: entry.compressedSize,
        method: entry.method,
        isDirectory: entry.isDirectory,
      }
      if (filter(publicEntry)) matched.push(entry)
    }
    const total = matched.length
    await fsp.mkdir(destRoot, { recursive: true })

    let files = 0
    let done = 0
    for (const entry of matched) {
      try {
        const rel = stripEntryName(entry.name, stripComponents)
        if (rel) {
          const target = safeJoin(destRoot, rel, entry.name)
          if (entry.isDirectory) {
            await fsp.mkdir(target, { recursive: true })
          } else {
            const skip = !overwrite && (await exists(target))
            if (!skip) {
              const data = await readEntryBuffer(fh, entry, file)
              await fsp.mkdir(path.dirname(target), { recursive: true })
              await fsp.writeFile(target, data)
              files += 1
            }
          }
        }
      } finally {
        done += 1
        if (onProgress) onProgress(done, total)
      }
    }
    return { entries: total, files }
  } finally {
    await fh.close().catch(() => {})
  }
}

/**
 * 读取 zip 内某个条目的文本内容（UTF-8），条目不存在返回 null。
 */
export async function readZipText(zipPath, entryName) {
  const file = path.resolve(zipPath)
  let fh
  try {
    fh = await fsp.open(file, 'r')
  } catch (err) {
    throw new Error(`无法打开 ZIP 文件：${file} — ${(err && err.message) || err}`)
  }
  try {
    const entries = await readZipIndex(fh, file)
    const entry = findEntry(entries, entryName)
    if (!entry || entry.isDirectory) return null
    const data = await readEntryBuffer(fh, entry, file)
    let text = data.toString('utf8')
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1) // 去掉 UTF-8 BOM
    return text
  } finally {
    await fh.close().catch(() => {})
  }
}

/**
 * 把 zip 内单个条目解压到 destFile（原子写）。条目不存在/是目录时返回 false。
 */
export async function extractEntryToFile(zipPath, entryName, destFile) {
  const file = path.resolve(zipPath)
  const dest = path.resolve(destFile)
  let fh
  try {
    fh = await fsp.open(file, 'r')
  } catch (err) {
    throw new Error(`无法打开 ZIP 文件：${file} — ${(err && err.message) || err}`)
  }
  try {
    const entries = await readZipIndex(fh, file)
    const entry = findEntry(entries, entryName)
    if (!entry || entry.isDirectory) return false
    const data = await readEntryBuffer(fh, entry, file)
    await fsp.mkdir(path.dirname(dest), { recursive: true })
    const tmp = `${dest}.${process.pid}.${Date.now()}.part`
    await fsp.writeFile(tmp, data)
    try {
      await fsp.rename(tmp, dest)
    } catch {
      await fsp.rm(dest, { force: true }).catch(() => {})
      await fsp.rename(tmp, dest)
    }
    return true
  } finally {
    await fh.close().catch(() => {})
  }
}

export default { listZipEntries, unzipTo, readZipText, extractEntryToFile }
