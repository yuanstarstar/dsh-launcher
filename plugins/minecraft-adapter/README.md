# Minecraft 适配器包（@local/dsh-mc-adapter）

这是 **DSH启动器**（`@local/dsh-launcher`）的一个**可选游戏适配器包**。它把 Minecraft 接进一个本身完全通用、不含任何具体游戏名的启动器框架：本包单独安装并启用后，启动器的游戏列表里才会出现 Minecraft；不安装它，启动器依然是纯净的通用框架。

- 插件 id：`dsh-mc-adapter`
- 注册的游戏 id：`minecraft`
- 版本：3.0.0
- 依赖（运行期）：DSH启动器核心包 `@local/dsh-launcher` 已安装并启用

## 为什么是「可选」的

DSH启动器 v3 的核心包零内置游戏、零平台域名、零品牌词，只提供：实例管理、通用下载器、游戏注册表、面板与对话工具。具体游戏（版本清单、安装布局、加载器、内容站、运行时、启动参数）全部由适配器包实现。

这样做的好处：

- 核心包可以保持干净、可测试、可复用于其它游戏；
- Minecraft 相关的镜像规则（BMCLAPI、QLU、Modrinth、Adoptium 等）只存在于本包 `lib/mirrors.js` 一个文件里，便于维护；
- 不玩 Minecraft 的用户不需要承担任何下载与品牌负担；
- 本包可独立升级、独立卸载，不影响核心与其他游戏适配器。

## 安装

前置：DSH启动器核心包已安装并启用（插件 id `dsh-launcher`）。

在 DSH 对话里执行：

```text
plugin_manager action=install_bundle target=<DSH启动器核心包目录>/plugins/minecraft-adapter
```

- 安装后**数秒内自动生效**（无需重启 DSH）：DSH 的插件包可能加载在彼此隔离的上下文里，核心包与适配器包通过文件桥接对接——核心把数据根写到 `~/.dsh-launcher/bridge.json`，本包读取后把桥接模块写进 `<dataRoot>/adapters/adapter-minecraft.mjs`，核心轮询到后自动热加载注册。
- 安装后启动器的游戏列表会出现 **Minecraft**，面板与对话工具即可列出 MC 版本、安装实例、管理加载器/模组并启动。
- 如果核心包尚未启动（指针文件还不存在），本包会在 60 秒内每 2 秒重试注册（同时重试全局注册表与文件桥接），核心包一旦就绪即自动生效。
- 注册成功后日志会出现：`[Minecraft 适配器] 已通过文件桥接向 DSH启动器 注册游戏…` 或 `已注册游戏：Minecraft`。

卸载/禁用本包时，本包会删除桥接文件，核心在数秒内自动把 Minecraft 从游戏列表移除（若卸载时进程已退出，删除 `<dataRoot>/adapters/adapter-minecraft.mjs` 即可）。

## 卸载与数据

- 卸载插件包本身不会删除已安装的游戏数据。
- Minecraft 的共享游戏数据位于核心的 `dataRoot/game-data/minecraft/`（见下）；实例位于 `dataRoot/instances/<实例 id>/`。需要彻底清理时手动删除这两个目录即可。
- 卸载后重装本包，已有版本/资源/Java 运行时会自动复用（按文件大小与 sha1 校验）。

## 能力矩阵

| 能力 | 支持 | 说明 |
| --- | --- | --- |
| 版本列表 | ✅ | Mojang 官方版本清单（经镜像加速），含正式版/快照、发布日期与 latest release |
| 原版安装 | ✅ | 客户端 jar、libraries、资源索引与资源对象、日志配置，按共享目录布局落盘 |
| 加载器 | ✅ | Fabric / Quilt / Forge / NeoForge；列表 + 安装（Fabric/Quilt 直接下载 profile；Forge/NeoForge 运行官方安装器） |
| 内容（模组） | ✅ | Modrinth 搜索、项目版本列表、按 slug/projectId/versionId 解析、下载到实例 `game/`，记录到实例 metadata |
| 运行时（Java） | ✅ | 扫描系统 Java；缺版本时从 Adoptium 下载 JRE 到共享 `runtime/jre-<major>` |
| 启动 | ✅ | 生成 `{executable,args,cwd,env}` 交给核心启动；含内存、JVM 参数、natives、资源、日志配置 |
| 实例校验 | ✅ | 校验版本 json、客户端 jar、加载器 json、版本链、Java、资源索引、实例 metadata |
| 实例选项 | ✅ | 加载器类型、加载器版本、内存 MB、资源模式（full/index）、自定义 JVM 参数 |
| 离线启动 | ✅ | 默认离线用户名/离线 UUID（不要求正版登录，v3 暂未接入微软登录） |

