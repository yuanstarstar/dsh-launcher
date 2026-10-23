# 纯网页上传到 GitHub：不装 Git 的完整流程

> 适用：只想用浏览器把本项目传到 GitHub，不想安装 Git、也不想敲命令。
> 缺点先说清：网页上传**没有提交历史管理**，以后每次改文件都是网页上直接提交；批量更新不如 Git 方便，但传第一版、发 Release 完全够用。
> 如果以后想学命令行/PR 流程，看 [GITHUB-UPLOAD.md](GITHUB-UPLOAD.md)。
>
> **本项目由两个仓库组成**：本体（本教程主线，第 0～9 节）与「我的世界启动器」附属启动器（第 10 节）。

---

## 0. 已经替你准备了一个「干净的上传文件夹」

网页上传最怕两件事：把 `data/`（几百 MB 私人数据）或 `test/tmp/` 传上去；以及漏掉 `.gitignore`、`.github` 这类隐藏文件。所以我按 `.gitignore` 规则从仓库里导出了一份**只含应上传文件**的副本：

```text
C:\Users\38357\Desktop\模组开发\_upload\dsh-launcher-repo\
```

里面共 **45 个文件**（含 `.gitignore`、`.gitattributes`、`.github/workflows/tests.yml`、LICENSE、文档、源码），没有 `data/`、`dist/`、`test/tmp/`、`plugins/`。**直接上传这个文件夹里的内容**，不要上传它本身（否则会多出一层目录）。

---

## 1. 在 GitHub 网页建一个空仓库

1. 登录 <https://github.com>；
2. 右上角 **+** → **New repository**；
3. Repository name 填 `dsh-launcher`（可自定义）；
4. Description 填 `DSH启动器：可扩展的 DSH 游戏下载与启动框架`；
5. 可见性选 **Public**；
6. **不要勾** “Add a README file / Add .gitignore / Choose a license”（本地已有，勾了会多出无关文件）；
7. 点 **Create repository**。

创建后页面会显示 Quick setup，找到这行链接并点击：

> **uploading an existing file**

---

## 2. 把文件拖进浏览器上传

