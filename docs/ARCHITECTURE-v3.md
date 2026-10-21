# DSH启动器 v3 架构（纯净版：核心无任何具体游戏）

> 本文件是 v3 团队实现的**唯一权威接口文档**。所有实现与测试以此为准；若实现中必须偏离，先改本文件并通知 Lead。

## §0 目标与品牌规则

用户需求（m01755）：**「里面没有 MC 的纯净版，能添加除了 MC 不同游戏的启动和下载，把框架做好」**。

1. **核心包 `@local/dsh-launcher`（v3.0.0）是纯框架**：包内任何文件（代码、注释、日志、脚本、UA、镜像地址、示例、README）**都不得出现具体游戏/平台/厂商名称**（禁止词示例：Minecraft、mc、mojang、minecraftforge、neoforge、fabric、quilt、modrinth、我的世界、bmclapi、piston 等——凡具体游戏生态专有词都不允许）。核心只认识「游戏 / 版本 / 内容 / 加载器 / 运行时」这些通用概念。
2. 核心**内置零个游戏**。游戏来自三条途径：
   - **用户添加**（内置通用提供者 provider：GitHub Releases / URL 清单 / 手动导入已安装游戏）；
   - **外部适配器包**（如可选的 `plugins/minecraft-adapter/`，独立安装，向核心注册游戏；本仓库提供但不随核心包发布、不默认安装）；
   - **数据目录自定义适配器文件**（`dataRoot/adapters/*.mjs`，进阶用户）。
3. 显示名：`DSH启动器` / `DSH Launcher`；入口：`启动游戏` / `Launch`；包名 `@local/dsh-launcher`。用户可见文本保持通用。
4. 设计参考 PCL 的「版本列表 → 下载 → 启动」体验，但**框架与具体游戏解耦**，并原生适配 DSH（Host 引擎 + Web 面板 + Agent 工具共用一套实现）。

## §1 核心包目录结构

```
dsh-launcher-v3/（包根）
├─ index.js                 # Host 入口：注册 22 个 launcher_* 工具 + /dsh-launcher/api 路由 + 系统提示词（严格 ctx.inject 惰性注册）
├─ client.js                # Client：侧栏「启动游戏」入口 + 全屏面板（零构建浏览器模块）
├─ lib/core/
│  ├─ registry.js           # 适配器注册表（公共 API，见 §2）
│  ├─ engine.js             # 引擎：任务/实例/安装/启动/停止/配置/状态（Lead）
│  ├─ instances.js          # 实例记录持久化（Lead）
│  ├─ paths.js              # 数据布局（Lead）
│  ├─ launch.js             # 进程启动器：LaunchSpec → child_process + 日志 + 停止（Lead）
│  ├─ game-store.js         # 用户游戏定义持久化 + 适配器实例化 + 自定义适配器文件加载（provider-core）
│  ├─ providers/            # 内置通用提供者（provider-core）
│  │  ├─ index.js           # PROVIDERS 注册表 + 校验/测试连接
│  │  ├─ github-release.js  # GitHub Releases 提供者
│  │  ├─ url-manifest.js    # URL 清单提供者（jsonUrl 或静态 versions）
│  │  └─ manual.js          # 手动导入已安装游戏
│  ├─ http.js               # 通用下载引擎（provider-core；无任何游戏专用 URL 规则）
│  ├─ zip.js                # 纯 Node ZIP 读取/解压（沿用 v2，provider-core 维护）
│  └─ archive.js            # 压缩包解压 + 在目录中定位可执行文件（provider-core）
├─ locale/zh.json|en.json   # 展示清单 + 面板字典（ui-v3）
├─ scripts/                 # 测试与基准脚本（见 §9）
├─ docs/ARCHITECTURE-v3.md  # 本文件
├─ docs/USAGE.md            # 用户使用说明（Lead）
├─ docs/PROVIDERS.md        # 提供者与添加游戏说明（provider-core）
├─ docs/GAME-ADAPTER.md     # 适配器开发文档（Lead）
├─ package.json / cordis.patch.yml / icon.svg / README.md
└─ plugins/minecraft-adapter/   # 可选外部适配器包（mc-adapter 负责；不在核心 package.json files 内）
```