不支持/未覆盖：微软账号登录、服务器自动连接、CurseForge、OptiFine、Forge/NeoForge 安装器的网络不稳定场景（见「已知风险」）。

## 目录与数据布局

本包（只能出现 Minecraft 相关名字，接口仍严格遵循核心契约）：

```text
plugins/minecraft-adapter/
├── index.js             # DSH 插件入口：拿注册表并 registerGame(adapter)，ctx.effect 注销
├── package.json         # @local/dsh-mc-adapter，dsh.bundle.patch 指向 cordis.patch.yml
├── cordis.patch.yml     # bundle 插入声明（insert id: dsh-mc-adapter）
├── icon.svg             # 方块 + 镐图标
├── README.md
├── lib/
│   ├── adapter.js       # GameAdapter 实现（契约唯一入口）
│   ├── mirrors.js       # 所有镜像测速与 URL 重写（唯一含平台域名的文件）
│   ├── version.js       # 版本清单、版本 json、版本链合并、参数模板替换
│   ├── vanilla.js       # 原版安装：客户端/libraries/assets/log config
│   ├── loaders.js       # Fabric/Quilt/Forge/NeoForge 列表与安装
│   ├── modrinth.js      # Modrinth 搜索/版本/解析/下载
│   ├── java.js          # Java 探测与 Adoptium 下载
│   ├── launch.js        # buildLaunchSpec：只生成启动参数，不 spawn
│   ├── util.js          # 游戏数据目录布局、原子 JSON 读写、任务与校验小工具
│   └── zip.js           # 解压工具（natives / JRE）
├── scripts/adapter-test.mjs   # 独立自测（假 ctx，不依赖宿主）
└── test/adapter-report.txt    # 自测报告（运行后生成）
```

共享游戏数据（由核心的 `ctx.gameDataDir` 决定，默认 `dataRoot/game-data/minecraft/`）：

```text
game-data/minecraft/
├── versions/<版本 id>/<版本 id>.json   # 原版/加载器版本 json 与 client jar
├── libraries/                          # Maven 布局依赖
├── assets/indexes/<index>.json         # 资源索引
├── assets/objects/<前两位>/<hash>      # 资源对象
├── assets/log_configs/                 # 日志配置
├── runtime/jre-<major>/                # 按需下载的 Java
├── installers/                         # Forge/NeoForge 安装器缓存
└── launcher_profiles.json              # Forge 安装器要求的占位文件
```

每个实例目录（`dataRoot/instances/<id>/`）由适配器维护 `metadata.json`：

```json
{
  "adapter": "minecraft",
  "adapterVersion": "3.0.0",
  "versionId": "1.20.1",
  "assetsMode": "full",
  "installedAt": "2026-10-21T00:00:00.000Z",
  "javaMajor": 17,
  "loader": { "type": "fabric", "version": "0.16.10", "versionId": "fabric-loader-0.16.10-1.20.1" },
  "content": [{ "slug": "sodium", "filename": "sodium-fabric-0.5.11+mc1.20.1.jar", "versionId": "..." }],
  "files": { "versionJson": "..." },
  "options": { "loader": "fabric", "loaderVersion": "0.16.10", "memoryMb": 4096, "assetsMode": "full" }
}
```

实例实际游戏目录（`ctx.gameDir`）里存放 `mods/`、`logs/`、`natives/` 等运行期内容；共享版本文件只在 `game-data/minecraft/` 存放一份。

## 配置

在核心启动器插件配置（`cordis.patch.yml` 的 config）或本包 config 中可覆盖：

```yaml
- insert:
    - id: dsh-mc-adapter
      name: '@local/dsh-mc-adapter'
      config:
        mirror: 'https://bmclapi2.bangbang93.com'   # 可选：强制指定默认镜像
        neoforgeMirror: 'https://mirrors4.qlu.edu.cn/bmclapi/'  # 可选：NeoForge maven 镜像
        dataRoot: 'C:\\path\\to\\data'              # 一般由核心注入，无需手写
        downloadSource: 'bmclapi'                    # 兼容旧配置字段
```

- 下载候选顺序由 `lib/mirrors.js` 决定：默认官方排在最后，BMCLAPI/QLU 镜像优先；`probeMirrors()` 可实测各镜像 64KB 速度并重排（结果缓存 10 分钟）。
- 所有下载都通过核心注入的下载器 `ctx.makeDownloader({ resolveUrl })` 完成，核心下载器本身不含任何游戏/平台规则。
- `mirror` 为空或 `auto` 表示自动（默认镜像列表 + 测速）。

## 启动参数

`lib/launch.js` 只生成 LaunchSpec，真正 spawn 由核心的 `launchProcess` 完成：

