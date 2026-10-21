# DSH启动器（DSH 插件 `@local/dsh-launcher`）

在 DeepSeek Harness（DSH）里**用对话或图形面板**添加、下载并启动任意游戏。

核心包是**纯框架**：它自己不认识任何具体游戏——不含任何游戏/平台/厂商的专用代码、镜像地址、文案或图标。所有游戏能力来自：

- **内置提供者**（开箱即用，无需写代码）：GitHub Releases、URL 版本清单、手动导入已安装游戏；
- **外部适配器包**（可选，按需安装）：第三方开发者按 [适配器契约](docs/GAME-ADAPTER.md) 写的插件包，安装后其游戏自动出现在列表里。

你可以在对话里说「帮我添加这个 GitHub 上的游戏，然后装最新版并启动」，也可以在面板里点选完成；两者共用同一套 Host 实现，可混用。

---

## 功能

| 能力 | 说明 |
| --- | --- |
| 添加游戏 | GitHub Release（按资源名匹配下载）、URL 清单（JSON 定义版本与下载地址）、手动导入（目录+可执行文件） |
| 版本管理 | 列表/强制刷新，安装前先选版本号 |
| 下载 | 多源测速、keep-alive 连接池、默认 16 并发、≥8MB 文件 Range 分片、sha1 校验、`429/5xx` 指数退避、断点缓存复用 |
| 实例 | 每个实例独立目录（版本隔离）、内存/启动参数覆盖、内容列表、日志、校验、重命名 |
| 启动/停止 | 后台任务启动、进程树停止、1.5s 早期失败探测、日志落盘 |
| 内容 | 支持内容能力的游戏（适配器声明）可搜索/安装/删除扩展内容 |
| 运行时 | 支持运行时的游戏可按版本自动检测/下载所需运行时 |
| 面板 | 「启动游戏」入口 → **游戏 / 添加游戏 / 设置** 三个页签；点开某个游戏进入详情，再针对该游戏下载版本、安装实例、启动、管内容（其他游戏同理）；实例区可直达游戏目录、内容目录、日志 |
| 对话 | 25 个 `launcher_*` 工具 + 系统提示词，全程中文 |

## 安装

```text
plugin_manager action=install_bundle target=<本目录绝对路径>
```

安装后 DSH 会加载 Host 半（工具 + HTTP API）。Client 面板首次安装通常即时生效；**替换已安装版本需要重启 DSH**（Node ESM 模块缓存）。

> 可选：仓库附带的示例适配器包在 `plugins/` 目录下，单独 `install_bundle` 后即可添加对应游戏。核心包不含它。
> 安装适配器包后**数秒内自动生效，无需重启 DSH**：核心与适配器通过文件桥接对接（核心写 `~/.dsh-launcher/bridge.json`，适配器把桥接模块写入 `<dataRoot>/adapters/`，核心轮询热加载）。替换**核心包**本身仍需重启 DSH。

## 分发到其它机器

```bash
node scripts/build-dist.mjs
```

生成 `dist/dsh-launcher-<version>/`（核心 + `INSTALL.md` + 可选适配器）与 `dist/dsh-launcher-<version>.zip`。分发包不含本机 `data/`、缓存和测试目录，`cordis.patch.yml` 也不写死任何绝对路径，拷到另一台机器后：

1. 解压到任意固定目录；
2. 在 DSH 对话里说「安装本地插件：<该目录>」（即 `plugin_manager install_bundle`）；
3. 完全退出并重启 DSH Desktop；
4. 可选：再用同样方式安装 `plugins/` 下的适配器包（装后数秒自动生效，无需重启）。

详细步骤与排错见 [INSTALL.md](docs/INSTALL.md)（分发包根目录也有一份）。

## 配置

bundle patch（`cordis.patch.yml`）中可配置：

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `dataRoot` | `<用户主目录>/.dsh-launcher/data`（兼容旧版 `<插件目录>/data`） | 启动器数据根：实例、下载缓存、游戏定义、外部适配器 |
| `downloadConcurrency` | `16` | 下载并发（1–32） |
| `retries` | `3` | 下载重试次数（0–10） |