## §2 适配器契约（GameAdapter）

注册表公共 API（`lib/core/registry.js`，所有适配器/提供者共用）：

```js
export function registerGame(adapter)        // 注册（重复 id 抛错「游戏已注册：id」；返回 () => void 注销函数）
export function unregisterGame(id)           // 注销；返回 boolean
export function getGame(id)                  // 取适配器；未知抛「不支持的游戏：x（可用：...）」
export function listGames()                  // [{id,label,versionLabel,contentLabel,capabilities,instanceOptions,source,providerType?}]
export function hasGame(id)                  // boolean
export function setRegistrySource(id, source) // 内部/扩展用：标记来源（'provider'|'external'|'builtin'）
```

同时把注册表挂到 `globalThis.__dshLauncherRegistry`（供 `dataRoot/adapters/*.mjs` 这类无法 import 包名的文件使用），注册核心时设置一次。

适配器对象（JS 对象即可，无需 class）：

```js
/**
 * @typedef {Object} LaunchSpec
 * @property {string} executable   可执行文件路径（可含空格；引擎负责 spawn，不经过 shell）
 * @property {string[]} [args]     参数数组
 * @property {string} [cwd]        工作目录（默认 instance.gameDir）
 * @property {Record<string,string>} [env]  追加环境变量
 *
 * @typedef {Object} AdapterContext   // 适配器方法第一个参数里的 ctx 字段
 * @property {object} dl            通用下载器（§8；由 engine 创建）
 * @property {(options?:object)=>object} makeDownloader  创建带自定义 resolveUrl 的下载器（与 ctx.dl 同接口）
 * @property {object} paths         paths 对象（§3）
 * @property {object} config        当前配置
 * @property {string} dataRoot
 * @property {string} instanceDir   实例目录
 * @property {string} gameDir       实例游戏目录（安装目标）
 * @property {string} gameDataDir   该游戏适配器共享数据目录（dataRoot/game-data/<adapter.id>）
 * @property {object} task          任务进度对象：log(line) / items(done,total,label) / bytes(n) / setPhase(phase) / cancelRequested
 * @property {(msg:string)=>void} log
 * @property {object} instance      实例记录
 *
 * @typedef {Object} GameAdapter
 * @property {string} id                     唯一 id（小写字母数字连字符）
 * @property {string} label                  用户可见名称（通用文本；可以含游戏名——但核心包内的适配器只能由外部提供）
 * @property {string} versionLabel           「版本」等标签
 * @property {string} [contentLabel]         「内容」等标签（默认「内容」）
 * @property {{content?:boolean, loaders?:boolean, runtimes?:boolean}} [capabilities]
 * @property {Array<{key,label,type:'string'|'number'|'boolean'|'select',default?,choices?,description?}>} [instanceOptions]
 * @property {(args:{ctx:AdapterContext, force?:boolean})=>Promise<{versions:Array<{id,label?,releaseTime?}>, latestRelease?:string}>} listVersions
 * @property {(args:{ctx:AdapterContext, instance:object, version:string, options:object})=>Promise<{versionId?:string, metadata?:object}>} install
 * @property {(args:{ctx:AdapterContext, instance:object})=>Promise<LaunchSpec|null>} launch   // null = 该实例由外部进程管理
 * @property {(args:{ctx:AdapterContext, instance:object})=>Promise<{ok:boolean, problems?:string[], checks?:object}>} [verify]
 * @property {(args:{ctx:AdapterContext, version:string, type?:string})=>Promise<{types:string[], versions:Array<{version,stable}>}>} [listLoaders]
 * @property {(args:{ctx:AdapterContext, query:string, version?:string, loader?:string, limit?:number, offset?:number})=>Promise<{hits:Array<object>, totalHits:number}>} [searchContent]
 * @property {(args:{ctx:AdapterContext, id:string, version?:string, loader?:string})=>Promise<Array<object>>} [contentVersions]
 * @property {(args:{ctx:AdapterContext, instance:object, specs:Array<{slug?:string,projectId?:string,versionId?:string}>, version?:string, loader?:string})=>Promise<{added:Array<object>}>} [addContent]
 * @property {(args:{ctx:AdapterContext, instance:object, filename:string})=>Promise<{removed:boolean}>} [removeContent]
 * @property {(args:{ctx:AdapterContext})=>Promise<Array<{id,label,path,version?,source?}>>} [listRuntimes]
 * @property {(args:{ctx:AdapterContext, instance:object, kind:string})=>Promise<{opened:boolean,path:string,kind:string}>} [openFolder]  // 可选；否则核心用 instance.gameDir
 */
```

