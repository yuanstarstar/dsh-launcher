# DSH启动器 · 游戏适配器契约

DSH启动器核心不包含任何具体游戏。要让一个游戏出现在启动器里、支持下载与启动，需要提供一个**适配器**（GameAdapter）。适配器可以：

1. 写成独立插件包（推荐）：安装后在 `apply()` 里注册；
2. 以 `.mjs` 文件放进 `<dataRoot>/adapters/`，DSH启动器启动时自动加载。

内置提供者（GitHub Release / URL 清单 / 手动导入）本质上就是预置的通用适配器；仓库 `plugins/` 目录下还有一份完整示例适配器包，可作为参考实现。

---

## 1. 注册

DSH启动器初始化时会设置全局注册表 `globalThis.__dshLauncherRegistry`：

```js
// 独立插件包 index.js
export function apply(ctx) {
  const registry = globalThis.__dshLauncherRegistry
  if (!registry) {
    ctx.logger?.warn?.('请先安装 DSH启动器插件')
    return
  }
  const unregister = registry.registerGame(adapter, 'external')
  ctx.effect(() => () => unregister(), 'my-game-adapter')
}
export const inject = []
export const name = '@local/my-game-adapter'
```

也可以直接 import 核心的注册表模块（插件包需把 DSH启动器声明为 peer/依赖，或使用上面的全局写法更稳）：

```js
import { registerGame } from '@local/dsh-launcher/lib/core/registry.js'
```

外部适配器包还需要一个 bundle patch，让 DSH 加载它的 Host 入口；参考仓库 `plugins/` 下示例适配器包的结构。

## 2. 适配器对象

必填字段与方法：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | string | 唯一 id（小写、短横线），实例记录会存它 |
| `label` | string | 显示名（用户语言） |
| `versionLabel` | string | 版本下拉的标题，如「游戏版本」 |
| `listVersions` | `async ({ctx, force}) => {versions:[{id,label?,releaseTime?}], latestRelease?}` | 返回可安装版本；列表按新→旧排序；`force` 时强制刷新缓存 |
| `install` | `async ({ctx, instance, version, options, content}) => {versionId?, metadata?}` | 下载/安装到实例目录；返回实际版本号与可选的适配器元数据（会存进实例记录 `metadata`） |
| `launch` | `async ({ctx, instance}) => {executable, args?, cwd?, env?}` | 只构造启动描述，不 spawn；核心负责启动/日志/退出监控 |

可选字段与方法：

| 方法 | 说明 |
| --- | --- |
| `capabilities` | `{loaders?:boolean, content?:boolean, runtimes?:boolean}`；决定面板显示哪些页签 |
| `instanceOptions` | 新建实例时动态表单：`[{key,label,type:'string'|'number'|'boolean'|'select',default,options?,hint?}]`，值会作为 `instance.options` 传给 `install` |
| `listLoaders({ctx, version, type})` | 返回 `{type, versions:[{version,stable}]}` |
| `searchContent({ctx, query, version, loader, limit, offset})` | 内容搜索命中 `{hits:[{slug,title,description,iconUrl,downloads,projectId?}], totalHits}` |
| `contentVersions({ctx, id, version, loader})` | 某个内容项目的可用文件 |
| `addContent({ctx, instance, specs, version, loader})` | 添加内容，返回 `{added:[{filename,...}]}` |
| `removeContent({ctx, instance, filename})` | 删除内容，返回 `{removed:true}` |
| `listRuntimes({ctx})` | 可用运行时（例如某个解释器/运行环境）列表 |
| `verify({ctx, instance})` | 完整性检查，返回 `{ok,problems:[],checks:{}}` |
| `openFolder({ctx, instance, kind})` | 返回要打开的目录 `{path}`（kind 由面板传入：`game`/`content`/`logs`） |

## 3. 上下文 `ctx`

| 字段 | 说明 |
| --- | --- |
| `ctx.dl` | 核心通用下载器：`fetchText/fetchJson/downloadFile/downloadBuffer/downloadJson/downloadMany`，支持 sha1 校验、分片、重试、并发 |
| `ctx.makeDownloader(options)` | 创建带自定义 URL 解析的下载器；`options.resolveUrl(url, ctx) => string \| string[]` 返回候选地址（多候选会自动测速/回退） |
| `ctx.paths` | 路径工具（`root/cache/instances/...`，含 `instanceDir(id)`、`instanceGameDir(id)`、`gameDataDir(gameId)`） |
| `ctx.gameDataDir` | 该游戏的共享数据目录（跨实例复用的本体/资源放这里） |
| `ctx.instanceDir` / `ctx.gameDir` | 当前实例目录 / 游戏目录（`install`/`launch` 时存在） |
| `ctx.instance` | 实例记录（`id/name/versionId/options/content/metadata...`） |
| `ctx.config` | 启动器配置（`downloadConcurrency/retries` 等） |
| `ctx.task` | 进度上报：`log(line)`、`items(done,total,label)`、`bytes(n)`、`setPhase(text)`、`cancelRequested` |
| `ctx.log(message)` | 写入任务日志 |

## 4. 启动描述 LaunchSpec

```js
{
  executable: 'C:\\path\\to\\game.exe', // 绝对路径最稳
  args: ['--data', ctx.gameDir],        // 可选
  cwd: ctx.gameDir,                     // 可选，默认实例游戏目录
  env: { MY_VAR: '1' }                  // 可选，追加到 process.env
}
```