运行期也可以在面板「设置」页或对话里用 `launcher_set_config` 修改。

## 数据目录

```text
<dataRoot>/
  instances/<id>/           每个实例的游戏目录（版本隔离）
  games/<id>.json           用户添加的游戏定义（凭据敏感字段请勿外传）
  adapters/*.mjs            外部适配器（自动热加载，安装/删除后数秒生效，无需重启）
  cache/                    版本清单、下载缓存、运行时缓存
  config.json               运行期配置
```

## 对话工具（25 个）

状态与游戏：`launcher_status`、`launcher_list_games`、`launcher_add_game`、`launcher_remove_game`
版本与内容：`launcher_list_versions`、`launcher_list_loaders`、`launcher_search_content`、`launcher_content_versions`
实例：`launcher_install_game`、`launcher_list_instances`、`launcher_get_instance`、`launcher_launch_game`、`launcher_stop_game`、`launcher_instance_log`、`launcher_open_folder`、`launcher_rename_instance`、`launcher_verify_instance`、`launcher_delete_instance`、`launcher_add_content`、`launcher_remove_content`
任务与杂项：`launcher_list_jobs`、`launcher_job_status`、`launcher_cancel_job`、`launcher_list_runtimes`、`launcher_set_config`

## HTTP API

前缀 `/dsh-launcher/api`，同源相对请求即可（面板就用它）。返回统一为 `{ok:true,data}` 或 `{ok:false,error:'中文错误'}`。

`GET /state`、`/games`、`/versions?game=`、`/loaders?game=&version=`、`/content/search?game=&q=`、`/content/project?game=&id=`、`/runtimes?game=`、`/instances`、`/instances/:id`、`/instances/:id/log`、`/jobs`、`/jobs/:id`；
`POST /games`、`/games/test`、`/install`、`/instances/:id/launch|stop|verify|rename|open`、`/instances/:id/content`、`/jobs/:id/cancel`；
`PATCH /config`；`DELETE /games/:id`、`/instances/:id`、`/instances/:id/content/:filename`。

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

- 适配器契约与最小示例：[docs/GAME-ADAPTER.md](docs/GAME-ADAPTER.md)
- 详细使用说明（对话/面板/FAQ）：[docs/USAGE.md](docs/USAGE.md)
- 架构设计（团队内部规范）：[docs/ARCHITECTURE-v3.md](docs/ARCHITECTURE-v3.md)

## 测试

```bash
node scripts/registry-test.mjs   # 注册表契约
node scripts/brand-check.mjs     # 核心包纯净度（无任何游戏/平台词）
node scripts/inject-test.mjs     # 严格注入（Cordis 访问器）
node scripts/http-test.mjs       # 路由/工具/错误映射
node scripts/bridge-test.mjs     # 跨插件文件桥接 + 适配器热加载/卸载
node scripts/portability-test.mjs # 可移植性（默认数据根/无本机路径/分发包）
node scripts/check-client.mjs    # 面板仿真（tab/详情/安装/内容/设置请求体）
node scripts/provider-test.mjs   # 内置提供者（本地 HTTP 服务，无需联网）
node scripts/e2e-v3.mjs          # 端到端：添加→安装→启动→停止→删除
node scripts/build-dist.mjs      # 生成分发包目录 + zip
```

`e2e-v3.mjs` 需要先安装可选适配器包（见「可选适配器」）才会跑出完整链路；纯核心包可先跑前五项。

## 验证记录（2026-10-21 ~ 2026-10-22 实测，Windows / Node 24）

