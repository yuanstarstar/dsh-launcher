// DSH启动器 · Host 入口
// 注册 Agent 工具（launcher_*）、HTTP API（/dsh-launcher/api）与系统提示词。
// 本文件属于纯净核心包：不含任何具体游戏或平台专用代码。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createEngine } from './lib/core/engine.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const API_PREFIX = '/dsh-launcher/api'
const BODY_LIMIT = 256 * 1024

// 数据根默认放在用户主目录，便于把插件目录拷到其它机器后直接使用；
// 兼容早期版本把 data/ 放在包目录内的布局（包目录内有数据时优先沿用，避免迁移）。
const HOME_DATA_ROOT = path.join(os.homedir(), '.dsh-launcher', 'data')
const PACKAGE_DATA_ROOT = path.join(__dirname, 'data')

function hasData(dir) {
  try {
    return fs.existsSync(path.join(dir, 'instances')) || fs.existsSync(path.join(dir, 'config.json')) || fs.existsSync(path.join(dir, 'cache'))
  } catch {
    return false
  }
}

/** 解析默认数据根：优先已存在数据的目录，其次用户主目录（可注入路径便于测试）。 */
export function resolveDefaultDataRoot(options = {}) {
  const homeDataRoot = options.homeDataRoot || HOME_DATA_ROOT
  const legacyDataRoot = options.legacyDataRoot || PACKAGE_DATA_ROOT
  if (hasData(homeDataRoot)) return homeDataRoot
  if (hasData(legacyDataRoot)) return legacyDataRoot
  return homeDataRoot
}

export const name = '@local/dsh-launcher'
export const inject = ['webServer']

const OUTPUT = {
  schema: { type: 'object' },
  render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
}

const PROMPT = [
  '本会话装了「DSH启动器」插件：它是一个通用的游戏下载与启动框架，核心本身不含任何具体游戏，游戏需要通过「添加游戏」引入。',
  '可用的游戏来源：1) GitHub Releases 提供者（repo 形如 owner/name，自动下载 release 资源）；2) URL 清单提供者（jsonUrl 返回版本清单，或直接给静态 versions）；3) 手动导入已安装游戏（给目录与可执行文件名）。另外用户可能安装了外部适配器包，那些游戏会直接出现在游戏列表里。',
  '典型对话流程：launcher_list_games 看已有哪些游戏 → 若没有，问用户想添加什么游戏并 launcher_add_game → launcher_list_versions 拿版本号 → launcher_install_game 安装（可带 content 内容列表）→ 等待任务完成 → launcher_launch_game 启动。',
  '用户说「启动某个游戏」时：先用 launcher_list_instances 找实例；没有实例就先按上面的流程安装。用户说「打开游戏文件夹/模组文件夹」时用 launcher_open_folder（kind 可为 game/content/logs）。',
  '不要凭记忆编造版本号、游戏 id 或文件名，一切以工具返回为准。版本号一律使用 launcher_list_versions 返回的字符串 id。',
  '安装与启动都是后台任务：安装返回 jobId 后可用 launcher_job_status 查看进度和日志；安装完成前实例状态不是 ready，不能启动。',
  '出错时把工具返回的中文错误原样告诉用户，并给出下一步建议（例如检查网络、换提供者、补齐可执行文件名）。',
  '用户没有指定具体版本时，简短确认一次即可（例如「装最新版本可以吗」），不要反复追问；不同游戏/版本可以各建一个实例并存。',
].join('\n')

const plain = (value) => {
  try {
    return JSON.parse(JSON.stringify(value === undefined ? null : value))
  } catch {
    return value
  }
}

const errorMessage = (error) => String((error && error.message) || error)

function classifyError(error) {
  const message = errorMessage(error)
  if (/正在运行|已注册|已结束|已存在/.test(message)) return 409
  if (/还没有添加任何游戏|游戏不存在|实例不存在|任务不存在|未找到|不存在/.test(message)) return 404
  if (/缺少|无效|不合法|请求体|不支持|非法|不能|请先|请传|请提供|参数|必须|需要/.test(message)) return 400
  return 500
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'content-length': Buffer.byteLength(body) })
  res.end(body)
}

function fail(res, error) {
  sendJson(res, classifyError(error), { ok: false, error: errorMessage(error) })
}

function ok(res, data) {
  sendJson(res, 200, { ok: true, data: plain(data) })
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > BODY_LIMIT) {
        reject(new Error('请求体过大（上限 256KB）'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8').trim()
      if (!text) return resolve({})
      try {
        const value = JSON.parse(text)
        resolve(value && typeof value === 'object' ? value : {})
      } catch {
        reject(new Error('请求体不是合法 JSON'))
      }
    })
    req.on('error', reject)
  })
}

