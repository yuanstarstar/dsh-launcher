# 附属启动器：包格式与发布指南

> 本文面向想给自己喜欢的游戏写一个「附属启动器」的开发者。
> 本启动器本体（DSH启动器）不含任何具体游戏与启动器实现，所有游戏能力都来自**附属启动器**（独立项目、独立仓库）。

## 1. 它是什么

附属启动器是一个独立的 zip 包，里面包含：

- `launcher.json`：包清单（下文）。
- 一段 Node.js ESM 代码（入口 `entry`）：向本体注册一个「游戏适配器」。
- 可选 README / LICENSE / 图标等。

本体从 GitHub Release、zip 地址或本机文件安装它，解压到数据目录并热加载：安装完几秒内，游戏就会出现在面板「游戏」页，可在对话或面板里下载、安装实例并启动。卸载后游戏自动消失，全程无需重启 DSH。

## 2. launcher.json 格式

```json
{
  "schemaVersion": 1,
  "id": "example",
  "label": "示例游戏",
  "version": "1.0.0",
  "entry": "lib/index.mjs",
  "minCoreVersion": "3.2.0",
  "description": "示例游戏的附属启动器。",
  "homepage": "https://github.com/OWNER/repo-name",
  "gamesHint": ["示例游戏"]
}
```

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `schemaVersion` | 是 | 固定 `1` |
| `id` | 是 | 小写字母/数字/连字符，`^[a-z0-9][a-z0-9-]{1,40}$`，在全机唯一 |
| `label` | 是 | 显示名（面板/对话里看到） |
| `version` | 是 | 包版本（semver），升级时用于判断 `updateAvailable` |
| `entry` | 是 | 包内相对路径（如 `lib/index.mjs`），必须在 zip 内 |
| `minCoreVersion` | 否 | 要求的最小本体版本，低于它拒绝安装 |
| `description` | 否 | 一句话介绍 |
| `homepage` | 否 | 项目主页（仓库地址） |
| `gamesHint` | 否 | 预期注册的游戏 id 列表，仅展示用途 |

## 3. 入口模块约定

`entry` 必须默认导出下列之一：

```js
// 形式一：工厂函数（推荐；本体调用时传入 helpers）
export default function createAdapter(helpers) {
  return adapter
}

// 形式二：直接导出适配器对象
export default adapter
```

`helpers` 由本体提供：`{ dl, paths, logger, registerGame }`。多数情况用不到，保留参数即可。

返回的适配器对象遵循 `docs/GAME-ADAPTER.md` 里的契约（必填 `id / label / versionLabel / listVersions / install / launch`）。最简示例：

```js
const adapter = {
  id: 'example',
  label: '示例游戏',
  versionLabel: '游戏版本',
  async listVersions() {
    return { versions: [{ id: '1.0.0' }], latestRelease: '1.0.0' }
  },
  async install({ instance }) {
    return { versionId: '1.0.0', metadata: {} }
  },
  async launch({ instance, ctx }) {
    return { executable: '<可执行文件绝对路径>', args: [], cwd: ctx.gameDir }
  },
}
export default function createAdapter() { return adapter }
```

## 4. 打包

zip **根目录**直接放 `launcher.json`，不要外层文件夹。建议命名 `<id>-launcher-<version>.zip`，例如 `example-launcher-1.0.0.zip`。

```
example-launcher-1.0.0.zip
├── launcher.json
├── lib/
│   ├── index.mjs
│   └── ...
├── README.md
└── icon.svg（可选）
```

限制：单个 zip ≤ 25MB；解压后 ≤ 200MB；不要包含 `data/`、`test/`、`node_modules/`、`.git/`。
包内只能用 Node 内置模块与 helpers 提供的能力，**不要** `import` 本体包路径（跨上下文不可靠）。

示例构建脚本（Windows PowerShell，可放进项目 `scripts/build-dist.mjs` 里用子进程调用）：