1. 打开文件资源管理器，进入：
   `C:\Users\38357\Desktop\模组开发\_upload\dsh-launcher-repo\`
2. 按 **Ctrl + A** 全选（45 个：文档、源码、`docs`、`lib`、`locale`、`scripts`、`.github`、`.gitignore`、`.gitattributes` …）；
3. 把选中的内容**拖到 GitHub 页面的虚线框里**（或点 “choose your files” 多选）；
   - 用 **Chrome / Edge**，支持拖文件夹并保留子目录结构；
   - 拖完等文件列表出现，确认显示的是 **45 files** 左右；
4. 页面下方 Commit changes：
   - 标题：`feat: DSH启动器 v3.3.0（本体 / 附属启动器拆分）`
   - 描述可留空；
   - 点 **Commit changes**。

> 注意：**不要**把 `dsh-launcher-repo` 文件夹本身拖进去，否则仓库里会变成 `dsh-launcher-repo/index.js` 这种多一层目录的结构。若已经这样了：进入这个多余目录，用右上角 `...` → Delete directory 删掉，再按上面的方法重传。

---

## 3. 核对仓库内容

打开仓库首页，根目录应该能看到：

```text
.github/  docs/  lib/  locale/  scripts/
.gitattributes  .gitignore  LICENSE  README.md
client.js  cordis.patch.yml  icon.svg  index.js  package.json
```

**重点检查两个隐藏文件是否传上去了**：
- `.gitignore`（根目录，文件名以点开头）
- `.github/workflows/tests.yml`（点进 `.github` → `workflows`）

### 如果拖拽时漏了隐藏文件（常见）

不用重新传。点仓库页面 **Add file → Create new file**：

1. 文件名填 `.gitignore`（注意前面有个点）；
2. 用记事本打开本地 `C:\Users\38357\Desktop\模组开发\_upload\dsh-launcher-repo\.gitignore`，Ctrl+A 复制，粘贴到网页编辑框；
3. Commit changes。

`.gitattributes` 同理。`.github/workflows/tests.yml`：Create new file 时文件名填 `.github/workflows/tests.yml`（斜杠会自动建目录），内容从本地同名文件复制。`LICENSE`、README 等普通文件一般拖拽不会漏；若漏了同样方法补。

---

## 4. 加仓库门面 + 开启 CI

1. 仓库右侧 **About** 齿轮：Description 填一句话；**Topics** 填 `dsh`、`dsh-plugin`、`launcher`、`game-launcher`；
2. License 应自动识别为 MIT；
3. 打开 **Actions** 标签：
   - 第一次可能需要点 “I understand my workflows, go ahead and enable them”；
   - 能看到 `tests` workflow 在跑（约 1～3 分钟），绿色 ✓ 表示 7 套测试全部通过；
   - 若失败，点进去看是哪一步（一般是浏览器上传时文件缺失/内容被截断）。

---

## 5. 发布第一个 Release（给别人下载分发包）

网页端发布 Release 时顺便创建 tag，不需要命令：

1. 打开仓库右侧 **Releases** → **Create a new release**（或 Draft a new release）；
2. **Choose a tag** → 输入 `v3.3.0` → 点 **Create new tag: v3.3.0 on publish**；
3. Release title 填 `DSH启动器 v3.3.0`；
4. 描述里写更新内容（可参考仓库 README 的「验证记录」）；
5. 最下方 **Attach binaries**：选择本地文件
   `C:\Users\38357\Desktop\模组开发\dsh-launcher-v3\dist\dsh-launcher-3.3.0.zip`
   （约 0.14 MB，纯本体框架 + INSTALL.md + LICENSE，不含任何具体游戏）；
6. 点 **Publish release**。

之后别人下载这个 zip，解压后按包内 `INSTALL.md` 安装即可。

> 如果 `dist` 里的 zip 被误删，重新构建：在本机用 DSH 自带的 Node 执行
> `& "C:\Users\38357\.dsh\dsh-runtimes\dsh-plugin-desktop-primary-runtime\dependencies\node\bin\node.exe" scripts\build-dist.mjs`。

---

## 6. 以后怎么更新（网页端）

| 场景 | 操作 |
| --- | --- |
| 改一个文件 | 进文件页 → 右上角铅笔 ✏️ → 修改 → Commit changes |
| 新增/替换文件 | 仓库页 **Add file → Upload files** → 拖入（同名会覆盖）→ Commit |
| 删文件 | 进文件页 → 右上角 `...` → Delete file |
| 发新版本 | 改 `package.json` 里 `version` → 提交 → 新建 Release + 新 tag（如 `v3.1.1`）+ 上传新 zip |

> 网页编辑适合小改动。改动一多，建议按 [GITHUB-UPLOAD.md](GITHUB-UPLOAD.md) 装 Git，用 `git add/commit/push` 批量管理（本机已备好便携版 Git）。

---

## 7. 网页上传的限制（提前知道不踩坑）

| 限制 | 说明 / 应对 |
| --- | --- |
| 单次最多 100 个文件 | 本仓库 45 个，一次够；以后超了分两次上传 |
| 浏览器单文件最大 25 MB | 本项目最大文件约 107 KB，没问题 |
| 不能上传空文件夹 | 本项目没有空文件夹 |
| 隐藏文件容易漏 | 按第 3 步核对 `.gitignore`、`.gitattributes`、`.github` |
| 没有本地提交历史 | 网页提交直接进默认分支 `main`；无回滚历史需求时够用 |
| 不能断点续传 | 一次传完；失败就重新拖 |

---

## 8. FAQ

**Q1：上传后发现根目录多了一层 `dsh-launcher-repo/`？**
进去用 `...` → Delete directory 删掉，再回到根目录按第 2 步重传（拖文件夹里的**内容**）。

**Q2：文件上传后中文文件名/内容变成乱码？**
GitHub 网页上传按 UTF-8 处理，本项目文件都是 UTF-8；若乱码说明文件被浏览器以外的方式改过编码，用编辑器另存为 UTF-8 再传。

**Q3：Actions 页面提示 “Workflows aren't being run on this repository”？**
Settings → Actions → General → 选 “Allow all actions and reusable workflows” → Save。

**Q4：Release 附件上传失败？**
确认 zip < 2 GB、网络稳定；失败后重新进 Draft 页面重试即可，tag 已经创建不会重复。

**Q5：想让别人参与开发怎么办？**
把仓库设为 Public；别人 Fork / 提 Pull Request / Issue 即可。你只需要在网页上点 “Merge pull request”。

**Q6：上传时把 `data/` 也拖进去了怎么办？**
进入该目录 → `...` → Delete directory，然后提交。**注意**：已上传的私人数据会留在 Git 历史里，公开前务必确认没传；本项目已经用 `.gitignore` 排除，正常不会发生。

---

## 9. 上传前检查清单

- [ ] 上传的是 `_upload\dsh-launcher-repo\` 里的**内容**（不是文件夹本身）；
- [ ] 仓库根目录有 `index.js`、`client.js`、`package.json`、`README.md`、`LICENSE`；
- [ ] `.gitignore`、`.gitattributes`、`.github/workflows/tests.yml` 都在；
- [ ] Actions 里 `tests` 跑出绿色 ✓；
- [ ] `package.json` 里 `OWNER` 换成你的 GitHub 用户名（网页直接编辑即可）；
- [ ] `LICENSE` 里版权人改成你的名字；
- [ ] Release 已发布且附上 `dsh-launcher-3.3.0.zip`。

---

## 10. 第二个仓库：我的世界启动器（附属启动器）

> 上传这个仓库时，把 `_upload\dsh-launcher-minecraft-repo\` 里的 **`catalog.json`** 一起传上去（它在仓库根目录）。本体「推荐目录」默认读的就是这个文件的 raw 地址；上传后可在本体 `cordis.patch.yml` 把 `catalogUrl` 换成你自己的用户名。

v4 起有两个仓库。第二个仓库**不是** DSH 插件，而是一个可下载的附属启动器包（zip）。上传步骤与本体相同，只是目录不同：

| 项目 | 本地目录（已为你准备好） | 仓库名建议 | Release 附件 |
| --- | --- | --- | --- |
| 启动器本体 | `C:\Users\38357\Desktop\模组开发\_upload\dsh-launcher-repo\`（45 个文件） | `dsh-launcher` | `dsh-launcher-3.3.0.zip` |
| 我的世界启动器 | `C:\Users\38357\Desktop\模组开发\_upload\dsh-launcher-minecraft-repo\`（21 个文件） | `dsh-launcher-minecraft` | `minecraft-launcher-1.0.0.zip` |

操作要点：

1. GitHub 右上角 **+ → New repository**，名字填 `dsh-launcher-minecraft`，**不要**勾选 README/.gitignore/License；
2. 进入空仓库页，把 `_upload\dsh-launcher-minecraft-repo\` 里的**内容**（Ctrl+A 全选）拖进去，Commit；
3. 发布 Release：tag `v1.0.0`，标题「我的世界启动器 v1.0.0」，附件上传 `C:\Users\38357\Desktop\模组开发\dsh-launcher-minecraft\dist\minecraft-launcher-1.0.0.zip`；
4. 回到本体，在「附属启动器」页填仓库 `<你的用户名>/dsh-launcher-minecraft`，数秒后游戏列表出现 Minecraft；也可以先测试本机 zip 安装。

> 两个仓库的 README / package.json 里都有 `OWNER` 占位，记得把仓库地址改成你自己的用户名（本体的 docs/GITHUB-UPLOAD.md 第 11 节有批量替换命令）。