规则：
- 所有适配器方法**抛中文 Error**；engine 捕获后写 job.error / HTTP 错误响应。
- 安装必须写到 `ctx.gameDir`（或 adapter 自己的 `gameDataDir` 缓存），不得写包目录与 profile。
- 用户可见文本保持通用（`label` 是用户可见名称，可含游戏名——外部适配器允许；核心包内禁止）。
- 适配器插件（外部）注册方式：`import { registerGame } from '@local/dsh-launcher/lib/core/registry.js'`（同时支持 `globalThis.__dshLauncherRegistry.registerGame`）。包内需在其 `apply()` 里注册，并把注销函数挂到 `ctx.effect`。
- **跨上下文桥接（已实现，真实宿主验证）**：DSH 不同插件包可能加载在彼此隔离的上下文中（`globalThis` 与跨包 `import` 不可用）。核心启动时写指针文件 `~/.dsh-launcher/bridge.json`（含 `dataRoot`/`adaptersDir`），并每约 2.5 秒巡检 `dataRoot/adapters/` 与 `dataRoot/games/`；适配器插件把只做 re-export 的桥接模块写进 `adaptersDir`，核心随即**热加载**注册（删除文件即卸载），全程无需重启 DSH。详见 `docs/GAME-ADAPTER.md §6.5`。

## §3 数据布局（paths.js）

```
dataRoot/（默认：<用户主目录>/.dsh-launcher/data；兼容旧版 <包目录>/data，有数据则沿用；可在插件配置里设 dataRoot 覆盖）
├─ config.json                    # {downloadConcurrency, retries, ...}
├─ games/<gameId>.json            # 用户添加的游戏定义（见 §4）
├─ adapters/*.mjs                 # 自定义适配器文件（进阶；default export = adapter 或 (helpers)=>adapter）
├─ instances/<id>/instance.json   # 实例记录
├─ instances/<id>/game/           # 游戏安装目录（adapter 的安装目标）
├─ instances/<id>/logs/           # launch-*.log
├─ cache/                         # 下载缓存 / 清单缓存（引擎与适配器自管）
├─ game-data/<adapterId>/         # 适配器共享数据（如运行库）
└─ tmp/                           # 临时文件
```

`paths.js` 导出 `createPaths(dataRoot)`：`root, configFile, games, adapters, instances, cache, downloads, manifests, tmp, gameDataRoot, instanceDir(id), instanceGameDir(id), instanceLogsDir(id), gameDataDir(adapterId), ensureDirs(paths)`。另提供 `slugify`、`readJson(file,fallback)`、`writeJson(file,value)`（原子写）、`readText`、`removeDir`、`pathExists`、`timestamp`、`timeLabel`、`formatBytes`（沿用 v2 实现即可，去掉游戏名）。

## §4 内置提供者（Providers）

用户通过「添加游戏」创建定义，落在 `dataRoot/games/<id>.json`：

```json
{ "id":"my-game", "label":"我的游戏", "provider":"github",
  "config": { ... }, "versionLabel":"版本" }
```

`provider` 取值与 config：

