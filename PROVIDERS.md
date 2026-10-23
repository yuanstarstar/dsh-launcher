# 提供者（Providers）使用文档

本文档介绍 DSH启动器 v3 中「添加游戏」的三条通用途径：GitHub Releases、URL 清单、手动导入，以及给开发者用的外部适配器方式。

核心包不内置任何具体游戏。游戏由用户通过提供者添加，或由独立适配器包注册。

> 所有示例里的地址、仓库、文件名都是占位示例，请换成自己的真实值。

---

## 1. 三条途径一览

| 提供者 | id | 适用场景 | 版本列表来源 |
| --- | --- | --- | --- |
| GitHub Releases | `github` | 游戏发布在 GitHub 仓库的 Releases 附件里 | GitHub API（每次拉取，缓存 5 分钟） |
| URL 清单 | `url` | 有远程 JSON 版本清单，或者只有几个固定下载地址 | 远程 `jsonUrl`（缓存 30 分钟）或静态 `versions` |
| 手动导入 | `manual` | 游戏已经装在本机某个目录，只想登记并启动 | 固定返回「已安装」 |

三条途径最终都会注册成一个标准适配器（adapter），对引擎暴露统一的 `listVersions / install / launch / verify`。

---

## 2. 通过工具添加（推荐给对话使用）

工具：`launcher_add_game`

```json
{
  "provider": "url",
  "id": "demo-game",
  "label": "示例游戏",
  "config": {
    "versions": [
      { "id": "1.0.0", "url": "https://example.com/game/1.0.0.zip", "size": 1024, "sha1": "0123456789abcdef0123456789abcdef01234567" }
    ],
    "executable": "game.exe"
  }
}
```

字段说明：

- `provider`：必填，`github` / `url` / `manual`。
- `id`：可选，只能是小写字母、数字、短横线；省略时由 `label` 自动生成。
- `label`：可选，游戏展示名；省略时按提供者自动推导（GitHub 用仓库名，URL 用清单域名，手动导入用目录名）。
- `config`：必填，结构见下文各提供者章节。
- `versionLabel`：可选，版本标签的展示名，默认「版本」。

添加成功返回 `{ id, game, definition }`，其中 `game` 是注册表里的列表项。

---

## 3. GitHub Releases（`github`）

从仓库的 Releases 附件安装游戏。适合以 GitHub 发布二进制/压缩包的独立游戏。

### 3.1 配置字段

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `repo` | 是 | 仓库，格式 `owner/name` |
| `assetPattern` | 否 | 正则表达式，用于从发布附件中挑文件；留空表示自动挑选 |
| `executable` | 否 | ZIP 解压后游戏目录内的可执行文件相对路径；留空则自动查找 |
| `archive` | 否 | `auto`（默认）/ `zip` / `none`；`auto` 按文件内容判断 |
| `assetKind` | 否 | `auto`（默认，优先 ZIP）/ `zip` / `file` |
| `args` | 否 | 启动参数数组，例如 `["--fullscreen"]` |

### 3.2 示例

```json
{
  "provider": "github",
  "label": "示例游戏",
  "config": {
    "repo": "example-owner/example-game",
    "assetPattern": "windows[_-]?x64.*\\.zip$",
    "executable": "game.exe",
    "args": []
  }
}
```

### 3.3 行为说明

- 版本列表来自 `https://api.github.com/repos/<repo>/releases?per_page=50`，版本 id 即 `tag_name`，并按发布时间倒序返回；结果缓存 5 分钟。
- 安装时按 `assetKind` / `assetPattern` 挑附件，下载到临时目录后解压（ZIP）或直接放入游戏目录（单文件）。
- 若附件 ZIP 只有一个顶层目录，会自动去掉这一层（见 `lib/core/archive.js`）。
- GitHub API 有匿名访问频率限制：触发时返回「访问受限」类中文错误，稍后再试；未认证请求也可能因网络策略失败。
- 安装完成后会在游戏目录写入 `metadata.json`，启动时以其中的可执行文件为准。

---

## 4. URL 清单（`url`）

从远程 JSON 清单或内置静态列表下载游戏。适合自建分发、对象存储、网盘直链等场景。

### 4.1 配置字段

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `jsonUrl` | 二选一 | 远程 JSON 版本清单地址（http/https） |
| `versions` | 二选一 | 静态版本数组，字段同清单条目 |
| `executable` | 否 | 游戏目录内的可执行文件相对路径；留空自动查找 |
| `archive` | 否 | `auto`（默认）/ `zip` / `none` |
| `args` | 否 | 启动参数数组 |

版本条目字段：

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `id` | 是 | 版本 id（字符串，展示用） |
| `url` | 是 | 下载地址（http/https） |
| `sha1` | 否 | 40 位十六进制摘要，填写后下载完成会校验 |
| `size` | 否 | 文件字节数，填写后用于校验与进度显示 |
| `archive` | 否 | 覆盖顶层设置 |
| `executable` | 否 | 覆盖顶层设置 |
| `args` | 否 | 覆盖顶层设置 |

### 4.2 远程清单格式

