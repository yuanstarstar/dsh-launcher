# DSH启动器（DSH 插件 `@local/dsh-launcher`）

在 DeepSeek Harness（DSH）里**用对话或图形面板**添加、下载并启动任意游戏。

本仓库是**启动器本体**：一个纯框架。它自己不认识任何具体游戏——不含任何游戏/平台/厂商的专用代码、镜像地址、文案或图标，也**不含任何具体启动器实现**。所有游戏能力来自：

- **内置提供者**（开箱即用，无需写代码）：GitHub Releases、URL 版本清单、手动导入已安装游戏；
- **附属启动器**（独立项目，按需从 GitHub 等方式安装）：第三方开发者为某个游戏写的独立启动器包，安装后其游戏自动出现在列表里，并在面板/对话里获得下载与启动能力。

本体与附属启动器是**两个独立项目**：本体负责框架、实例、下载器、面板、对话工具与附属启动器的安装/更新/卸载；具体游戏怎么下载、怎么启动，全部由对应附属启动器实现。

你可以在对话里说「帮我装一个游戏，然后下载最新版并启动」，也可以在面板里点选完成；两者共用同一套 Host 实现，可混用。

---

## 功能

| 能力 | 说明 |
| --- | --- |
| 添加游戏 | GitHub Release（按资源名匹配下载）、URL 清单（JSON 定义版本与下载地址）、手动导入（目录+可执行文件） |
| 版本管理 | 列表/强制刷新，安装前先选版本号 |
| 下载 | 多源测速、keep-alive 连接池、默认 16 并发、≥8MB 文件 Range 分片、sha1 校验、`429/5xx` 指数退避、断点缓存复用 |
| 实例 | 每个实例独立目录（版本隔离）、内存/启动参数覆盖、内容列表、日志、校验、重命名、打开游戏/内容目录 |
| 启动/停止 | 后台任务启动、进程树停止、1.5s 早期失败探测、日志落盘 |
| 内容 | 支持内容能力的游戏（附属启动器声明）可搜索/安装/删除扩展内容 |
| 运行时 | 支持运行时的游戏可按版本自动检测/下载所需运行时 |
| 附属启动器 | 从 GitHub 仓库、zip URL 或本机文件安装；检查更新/更新/卸载；安装后游戏自动出现，无需重启 |
| 面板 | 「启动游戏」入口 → **游戏 / 附属启动器 / 添加游戏 / 设置** 四个页签；点开某个游戏进入详情，再针对该游戏下载版本、安装实例、启动、管内容（其他游戏同理）；实例区可直达游戏目录、内容目录、日志 |
| 对话 | 30 个 `launcher_*` 工具 + 系统提示词，全程中文 |

## 安装

```text
plugin_manager action=install_bundle target=<本目录绝对路径>
```

安装后 DSH 会加载 Host 半（工具 + HTTP API）。Client 面板首次安装通常即时生效；**替换已安装版本需要重启 DSH**（Node ESM 模块缓存）。

## 安装附属启动器（获得具体游戏能力）

打开面板「启动游戏」→「附属启动器」页，三种来源任选：

| 来源 | 填什么 |
| --- | --- |
| GitHub 仓库 | `owner/repo`（本体读取该仓库最新 Release 里的 zip） |
| zip URL | 任意可访问的 zip 直链 |
| 本机文件 | 本机 zip 路径 |

面板顶部还有**推荐目录**：一键安装本体推荐的附属启动器（例如本体作者维护的示例附属启动器，具体以目录内容为准）。目录来自 bundle 配置的 `catalogUrl`，或数据根下的 `catalog.json`；远程不可用时会自动回退本地文件。对话里说「看看有哪些附属启动器可以装」即可（`launcher_list_catalog`）。

也可以直接对话，例如：

```text
你：帮我把 owner/repo 这个附属启动器装上
DSH：（launcher_install_sublauncher {repo:"owner/repo"} → launcher_job_status 看进度）
```

