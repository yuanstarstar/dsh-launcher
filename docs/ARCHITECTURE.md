# DSH启动器 v4 架构契约（本体 + 附属启动器，两个项目）

> 权威规范。v3 的「核心内含可选适配器包」方案被本文件取代（v3 文档保留作历史参考）。
> 本轮目标（用户 m03095）：
> 「把启动器本体和我的世界启动器做成两个项目，我的世界启动器为附属启动器，启动器本体不含任何启动器但支持从 github 等下载附属启动器。」

## §0 两个项目

| 项目 | 本地目录 | Git 仓库（建议名） | 定位 |
| --- | --- | --- | --- |
| 启动器本体（核心） | `dsh-launcher-v3`（保持目录名，profile 里 bundle 是 link 到这里的） | `dsh-launcher` | 纯框架：不含任何具体游戏 / 平台 / 启动器实现；负责游戏定义、实例、下载器、面板、Agent 工具、**附属启动器管理** |
| 我的世界启动器（附属启动器） | `dsh-launcher-minecraft`（新建） | `dsh-launcher-minecraft` | 独立项目：把现有 `plugins/minecraft-adapter` 的代码迁移成可下载的附属启动器包；打 zip 发 GitHub Release |

硬规则：
- 核心包（目录 `dsh-launcher-v3`）内**不得**出现任何具体游戏/平台字样（品牌检查脚本继续强制；`lib/`、`README`、`docs/USAGE.md`、`docs/INSTALL.md`、`index.js`、`client.js`、`locale/*` 全部扫描）。允许的例外只有 `docs/ARCHITECTURE*.md`、`docs/SUB-LAUNCHER.md` 这类开发者文档中作为**格式示例**出现的字样（品牌检查按既有豁免规则处理）。
- 核心 `plugins/` 目录**整个删除**（迁移到附属启动器项目）。核心分发包、`package.json files`、`build-dist.mjs` 都不再包含 `plugins/`。
- 附属启动器项目可以包含具体游戏/平台代码，不受核心品牌检查约束。
- 两个项目各自有 `package.json`（核心是 DSH 插件包；附属启动器不是 DSH 插件包，是纯 zip 包）、README、LICENSE、`.gitignore`、构建脚本。

## §1 附属启动器包格式（zip）

文件名建议：`<id>-launcher-<version>.zip`，例如 `minecraft-launcher-1.0.0.zip`。
zip 根目录（没有外层文件夹）必须包含 `launcher.json`：

```json
{
  "schemaVersion": 1,
  "id": "minecraft",
  "label": "Minecraft",
  "version": "1.0.0",
  "entry": "lib/index.mjs",
  "minCoreVersion": "3.2.0",
  "description": "Minecraft 附属启动器：版本/加载器/内容下载与启动。",
  "homepage": "https://github.com/OWNER/dsh-launcher-minecraft",
  "gamesHint": ["Minecraft"]
}
```

字段：
- `schemaVersion` 必须为 1；`id` 小写字母/数字/连字符（`^[a-z0-9][a-z0-9-]{1,40}$`），在核心内唯一（安装时若 id 与已装冲突→报错，除非是 update）；`label` 显示名；`version` semver；`entry` 包内相对路径，必须落在 zip 内；`minCoreVersion` 与核心版本做简单 semver 比较（不满足则报「需要核心版本 >= x」）；`description`/`homepage`/`gamesHint` 可选。
- 包内**不得**包含 `data/`、`node_modules/`、`.git/`。
- `entry` 模块必须 export default：一个函数 `(helpers) => adapter | adapter[]` 或一个 adapter 对象。helpers = `{ dl, paths, logger, registerGame }`（game-store 现有约定）。adapter 契约见 `docs/GAME-ADAPTER.md`（`lib/core/registry.js` 的 validateAdapter 规则）。
- 包内依赖只允许 Node 内置模块 + 核心暴露的 helpers；不允许 `import '@local/dsh-launcher/...'`（跨上下文不可靠）。
- 单个 zip ≤ 25MB；解压后 ≤ 200MB。

## §2 核心侧存储与加载

```
dataRoot/
  sub-launchers/
    registry.json            # { schemaVersion: 1, launchers: [{ id,label,version,entry,source,repo?,url?,installedAt,updatedAt,dir }] }
    <id>/<version>/...       # 解压后的包内容（含 launcher.json）
  adapters/sublauncher-<id>.mjs   # 核心写的加载桥：
                                  #   export { default } from 'file:///.../entry.mjs'
  adapters/...（旧的手工适配器仍可用）
```

- 安装：下载 zip → 校验（zip 头 + `launcher.json` + entry 存在）→ 解压到 `sub-launchers/<id>/<version>/` → 写 `registry.json` → 写/替换 `adapters/sublauncher-<id>.mjs` → 触发 game-store 热加载（现有 `engine` 的 adapters/games 目录 2.5s 轮询或直接 `reloadGames()`）。
- 更新：装新版本目录 → 重写桥 → 删旧版本目录 → 更新 registry。
- 卸载：删桥文件 + 删 `sub-launchers/<id>/` + 删 registry 条目 → 热加载后游戏消失。
- 已安装的适配器（`dataRoot/adapters/*.mjs`）与用户游戏定义（`dataRoot/games/*.json`）继续兼容，附属启动器只是多了一种来源。