### 4.1 `github`（GitHub Releases）
```js
{ repo: "owner/name", assetPattern?: string(正则，对 asset 文件名; 默认：优先 .zip，其次第一个 asset),
  executable?: string(解压后相对路径；省略则自动查找), archive?: "auto"|"zip"|"none",
  args?: string[], assetKind?: "auto"|"zip"|"file" }
```
- `listVersions`：`GET https://api.github.com/repos/<repo>/releases?per_page=50`（UA 必填；401 时提示可能限流）。版本 id=tag_name，label=name 或 tag_name。
- `install`：下载匹配 asset（zip 解压到 gameDir；单文件直接放到 gameDir）；记录 metadata.json（asset 名/可执行相对路径）。
- `launch`：executable 指向 gameDir 内文件；args 透传。

### 4.2 `url`（URL 清单 / 静态列表）
```js
{ jsonUrl?: string,   // 返回 {versions:[{id,url,sha1?,size?,archive?:"auto"|"zip"|"none",executable?,args?}]}
  versions?: Array<{id,url,sha1?,size?,archive?,executable?,args?}>,
  executable?: string, args?: string[], archive?: "auto"|"zip"|"none" }
```
- `listVersions`：有 jsonUrl 则每次拉取（可 30 分钟缓存），否则用静态 versions（至少 1 个）。
- `install`：下载 `url` → zip 解压到 gameDir（archive=zip/auto 时；auto 依据 .zip 后缀或响应 content-type）→ 记录可执行；单文件则直接复制/保存到 gameDir。

### 4.3 `manual`（手动导入已安装游戏）
```js
{ path: "C:\\Games\\Foo", executable: "foo.exe", args?: string[], versionLabel?: string }
```
- `listVersions`：返回单个版本 `{id:'installed', label:'已安装'}`。
- `install`：校验 path 与 executable 存在（不复制文件）；实例 metadata 记录 manualPath。
- `launch`：executable 相对 path 解析（或绝对路径），cwd=path。
- 面板「添加游戏」表单显示目录与可执行文件输入。

提供者实现必须导出适配器工厂：`createAdapter(definition) -> GameAdapter`；`providers/index.js` 导出 `PROVIDERS = { github, url, manual }`、`providerSummaries()`、`validateDefinition(def)`（同步字段校验，中文错误）、`async testDefinition({provider, config, logger})`（真实网络校验：github 拉 repo 信息 / url 拉 jsonUrl / manual 检查路径存在）。

## §5 HTTP API（前缀 `/dsh-launcher/api`）