安装完成数秒内游戏自动出现在「游戏」页（无需重启 DSH）；删除附属启动器后游戏自动消失，已安装的游戏实例不受影响。

> 附属启动器的包格式、入口约定、打包与发布方式见 [docs/SUB-LAUNCHER.md](docs/SUB-LAUNCHER.md)。适配器接口契约见 [docs/GAME-ADAPTER.md](docs/GAME-ADAPTER.md)。

## 分发到其它机器

```bash
node scripts/build-dist.mjs
```

生成 `dist/dsh-launcher-<version>/`（本体 + `INSTALL.md`）与 `dist/dsh-launcher-<version>.zip`。分发包不含本机 `data/`、缓存和测试目录，`cordis.patch.yml` 也不写死任何绝对路径，拷到另一台机器后：

1. 解压到任意固定目录；
2. 在 DSH 对话里说「安装本地插件：<该目录>」（即 `plugin_manager install_bundle`）；
3. 完全退出并重启 DSH Desktop；
4. 在「附属启动器」页安装需要的附属启动器（装后数秒自动生效，无需重启）。

详细步骤与排错见 [INSTALL.md](docs/INSTALL.md)（分发包根目录也有一份）。

## 配置

bundle patch（`cordis.patch.yml`）中可配置：

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `dataRoot` | `<用户主目录>/.dsh-launcher/data`（兼容旧版 `<插件目录>/data`） | 启动器数据根：实例、下载缓存、游戏定义、附属启动器 |
| `catalogUrl` | 内置推荐目录地址（见 `cordis.patch.yml`，可留空） | 「推荐目录」JSON 地址；留空则只读数据根 `catalog.json` |
| `downloadConcurrency` | `16` | 下载并发（1–32） |
| `retries` | `3` | 下载重试次数（0–10） |

运行期也可以在面板「设置」页或对话里用 `launcher_set_config` 修改。

## 数据目录

```text
<dataRoot>/
  instances/<id>/           每个实例的游戏目录（版本隔离）
  games/<id>.json           用户添加的游戏定义（凭据敏感字段请勿外传）
  catalog.json             本地推荐目录（可选；远程不可用时回退）
  adapters/*.mjs            手工/外部适配器加载桥（自动热加载）
  sub-launchers/
    registry.json           已安装附属启动器登记表
    <id>/<version>/...      解压后的附属启动器包
  cache/                    版本清单、下载缓存、运行时缓存
  config.json               运行期配置
```

## 对话工具（30 个）

状态与游戏：`launcher_status`、`launcher_list_games`、`launcher_add_game`、`launcher_remove_game`
附属启动器：`launcher_list_catalog`、`launcher_list_sublaunchers`、`launcher_install_sublauncher`、`launcher_update_sublauncher`、`launcher_remove_sublauncher`
版本与内容：`launcher_list_versions`、`launcher_list_loaders`、`launcher_search_content`、`launcher_content_versions`
实例：`launcher_install_game`、`launcher_list_instances`、`launcher_get_instance`、`launcher_launch_game`、`launcher_stop_game`、`launcher_instance_log`、`launcher_open_folder`、`launcher_rename_instance`、`launcher_verify_instance`、`launcher_delete_instance`、`launcher_add_content`、`launcher_remove_content`
任务与杂项：`launcher_list_jobs`、`launcher_job_status`、`launcher_cancel_job`、`launcher_list_runtimes`、`launcher_set_config`

## HTTP API

前缀 `/dsh-launcher/api`，同源相对请求即可（面板就用它）。返回统一为 `{ok:true,data}` 或 `{ok:false,error:'中文错误'}`。

`GET /state`、`/games`、`/versions?game=`、`/loaders?game=&version=`、`/content/search?game=&q=`、`/content/project?game=&id=`、`/runtimes?game=`、`/instances`、`/instances/:id`、`/instances/:id/log`、`/sublaunchers`、`/catalog`、`/jobs`、`/jobs/:id`；
`POST /games`、`/games/test`、`/install`、`/sublaunchers/install`、`/sublaunchers/:id/check`、`/sublaunchers/:id/update`、`/instances/:id/launch|stop|verify|rename|open`、`/instances/:id/content`、`/jobs/:id/cancel`；
`PATCH /config`；`DELETE /games/:id`、`/sublaunchers/:id`、`/instances/:id`、`/instances/:id/content/:filename`。

