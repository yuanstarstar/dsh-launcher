/**
 * 纯净度检查（v3）：核心包内不得出现任何具体游戏/平台/厂商专用字样。
 *
 * 用法：node scripts/brand-check.mjs [--verbose]
 * 退出码 0 = 全部通过；1 = 有违规。
 *
 * 扫描范围：
 *   1) 用户可见文件：index.js、client.js、locale/*.json、package.json、README.md、
 *      docs/USAGE.md、docs/GAME-ADAPTER.md、icon.svg、cordis.patch.yml
 *   2) 核心实现：lib/core 目录下全部 js 文件（核心包必须完全通用）
 * 不扫描：docs/ARCHITECTURE-v3.md（内部开发规范）、scripts/（测试脚本可用具体 URL）、
 *        plugins/（外部示例适配器，允许出现具体游戏字样）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const VERBOSE = process.argv.includes('--verbose')

// 具体游戏/平台/厂商/镜像/工具链词（大小写不敏感）
const FORBIDDEN = [
  'minecraft',
  'mojang',
  'forge',
  'fabric',
  'quilt',
  'neoforge',
  'modrinth',
  'curseforge',
  'bmclapi',
  'piston',
  'optifine',
  'adoptium',
  '我的世界',
]

// 单独出现的 mc（词边界，避免命中 cmd 等）
const WORD_MC = /\bmc\b/i

const USER_FILES = [
  'index.js',
  'client.js',
  'locale/zh.json',
  'locale/en.json',
  'package.json',
  'README.md',
  'docs/USAGE.md',
  'docs/INSTALL.md',
  'docs/GAME-ADAPTER.md',
  'icon.svg',
  'cordis.patch.yml',
]

const failures = []
let scanned = 0

function checkFile(rel, content, { strict = true } = {}) {
  scanned += 1
  const lines = content.split(/\r?\n/)
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    const lower = line.toLowerCase()
    for (const word of FORBIDDEN) {
      if (lower.includes(word)) failures.push(`${rel}:${i + 1} 含具体游戏/平台字样「${word}」：${line.trim().slice(0, 160)}`)
    }
    if (WORD_MC.test(line)) failures.push(`${rel}:${i + 1} 含独立词「mc」：${line.trim().slice(0, 160)}`)
  }
  if (!strict) return
}

function read(rel) {
  const file = path.join(ROOT, rel)
  if (!fs.existsSync(file)) {
    failures.push(`缺少文件：${rel}`)
    return null
  }
  return fs.readFileSync(file, 'utf8')
}

// 1) 用户可见文件
for (const rel of USER_FILES) {
  const content = read(rel)
  if (content !== null) checkFile(rel, content)
}

// 2) 核心实现全部文件
function walk(dir) {
  const out = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walk(full))
    else if (entry.isFile() && entry.name.endsWith('.js')) out.push(full)
  }
  return out
}

const coreDir = path.join(ROOT, 'lib', 'core')
if (!fs.existsSync(coreDir)) {
  failures.push('缺少核心目录 lib/core')
} else {
  for (const file of walk(coreDir)) {
    const rel = path.relative(ROOT, file).replace(/\\/g, '/')
    checkFile(rel, fs.readFileSync(file, 'utf8'))
  }
}

// 3) 结构断言：核心不得内置游戏目录；不得含内置游戏定义
if (fs.existsSync(path.join(ROOT, 'lib', 'games'))) {
  failures.push('核心包内不应存在 lib/games（游戏专用实现必须做成外部适配器）')
}
const indexContent = read('index.js') || ''
if (!/launcher_/.test(indexContent)) failures.push('index.js 未发现 launcher_* 工具注册')
const toolNames = [...indexContent.matchAll(/name:\s*'(launcher_[a-z0-9_]+)'/g)].map((m) => m[1])
const uniqueTools = [...new Set(toolNames)]
if (uniqueTools.length < 20) failures.push(`index.js 工具数量不足（发现 ${uniqueTools.length} 个 launcher_* 工具）`)

// 4) locale 元数据
for (const lang of ['zh', 'en']) {
  const content = read(`locale/${lang}.json`)
  if (content === null) continue
  try {
    const data = JSON.parse(content)
    if (!data.meta || !data.meta.title) failures.push(`locale/${lang}.json 缺少 meta.title`)
    if (!data.meta || !data.meta.description) failures.push(`locale/${lang}.json 缺少 meta.description`)
  } catch (error) {
    failures.push(`locale/${lang}.json 不是合法 JSON：${error.message}`)
  }
}

// 5) package 清单
const pkg = JSON.parse(read('package.json') || '{}')
if (!pkg.dsh || !pkg.dsh.bundle || !pkg.dsh.bundle.patch) failures.push('package.json 缺少 dsh.bundle.patch')
if (!pkg.dsh || !pkg.dsh.client) failures.push('package.json 缺少 dsh.client')
for (const field of ['index.js', 'client.js', 'cordis.patch.yml', 'icon.svg']) {
  if (!fs.existsSync(path.join(ROOT, field))) failures.push(`清单文件缺失：${field}`)
}
const iconStat = fs.statSync(path.join(ROOT, 'icon.svg'))
if (iconStat.size > 256 * 1024) failures.push('icon.svg 超过 256KiB')

if (VERBOSE) {
  console.log('扫描文件数：' + scanned)
  console.log('工具数量：' + uniqueTools.length)
  console.log(uniqueTools.join(', '))
}

if (failures.length) {
  console.error('FAIL brand-check：' + failures.length + ' 处违规')
  for (const item of failures.slice(0, 80)) console.error('  - ' + item)
  if (failures.length > 80) console.error(`  ……还有 ${failures.length - 80} 条`)
  process.exitCode = 1
} else {
  console.log(`PASS brand-check：核心包纯净（扫描 ${scanned} 个文件，${uniqueTools.length} 个 launcher_* 工具）`)
}
