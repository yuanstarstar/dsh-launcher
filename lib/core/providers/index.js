// DSH启动器 v3 · 提供者统一入口
//
// 三条添加游戏的通用途径都收敛到这里：
//   github —— 从 GitHub 仓库发布附件安装
//   url    —— 从 URL 版本清单安装
//   manual —— 登记本机已安装的游戏
import * as githubRelease from './github-release.js'
import * as urlManifest from './url-manifest.js'
import * as manualProvider from './manual.js'

const MODULES = {
  github: githubRelease,
  url: urlManifest,
  manual: manualProvider,
}

/** provider id -> { id, label, description, validateConfig, createAdapter, testDefinition } */
export const PROVIDERS = Object.freeze(
  Object.fromEntries(
    Object.entries(MODULES).map(([id, module]) => [
      id,
      Object.freeze({
        ...module.PROVIDER,
        validateConfig: module.validateConfig,
        createAdapter: module.createAdapter,
        testDefinition: module.testDefinition,
      }),
    ]),
  ),
)

export const PROVIDER_IDS = Object.freeze(Object.keys(PROVIDERS))

const CONFIG_FIELDS = {
  github: [
    {
      key: 'repo',
      label: '仓库',
      type: 'text',
      required: true,
      placeholder: 'owner/name',
      description: 'GitHub 仓库，格式为 owner/name',
    },
    {
      key: 'assetPattern',
      label: '附件匹配规则',
      type: 'text',
      required: false,
      placeholder: '例如 windows[_-]?x64\\.zip',
      description: '可选的正则表达式，用来挑选发布附件；留空表示自动挑选',
    },
    {
      key: 'executable',
      label: '可执行文件',
      type: 'text',
      required: false,
      placeholder: '例如 game.exe',
      description: 'ZIP 解压后游戏目录内的可执行文件相对路径；留空则自动查找',
    },
    {
      key: 'archive',
      label: '压缩包处理',
      type: 'select',
      required: false,
      options: ['auto', 'zip', 'none'],
      description: 'auto 表示根据附件自动判断',
    },
    {
      key: 'assetKind',
      label: '附件类型',
      type: 'select',
      required: false,
      options: ['auto', 'zip', 'file'],
      description: 'auto 表示优先选择 ZIP 附件',
    },
    { key: 'args', label: '启动参数', type: 'args', required: false, description: '每行一个参数，可留空' },
  ],
  url: [
    {
      key: 'jsonUrl',
      label: '版本清单地址',
      type: 'text',
      required: false,
      placeholder: 'https://example.com/versions.json',
      description: '可选的远程 JSON 版本清单；与静态版本列表二选一',
    },
    {
      key: 'versions',
      label: '静态版本列表',
      type: 'json',
      required: false,
      placeholder: '[{ "id": "1.0", "url": "https://..." }]',
      description: '可选的静态 JSON 数组；与远程清单二选一',
    },
    {
      key: 'executable',
      label: '可执行文件',
      type: 'text',
      required: false,
      placeholder: '例如 game.exe',
      description: '游戏目录内的可执行文件相对路径；留空则自动查找',
    },
    {
      key: 'archive',
      label: '压缩包处理',
      type: 'select',
      required: false,
      options: ['auto', 'zip', 'none'],
      description: 'auto 表示根据文件内容自动判断',
    },
    { key: 'args', label: '启动参数', type: 'args', required: false, description: '每行一个参数，可留空' },
  ],
  manual: [
    {
      key: 'path',
      label: '本机路径',
      type: 'text',
      required: true,
      placeholder: 'D:\\Games\\SomeGame',
      description: '本机已经安装好的游戏目录，不会复制文件',
    },
    {
      key: 'executable',
      label: '可执行文件',
      type: 'text',
      required: true,
      placeholder: '例如 game.exe',
      description: '相对于本机路径的可执行文件',
    },
    { key: 'args', label: '启动参数', type: 'args', required: false, description: '每行一个参数，可留空' },
  ],
}

/** 给界面用的提供者摘要（不包含函数，便于 JSON 序列化）。 */
export function providerSummaries() {
  return PROVIDER_IDS.map((id) => {
    const provider = PROVIDERS[id]
    return {
      id,
      label: provider.label,
      description: provider.description,
      configFields: (CONFIG_FIELDS[id] || []).map((field) => ({ ...field, options: field.options ? field.options.slice() : undefined })),
    }
  })
}

function fail(message) {
  throw new Error(message)
}

/**
 * 同步校验游戏定义（中文错误）。
 * 通过后返回规整后的定义；config 已被对应提供者校验并补默认值。
 */
export function validateDefinition(definition) {
  if (!definition || typeof definition !== 'object') fail('游戏定义必须是对象')
  const provider = typeof definition.provider === 'string' ? definition.provider.trim() : ''
  if (!provider) fail('缺少提供者（provider）')
  if (!Object.prototype.hasOwnProperty.call(PROVIDERS, provider)) {
    fail('不支持的提供者：' + provider + '（可用：' + PROVIDER_IDS.join('、') + '）')
  }
  const label = typeof definition.label === 'string' ? definition.label.trim() : ''
  if (!label) fail('缺少游戏名称（label）')
  const id = definition.id != null ? String(definition.id).trim() : ''
  if (id && !/^[a-z0-9][a-z0-9-]*$/.test(id)) fail('游戏 id 只能包含小写字母、数字和短横线：' + id)
  if (definition.config == null) fail('缺少提供者配置（config）')
  if (typeof definition.config !== 'object' || Array.isArray(definition.config)) fail('提供者配置（config）必须是对象')
  const normalizedConfig = PROVIDERS[provider].validateConfig(definition.config)
  const versionLabel =
    definition.versionLabel != null && String(definition.versionLabel).trim()
      ? String(definition.versionLabel).trim()
      : '版本'
  return {
    ...(id ? { id } : {}),
    label,
    provider,
    versionLabel,
    config: normalizedConfig,
  }
}

/**
 * 真实校验提供者配置（用于界面上的「测试连接」）。
 * 参数错误时返回 { ok:false, detail }，不抛异常；网络/路径问题的描述也放在 detail 里。
 */
export async function testDefinition({ provider, config, dl, logger } = {}) {
  const providerId = typeof provider === 'string' ? provider.trim() : ''
  if (!providerId) return { ok: false, detail: '缺少提供者（provider）' }
  if (!Object.prototype.hasOwnProperty.call(PROVIDERS, providerId)) {
    return { ok: false, detail: '不支持的提供者：' + providerId + '（可用：' + PROVIDER_IDS.join('、') + '）' }
  }
  const module = PROVIDERS[providerId]
  let normalized
  try {
    normalized = module.validateConfig(config)
  } catch (error) {
    return { ok: false, detail: error.message }
  }
  try {
    const result = await module.testDefinition({ config: normalized, dl, logger })
    if (!result || typeof result !== 'object') return { ok: true, detail: '配置格式正确' }
    return { ok: Boolean(result.ok), detail: result.detail || (result.ok ? '配置可用' : '配置不可用') }
  } catch (error) {
    return { ok: false, detail: (error && error.message) || String(error) }
  }
}

export default { PROVIDERS, PROVIDER_IDS, providerSummaries, validateDefinition, testDefinition }