## 添加游戏示例（对话）

```text
你：帮我添加一个游戏
DSH：你想从哪来？GitHub Release / URL 清单 / 手动导入。
你：GitHub，仓库 owner/name，下载 assets 里以 -windows.zip 结尾的那个，主程序是 game.exe
DSH：（launcher_add_game → launcher_list_versions → launcher_install_game → launcher_launch_game）
```

URL 清单格式（`jsonUrl` 指向的 JSON）：

```json
{
  "versions": [
    { "id": "1.0.0", "label": "1.0.0", "url": "https://example.com/game-1.0.0.zip", "sha1": "…", "size": 12345 }
  ],
  "executable": "game.exe",
  "args": ["--data", "."]
}
```

## 二次开发

- 附属启动器包格式与发布：[docs/SUB-LAUNCHER.md](docs/SUB-LAUNCHER.md)
- 适配器契约与最小示例：[docs/GAME-ADAPTER.md](docs/GAME-ADAPTER.md)
- 详细使用说明（对话/面板/FAQ）：[docs/USAGE.md](docs/USAGE.md)
- 架构设计（团队内部规范）：[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)（本体/附属启动器拆分方案）

## 测试

```bash
node scripts/registry-test.mjs     # 注册表契约
node scripts/brand-check.mjs       # 本体纯净度（无任何游戏/平台词）
node scripts/inject-test.mjs       # 严格注入（Cordis 访问器）
node scripts/http-test.mjs         # 路由/工具/错误映射
node scripts/sublauncher-test.mjs  # 附属启动器安装/更新/卸载/热加载
node scripts/catalog-test.mjs      # 推荐目录解析/远程+本地回退/GitHub 网页解析
node scripts/bridge-test.mjs       # 适配器加载桥 + 热加载/卸载
node scripts/portability-test.mjs  # 可移植性（默认数据根/无本机路径/分发包）
node scripts/check-client.mjs      # 面板仿真（四页签/附属启动器/安装/内容/设置请求体）
node scripts/providers-test.mjs    # 内置提供者（本地 HTTP 服务，无需联网）
node scripts/build-dist.mjs        # 生成分发包目录 + zip
```

端到端验收（会真实下载游戏，需要先准备一个附属启动器 zip）：

```bash
# 1) 在你自己的游戏项目里构建附属启动器 zip（格式见 docs/SUB-LAUNCHER.md）
#    产物：<你的项目>/dist/<name>-<version>.zip

# 2) 本体 + 附属启动器的完整链路：安装附属启动器 → 游戏出现 → 安装实例 → 启动 → 停止 → 删除
node scripts/e2e-v4.mjs --zip <附属启动器 zip 的绝对路径>
```

## 验证记录（2026-10-21 ~ 2026-10-23 实测，Windows / Node 24）

| 测试 | 结果 |
| --- | --- |
| registry-test | 15 PASS / 0 FAIL |
| providers-test（本地 HTTP 服务，无需联网） | 32 PASS / 1 SKIP（GitHub 用例需外网） |
| http-test | 38 PASS / 0 FAIL（路由/工具/错误映射，含附属启动器与推荐目录接口） |
| inject-test | 8 PASS / 0 FAIL（30 个工具 / 1 个提示词段 / 1 条路由） |
| brand-check | PASS（27 个文件 / 30 个工具，本体零游戏/平台词；URL 与仓库标识不误报） |
| sublauncher-test | 123/123 PASS：安装/校验/解压/清单/桥接/热加载/更新/卸载全链路 |
| catalog-test | 19 PASS / 0 FAIL（离线：解析/缓存/回退/GitHub 网页解析）；REAL_GITHUB=1 时另有 3 项真实网络用例 |
| bridge-test | 12 PASS / 0 FAIL：指针文件 → 适配器写入桥接 → 热加载出游戏 → 删除桥接自动卸载 |
| portability-test | 28 PASS / 0 FAIL：默认数据根/无本机绝对路径/可移植 patch/分发包完整性 |
| check-client | PASS（31 项检查 / 14 渲染场景 / zh+en 各 256 键） |
| e2e-v4（本体 + 附属启动器） | 23 PASS / 0 FAIL / 0 SKIP：安装附属启动器 → 游戏自动出现 → 安装实例（23.1s）→ 启动（真实进程 + 日志证据）→ 停止 → 删除 |