统一响应：成功 `{ok:true,data}`；失败 `{ok:false,error:"中文"}`，状态码 400/404/409/500。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/state` | `{config,games,instances,running,jobs}` |
| GET | `/games` | 游戏列表（§2 listGames） |
| POST | `/games` | 添加游戏 `{provider,id?,label,config}` → `{game}` |
| POST | `/games/test` | 测试 `{provider,config}` → `{ok,detail}`（不落盘） |
| DELETE | `/games/:id` | 删除用户添加的游戏（external 适配器游戏不可删） |
| GET | `/versions?game=&force=` | 版本列表 |
| GET | `/loaders?game=&version=&type=` | 加载器（capabilities.loaders） |
| GET | `/content/search?game=&q=&version=&limit=&offset=` | 内容搜索 |
| GET | `/content/project?game=&id=&version=` | 内容版本列表 |
| GET | `/runtimes?game=` | 运行时列表 |
| GET | `/instances` | 实例摘要列表 |
| GET | `/instances/:id` | 实例详情 `{instance,gameDir,contentDir,running}` |
| GET | `/instances/:id/log?lines=` | 最近日志 |
| POST | `/install` | `{game,version?,name?,options?,content?}` → `{jobId,instanceId}` |
| POST | `/instances/:id/launch` | → `{jobId}` |
| POST | `/instances/:id/stop` | → `{stopped,pid?}` |
| POST | `/instances/:id/content` | `{specs}` → `{added}` |
| DELETE | `/instances/:id/content/:filename` | → `{removed}` |
| POST | `/instances/:id/rename` | `{name}` |
| POST | `/instances/:id/open` | `{kind:'game'\|'content'\|'logs'}` |
| POST | `/instances/:id/verify` | `{ok,problems}` |
| DELETE | `/instances/:id` | `{deleted}` |
| GET | `/jobs`、`/jobs/:id` | 任务列表/详情 |
| POST | `/jobs/:id/cancel` | 协作取消 |
| PATCH | `/config` | 部分更新配置 |

## §6 Agent 工具（25 个，`launcher_*`）

| 工具 | 作用 |
|---|---|
| launcher_status | 配置/游戏/实例/任务/运行中总览 |
| launcher_list_games | 游戏列表（id/label/能力/是否支持内容） |
| launcher_add_game | 添加游戏（provider+config，先校验远程/路径） |
| launcher_remove_game | 删除用户添加的游戏 |
| launcher_list_versions | 某游戏的版本列表 |
| launcher_list_loaders | 某游戏某版本的加载器（无此能力时报中文错误） |
| launcher_search_content | 内容搜索 |
| launcher_list_runtimes | 运行时列表 |
| launcher_install_game | 安装实例（game+version+options+content，后台 job，可 waitSeconds） |
| launcher_list_instances | 实例列表 |
| launcher_get_instance | 实例详情 |
| launcher_launch_game | 启动实例（后台 job） |
| launcher_stop_game | 停止实例 |
| launcher_instance_log | 实例日志尾部 |
| launcher_list_jobs | 任务列表 |
| launcher_job_status | 任务详情（含进度/日志） |
| launcher_cancel_job | 取消任务 |
| launcher_add_content | 给实例加内容 |
| launcher_remove_content | 删除实例内容文件 |
| launcher_open_folder | 打开实例游戏/内容/日志目录（资源管理器） |
| launcher_rename_instance | 重命名实例 |
| launcher_set_config | 修改配置 |
| launcher_verify_instance | 校验实例完整性 |
| launcher_delete_instance | 删除实例（需 confirm:true） |

（共 25 个；描述必须通用、中文、说明何时用。）

## §7 Client UI（ui-v3）

- 侧栏底部图标按钮（`sidebar.footer.action`）：「启动游戏」，点击打开全屏浮层（同 v2 模式：fixed inset 0、z-index 4000、主题变量、Esc/遮罩关闭）。
- 顶层 Tab：**游戏 / 添加游戏 / 设置**（v3.1 起收敛为三个；点开某个游戏后进入该游戏详情，再针对它下载版本、安装实例、启动与管内容，其他游戏同理）。
  1. **游戏**：游戏卡片列表（游戏名、来源 Badge、versionLabel、能力 badges、实例数、运行中数）；整卡可点击（含键盘 Enter/Space）进入游戏详情；空态引导去「添加游戏」；顶部显示运行中任务进度（轮询 `/state` 1.5s）。
  2. **游戏详情**（同浮层内，← 返回；Esc 先退详情再关面板）：版本区（`/versions?game=` 下拉默认 latestRelease，「下载并安装」展开表单：实例名 + instanceOptions 动态字段 + 内容多选）→ `POST /install` + JobMonitor 进度；实例区（只显示 `instance.game === game.id`：启动/停止/日志/打开游戏目录/打开内容目录/删除）；内容区（仅 capabilities.content：选实例 → 已装内容列表 → 搜索/多选添加/逐条确认删除）。
  3. **添加游戏**：选择提供者（GitHub Releases / URL 清单 / 手动导入）→ 填字段 → 「测试连接」→「保存」；保存成功自动跳到该游戏详情。
  4. **设置**：数据目录（只读展示）、下载并发（1-32）、重试次数（0-10）、统计；保存调 `PATCH /config`（只发 `{downloadConcurrency,retries}`）。
- 文本走 locale（zh/en 完整键，`meta.title`/`meta.description` 的标题为「DSH启动器」/「DSH Launcher」）；颜色只用 `--dsw-alias-*` 变量；无全局副作用；工厂零副作用；样式/监听在 apply 内 ctx.effect 注册并 cleanup；外部文本经 scalarText/brandSafe 兜底。

## §8 通用下载引擎（lib/core/http.js，provider-core 拥有）

签名：

```js
export function createDownloader(options = {}) // {concurrency=16, retries=3, logger, resolveUrl?: (url)=>string[]|{url,family?}[], timeoutMs, userAgent}
// 返回：
{ resolveUrls(url, ctx?), fetchText(url,opts?), fetchJson(url,opts?),
  downloadBuffer(url,{task,maxBytes?}), downloadJson(url,destPath,{maxAgeMs,task}),
  downloadFile(url,destPath,{sha1,size,task,quiet}), downloadMany(items,{task,label}), getSpeedReport?() }