核心负责：写日志文件（实例 `logs/`）、监听退出、更新 `lastExit/playCount`、进程树停止、1.5 秒早期失败探测。

## 5. 最小示例

```js
// 一个把「压缩包下载 + 解压 + 启动」全部交给核心的适配器
import path from 'node:path'

export const adapter = {
  id: 'my-game',
  label: '我的游戏',
  versionLabel: '版本',
  capabilities: { content: false, loaders: false, runtimes: false },

  async listVersions({ ctx }) {
    const data = await ctx.dl.fetchJson('https://example.com/versions.json', { maxAgeMs: 3600_000 })
    return { versions: data.versions, latestRelease: data.versions[0]?.id }
  },

  async install({ ctx, version, options }) {
    const data = await ctx.dl.fetchJson('https://example.com/versions.json')
    const item = data.versions.find((v) => v.id === version)
    if (!item) throw new Error('版本不存在：' + version)
    ctx.task.setPhase('下载游戏文件')
    const zipPath = path.join(ctx.gameDir, 'download.zip')
    await ctx.dl.downloadFile(item.url, zipPath, { sha1: item.sha1, size: item.size, task: ctx.task })
    ctx.task.setPhase('解压')
    const { extractArchiveToDir } = await import('@local/dsh-launcher/lib/core/archive.js')
    await extractArchiveToDir(zipPath, ctx.gameDir, { stripComponents: 1 })
    return { versionId: version }
  },

  async launch({ ctx }) {
    return { executable: path.join(ctx.gameDir, 'game.exe'), args: [], cwd: ctx.gameDir }
  },
}
```

注册：

```js
export function apply(ctx) {
  const unregister = globalThis.__dshLauncherRegistry?.registerGame(adapter, 'external')
  if (unregister) ctx.effect(() => () => unregister(), 'my-game-adapter')
}
```

> **重要**：DSH 的不同插件包可能运行在彼此隔离的加载上下文里，`globalThis` 与跨包 `import` 都不保证可用。适配器以**独立插件包**形式安装时，请改用下面的文件桥接方式（核心包与适配器包正在用这种方式对接，已在真实宿主验证）。

## 6.5 插件包适配器：跨上下文文件桥接（推荐）

核心包启动时会写固定的桥接指针文件（写入两个位置以兼容不同运行环境，适配器按顺序探测；也可在插件配置里用 `launcherDataRoot` 直接指定）：

```text
1) ~/.dsh-launcher/bridge.json
2) %APPDATA%/dsh-launcher/bridge.json
{
  "launcher": "@local/dsh-launcher",
  "dataRoot": "…/dsh-launcher-v3/data",
  "adaptersDir": "…/dsh-launcher-v3/data/adapters",
  …
}
```

适配器插件在自己的 `apply()` 里读这个文件，把「一个只做 re-export 的桥接模块」写进 `adaptersDir`：

```js
// <dataRoot>/adapters/adapter-my-game.mjs（自动生成）
import adapter from 'file:///C:/…/my-game-adapter/lib/adapter.js'
export default adapter
```

核心每一段时间（约 2.5 秒）巡检 `<dataRoot>/adapters/` 与 `<dataRoot>/games/`，发现新增或修改就**热加载**并注册/注销游戏——**不需要重启 DSH**。删除桥接文件即可让核心自动卸载对应游戏；插件卸载时也应删除它。

几个要点：

- 桥接模块里只允许 `import`/`export`，适配器本体仍放在适配器包内，可继续 `import` 包内其他文件；
- 核心与适配器即使处在不同进程/不同上下文也没问题：桥接文件里的绝对 `file://` URL 由核心进程自行导入，适配器对象在核心进程内构造；
- 若核心包还没启动（指针文件不存在），适配器可在启动阶段重试（建议每 2 秒、最多 60 秒）；
- `~/.dsh-launcher/bridge.json` 由核心包维护；核心包卸载/停用后指针会被清理。

## 6.6 用内置提供者而不写代码

如果游戏只是「下载一个压缩包 → 解压 → 启动里面某个程序」，无需写适配器，直接用 **URL 清单提供者**：

```text
launcher_add_game {
  provider: "url",
  label: "我的游戏",
  config: {
    jsonUrl: "https://example.com/versions.json",
    executable: "game.exe",
    args: ["--data", "{gameDir}"]
  }
}
```

或 GitHub Release 提供者：

```text
launcher_add_game {
  provider: "github",
  label: "我的游戏",
  config: { repo: "owner/name", assetPattern: "windows-x64\\.zip$", executable: "game.exe" }
}
```

## 7. 调试与测试

- 把 `.mjs` 适配器放进 `<dataRoot>/adapters/`，核心会在数秒内**自动热加载**（无需重启 DSH）；删除文件即卸载；
- 用 `launcher_status` 确认游戏已注册（`games[].source === 'external'`）；
- `launcher_list_versions` 试适配器查询，`launcher_install_game` 试安装（后台任务日志可见），`launcher_launch_game` 试启动；
- 单元测试：核心 `lib/core/registry.js` 只依赖纯 JS，可直接在 Node 里构造假 `ctx` 测试。

## 8. 错误约定

- 抛 `Error('中文原因')`：面板/对话会原样展示；
- 常见错误映射：`不存在/未找到/不支持` → 404，`已注册/正在运行` → 409，`缺少/无效/参数` → 400；
- 安装中途取消：检查 `ctx.task.cancelRequested`，尽快抛出 `任务已取消`，核心会把任务标记为失败并保留日志。