function toInt(value, fallback) {
  const number = Number(value)
  return Number.isFinite(number) ? Math.round(number) : fallback
}

function registerRoutes(ctx, engine, logger) {
  if (!ctx.webServer || typeof ctx.webServer.register !== 'function') {
    logger?.warn?.('%s: 没有可用的 webServer 服务，HTTP API 未注册', name)
    return () => {}
  }
  const dispose = ctx.webServer.register({
    kind: 'prefix',
    path: API_PREFIX,
    handler: async (req, res) => {
      const requestUrl = new URL(req.url || '/', 'http://localhost')
      const sub = requestUrl.pathname.slice(API_PREFIX.length).replace(/\/+$/, '') || '/'
      const method = (req.method || 'GET').toUpperCase()
      const query = requestUrl.searchParams
      try {
        if (method === 'GET' && sub === '/state') return ok(res, await engine.getState())
        if (method === 'GET' && sub === '/games') return ok(res, { games: engine.listGames() })
        if (method === 'POST' && sub === '/games') return ok(res, await engine.addGame(await readBody(req)))
        if (method === 'POST' && sub === '/games/test') {
          const result = await engine.testGame(await readBody(req))
          if (result && result.ok === false) return sendJson(res, 400, { ok: false, error: result.detail || result.message || '测试未通过', detail: plain(result) })
          return ok(res, result)
        }
        if (method === 'DELETE' && /^\/games\/[^/]+$/.test(sub)) return ok(res, await engine.removeGame(decodeURIComponent(sub.split('/')[2])))
        if (method === 'GET' && sub === '/versions') {
          return ok(res, await engine.listVersions({ game: query.get('game') || '', force: query.get('force') === '1' || query.get('force') === 'true' }))
        }
        if (method === 'GET' && sub === '/loaders') {
          const game = query.get('game') || ''
          const version = query.get('version') || ''
          if (!game) return sendJson(res, 400, { ok: false, error: '缺少游戏 id 参数' })
          if (!version) return sendJson(res, 400, { ok: false, error: '缺少游戏版本号参数' })
          return ok(res, await engine.listLoaders({ game, version, type: query.get('type') || undefined }))
        }
        if (method === 'GET' && sub === '/content/search') {
          const game = query.get('game') || ''
          const keyword = query.get('q') || query.get('query') || ''
          if (!game) return sendJson(res, 400, { ok: false, error: '缺少游戏 id 参数' })
          if (!keyword) return sendJson(res, 400, { ok: false, error: '缺少搜索关键词参数' })
          return ok(res, await engine.searchContent({ game, query: keyword, version: query.get('version') || undefined, loader: query.get('loader') || undefined, limit: toInt(query.get('limit'), 12), offset: toInt(query.get('offset'), 0) }))
        }
        if (method === 'GET' && sub === '/content/project') {
          return ok(res, await engine.contentVersions({ game: query.get('game') || '', id: query.get('id') || '', version: query.get('version') || undefined, loader: query.get('loader') || undefined }))
        }
        if (method === 'GET' && sub === '/runtimes') return ok(res, { runtimes: await engine.listRuntimes({ game: query.get('game') || '' }) })
        if (method === 'GET' && sub === '/instances') return ok(res, { instances: await engine.listInstances() })
        if (method === 'POST' && sub === '/install') return ok(res, await engine.installInstance(await readBody(req)))
        const instanceMatch = sub.match(/^\/instances\/([^/]+)(?:\/(.+))?$/)
        if (instanceMatch) {
          const instanceId = decodeURIComponent(instanceMatch[1])
          const tail = instanceMatch[2] || ''
          if (!tail && method === 'GET') return ok(res, await engine.getInstance(instanceId))
          if (!tail && method === 'DELETE') return ok(res, await engine.deleteInstance(instanceId))
          if (tail === 'launch' && method === 'POST') return ok(res, await engine.launch(instanceId))
          if (tail === 'stop' && method === 'POST') return ok(res, await engine.stop(instanceId))
          if (tail === 'log' && method === 'GET') return ok(res, await engine.getInstanceLog(instanceId, toInt(query.get('lines'), 120)))
          if (tail === 'verify' && method === 'POST') return ok(res, await engine.verifyInstance(instanceId))
          if (tail === 'rename' && method === 'POST') {
            const body = await readBody(req)
            return ok(res, await engine.renameInstance(instanceId, body.name))
          }
          if (tail === 'open' && method === 'POST') {
            const body = await readBody(req)
            return ok(res, await engine.openFolder(instanceId, body.kind || 'game'))
          }
          if (tail === 'content' && method === 'POST') {
            const body = await readBody(req)
            return ok(res, await engine.addContent(instanceId, body.specs || body.content || []))
          }
          const contentMatch = tail.match(/^content\/(.+)$/)
          if (contentMatch && method === 'DELETE') return ok(res, await engine.removeContent(instanceId, decodeURIComponent(contentMatch[1])))
        }
        if (method === 'GET' && sub === '/jobs') return ok(res, { jobs: engine.listJobs(toInt(query.get('limit'), 20)) })
        const jobMatch = sub.match(/^\/jobs\/([^/]+)(?:\/(cancel))?$/)
        if (jobMatch) {
          const jobId = decodeURIComponent(jobMatch[1])
          if (!jobMatch[2] && method === 'GET') return ok(res, engine.getJob(jobId))
          if (jobMatch[2] === 'cancel' && method === 'POST') return ok(res, await engine.cancelJob(jobId))
        }
        if (method === 'PATCH' && sub === '/config') return ok(res, await engine.setConfig(await readBody(req)))
        return sendJson(res, 404, { ok: false, error: '接口不存在：' + method + ' ' + sub })
      } catch (error) {
        logger?.warn?.('%s: 请求失败 %s %s: %s', name, method, sub, errorMessage(error))
        return fail(res, error)
      }
    },
  })
  return () => {
    try {
      dispose()
    } catch {
      /* ignore */
    }
  }
}

