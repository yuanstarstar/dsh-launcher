/**
 * 构建分发包：打包「DSH启动器」核心包 + 可选适配器包，生成可直接拷到其它机器安装的目录与 zip。
 *
 * 用法：
 *   node scripts/build-dist.mjs               # 输出到 <仓库>/dist/
 *   node scripts/build-dist.mjs --out <目录>  # 自定义输出目录
 *   node scripts/build-dist.mjs --no-zip      # 只生成目录，不压缩
 *
 * 产物结构：
 *   dist/dsh-launcher-<version>/
 *     index.js client.js lib/ locale/ icon.svg package.json cordis.patch.yml
 *     README.md INSTALL.md docs/ plugins/<适配器>/
 *   dist/dsh-launcher-<version>.zip
 *
 * 分发内容不含 data/、test/、tmp/、node_modules/、dist/ 与本机缓存。
 */
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { listZipEntries } from '../lib/core/zip.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function argValue(flag) {
  const index = process.argv.indexOf(flag)
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : null
}

const OUT_DIR = path.resolve(argValue('--out') || path.join(ROOT, 'dist'))
const MAKE_ZIP = !process.argv.includes('--no-zip')

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
const VERSION = pkg.version || '0.0.0'
const TARGET = path.join(OUT_DIR, `dsh-launcher-${VERSION}`)

const EXCLUDE_DIR_NAMES = new Set(['data', 'test', 'tmp', 'node_modules', 'dist', '.git', '.cache'])
const EXCLUDE_FILE_NAMES = new Set(['.DS_Store', 'Thumbs.db'])

function filter(source) {
  const base = path.basename(source)
  if (EXCLUDE_DIR_NAMES.has(base) || EXCLUDE_FILE_NAMES.has(base)) return false
  if (base.endsWith('.log') || base.endsWith('.part')) return false
  return true
}

function copy(src, dest) {
  if (!fs.existsSync(src)) return false
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  fs.cpSync(src, dest, { recursive: true, filter })
  return true
}

function fail(message) {
  console.error(`FAIL build-dist：${message}`)
  process.exit(1)
}

// 1) 清理并创建目标目录
fs.rmSync(TARGET, { recursive: true, force: true })
fs.mkdirSync(TARGET, { recursive: true })

// 2) 核心包文件
const ROOT_FILES = ['index.js', 'client.js', 'package.json', 'cordis.patch.yml', 'icon.svg', 'README.md', 'LICENSE']
const ROOT_DIRS = ['lib', 'locale', 'docs', 'plugins']
let copied = 0
for (const file of ROOT_FILES) {
  if (copy(path.join(ROOT, file), path.join(TARGET, file))) copied += 1
  else fail(`缺少核心文件：${file}`)
}
for (const dir of ROOT_DIRS) {
  if (copy(path.join(ROOT, dir), path.join(TARGET, dir))) copied += 1
}

// 3) 把安装说明放到分发包根目录，方便目标机器第一眼看到
const installDoc = path.join(ROOT, 'docs', 'INSTALL.md')
if (fs.existsSync(installDoc)) fs.copyFileSync(installDoc, path.join(TARGET, 'INSTALL.md'))
else fail('缺少 docs/INSTALL.md')
// 仓库维护者专用的上传教学不进分发包
for (const doc of ['GITHUB-UPLOAD.md', 'GITHUB-WEB-UPLOAD.md']) {
  const contributorDoc = path.join(TARGET, 'docs', doc)
  if (fs.existsSync(contributorDoc)) fs.rmSync(contributorDoc, { force: true })
}

// 4) 校验目录内容：必须包含关键文件，且不能含本机数据
const REQUIRED = [
  'index.js',
  'client.js',
  'package.json',
  'cordis.patch.yml',
  'icon.svg',
  'README.md',
  'INSTALL.md',
  'LICENSE',
  'lib/core/engine.js',
  'lib/core/registry.js',
  'lib/core/http.js',
  'locale/zh.json',
  'locale/en.json',
]
for (const rel of REQUIRED) {
  if (!fs.existsSync(path.join(TARGET, rel))) fail(`分发包缺少关键文件：${rel}`)
}

function walk(dir, rel = '') {
  const out = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const childRel = rel ? `${rel}/${entry.name}` : entry.name
    if (entry.isDirectory()) out.push(...walk(path.join(dir, entry.name), childRel))
    else out.push(childRel)
  }
  return out
}

const files = walk(TARGET)
const forbidden = files.filter((rel) => /(^|\/)(data|test|tmp|node_modules|dist)(\/|$)/.test(rel))
if (forbidden.length) fail(`分发包含不应分发的内容：${forbidden.slice(0, 10).join(', ')}`)

// 5) 压缩（PowerShell Compress-Archive；失败不算致命，目录本身已可用）
let zipPath = null
let zipBytes = 0
if (MAKE_ZIP) {
  zipPath = path.join(OUT_DIR, `dsh-launcher-${VERSION}.zip`)
  fs.rmSync(zipPath, { force: true })
  try {
    execFileSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', `Compress-Archive -Path '${path.join(TARGET, '*')}' -DestinationPath '${zipPath}' -Force`],
      { stdio: 'ignore', windowsHide: true, timeout: 180000 },
    )
    zipBytes = fs.statSync(zipPath).size
    const entries = await listZipEntries(zipPath)
    const bad = entries.filter((entry) => /(^|\/)(data|test|tmp|node_modules|dist)(\/|$)/.test(entry.name))
    if (bad.length) fail(`zip 含不应分发的内容：${bad.slice(0, 10).map((e) => e.name).join(', ')}`)
    const has = (name) => entries.some((entry) => entry.name === name)
    for (const rel of ['index.js', 'client.js', 'cordis.patch.yml', 'lib/core/engine.js']) {
      if (!has(rel)) fail(`zip 缺少关键文件：${rel}`)
    }
  } catch (error) {
    console.warn(`警告：zip 生成/校验失败（目录仍可直接分发）：${String((error && error.message) || error)}`)
    zipPath = null
    zipBytes = 0
  }
}

const adapterRoot = path.join(TARGET, 'plugins')
const adapters = fs.existsSync(adapterRoot) ? fs.readdirSync(adapterRoot).filter((name) => fs.existsSync(path.join(adapterRoot, name, 'package.json'))) : []

console.log(`PASS build-dist：dsh-launcher ${VERSION}`)
console.log(`  输出目录：${TARGET}`)
console.log(`  文件数：${files.length}（核心 ${copied} 项 + 可选适配器 ${adapters.length} 个）`)
if (adapters.length) console.log(`  可选适配器：${adapters.join(', ')}`)
if (zipPath) console.log(`  zip：${zipPath}（${(zipBytes / 1024 / 1024).toFixed(2)} MB）`)
else if (MAKE_ZIP) console.log('  zip：未生成（见上方警告）')
console.log('  目标机器安装见 INSTALL.md：安装核心包 → 重启 DSH → 可选安装适配器（无需重启）。')