```json
{
  "versions": [
    { "id": "1.0.0", "label": "1.0.0 稳定版", "url": "https://example.com/game-1.0.0.zip" },
    { "id": "1.1.0", "url": "https://example.com/game-1.1.0.zip", "sha1": "0123456789abcdef0123456789abcdef01234567", "size": 1234567 }
  ]
}
```

也接受顶层直接是数组的写法。`label` 可省略，默认等于 `id`。

### 4.3 示例

```json
{
  "provider": "url",
  "label": "示例游戏",
  "config": {
    "jsonUrl": "https://example.com/versions.json",
    "archive": "auto"
  }
}
```

### 4.4 行为说明

- 远程清单每次添加/刷新版本列表时拉取，缓存 30 分钟；失败会返回中文错误而不是崩溃。
- 只允许 `http` / `https` 地址；`file:`、`javascript:` 等一律拒绝。
- 下载的压缩包先落到 `dataRoot/tmp/`，解压完成后清理；单文件直接放进游戏目录。
- 若 `archive: "auto"`，按文件头魔数判断是否为 ZIP，而不是只看扩展名。
- 填写 `sha1`/`size` 时下载器会强校验，不匹配则删除临时文件并报错。

---

## 5. 手动导入（`manual`）

用于已经安装好的本机游戏：只登记路径，不复制任何文件，启动时直接运行该目录里的可执行文件。

### 5.1 配置字段

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `path` | 是 | 本机游戏目录（绝对路径） |
| `executable` | 是 | 相对 `path` 的可执行文件，例如 `game.exe` |
| `args` | 否 | 启动参数数组 |

### 5.2 示例

```json
{
  "provider": "manual",
  "id": "local-demo",
  "label": "本机示例游戏",
  "config": {
    "path": "D:\\Games\\ExampleGame",
    "executable": "game.exe"
  }
}
```

### 5.3 行为说明

- 版本列表固定返回 `[{ "id": "installed", "label": "已安装" }]`。
- 添加时会校验目录与可执行文件是否存在，不复制文件；`metadata.json` 记录原始路径。
- 启动时工作目录就是 `path`（游戏本体目录）。
- 删除该游戏只是从列表移除登记，不会删除本机文件。

---

## 6. 其他添加方式

### 6.1 HTTP API

接口前缀：`/dsh-launcher/api`

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/games` | 列出已注册游戏 |
| POST | `/games` | 添加游戏，请求体同 `launcher_add_game` 参数 |
| POST | `/games/test` | 只校验并测试配置，不保存 |
| DELETE | `/games/:id` | 删除用户添加的游戏（外部适配器注册的不可删） |
| GET | `/versions?game=<id>&force=1` | 拉取某游戏的版本列表 |

因为部分环境的命令行网络工具存在证书/代理问题，这里给出等效的 Node 脚本（Node 仅用内置 `fetch`，无需安装依赖）：

```js
// 添加一个 URL 清单游戏
const base = 'http://127.0.0.1:PORT/dsh-launcher/api'
const body = {
  provider: 'url',
  label: '示例游戏',
  config: { jsonUrl: 'https://example.com/versions.json' }
}
const res = await fetch(`${base}/games`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body)
})
console.log(await res.json())
```

```js
// 测试配置是否可用（不写入）
const res = await fetch('http://127.0.0.1:PORT/dsh-launcher/api/games/test', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ provider: 'github', config: { repo: 'owner/name' } })
})
console.log(await res.json())
```

```js
// 列出、拉版本、删除
const list = await (await fetch('http://127.0.0.1:PORT/dsh-launcher/api/games')).json()
const versions = await (await fetch('http://127.0.0.1:PORT/dsh-launcher/api/versions?game=demo-game&force=1')).json()
await fetch('http://127.0.0.1:PORT/dsh-launcher/api/games/demo-game', { method: 'DELETE' })
```

### 6.2 代码里使用 `createGameStore`

```js
import { createGameStore } from './lib/core/game-store.js'
import { createPaths, ensureDirs } from './lib/core/paths.js'
import { createDownloader } from './lib/core/http.js'

const paths = createPaths('./data')
await ensureDirs(paths)
const dl = createDownloader({ concurrency: 16 })
const store = createGameStore({ paths, dl, logger: console.log })

await store.loadAll()                       // 加载 dataRoot/adapters 与 games

const entry = await store.add({             // 添加并注册
  provider: 'url',
  label: '示例游戏',
  config: { jsonUrl: 'https://example.com/versions.json' }
})
console.log(entry.id, entry.game.label)

console.log(store.list())                   // 已注册游戏列表
console.log(await store.test({ provider: 'github', config: { repo: 'owner/name' } }))
console.log(store.listProviders())          // 三种提供者的字段说明（供 UI 表单用）
console.log(await store.remove(entry.id))   // 删除用户添加的游戏

