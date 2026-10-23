# 安装到其它机器

本文说明如何把「DSH启动器」（启动器**本体**）装到**另一台机器**的 DSH Desktop 上，以及之后如何获得具体游戏能力。

本体是通用框架：不含任何具体游戏、也不含任何具体启动器实现。装上本体后，再按需安装对应游戏的**附属启动器**（独立项目/独立仓库），即可在 DSH 里下载、安装并启动该游戏。

## 1. 在开发机准备分发包

在仓库根目录执行：

```bash
node scripts/build-dist.mjs
```

产物：

```
dist/dsh-launcher-<版本>/
├── index.js  client.js  lib/  locale/  icon.svg
├── package.json  cordis.patch.yml
├── README.md  INSTALL.md  docs/
dist/dsh-launcher-<版本>.zip     ← 拷到其它机器用这个
```

分发内容已自动排除 `data/`、`test/`、`tmp/`、`node_modules/`、`dist/`，不含任何本机数据或缓存；`cordis.patch.yml` 里也没有写死数据目录，因此换机器后无需改配置。

## 2. 在目标机器安装本体

1. 把 `dsh-launcher-<版本>.zip` 拷到目标机器，解压到一个固定目录，例如 `C:\Tools\dsh-launcher-3.3.0`。
2. 打开 DSH Desktop，在对话里让 Agent 安装这个本地插件包，例如说：

   > 安装本地插件：C:\Tools\dsh-launcher-3.3.0

   Agent 会调用插件管理完成安装（等价于 `plugin_manager action=install_bundle target=<该目录绝对路径>`）。
3. **完全退出并重新启动 DSH Desktop**（Host 代码需要重启才能加载）。
4. 启动后新开一个对话，问一句「启动器状态」：如果能看到 `launcher_status` 等工具，就说明本体已就绪。
5. 界面左下角出现「启动游戏」入口；面板四个页签：游戏 / 附属启动器 / 添加游戏 / 设置。

## 3. 在目标机器安装附属启动器（获得具体游戏）

打开面板「启动游戏」→「附属启动器」页。最省事的方式是顶部**推荐目录**里的「安装」按钮（一键装推荐附属启动器，例如本体作者维护的示例项）；也可以手动从三种来源任选：

| 来源 | 需要什么 |
| --- | --- |
| GitHub 仓库 | 附属启动器项目的仓库名 `owner/repo`（读取其最新 Release 里的 zip） |
| zip URL | 可访问的 zip 直链（自建镜像、网盘直链等） |
| 本机文件 | 已下载的附属启动器 zip 的完整路径 |

也可以直接对话：

```text
你：帮我把 owner/repo 这个附属启动器装上
DSH：→ launcher_install_sublauncher { repo: "owner/repo" }
```

安装任务可在面板看进度，或对话 `launcher_job_status`。成功后**数秒内**游戏自动出现在「游戏」页，**无需重启 DSH**；卸载同理自动消失。

> 想把自己的游戏做成附属启动器：见 `docs/SUB-LAUNCHER.md`（zip 格式、`launcher.json`、入口约定、GitHub Release 发布步骤）。

## 4. 数据放在哪里

- 默认数据根：`<用户主目录>/.dsh-launcher/data`（Windows 为 `C:\Users\<用户名>\.dsh-launcher\data`）。
- 里面有：`config.json`、`instances/`（实例）、`games/`（添加的游戏定义）、`adapters/`（适配器加载桥）、`sub-launchers/`（已安装附属启动器）、`cache/`（下载缓存）、`game-data/`（适配器私有数据）。
- 迁移数据：把整个 `data` 目录拷到新机器的同一位置即可；实例里的相对路径都相对数据根解析。
- 自定义数据根：在 DSH 的插件配置里给本插件设置 `dataRoot`。

## 5. 内置的「添加游戏 / 下载 / 启动」方案

分发后目标机器上不需要额外安装运行时（下载器使用 DSH 自带 Node）。

除了附属启动器，本体还有三种内置添加方式（面板「添加游戏」页签，或对话 `launcher_add_game`）：

| 提供者 | 适用场景 | 关键字段 |
| --- | --- | --- |
| GitHub Releases | 游戏以 GitHub Release 资源发布 | `repo`（owner/name）、可选 `assetPattern`、`executable` |
| URL 清单 | 官方/第三方提供版本清单 JSON | `jsonUrl` 或内联 `versions[]`、`executable`、可选 `args` |
| 手动导入 | 已经有安装好的游戏目录 | `path`、`executable` |

添加后：`launcher_list_versions` 拿版本号 → `launcher_install_game` 下载安装（可带内容列表）→ `launcher_launch_game` 启动。面板里先点开某个游戏，再在详情里下载版本、安装实例、启动、管理内容；所有游戏走同一套流程。

需要复杂平台逻辑（版本清单格式特殊、运行时下载、启动参数生成、内容管理等）的游戏，做成**附属启动器**接入，规范见 `docs/SUB-LAUNCHER.md` 与 `docs/GAME-ADAPTER.md`。

## 6. 网络与权限

- 下载与查询都用 HTTPS；GitHub API 在部分网络环境需要代理。
- 首次安装游戏会下载版本文件与运行库，耗时取决于网络；面板和任务日志会显示进度。
- 目标机器需要能写入自己的用户主目录（数据根）与插件安装目录。
- 只安装信任来源的附属启动器：它们的代码会在 DSH 宿主进程里运行。

## 7. 常见问题

| 现象 | 处理 |
| --- | --- |
| 面板不出现「启动游戏」 | 确认 bundle 已 enabled；完全重启 DSH Desktop；刷新页面 |
| 对话里没有 `launcher_*` 工具 | 同上；新开一个对话（工具列表在对话开始时快照） |
| 游戏列表是空的 | 本体不含游戏。到「附属启动器」页装一个附属启动器，或用「添加游戏」加一个 |
| 附属启动器安装失败 | `launcher_job_status` 看日志：仓库名错、Release 无 zip 资产、zip 缺 `launcher.json`、`minCoreVersion` 高于本体、网络被代理拦截 |
| 装了附属启动器游戏没出现 | 等几秒（热加载 2.5 秒轮询）；仍无则看任务日志与 DSH 宿主日志，可删除后重装 |
| 安装/启动任务失败 | 面板实例区「日志」或 `launcher_instance_log` 看日志尾部；错误信息是中文的下一步提示 |
| 数据目录太大 | 删 `data/cache`；不要删 `instances/`（实例本体） |
| 卸载 | 在插件管理里停用/移除 `@local/dsh-launcher`，再按需删除数据根 |

## 8. 版本校验

- 本体版本见 `package.json` 的 `version`；附属启动器版本见各自 `launcher.json`。
- `scripts/build-dist.mjs` 会打印 zip 大小与文件数；分发包内 `package.json` 与 `cordis.patch.yml` 均可直接核对。
