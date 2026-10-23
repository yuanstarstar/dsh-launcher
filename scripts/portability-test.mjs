/**
 * 可移植性检查：保证「DSH启动器」分发包拷到其它机器后能直接安装使用。
 *
 * 用法：node scripts/portability-test.mjs [--verbose]
 * 退出码 0 = 全部通过。
 *
 * 检查项：
 *   1) 默认数据根解析（用户主目录优先、兼容包内旧 data/、可注入路径测试）
 *   2) 运行文件/用户文档里没有写死本机绝对路径（C:\Users\<具体用户名>、/home/<具体用户名>、本仓库路径）
 *   3) cordis.patch.yml 不含 dataRoot 等本机配置、不含绝对路径
 *   4) package.json files 覆盖全部运行时文件、含分发脚本
 *   5) 适配器包不依赖核心包（安装顺序自由），自身 patch 也不写死路径
 *   6) 构建脚本存在且排除 data/test/tmp/node_modules
 *   7) 桥接指针放在用户主目录（跨机器可用）
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveDefaultDataRoot } from '../index.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const VERBOSE = process.argv.includes('--verbose')
let pass = 0
const failures = []
const tmpRoots = []

function check(label, condition, detail = '') {
  if (condition) {
    pass += 1
    if (VERBOSE) console.log(`PASS ${label}`)
  } else {
    failures.push(`${label}${detail ? `：${detail}` : ''}`)
  }
}

function read(rel) {
  try {
    return fs.readFileSync(path.join(ROOT, rel), 'utf8')
  } catch {
    return null
  }
}

function tempDir(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `dsh-launcher-portability-${name}-`))
  tmpRoots.push(dir)
  return dir
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

// 1) 默认数据根解析
try {
  const emptyHome = tempDir('empty-home')
  const emptyLegacy = tempDir('empty-legacy')
  check('空目录时默认用主目录数据根', resolveDefaultDataRoot({ homeDataRoot: emptyHome, legacyDataRoot: emptyLegacy }) === emptyHome)

  const legacyWithData = tempDir('legacy-data')
  fs.mkdirSync(path.join(legacyWithData, 'instances'), { recursive: true })
  check('包内旧数据优先沿用', resolveDefaultDataRoot({ homeDataRoot: tempDir('home-empty2'), legacyDataRoot: legacyWithData }) === legacyWithData)

  const homeWithData = tempDir('home-data')
  fs.mkdirSync(path.join(homeWithData, 'instances'), { recursive: true })
  check('主目录已有数据时优先主目录', resolveDefaultDataRoot({ homeDataRoot: homeWithData, legacyDataRoot: legacyWithData }) === homeWithData)

  const homeConfig = tempDir('home-config')
  fs.writeFileSync(path.join(homeConfig, 'config.json'), '{}')
  check('主目录仅有 config.json 也算已有数据', resolveDefaultDataRoot({ homeDataRoot: homeConfig, legacyDataRoot: emptyLegacy }) === homeConfig)

  check('自定义注入路径生效', resolveDefaultDataRoot({ homeDataRoot: emptyHome, legacyDataRoot: emptyLegacy }) === emptyHome)
} catch (error) {
  failures.push(`默认数据根解析崩溃：${String((error && error.message) || error)}`)
}

// 2) 运行文件与用户文档不得写死本机路径
const USER_LOCAL_PATTERNS = [
  /C:\\Users\\[A-Za-z0-9._-]+/i,
  /\/Users\/[A-Za-z0-9._-]+/,
  /\/home\/[A-Za-z0-9._-]+/,
  /模组开发/,
]
const LOCAL_EXEMPT = new Set(['docs/ARCHITECTURE.md', 'docs/PROVIDERS.md'])
const RUNTIME_FILES = [
  'index.js',
  'client.js',
  'package.json',
  'cordis.patch.yml',
  'README.md',
  'docs/USAGE.md',
  'docs/INSTALL.md',
  'docs/GAME-ADAPTER.md',
  'docs/SUB-LAUNCHER.md',
  'docs/ARCHITECTURE.md',
  'icon.svg',
]
const runtimeList = [...RUNTIME_FILES]
for (const rel of walk(path.join(ROOT, 'lib'))) runtimeList.push(`lib/${rel}`)
for (const rel of walk(path.join(ROOT, 'locale'))) runtimeList.push(`locale/${rel}`)

for (const rel of runtimeList) {
  if (LOCAL_EXEMPT.has(rel)) continue
  const content = read(rel)
  if (content === null) {
    failures.push(`缺少运行文件：${rel}`)
    continue
  }
  for (const pattern of USER_LOCAL_PATTERNS) {
    const match = content.match(pattern)
    if (match) failures.push(`${rel} 写死了本机路径「${match[0]}」`)
  }
}
check('运行文件与文档无本机绝对路径', failures.filter((item) => item.includes('写死了本机路径') || item.includes('缺少运行文件')).length === 0)

// 3) cordis.patch.yml 可移植
const patch = read('cordis.patch.yml')
check('cordis.patch.yml 存在', Boolean(patch))
if (patch) {
  const effective = patch
    .split(/\r?\n/)
    .filter((line) => !line.trim().startsWith('#'))
    .join('\n')
  check('patch 未写死 dataRoot', !/^\s*dataRoot\s*:/m.test(effective))
  check('patch 无绝对路径', !/[A-Za-z]:\\/.test(effective) && !/\/(Users|home)\//.test(effective))
  check('patch 含 insert 与插件名', /insert:/.test(effective) && /@local\/dsh-launcher/.test(effective))
}

// 4) package.json 覆盖运行时文件
const pkgText = read('package.json')
const pkg = pkgText ? JSON.parse(pkgText) : null
check('package.json 可解析', Boolean(pkg))
if (pkg) {
  check('版本号形如 x.y.z', /^\d+\.\d+\.\d+$/.test(String(pkg.version)))
  check('files 包含运行时文件', ['index.js', 'client.js', 'lib/', 'cordis.patch.yml', 'locale/*.json', 'icon.svg', 'docs/USAGE.md', 'docs/INSTALL.md', 'docs/SUB-LAUNCHER.md'].every((entry) => (pkg.files || []).includes(entry)))

  check('导出 ./lib/core/registry.js', Boolean(pkg.exports && pkg.exports['./lib/core/registry.js']))
  check('含 build:dist 脚本', Boolean(pkg.scripts && pkg.scripts['build:dist']))
  check('package.json 无绝对路径', !/[A-Za-z]:\\/.test(pkgText) && !pkgText.includes('模组开发'))
}

// 5) 本体不含任何具体游戏/启动器实现，只提供附属启动器管理能力
check('本体不内置 plugins 目录', !fs.existsSync(path.join(ROOT, 'plugins')))
check('本体无 lib/games 内置游戏', !fs.existsSync(path.join(ROOT, 'lib', 'games')))
check('附属启动器管理模块存在', fs.existsSync(path.join(ROOT, 'lib', 'core', 'sublaunchers.js')))
check('附属启动器开发文档存在', fs.existsSync(path.join(ROOT, 'docs', 'SUB-LAUNCHER.md')))
check('本体工具里没有内置游戏名', !read('index.js') || !/minecraft|我的世界/i.test(read('index.js')))

// 6) 构建脚本
const buildScript = read('scripts/build-dist.mjs')
check('构建脚本存在', Boolean(buildScript))
if (buildScript) {
  check('构建脚本排除本机数据目录', ['data', 'test', 'tmp', 'node_modules'].every((name) => buildScript.includes(`'${name}'`)))
  check('构建脚本生成 zip', /Compress-Archive|\.zip/.test(buildScript))
  check('构建脚本复制 INSTALL.md', /INSTALL\.md/.test(buildScript))
  check('构建脚本含附属启动器文档', /SUB-LAUNCHER\.md/.test(buildScript))
  check('构建脚本打包不含 plugins', !/ROOT_DIRS = \[[^\]]*'plugins'/.test(buildScript))
}

// 7) 桥接指针位置（用户主目录）
const engine = read('lib/core/engine.js')
check('桥接指针基于用户主目录', Boolean(engine) && /os\.homedir\(\)/.test(engine) && /\.dsh-launcher/.test(engine))

for (const dir of tmpRoots) {
  try {
    fs.rmSync(dir, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
}

if (failures.length) {
  console.error(`FAIL portability-test：${failures.length} 项失败`)
  for (const item of failures) console.error(`  - ${item}`)
  process.exit(1)
}
console.log(`PASS portability-test：${pass} 项全部通过（默认数据根/无本机路径/可移植 patch/分发包检查）`)