```powershell
Compress-Archive -Path '<打包目录>\*' -DestinationPath 'dist\example-launcher-1.0.0.zip' -Force
```

## 5. 发布到 GitHub（推荐分发方式）

1. 建一个独立仓库（例如 `OWNER/example-launcher`），提交源码 + 打包脚本（不要提交 `dist/`）。
2. 在仓库打 tag 并创建 Release，把 zip 作为 Release 资产上传。
3. 用户在本体面板「附属启动器」页填写仓库 `OWNER/example-launcher`，或对话里：
   `launcher_install_sublauncher { "repo": "OWNER/example-launcher" }`
4. 本体调用 `https://api.github.com/repos/OWNER/example-launcher/releases/latest`，取 Release 里的 zip 资产（默认取第一个 `.zip`；文件名不规范时让用户填 `assetPattern` 通配符，如 `example-launcher-*.zip`）。

> 提示：GitHub API 未登录时有速率限制；Release 里必须真的有 zip 资产，否则会提示「该 GitHub Release 没有 zip 资产」。

## 6. 本机/自建分发

- 本机 zip：面板「附属启动器」→ 本机文件路径，或对话 `{ "file": "D:\\builds\\example-launcher-1.0.0.zip" }`。
- 自建服务器/镜像：`{ "url": "https://your.host/example-launcher-1.0.0.zip" }`。

## 7. 更新与卸载

- 本体记录安装来源（repo/url/file）与安装版本；有 repo 时面板可「检查更新」，比较 GitHub 最新 Release tag 与本地版本，`updateAvailable` 为真时可一键更新（先装新版本目录，再切桥、删旧目录）。
- 卸载会删除包目录、加载桥与登记记录，并热加载让游戏消失；已安装的游戏实例不会被删除（实例数据在 `instances/`，可单独删除）。

## 8. 数据目录位置

```
<数据根>/
  sub-launchers/
    registry.json          # 已安装附属启动器登记表
    <id>/<version>/...     # 解压后的包
  adapters/sublauncher-<id>.mjs  # 本体写的加载桥（自动生成，勿手改）
```

数据根默认 `~/.dsh-launcher/data`（旧版本 `<插件目录>/data` 有数据时会继续沿用，见 README）。

## 9. 安全提示

附属启动器代码会在 DSH 宿主进程里运行，等价于安装一个本机程序。**只安装你信任来源的包**；本体对 zip 做路径穿越防护与清单校验，但无法限制包内代码行为。

## 10. 推荐目录（catalog.json，可选）

推荐做法：把自己的附属启动器放进「推荐目录」，用户在面板里点一下就能装，不用手动填仓库名。

做法：在仓库**根目录**放一个 `catalog.json`（和源码一起提交到默认分支，本体可通过 raw 链接读取）：

```json
{
  "schemaVersion": 1,
  "updatedAt": "2026-10-23",
  "entries": [
    {
      "id": "my-launcher",
      "label": "我的启动器",
      "repo": "owner/my-launcher",
      "version": "1.0.0",
      "description": "一句话说明这个附属启动器支持什么游戏、有什么能力。",
      "homepage": "https://github.com/owner/my-launcher",
      "tags": ["sandbox"]
    }
  ]
}
```

- `id` 小写字母/数字/连字符；`label` 显示名；`repo` 为 `owner/name`（本体读取该仓库最新 Release 的 zip）；也可改用 `url`（zip 直链）或 `file`（本机路径）。
- 本体侧在 `cordis.patch.yml` 的 `catalogUrl` 填这个文件的 raw 地址，例如 `https://raw.githubusercontent.com/owner/my-launcher/main/catalog.json`；留空则读取数据根下的 `catalog.json`。
- 远程目录不可用时，本体会自动回退到数据根的本地 `catalog.json`（用户可自己放一份）。
- 发布新版本后同步改 `catalog.json` 里的 `version`，用户面板就会出现「可更新」提示。