| 测试 | 结果 |
| --- | --- |
| registry-test | 15 PASS / 0 FAIL |
| provider-test（本地 HTTP 服务，无需联网） | 32 PASS / 1 SKIP（GitHub 用例需外网） |
| http-test | 30 PASS / 0 FAIL |
| inject-test | 8 PASS / 0 FAIL（25 工具 / 1 提示词段 / 1 路由） |
| brand-check | PASS（核心包 24 个文件零游戏/平台词，25 个 `launcher_*` 工具） |
| bridge-test | **9 PASS / 0 FAIL**：指针文件 → 适配器写入桥接 → 核心热加载出游戏 → 删除桥接文件自动卸载 → 插件卸载清理 |
| portability-test | **25 PASS / 0 FAIL**：默认数据根/无本机绝对路径/可移植 patch/分发包完整性 |
| check-client | PASS（29 项检查 / 11 个渲染场景；zh/en 各 189 条翻译；v3.1 按游戏进入的详情交互） |
| e2e-v3（含可选适配器） | **22 PASS / 0 FAIL**：安装 90.6s–118.0s（游戏文件 80.4MB + 内容），启动日志命中 `Setting user` / `Backend library` / `LWJGL`，停止与删除正常 |
| adapter-test（可选适配器包自测） | 29 PASS / 0 FAIL |

e2e-v3 使用真实网络与真实游戏进程跑完整链路：注册表 → 版本/加载器/内容查询 → 安装 → 校验 → 启动 → 停止 → 删除。
其中「下载内容」阶段速度受内容 CDN 影响，可能占安装时间的一半；纯游戏文件安装（库+本体+资源）在缓存就绪后约 40 秒。

## 目录结构

```text
index.js                  Host 入口：工具 + HTTP API + 提示词
client.js                 面板（零构建浏览器模块）
lib/core/registry.js      游戏注册表（供适配器注册）
lib/core/engine.js        引擎：配置/游戏存储/实例/任务
lib/core/game-store.js    游戏定义存储 + 外部适配器加载
lib/core/providers/       内置提供者（github-release / url-manifest / manual）
lib/core/http.js          通用下载器
lib/core/archive.js       ZIP 解压 + 可执行探测
lib/core/launch.js        进程启动/停止/日志
lib/core/{paths,instances}.js
plugins/                  可选示例适配器包（独立安装，不属于核心）
docs/                     使用说明、适配器契约、架构规范
scripts/                  测试与自测脚本
```

## 常见问题

**面板没出现「启动游戏」/对话里没有 `launcher_*` 工具？**  
替换已安装版本后需完全退出并重启 DSH（Host 代码有模块缓存）。

**添加游戏时报 403/429？**  
GitHub API 对匿名请求限流，稍后重试；URL 清单若需要鉴权请直接在配置里带请求头（适配器支持 `headers`）。

**下载很慢？**  
在设置里把并发调到 16–24；镜像类 URL 可在游戏定义的 `resolveUrl` 里提供多候选，下载器会自动测速选源。

**安装失败怎么看？**  
`launcher_job_status` 看任务日志；实例详情 `installError` 字段保留上次失败原因；`launcher_verify_instance` 可校验文件完整性。

**卸载**：`plugin_manager` 移除 `@local/dsh-launcher` bundle 即可；数据目录默认在插件目录下 `data/`，可手动删除。

## 开源与参与开发

- 把项目上传到 GitHub、发布 Release、日常提交与常见问题的完整步骤见 [docs/GITHUB-UPLOAD.md](docs/GITHUB-UPLOAD.md)；不想装 Git、只想用浏览器上传的话看 [docs/GITHUB-WEB-UPLOAD.md](docs/GITHUB-WEB-UPLOAD.md)。
- 仓库只提交源码与文档：`data/`、`dist/`、`test/tmp/` 等运行/生成产物由 `.gitignore` 排除；分发包请通过 GitHub Releases 附件发布（`npm run build:dist` 生成的 zip）。
- 每次 push 到 `main` 或提交 Pull Request，GitHub Actions（`.github/workflows/tests.yml`）会自动跑注册表、桥接、可移植性、品牌、注入、HTTP 与面板仿真测试。
- 许可证 MIT，见 [LICENSE](LICENSE)。

## 许可

MIT