store.close()                               // 卸载本 store 注册的游戏
```

`createGameStore` 支持 `setDownloader(next)`：引擎在配置变更重建下载器后会调用它，无需重建 store。

### 6.3 外部适配器包（开发者）

把 `.mjs` 文件放到 `dataRoot/adapters/`，启动时自动加载：

```js
// dataRoot/adapters/my-game.mjs
export default (helpers) => ({
  id: 'my-game',
  label: '我的游戏',
  versionLabel: '版本',
  async listVersions() { return { versions: [{ id: '1.0', label: '1.0' }], latestRelease: '1.0' } },
  async install({ ctx, instance, version }) {
    // 可用 helpers.dl 下载、helpers.paths 取目录；把文件放进 ctx.gameDir
    return { versionId: version, metadata: {} }
  },
  async launch({ ctx, instance }) {
    return { executable: instance.metadata.executable, args: [], cwd: ctx.gameDir }
  },
  async verify({ ctx }) { return { ok: true, problems: [] } }
})
```

- `default` 还可以直接导出适配器对象、数组，或工厂函数（工厂函数收到 `{ dl, paths, logger, registerGame }`）。
- 外部适配器由注册表以 `external` 来源注册：它们不会随 `games/*.json` 持久化，也不能通过界面删除（删文件即可卸载）。
- 适配器必须提供 `listVersions` / `install` / `launch` 三个方法，`id` 只能是小写字母、数字、短横线。

---

## 7. 数据与落盘

| 位置 | 内容 |
| --- | --- |
| `dataRoot/games/<id>.json` | 用户添加的游戏定义（`{ id, label, provider, versionLabel, config }`） |
| `dataRoot/adapters/*.mjs` | 外部适配器 |
| `dataRoot/instances/<实例 id>/game/` | 安装后的游戏目录 |
| `<gameDir>/metadata.json` | 本次安装的元数据（提供者、版本、可执行文件、参数等） |
| `dataRoot/tmp/` | 下载临时文件（安装结束自动清理） |

- `id` 由 `label` 生成，重复时自动追加 `-2`、`-3`。
- 定义文件采用原子写（先写临时文件再改名），写入失败会回滚注册。
- 修改配置文件后需要刷新（重启或重新调用 `loadAll({ force: true })`）才会生效。

---

## 8. 限制与已知边界

1. 只支持 `http` / `https` 直链；不支持磁力链接、种子、分卷压缩包、需要登录态的下载。
2. 下载器不实现断点续传：中断后重新从 `.part` 开始（临时文件会被清理）。
3. 大于 8MB 的文件自动使用 Range 分片并发下载；服务器不支持 Range（返回 200 而不是 206）时自动回退单流下载。
4. ZIP 内路径穿越已被 `lib/core/zip.js` 拦截；RAR/7z 等格式暂不支持（会被当作单文件或报错）。
5. GitHub 匿名 API 有频率限制；网络受限环境下真实 GitHub 校验可能失败，自测会记为 SKIP。
6. 代理、IPv6 优先、HTTP/2 不在当前实现范围内（使用 Node 内置 `http/https` Agent）。
7. 一个 `id` 同时只能存在一份定义；重复添加会报「游戏已注册」。
8. 静态清单与远程清单同时配置时以 `jsonUrl` 为准（远程拉取失败会报错，不会静默回退到静态列表）。

---

## 9. 自测

仓库自带纯离线自测脚本，用本地 Node HTTP 服务器提供 ZIP 与清单文件，不访问外网：

```powershell
node scripts/providers-test.mjs
```

- 输出逐项 `[PASS] / [FAIL] / [SKIP]`，任一硬失败退出码为 1。
- 完整报告写入 `test/providers-report.txt`。
- GitHub 真实网络用例在无网络环境下记 `SKIP`，不算失败。

自测覆盖：定义校验、三提供者全流程（含 ZIP 顶层目录自动去壳、sha1/size 校验、手动导入登记）、`archive.js` 识别/解压/找可执行、game-store 的增删查改与外部适配器加载。

---

## 10. 常见错误

| 错误信息 | 原因 | 处理 |
| --- | --- | --- |
| 不支持的提供者：x（可用：github、url、manual） | `provider` 写错 | 改为三个 id 之一 |
| 缺少游戏名称（label） | 没有 `label` 且无法自动推导 | 手动填写 `label` |
| 游戏已注册：x | `id` 重复 | 换 `id` 或先删除旧定义 |
| 外部适配器游戏不能删除 | 该游戏来自 `dataRoot/adapters` | 删除对应 `.mjs` 文件后重启 |
| 请求 GitHub 失败：网络错误 | 本机网络无法访问 GitHub API | 配好网络/代理后重试 |
| 访问受限（GitHub 频率限制） | 匿名 API 调用过多 | 稍后再试 |
| 下载失败：xxx；已尝试 N 个候选地址 | 所有下载地址都失败 | 检查地址、网络或镜像 |
| SHA1 校验失败 | 文件内容与预期不符 | 确认版本清单里的 `sha1` 是否正确 |
| 配置里指定的可执行文件不存在 | `executable` 路径与包内布局不符 | 改填正确相对路径或留空自动查找 |
| 手动导入需要 path | 未填写本机目录 | 填写 `path`（绝对路径） |