```js
{ executable: 'C:\\...\\java.exe', args: ['-Xmx4096M', ...], cwd: '<实例 game 目录>', env: { ... } }
```

包含：内存 `-Xmx/-Xms`、`-Dfile.encoding=UTF-8`、启动器品牌版本、按 Java 主版本的兼容参数（17+ `--enable-native-access`、24+ `--sun-misc-unsafe-memory-access`）、libraries + 客户端 jar 的 classpath、natives 目录、资源目录与索引、日志配置、离线用户名/UUID，以及用户自定义 JVM 参数。`env` 会移除 `JAVA_TOOL_OPTIONS` / `_JAVA_OPTIONS` 避免注入冲突。

## 开发与测试

```powershell
# 语法检查（全部 JS，含本包）
node --check index.js
Get-ChildItem -Recurse -Filter *.js | ForEach-Object { node --check $_.FullName }

# 独立自测：假 ctx、不需要安装 DSH、不依赖核心包
node scripts/adapter-test.mjs
```

自测覆盖：GameAdapter 契约字段与方法、`mirrors.resolveUrl` 候选顺序与自定义镜像、真实版本清单拉取、真实版本 json、加载器列表（Fabric/Forge/NeoForge）、Modrinth 搜索、`buildLaunchSpec` 参数与 cwd/env、实例 metadata/verify、`index.js` 注册/注销流程（用假 `globalThis.__dshLauncherRegistry`）。结果写入 `test/adapter-report.txt`，全 PASS 时退出码 0。

真实大文件安装（原版 + assets + Java）在 v2 已完整实测；本包自测默认只做「真实网络 + 小文件下载」冒烟，避免 CI 时间与流量。

## 已知风险

1. **NeoForge 安装可能失败**：NeoForge 官方 maven（`maven.neoforged.net`）在部分网络不可达。安装器 jar 可从镜像下载，但安装器运行期仍会访问官方 maven 拉取 processors 依赖，失败时会抛中文错误并提示「NeoForge 官方 maven 当前不可达，请改用 Forge/Fabric，或稍后重试」。Forge/Fabric/Quilt 不受影响。
2. **Forge/NeoForge 安装耗时**：安装器需要 Java 与 100MB+ 下载，且运行 processors；失败时不会破坏已安装的原版版本。
3. **Modrinth CDN 速度波动**：实测从 cdn.modrinth.com 下载单个 ~1MB 模组可能耗时数十秒，下载超时/重试由核心下载器负责；失败会给出中文错误。
4. **资源体积**：默认 `assetsMode: full` 会下载约 600MB+ 资源；只想快速试玩可把实例选项 `assetsMode` 设为 `index`（只下索引，启动时可能缺部分音效纹理，不建议长期使用）。
5. **Windows 优先**：Java 可执行路径检测按 Windows 布局（`bin/java.exe`）实现；Linux/macOS 未在 v3 适配范围内。
6. **无正版登录**：v3 只支持离线用户名/UUID，暂不接入 Microsoft 登录。

## 与核心的契约

本包实现核心 `docs/ARCHITECTURE-v3.md` §2 的 GameAdapter：

| 字段/方法 | 本包实现 |
| --- | --- |
| `id` / `label` / `versionLabel` / `contentLabel` | `minecraft` / `Minecraft` / `游戏版本` / `模组` |
| `capabilities` | `{ content: true, loaders: true, runtimes: true }` |
| `instanceOptions` | 加载器类型、加载器版本、内存、资源模式、自定义 JVM 参数 |
| `listVersions({ctx,force})` | Mojang 版本清单 |
| `install({ctx,instance,version,options})` | 原版安装 + 可选加载器 + 实例 metadata |
| `launch({ctx,instance})` | 补库/资源/Java 后返回 LaunchSpec |
| `verify({ctx,instance})` | 检查版本文件/Java/资源/metadata |
| `listLoaders` / `searchContent` / `contentVersions` | 加载器列表 / Modrinth 搜索 / 项目版本 |
| `addContent` / `removeContent` | 下载模组到实例 mods / 删除并更新 metadata |
| `listRuntimes` | 系统 Java + 共享 runtime 内 Java |
| `openFolder` | 返回实例目录路径 |

注册流程：`index.js` 的 `apply()` 依次尝试 ① `globalThis.__dshLauncherRegistry`；② 动态 import 核心包注册表；③ **文件桥接**——读取 `~/.dsh-launcher/bridge.json`，把 `<dataRoot>/adapters/adapter-minecraft.mjs`（re-export 本包 `lib/adapter.js`）写入核心数据目录，核心轮询后热加载。全部失败时只告警、不抛异常；插件卸载时删除桥接文件以让核心自动注销游戏。桥接机制的原因与细节见核心文档 `docs/GAME-ADAPTER.md §6.5`。