## §3 下载来源（三种）

1. `repo: "owner/name"` —— GitHub Releases：GET `https://api.github.com/repos/<owner>/<name>/releases/latest`，取 assets；选资产规则：优先 `assetPattern`（简单通配符如 `minecraft-launcher-*.zip`），否则取文件名以 `.zip` 结尾的第一个；RELEASE 没有 zip → 报错「该 GitHub Release 没有 zip 资产」。
2. `url: "https://..."` —— 直接 zip URL（可用镜像/自建服务器）。
3. `file: "<本机路径>"` —— 本机 zip（面板里给路径输入框，host 直接读；用于离线/自测）。

下载用 `lib/core/http.js` 的 `downloadFile`（大文件分片 + sha1 可选）；解压用 `lib/core/archive.js` / `lib/core/zip.js`（防 zip slip）；GitHub API 请求带上 `Accept: application/vnd.github+json`、`User-Agent: dsh-launcher/<version>`，失败给中文错误。无 token 情况下 GitHub API 有速率限制，错误要原样转告但包装成中文。

## §4 Engine API（Lead 实现；队友按此写模块）

新增 `lib/core/sublaunchers.js`：

```js
export function createSubLauncherManager({ paths, dl, logger, runJob, reloadGames, coreVersion }) {
  return {
    async list() -> [{ id,label,version,entry,source,repo?,url?,installedAt,updatedAt,dir,games:[gameId] }],
    async install(spec) -> { id, version, dir },      // spec: { repo?, url?, file?, assetPattern? }
    async check(id) -> { id, installedVersion, latestVersion, updateAvailable, repo? },
    async update(id) -> { id, version, dir },
    async remove(id) -> { removed: true },
  }
}
```

- `install` 内部要写 job 日志（phase：解析来源→下载→校验→解压→注册），用 `runJob` 包装成 `kind='sublauncher-install'` 任务；失败抛中文错误。
- 版本比较用简单 semver 比较（`compareVersion`）。
- 所有写操作完成后 `await reloadGames()`，让游戏立即出现/消失（免重启）。

engineApi 新增：`listSubLaunchers()`、`installSubLauncher(spec)`（返回 `{jobId}`）、`checkSubLauncher(id)`、`updateSubLauncher(id)`（返回 `{jobId}`）、`removeSubLauncher(id)`。

## §5 HTTP API（前缀 `/dsh-launcher/api`）

| 方法 | 路径 | body | 返回 |
| --- | --- | --- | --- |
| GET | `/sublaunchers` | - | `{launchers:[...]}` |
| POST | `/sublaunchers/install` | `{repo?|url?|file?, assetPattern?}` | `{jobId}` |
| POST | `/sublaunchers/:id/check` | - | `{id,installedVersion,latestVersion,updateAvailable}` |
| POST | `/sublaunchers/:id/update` | - | `{jobId}` |
| DELETE | `/sublaunchers/:id` | - | `{removed:true}` |

错误映射沿用现有 classifyError。job 摘要沿用现有 job 模型（`GET /jobs/:id` 看进度，`kind='sublauncher-install'`/`'sublauncher-update'`）。

## §6 Agent 工具（共 30 个）

- `launcher_list_sublaunchers`：列出已安装附属启动器（含是否有更新）。
- `launcher_install_sublauncher`：从 GitHub 仓库（`owner/name`）、zip URL 或本机文件路径安装附属启动器；参数 `{repo?, url?, file?, assetPattern?}`，至少一个来源；返回 jobId。
- `launcher_update_sublauncher`：`{id}`。
- `launcher_remove_sublauncher`：`{id}`。
工具描述中文、不出现具体游戏名；系统提示词 PROMPT 增补「用户想玩某个游戏但游戏列表没有时：先检查/安装对应附属启动器（问用户要 GitHub 仓库或 zip 地址），再按普通流程下载安装」。

## §7 面板（Client）

顶层 tab：**游戏 / 附属启动器 / 添加游戏 / 设置**。
「附属启动器」页：
- 已安装列表卡片：label、version、来源（GitHub repo / URL / 本机）、有更新徽标、按钮「检查更新」「更新」「删除（二次确认）」。
- 安装表单：来源类型三选一（GitHub 仓库 / zip URL / 本机文件路径）+ assetPattern（高级，可选）+ 安装按钮 → POST install → 轮询 `/jobs/:id` 显示进度；成功后 toast 并刷新 /state。
- 页内说明文案（通用）：附属启动器是独立项目，核心不含具体游戏；从 GitHub Release 或 zip 地址安装后游戏会自动出现在「游戏」页。
- 全部文本走 locale；无具体游戏名（示例文案用「某个游戏」）。

