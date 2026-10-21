# 安装到其它机器

本文说明如何把「DSH启动器」装到**另一台机器**的 DSH Desktop 上，以及如何把内置的「添加游戏 / 下载 / 启动」方案一起带过去。核心包本身是通用框架，不含任何具体游戏；具体游戏通过内置提供者（GitHub Releases / URL 清单 / 手动导入）或可选适配器包添加。

## 1. 准备分发包

在开发机（当前仓库根目录）执行：

```bash
node scripts/build-dist.mjs
```

产物：

```
dist/dsh-launcher-<版本>/
├── index.js  client.js  lib/  locale/  icon.svg
├── package.json  cordis.patch.yml
├── README.md  INSTALL.md  docs/
└── plugins/<可选适配器包>/
dist/dsh-launcher-<版本>.zip     ← 拷到其它机器用这个
```

分发内容已自动排除 `data/`、`test/`、`tmp/`、`node_modules/`、`dist/`，不含任何本机数据或缓存；`cordis.patch.yml` 里也没有写死数据目录，因此换机器后无需改配置。

## 2. 在目标机器安装

1. 把 `dsh-launcher-<版本>.zip` 拷到目标机器，解压到一个固定目录，例如 `C:\Tools\dsh-launcher-3.1.0`（路径**不要**带空格也没关系，但要记住）。
2. 打开 DSH Desktop，在对话里让 Agent 安装这个本地插件包，例如说：

   > 安装本地插件：C:\Tools\dsh-launcher-3.1.0

   Agent 会调用插件管理完成安装（等价于 `plugin_manager action=install_bundle target=<该目录绝对路径>`）。
3. **完全退出并重新启动 DSH Desktop**（Host 代码需要重启才能加载）。
4. 启动后新开一个对话，问一句「启动器状态」：如果能看到 `launcher_status` 等工具，就说明核心已就绪。
5. 界面左下角会出现「启动游戏」入口；面板顶部三个页签：游戏 / 添加游戏 / 设置。点开某个游戏进入详情，即可下载该游戏的版本、安装实例并启动（其他游戏同理）。

### 可选：安装适配器包（如分发包里带 `plugins/`）

核心装好并重启后，再用同样方式安装适配器目录，例如：

> 安装本地插件：C:\Tools\dsh-launcher-3.1.0\plugins\<适配器目录名>

适配器安装后**不需要重启**：核心会自动扫描并注册游戏（跨插件文件桥接，见下），几秒内面板里就会出现对应游戏。

## 3. 数据放在哪里

- 默认数据根：`<用户主目录>/.dsh-launcher/data`（Windows 为 `C:\Users\<用户名>\.dsh-launcher\data`）。
- 里面有：`config.json`、`instances/`（实例）、`games/`（添加的游戏定义）、`adapters/`（外部适配器桥接文件）、`cache/`（下载缓存）、`game-data/`（适配器私有数据）。
- 迁移数据：把整个 `data` 目录拷到新机器的同一位置即可；实例里的相对路径都是相对数据根解析的。
- 自定义数据根：在 DSH 的插件配置里给本插件设置 `dataRoot`（不要改 `cordis.patch.yml` 里的注释行以外内容）。

## 4. 内置的「添加游戏 / 下载 / 启动」方案

分发后目标机器上**不需要额外安装 Node、Java 之外的运行时**：下载器使用 DSH 自带运行时（Node）。

添加游戏有三种内置方式（面板「添加游戏」页签，或直接对话让 Agent 调用 `launcher_add_game`）：

| 提供者 | 适用场景 | 关键字段 |
| --- | --- | --- |
| GitHub Releases | 游戏以 GitHub Release 资源发布 | `repo`（owner/name）、可选 `assetPattern`、`executable` |
| URL 清单 | 官方/第三方提供版本清单 JSON | `jsonUrl` 或内联 `versions[]`、`executable`、可选 `args` |
| 手动导入 | 已经有安装好的游戏目录 | `path`、`executable` |

添加后：`launcher_list_versions` 拿版本号 → `launcher_install_game` 下载安装（可带内容列表）→ `launcher_launch_game` 启动。面板里先点开某个游戏，再在详情里下载版本、安装实例、启动、管理内容；所有游戏走同一套流程。

需要特定平台协议（登录、版本清单格式特殊、启动参数生成）的游戏，写一个适配器包即可接入，规范见 `docs/GAME-ADAPTER.md`。

## 5. 网络与权限

- 下载与查询都用 HTTPS；GitHub API 在部分网络环境需要代理。
- 首次安装会下载版本文件与运行库，耗时取决于网络；面板和任务日志会显示进度。
- 目标机器需要能写入自己的用户主目录（数据根）与插件安装目录。

## 6. 常见问题

| 现象 | 处理 |
| --- | --- |
| 面板不出现「启动游戏」 | 确认 bundle 已 enabled；完全重启 DSH Desktop；刷新页面 |
| 对话里没有 `launcher_*` 工具 | 同上；新开一个对话（工具列表在对话开始时快照） |
| 适配器装好后游戏列表仍为空 | 确认核心包已安装并重启过；查看 `~/.dsh-launcher/bridge.json` 是否存在且时间较新；适配器会自动重试 60 秒，超过可重启 DSH |
| 安装/启动任务失败 | 面板「游戏 → 实例 → 日志」或 `launcher_instance_log` 看日志尾部；错误信息是中文的下一步提示 |
| 数据目录太大 | 删 `data/cache`；不要删 `instances/`（实例本体） |
| 卸载 | 在插件管理里停用/移除 `@local/dsh-launcher`（以及适配器包），再按需删除数据根 |

## 7. 版本校验

- 核心包版本见 `package.json` 的 `version`。
- `scripts/build-dist.mjs` 会打印 zip 大小与文件数；分发包内 `package.json` 与 `cordis.patch.yml` 均可直接核对。