```

要求：
- Node 原生 `http`/`https`，keep-alive Agent；全局并发默认 16（上限 32）。
- ≥8MB 文件 Range 分片 4–8 段并发；服务端 206 不支持时自动回退单流；sha1 边写边算；`.part` + rename；同 dest 去重。
- 429/5xx/网络错误指数退避重试（尊重 Retry-After）。
- `downloadMany`：`items=[{url,dest,sha1?,size?,task?}]`，内部候选回退/去重/进度聚合；进度经 `task.items(done,total,label)` + `task.bytes(n)` 汇总。
- 不出现任何具体游戏/平台字样（UA 用 `dsh-launcher/3.0.0`）。

## §9 测试与验证

- `node --check` 全部 JS。
- `scripts/http-test.mjs`：假 ctx 加载 index.js，验证全部路由与工具（Lead 重写）。
- `scripts/inject-test.mjs`：严格 Cordis 注入，零注册失败（Lead 重写）。
- `scripts/providers-test.mjs`：provider 校验/测试/本地 HTTP 服务器下载+解压（provider-core）。
- `scripts/registry-test.mjs`：注册/注销/未知游戏错误/自定义适配器文件加载（Lead）。
- `scripts/check-client.mjs`：静态断言 + vm 模拟渲染（ui-v3）。
- `scripts/brand-check.mjs`：**核心包全文件扫描**禁止词（含注释/日志/UA/脚本名），且工具名全 `launcher_*`（Lead）。
- `scripts/e2e-v3.mjs`：真实端到端：本地 HTTP 服务器提供 url 提供者游戏（zip 含标记文件 + 可选 exe）→ 添加游戏 → 列版本 → 安装 → launch（可执行=notepad.exe 或 cmd）→ 验证运行中 → stop → 删除（Lead）。
- 安装：`plugin_manager install_bundle target=<v3 包绝对目录>`；替换已装包需重启 DSH 才加载新 Host JS。

## §10 环境与禁止事项

- 运行 Node：开发机上可用 DSH 自带的 Node（形如 `<DSH 安装目录>/dsh-runtimes/<运行时>/dependencies/node/bin/node.exe`），或任意 Node.js >= 20；仓库内脚本一律用 `node` 命令书写，不写死绝对路径。
- 网络必须走 Node（shell curl/iwr 不可用）；workspace 可写。默认 dataRoot 在用户主目录（`~/.dsh-launcher/data`），本机已有旧数据时沿用 `<包目录>/data`。
- 分发包：`node scripts/build-dist.mjs` 生成 `dist/dsh-launcher-<version>/` + zip；`cordis.patch.yml` 与源码中不得写死绝对路径；`scripts/portability-test.mjs` 守护可移植性。
- 不修改 DSH profile 文件、不在 profile 里 pnpm、不写其他插件/他人文件。
- v2 旧目录 `dsh-launcher/` 保留作参考，**不要修改**；MC 专用代码只能进 `plugins/minecraft-adapter/`。
- 文件归属见 §1 括号；同文件只能一个人写。

## §11 团队任务与交付

| 任务 | 负责人 | 交付 |
|---|---|---|
| task-A 核心框架（registry/engine/instances/paths/launch/index/package/文档） | Lead | 可运行核心 + 测试 |
| task-B 通用下载与提供者（http/zip/archive/providers/game-store + 测试 + docs/PROVIDERS.md） | provider-core | §4/§8 全部实现与测试 |
| task-C Client UI（client.js + locale + check-client） | ui-v3 | §7 全部界面 |
| task-D 可选游戏适配器包（plugins/minecraft-adapter） | mc-adapter | 独立可安装包：注册一个游戏，复用核心下载器并实现自己的镜像解析、版本/加载器/内容/运行时能力；自测通过 |