## §8 我的世界启动器项目（`dsh-launcher-minecraft/`）

从 `dsh-launcher-v3/plugins/minecraft-adapter/` 迁移（该目录随后从核心删除）。目标结构：

```
dsh-launcher-minecraft/
  launcher.json                # §1 格式，id=minecraft，version=1.0.0，entry=lib/index.mjs，minCoreVersion=3.2.0
  lib/index.mjs                # export default (helpers) => adapter（桥接入口）
  lib/adapter.js ... 其余原 lib/*（mirrors/version/vanilla/loaders/modrinth/java/launch/util/zip）
  README.md                    # 用户安装（面板/对话装 GitHub 仓库）、构建、发布 Release、目录说明
  package.json                 # name dsh-launcher-minecraft，private，type module，scripts: test/build:dist
  LICENSE (MIT)
  .gitignore
  scripts/build-dist.mjs       # 产出 dist/minecraft-launcher-<version>/ 与 dist/minecraft-launcher-<version>.zip（zip 根含 launcher.json）
  scripts/check-package.mjs    # 静态校验包格式（launcher.json 必填/entry 存在/zip 内路径合法/无 node_modules/data）
  test/...                     # 保留 adapter-test（改为从包根加载 entry 验证能返回 adapter）
```

- `lib/index.mjs`：`import adapter from './adapter.js'; export default function createAdapter() { return adapter }`（game-store 会用 helpers 调它）。
- 原 DSH 插件包装 `index.js`/`cordis.patch.yml`/`package.json` 的 dsh 字段**不需要**；附属启动器不做 DSH 插件安装（若想两种都支持可在 README 写手动方案，v1 不做）。
- 适配器内部保持现有能力：版本/加载器/内容/Java/启动；`configure()` 继续支持。
- `adapter-test` 改为直接 `import('./lib/index.mjs')` 得到 factory → 调 `factory({})` → 校验 adapter 结构，并保留真实网络用例（可跳过）。

## §9 版本与兼容

- 核心版本 **3.2.0**（package.json + cordis.patch.yml 注释 + README + bridge pointer payload 更新）。
- 附属启动器版本 **1.0.0**；`minCoreVersion` 3.2.0。
- 核心与 v3.1 数据/实例/定义完全向后兼容（`data/adapters/*.mjs`、`data/games/*.json` 不动）。

## §10 文件归属（本轮 v4）

| 负责人 | 文件 |
| --- | --- |
| download-speed（task-13） | 新建 `lib/core/sublaunchers.js`、`scripts/sublauncher-test.mjs`；不得改其他核心文件 |
| ui-v2（task-14） | `client.js`、`locale/zh.json`、`locale/en.json`、`scripts/check-client.mjs` |
| content（task-15） | 新建 `dsh-launcher-minecraft/` 整个项目；不得改核心文件 |
| Lead | `docs/ARCHITECTURE-v4.md`、`index.js`、`lib/core/engine.js`、`package.json`、`scripts/build-dist.mjs`、`README.md`、`docs/USAGE.md`、`docs/INSTALL.md`、`docs/GAME-ADAPTER.md`、`scripts/brand-check.mjs`、`cordis.patch.yml`、集成测试与 E2E |

## §11 环境

- Node 绝对路径：`C:\Users\38357\.dsh\dsh-runtimes\dsh-plugin-desktop-primary-runtime\dependencies\node\bin\node.exe`（PATH 无 node）。
- 网络必须 Node fetch/http；shell curl 不可用。
- 工作目录 `C:\Users\38357\Desktop\模组开发`；文件策略 danger-full-access、审批禁用。
- 测试必须全绿；核心测试命令保持 `npm test` 语义（node scripts/... 串联）。

## §12 推荐目录（catalog）

- 模块 `lib/core/catalog.js`：`createCatalogLoader({paths, logger, getConfig})` → `{ load({refresh}), clear() }`；`parseCatalog`/`normalizeCatalogEntry`/`annotateCatalog`/`fetchCatalogJson` 导出。
- 配置键 `catalogUrl`（DEFAULT_CONFIG 默认空；cordis.patch.yml 内置官方推荐目录地址）→ 远程 JSON（≤256KB、≤50 条、10 分钟内存缓存）；远程失败或为空时读 `<dataRoot>/catalog.json`，两份都没有返回 `entries: []` + `error: ''`（面板显示空态，不挡手动安装）。
- engine：`listCatalog({refresh})` → `{entries, updatedAt, source, fetchedAt, error}`，其中 entries 已由 `annotateCatalog` 标注 `installed / installedVersion / updateAvailable`（按 repo 或 id 匹配已安装附属启动器）。
- index.js：`GET /catalog[?refresh=1]`；工具 `launcher_list_catalog`（30 个工具之一）。
- 条目来源字段：`repo` / `url` / `file` 三选一，安装时原样传给 `installSubLauncher`。