function tool({ name: toolName, description, parameters, run }) {
  return {
    name: toolName,
    description,
    parameters: parameters || { type: 'object', properties: {} },
    output: OUTPUT,
    execute: async (args = {}) => plain(await run(args && typeof args === 'object' ? args : {})),
  }
}

function registerTools(ctx, engine) {
  const disposers = []
  const add = (definition) => {
    if (typeof ctx.tools.register !== 'function') return
    disposers.push(ctx.tools.register(definition))
  }
  const instanceParam = { type: 'string', description: '实例 id（来自 launcher_list_instances）' }

  add(tool({ name: 'launcher_status', description: '查看 DSH启动器总体状态：配置、已添加的游戏、实例列表、运行中的实例、最近任务。不知道有哪些游戏/实例时先调用它。', run: () => engine.getState() }))
  add(tool({ name: 'launcher_list_games', description: '列出已注册的游戏（id、名称、版本标签、能力、来源）。没有游戏时先用 launcher_add_game 添加。', run: () => ({ games: engine.listGames() }) }))
  add(tool({
    name: 'launcher_add_game',
    description: '添加一个游戏。provider=github 时 config 需 repo（owner/name，可选 assetPattern/executable/args）；provider=url 时 config 需 jsonUrl 或 versions 数组（可选 executable/args）；provider=manual 时 config 需 path（已安装目录）与 executable。可选 id/label 自定义。',
    parameters: { type: 'object', properties: { provider: { type: 'string', description: 'github | url | manual' }, id: { type: 'string', description: '游戏 id（可选，留空自动生成）' }, label: { type: 'string', description: '显示名称（可选）' }, config: { type: 'object', description: '提供者配置，见工具说明' } }, required: ['provider', 'config'] },
    run: async (args) => engine.addGame(args),
  }))
  add(tool({ name: 'launcher_remove_game', description: '删除用户添加的游戏（外部适配器注册的游戏不能删）。', parameters: { type: 'object', properties: { game: { type: 'string', description: '游戏 id' } }, required: ['game'] }, run: (args) => engine.removeGame(args.game) }))
  add(tool({ name: 'launcher_list_versions', description: '列出某游戏可安装的版本。安装前必须先调用它拿到版本号字符串。', parameters: { type: 'object', properties: { game: { type: 'string', description: '游戏 id' }, force: { type: 'boolean', description: '强制刷新（可选）' } }, required: ['game'] }, run: (args) => engine.listVersions({ game: args.game, force: !!args.force }) }))
  add(tool({ name: 'launcher_list_loaders', description: '列出某游戏某版本可用的加载器（仅支持加载器的游戏可用）。', parameters: { type: 'object', properties: { game: { type: 'string' }, version: { type: 'string' }, type: { type: 'string', description: '加载器类型（可选）' } }, required: ['game', 'version'] }, run: (args) => engine.listLoaders(args) }))
  add(tool({ name: 'launcher_search_content', description: '搜索某游戏的内容（模组/扩展等，仅支持内容能力的游戏可用）。', parameters: { type: 'object', properties: { game: { type: 'string' }, query: { type: 'string', description: '关键词' }, version: { type: 'string', description: '游戏版本（可选）' }, loader: { type: 'string', description: '加载器（可选）' }, limit: { type: 'number', description: '数量，默认 12' } }, required: ['game', 'query'] }, run: (args) => engine.searchContent(args) }))
  add(tool({ name: 'launcher_content_versions', description: '查看某个内容项目的可用版本文件（用于指定版本安装）。', parameters: { type: 'object', properties: { game: { type: 'string' }, id: { type: 'string', description: '内容项目 id 或 slug' }, version: { type: 'string' }, loader: { type: 'string' } }, required: ['game', 'id'] }, run: (args) => engine.contentVersions(args) }))
  add(tool({ name: 'launcher_list_runtimes', description: '列出某游戏可用的运行时（如 Java 运行时；仅支持的可用）。', parameters: { type: 'object', properties: { game: { type: 'string' } }, required: ['game'] }, run: async (args) => ({ runtimes: await engine.listRuntimes({ game: args.game }) }) }))
  add(tool({
    name: 'launcher_install_game',
    description: '安装一个游戏实例（后台任务）。version 必须是 launcher_list_versions 返回的版本号字符串；content 为可选内容规格数组（如 [{slug:"xxx"}]）；options 为可选实例选项对象。返回 jobId 与 instanceId，可用 launcher_job_status 查进度。',
    parameters: { type: 'object', properties: { game: { type: 'string', description: '游戏 id' }, version: { type: 'string', description: '版本号字符串' }, name: { type: 'string', description: '实例名称（可选）' }, options: { type: 'object', description: '实例选项（可选）' }, content: { type: 'array', description: '内容规格数组（可选）', items: { type: 'object' } }, waitSeconds: { type: 'number', description: '等待任务完成的秒数（可选，默认 0=立即返回）' } }, required: ['game', 'version'] },
    run: async (args) => {
      const result = await engine.installInstance({ game: args.game, version: args.version, name: args.name, options: args.options, content: args.content })
      if (Number(args.waitSeconds) > 0) {
        const job = await engine.waitJob(result.jobId, Number(args.waitSeconds) * 1000)
        return { ...result, job }
      }
      return result
    },
  }))
  add(tool({ name: 'launcher_list_instances', description: '列出所有实例（名称、游戏、版本、状态、是否运行中、最近启动）。', run: async () => ({ instances: await engine.listInstances() }) }))
  add(tool({ name: 'launcher_get_instance', description: '查看实例详情（记录、游戏目录、内容目录、运行状态）。', parameters: { type: 'object', properties: { instance: instanceParam }, required: ['instance'] }, run: (args) => engine.getInstance(args.instance) }))
  add(tool({ name: 'launcher_launch_game', description: '启动一个已就绪的实例（后台任务），返回 jobId；waitSeconds>0 时等待启动结果。', parameters: { type: 'object', properties: { instance: instanceParam, waitSeconds: { type: 'number', description: '等待秒数（可选）' } }, required: ['instance'] }, run: async (args) => { const result = await engine.launch(args.instance); if (Number(args.waitSeconds) > 0) { const job = await engine.waitJob(result.jobId, Number(args.waitSeconds) * 1000); return { ...result, job } } return result } }))
  add(tool({ name: 'launcher_stop_game', description: '停止正在运行的实例进程。', parameters: { type: 'object', properties: { instance: instanceParam }, required: ['instance'] }, run: (args) => engine.stop(args.instance) }))
  add(tool({ name: 'launcher_instance_log', description: '查看实例最近一次启动的日志尾部。', parameters: { type: 'object', properties: { instance: instanceParam, lines: { type: 'number', description: '行数，默认 120' } }, required: ['instance'] }, run: (args) => engine.getInstanceLog(args.instance, Number(args.lines) || 120) }))
  add(tool({ name: 'launcher_list_jobs', description: '列出最近的后台任务（安装/启动等）。', parameters: { type: 'object', properties: { limit: { type: 'number', description: '数量，默认 20' } } }, run: (args) => ({ jobs: engine.listJobs(Number(args.limit) || 20) }) }))
  add(tool({ name: 'launcher_job_status', description: '查看任务详情：状态、阶段、进度、日志尾部。安装/启动后用它跟进。', parameters: { type: 'object', properties: { job: { type: 'string', description: '任务 id' } }, required: ['job'] }, run: (args) => engine.getJob(args.job) }))
  add(tool({ name: 'launcher_cancel_job', description: '取消正在执行的任务（安装等）；适配器支持取消时会尽快停止。', parameters: { type: 'object', properties: { job: { type: 'string', description: '任务 id' } }, required: ['job'] }, run: (args) => engine.cancelJob(args.job) }))
  add(tool({ name: 'launcher_add_content', description: '给已安装实例添加内容（需游戏支持内容能力）。content 为规格数组，如 [{slug:"xxx"}] 或 [{projectId:"...",versionId:"..."}]。', parameters: { type: 'object', properties: { instance: instanceParam, content: { type: 'array', description: '内容规格数组', items: { type: 'object' } } }, required: ['instance', 'content'] }, run: (args) => engine.addContent(args.instance, args.content) }))
  add(tool({ name: 'launcher_remove_content', description: '删除实例中的某个内容文件（filename 来自实例详情 content 列表）。', parameters: { type: 'object', properties: { instance: instanceParam, filename: { type: 'string' } }, required: ['instance', 'filename'] }, run: (args) => engine.removeContent(args.instance, args.filename) }))
  add(tool({ name: 'launcher_open_folder', description: '在文件管理器中打开实例目录：kind=game（游戏目录）/content（内容目录）/logs（日志目录），默认 game。', parameters: { type: 'object', properties: { instance: instanceParam, kind: { type: 'string', description: 'game | content | logs' } }, required: ['instance'] }, run: (args) => engine.openFolder(args.instance, args.kind || 'game') }))
  add(tool({ name: 'launcher_rename_instance', description: '重命名实例。', parameters: { type: 'object', properties: { instance: instanceParam, name: { type: 'string', description: '新名称' } }, required: ['instance', 'name'] }, run: (args) => engine.renameInstance(args.instance, args.name) }))
  add(tool({ name: 'launcher_set_config', description: '修改启动器配置（下载并发 1-32、重试次数 0-10）。', parameters: { type: 'object', properties: { downloadConcurrency: { type: 'number' }, retries: { type: 'number' } } }, run: (args) => engine.setConfig({ downloadConcurrency: args.downloadConcurrency, retries: args.retries }) }))
  add(tool({ name: 'launcher_verify_instance', description: '校验实例完整性（目录、记录、适配器检查）。', parameters: { type: 'object', properties: { instance: instanceParam }, required: ['instance'] }, run: (args) => engine.verifyInstance(args.instance) }))
  add(tool({ name: 'launcher_delete_instance', description: '删除实例及其全部文件（需 confirm:true 防误删）。', parameters: { type: 'object', properties: { instance: instanceParam, confirm: { type: 'boolean', description: '必须为 true' } }, required: ['instance', 'confirm'] }, run: async (args) => { if (args.confirm !== true) throw new Error('删除实例需要 confirm:true 确认'); return engine.deleteInstance(args.instance) } }))
  return () => {
    for (const dispose of disposers.reverse()) {
      try {
        dispose()
      } catch {
        /* ignore */
      }
    }
  }
}