## 目录结构

```text
index.js                  Host 入口：工具 + HTTP API + 提示词
client.js                 面板（零构建浏览器模块）
lib/core/registry.js      游戏注册表（供适配器注册）
lib/core/engine.js        引擎：配置/游戏存储/实例/任务/附属启动器
lib/core/sublaunchers.js  附属启动器管理（下载/校验/解压/注册/更新/卸载）
lib/core/catalog.js       推荐目录（远程 catalogUrl + 本地 catalog.json + 回退）
lib/core/game-store.js    游戏定义存储 + 适配器加载
lib/core/providers/       内置提供者（github-release / url-manifest / manual）
lib/core/http.js          通用下载器
lib/core/archive.js       ZIP 解压 + 可执行探测
lib/core/launch.js        进程启动/停止/日志
lib/core/{paths,instances}.js
docs/                     使用说明、附属启动器格式、适配器契约、架构规范
scripts/                  测试与自测脚本
```

## 常见问题

**面板没出现「启动游戏」/对话里没有 `launcher_*` 工具？**  
替换已安装版本后需完全退出并重启 DSH（Host 代码有模块缓存）。

**游戏列表是空的？**  
本体不含任何游戏。到「附属启动器」页安装一个附属启动器（GitHub 仓库 / zip 地址 / 本机文件），或在对话里用 `launcher_install_sublauncher`；也可以先用「添加游戏」手动导入已安装的游戏。

**附属启动器安装失败？**  
`launcher_job_status` 看任务日志；常见原因：GitHub Release 里没有 zip 资产、仓库名写错、zip 缺少合法的 `launcher.json`、`minCoreVersion` 高于本体版本、网络被代理拦截。

**添加游戏时报 403/429？**  
GitHub API 对匿名请求限流，稍后重试；URL 清单若需要鉴权请直接在配置里带请求头（适配器支持 `headers`）。

**下载很慢？**  
在设置里把并发调到 16–24；镜像类 URL 可在游戏定义的 `resolveUrl` 里提供多候选，下载器会自动测速选源。

**安装失败怎么看？**  
`launcher_job_status` 看任务日志；实例详情 `installError` 字段保留上次失败原因；`launcher_verify_instance` 可校验文件完整性。

**卸载**：`plugin_manager` 移除 `@local/dsh-launcher` bundle 即可；数据目录默认在 `~/.dsh-launcher/data`，可手动删除。

## 开源与参与开发

- 本仓库只包含**启动器本体**；各附属启动器是独立项目与独立仓库（可从 GitHub Release 安装）。
- 上传 GitHub、发布 Release、日常提交与常见问题的步骤见 [docs/GITHUB-UPLOAD.md](docs/GITHUB-UPLOAD.md)；只用浏览器上传看 [docs/GITHUB-WEB-UPLOAD.md](docs/GITHUB-WEB-UPLOAD.md)。
- 仓库只提交源码与文档：`data/`、`dist/`、`test/tmp/` 等运行/生成产物由 `.gitignore` 排除；分发包请通过 GitHub Releases 附件发布（`npm run build:dist` 生成的 zip）。
- 每次 push 到 `main` 或提交 Pull Request，GitHub Actions（`.github/workflows/tests.yml`）会自动跑本体测试。
- 许可证 MIT，见 [LICENSE](LICENSE)。

## 许可

MIT