export function apply(ctx, config = {}) {
  const logger = ctx.logger || null
  const engine = createEngine({
    config: {
      dataRoot: config.dataRoot || resolveDefaultDataRoot(),
      downloadConcurrency: config.concurrency !== undefined ? config.concurrency : config.downloadConcurrency,
      retries: config.retries,
    },
    log: (line) => {
      try {
        logger?.info?.('%s: %s', name, line)
      } catch {
        /* ignore */
      }
    },
  })

  const safe = (label, fn) => {
    try {
      fn()
    } catch (error) {
      logger?.warn?.('%s: %s失败：%s', name, label, errorMessage(error))
    }
  }

  safe('HTTP 路由注册', () => {
    ctx.inject(['webServer'], (wctx) => {
      safe('HTTP 路由注册', () => wctx.effect(() => registerRoutes(wctx, engine, logger), name + ': routes'))
    })
  })

  safe('工具注册', () => {
    ctx.inject(['tools'], (tctx) => {
      safe('工具注册', () => tctx.effect(() => registerTools(tctx, engine), name + ': tools'))
    })
  })

  safe('提示词注册', () => {
    ctx.inject(['systemPrompt'], (sctx) => {
      safe('提示词注册', () => sctx.systemPrompt.section({ name: 'dsh-launcher', order: 61, text: PROMPT }))
    })
  })

  safe('引擎初始化', () => {
    engine.init().catch((error) => logger?.warn?.('%s: 引擎初始化失败：%s', name, errorMessage(error)))
  })

  safe('生命周期清理', () => {
    ctx.effect(() => () => {
      try {
        engine.dispose()
      } catch {
        /* ignore */
      }
    }, name + ': dispose')
  })
}
