# 把这个插件上传到 GitHub：手把手教学

> 目标：把本项目（DSH启动器本体，版本 3.3.0）发布成你自己的 GitHub 仓库，之后能持续更新、发 Release 给别人下载。
>
> **v4 起有两个仓库**：① 本体仓库（本目录）——不含任何具体游戏；② 附属启动器仓库 `dsh-launcher-minecraft`（在我的世界启动器项目目录里，见第 11 节）。两个仓库分别发 Release，本体 Release 附件是 `dist/dsh-launcher-3.3.0.zip`，附属启动器 Release 附件是 `minecraft-launcher-1.0.0.zip`。
> 全程约 15～30 分钟。你只需要一个浏览器 + 一个终端（PowerShell），不需要先懂 Git。
>
> 不想安装 Git、只想用浏览器上传？看纯网页版教程：[GITHUB-WEB-UPLOAD.md](GITHUB-WEB-UPLOAD.md)。

---

## 0. 先搞清楚：哪些文件会传上去？

本仓库已经准备好了 `.gitignore`，以下内容**不会**被提交（也不该被提交）：

| 路径 | 原因 |
| --- | --- |
| `data/` | 你的游戏数据、缓存、实例、存档，属于本机隐私数据（可能几百 MB） |
| `dist/` | 打包产物，改用 GitHub Releases 的附件分发 |
| `test/tmp/`、`test/*-report.txt` | 测试临时文件与报告 |
| `node_modules/`、`tmp/` | 依赖与本地杂项 |

会提交的是：`index.js`、`client.js`、`lib/`、`locale/`、`docs/`、`scripts/`、`package.json`、`cordis.patch.yml`、`README.md`、`LICENSE` 等源码与文档（`plugins/` 已在 v4 拆分出去，不属于本体仓库）。

---

## 1. 安装 Git（Windows）

本机目前**没有安装 Git**（`git --version` 会报错），先装：

### 方式 A：用 winget（推荐，一条命令）

在 PowerShell 里执行：

```powershell
winget install --id Git.Git -e --source winget --accept-package-agreements --accept-source-agreements
```

装完**关掉终端重新打开**（让 PATH 生效），验证：

```powershell
git --version
# 应输出：git version 2.x.x.windows.x
```

### 方式 B：官网安装包

打开 <https://git-scm.com/download/win> 下载 64-bit 安装包，一路默认下一步即可。安装选项里保持默认的 “Git from the command line and also from 3rd-party software”。

### 方式 C：不想用命令行

装 **GitHub Desktop**（<https://desktop.github.com/>），用图形界面完成下面第 3～4 步；但本文仍以命令行为主，学会命令再换图形界面会更清楚每一步在做什么。

### 方式 D：本机已经备好的便携版 Git（装不上时直接用）

winget 从 GitHub 下载安装包在部分网络下会失败（本项目已实测过一次 `InternetOpenUrl() failed`）。我已经把 **便携版 MinGit 2.55.0** 解压到本机：

```text
C:\Users\38357\Desktop\模组开发\_tools\mingit\cmd\git.exe
```

三个选择，任选其一：

1. **临时用**（只对当前 PowerShell 窗口生效）：
   ```powershell
   $env:Path = "C:\Users\38357\Desktop\模组开发\_tools\mingit\cmd;$env:Path"
   git --version
   ```
2. **永久用**：把 `C:\Users\38357\Desktop\模组开发\_tools\mingit\cmd` 加入「系统属性 → 环境变量 → 用户变量 Path」，重开终端后 `git --version`；
3. **直接用绝对路径**调用（把下文所有 `git` 换成）：
   ```powershell
   & "C:\Users\38357\Desktop\模组开发\_tools\mingit\cmd\git.exe" --version
   ```

> 说明：这个便携版只在你这台机器上、且在工作区里，**不会**被提交到 GitHub（它在仓库目录之外）。想在别的电脑开发时，正常安装 Git 即可。

---

## 2. 一次性配置（只需做一次）

```powershell
git config --global user.name "你的名字"
git config --global user.email "你的GitHub注册邮箱"
git config --global init.defaultBranch main
```

说明：
- `user.name` 会显示在每次提交记录里，可以填昵称；
- `user.email` 建议和 GitHub 账号邮箱一致，这样提交能关联到你的头像；
- `init.defaultBranch main` 让以后新建仓库默认分支叫 `main`（GitHub 的默认分支）；
- 换行符已经由仓库里的 `.gitattributes` 统一，**不需要**再设 `core.autocrlf`。

可选（让中文文件名显示正常）：

```powershell
git config --global core.quotepath false
```

---

## 3. 在 GitHub 网页上创建空仓库

1. 登录 <https://github.com>（没有账号先注册）；
2. 右上角 **+** → **New repository**；
3. 填写：
   - **Repository name**：`dsh-launcher`（可自定义，下文命令里的仓库名要同步改）；
   - **Description**：`DSH启动器：可扩展的 DSH 游戏下载与启动框架`；
   - 可见性：**Public**（公开，方便别人安装/提 issue）或 Private（只自己用）；
   - **不要**勾选 “Add a README file / Add .gitignore / Choose a license”——本地已经有这些文件，勾了反而会在第一次 push 时冲突；
4. 点 **Create repository**，复制页面上显示的仓库地址，形如：

```text
https://github.com/<你的用户名>/dsh-launcher.git
```

---

## 4. 本地初始化并首次推送

> **本机已经帮你初始化好了**：仓库目录里已有 `.git`，分支是 `main`，并且已确认 **57 个源码/文档文件**会被提交、`data/`、`dist/`、`test/tmp/` 等都被 `.gitignore` 排除。因此你可以直接跳过 `git init`，从下面的第 3 步 `git add .` 开始；如果第 2 步仍执行 `git init`，提示 `Reinitialized existing Git repository` 属于正常现象。

**逐条执行**（不要一次全粘，理解每条在干什么）：

```powershell
# 1) 进入项目目录（把 <用户名> 换成你自己的）
cd C:\Users\<用户名>\Desktop\模组开发\dsh-launcher-v3

# 2) 初始化本地仓库（会在当前目录生成 .git 文件夹）
git init

# 3) 查看将被提交的文件清单（重点检查：不应出现 data/、dist/、test/tmp/）
git status

# 4) 暂存全部改动
git add .

# 5) 再次确认（应该看到 index.js、client.js、lib/、docs/ 等）
git status

# 6) 提交第一个版本
git commit -m "feat: DSH启动器 v3.3.0（通用游戏下载与启动框架）"

# 7) 把默认分支改名为 main（GitHub 默认分支）
git branch -M main

# 8) 关联远程仓库（换成第 3 步复制的地址）
git remote add origin https://github.com/<你的用户名>/dsh-launcher.git

# 9) 首次推送
git push -u origin main
```

第 9 步会要求登录：
- Windows 版 Git 自带 **Git Credential Manager**，一般会弹出浏览器窗口，点 “Sign in with your browser” 用 GitHub 账号授权即可；
- 如果提示输入用户名/密码，密码处要填 **Personal Access Token**（不是登录密码）。生成方法：GitHub → 右上头像 → **Settings** → **Developer settings** → **Personal access tokens** → **Tokens (classic)** → **Generate new token (classic)** → 勾选 `repo` → 生成后复制，粘贴到密码处（只显示一次）。

### 成功后检查

刷新 GitHub 仓库页面，应能看到完整目录结构和 README。命令行执行：

```powershell
git log --oneline -1
git status   # 应显示 working tree clean
```

---

## 5. 给仓库加“门面”

在 GitHub 仓库页面：

1. 右侧 **About** 齿轮 → Description 填一句话；**Topics** 填 `dsh`、`dsh-plugin`、`launcher`、`game-launcher`；
2. 确认 License 被识别为 MIT（仓库页会显示 MIT license）；
3. 默认分支确认是 `main`。

README 里已经有功能、安装、配置、测试说明，别人打开仓库就能看懂。

---

## 6. 发布 Release（给别人下载分发包）

分发包 zip 是构建产物，不放进仓库，而是作为 **Release 附件**。先在本机构建：

```powershell
# 构建 dist/dsh-launcher-3.3.0/ 与 dist/dsh-launcher-3.3.0.zip
node scripts/build-dist.mjs
```

> 本机没有单独安装 Node.js，`node` 可能不在 PATH。可临时用 DSH 自带的 Node：
> `& "C:\Users\<用户名>\.dsh\dsh-runtimes\dsh-plugin-desktop-primary-runtime\dependencies\node\bin\node.exe" scripts\build-dist.mjs`
> 或在任意机器上装 Node.js LTS 后再构建。

### 打 tag 并发布

```powershell
# 给当前提交打一个带注释的 tag（版本号要和 package.json 一致）
git tag -a v3.3.0 -m "DSH启动器 v3.3.0"
git push origin v3.3.0
```

然后在 GitHub 网页：**Releases** → **Draft a new release** → Choose a tag 选 `v3.3.0` → 标题填 `DSH启动器 v3.3.0` → 说明里贴更新日志 → 最下方拖入 `dist\dsh-launcher-3.3.0.zip` → **Publish release**。

之后别人下载 release 里的 zip，解压后按 [docs/INSTALL.md](INSTALL.md) 安装即可。

> 也可以安装 GitHub CLI（`winget install --id GitHub.cli`），登录后一条命令发布：
> `gh release create v3.3.0 "dist\dsh-launcher-3.3.0.zip" --title "DSH启动器 v3.3.0" --notes "更新说明"`

---

## 7. 之后的日常更新流程

每次改完代码，**按这个顺序**做：

```powershell
# 0) 改代码 / 改文档

# 1) 跑测试（全绿再提交；本机 node 不在 PATH 时用 DSH 自带 node 的绝对路径）
node scripts/registry-test.mjs
node scripts/bridge-test.mjs
node scripts/portability-test.mjs
node scripts/brand-check.mjs
node scripts/inject-test.mjs
node scripts/http-test.mjs
node scripts/check-client.mjs

# 2) 看改了什么
git status
git diff

# 3) 提交
git add .
git commit -m "fix: 修复 xxx"

# 4) 推上去
git push
```

发布新版本时额外：改 `package.json` 的 `version` → 提交 → 打新 tag → `git push origin v<新版本>` → 在 Releases 里新建 release 并上传新 zip。

### 提交信息（commit message）建议

| 前缀 | 用途 | 例子 |
| --- | --- | --- |
| `feat:` | 新功能 | `feat: 支持从 URL 清单添加游戏` |
| `fix:` | 修 bug | `fix: 修复面板 Esc 关闭顺序` |
| `docs:` | 只改文档 | `docs: 补充 Release 发布步骤` |
| `test:` | 只改测试 | `test: 增加桥接指针隔离断言` |
| `chore:` | 杂项/依赖/打包 | `chore: 构建 3.3.0 分发包` |

### 自动测试（CI）

仓库已包含 `.github/workflows/tests.yml`：每次 `git push` 到 main 或提交 Pull Request，GitHub 会自动在 Windows 环境跑静态/仿真测试。在仓库页 **Actions** 标签能看到运行结果；红色 ✗ 表示有测试失败，点进去看日志。

---

## 8. 常见问题（FAQ）

**Q1：`git: 无法将“git”项识别为 cmdlet...`**
Git 没装好或终端没重启。重开 PowerShell，或重新执行第 1 步。

**Q2：`fatal: not a git repository`**
当前目录不在仓库里。先 `cd` 到 `dsh-launcher-v3` 目录（有 `.git` 的那个），再执行命令。

**Q3：`failed to push some refs ... rejected (non-fast-forward)`**
远程仓库比本地多提交（常见于建仓库时勾选了 README）。两种处理：
- 新建一个空仓库重新 `git remote set-url origin <新地址>`；或
- 先拉取合并：`git pull origin main --allow-unrelated-histories`，解决冲突后再 push。

**Q4：push 很慢 / 连不上 GitHub**
国内网络访问 GitHub 经常不稳。解决：开代理后给 Git 设置代理（端口按你的代理软件改）：

```powershell
git config --global http.proxy http://127.0.0.1:7890
git config --global https.proxy http://127.0.0.1:7890
# 取消代理
git config --global --unset http.proxy
git config --global --unset https.proxy
```

或改用 SSH（生成密钥 `ssh-keygen -t ed25519 -C "你的邮箱"`，把 `~/.ssh/id_ed25519.pub` 内容贴到 GitHub → Settings → SSH and GPG keys），远端地址换成 `git@github.com:<用户名>/dsh-launcher.git`。

**Q5：认证失败 / `Authentication failed`**
密码处要填 **Personal Access Token**（见第 4 步），不是 GitHub 登录密码。Windows 可在 “凭据管理器” → Windows 凭据 → 找到 `git:https://github.com` 删除旧凭据后重试。

**Q6：不小心把 `data/` 或大文件提交了怎么办？**
```powershell
# 只从 Git 索引里移除，不删本地文件
git rm -r --cached data
git commit -m "chore: 移除误提交的运行数据"
git push
```
本仓库 `.gitignore` 已提前排除，正常不会发生。

**Q7：GitHub 提示文件超过 100 MB 怎么办？**
本仓库源码只有 0.5 MB 左右，不会遇到。如果以后要放大文件，用 Git LFS：`git lfs install` → `git lfs track "*.zip"`；更推荐放 Release 附件而不是仓库。

**Q8：换行符警告 `LF will be replaced by CRLF`？**
不用管，`.gitattributes` 已统一为 LF，警告不影响使用。

**Q9：如何撤销还没提交的修改？**
```powershell
git restore <文件>        # 撤销单个文件的修改
git restore .             # 撤销全部未暂存修改（谨慎）
```

**Q10：别人怎么安装我的插件？**
把仓库地址或 Release 的 zip 发给他：下载 → 解压 → 在 DSH 对话里让它「安装本地插件：<解压目录>」→ 重启 DSH。详见 [INSTALL.md](INSTALL.md)。

---

## 9. 上传前安全检查清单

- [ ] `git status` 里**没有** `data/`、`dist/`、`test/tmp/`、`*.log`；
- [ ] `git status` 里没有你的私人路径（可以用 `git diff --cached | Select-String "C:\\Users"` 自查）；
- [ ] 没有把 token、密码、密钥写进任何文件；
- [ ] 测试至少跑过：`registry-test`、`bridge-test`、`brand-check`、`inject-test`、`http-test`、`check-client`；
- [ ] `LICENSE` 里的版权人改成了你自己；
- [ ] `package.json` 的 `repository` / `homepage` / `bugs` 里 `OWNER` 换成你的 GitHub 用户名（见下）。

把 `package.json` 顶部改成（把 `OWNER` 替换成你的用户名）：

```json
"author": "你的名字",
"repository": { "type": "git", "url": "https://github.com/OWNER/dsh-launcher.git" },
"homepage": "https://github.com/OWNER/dsh-launcher",
"bugs": { "url": "https://github.com/OWNER/dsh-launcher/issues" },
```

---

## 10. 练习任务（做完就算学会）

1. 装好 Git，`git --version` 有输出；
2. 在 GitHub 建好空仓库，完成首次 `git push`，网页能看到代码；
3. 把 README 里某个错别字改掉 → `git add .` → `git commit -m "docs: 修正错别字"` → `git push`；
4. 用 `git log --oneline`、`git status`、`git diff` 各看一次，理解它们在显示什么；
5. 构建分发包并发布第一个 Release（附 zip）；
6. （进阶）提交一次 Pull Request / 在 Actions 里看一次 CI 测试结果。

全部完成后，这个项目就是一个标准的开源仓库：别人可以 Star、提 Issue、下载 Release 安装。


---

## 11. 第二个仓库：我的世界启动器（附属启动器）

启动器本体仓库只是框架；**游戏能力来自第二个仓库**，它是一个「附属启动器」包，不是 DSH 插件。

| 项目 | 本地目录 | 仓库名建议 | Release 附件 |
| --- | --- | --- | --- |
| 启动器本体 | `C:\Users\38357\Desktop\模组开发\dsh-launcher-v3` | `dsh-launcher` | `dist\dsh-launcher-3.3.0.zip` |
| 我的世界启动器 | `C:\Users\38357\Desktop\模组开发\dsh-launcher-minecraft` | `dsh-launcher-minecraft` | `dist\minecraft-launcher-1.0.0.zip` |

命令流程（在 `dsh-launcher-minecraft` 目录里执行，Git 用法与本体相同）：

```powershell
# 1) 在 GitHub 网页新建空仓库 dsh-launcher-minecraft（不勾任何初始化文件）
# 2) 本地初始化并推送
$env:Path = "C:\Users\38357\Desktop\模组开发\_tools\mingit\cmd;$env:Path"
cd C:\Users\38357\Desktop\模组开发\dsh-launcher-minecraft
git init
git add .
git commit -m "feat: 我的世界启动器 v1.0.0（附属启动器）"
git branch -M main
git remote add origin https://github.com/<你的用户名>/dsh-launcher-minecraft.git
git push -u origin main

# 3) 构建并发布 Release（附件是附属启动器 zip，不是本体插件包）
node scripts/check-package.mjs
node scripts/adapter-test.mjs
node scripts/build-dist.mjs
# 网页 Releases → Draft a new release → tag v1.0.0 → 上传
# C:\Users\38357\Desktop\模组开发\dsh-launcher-minecraft\dist\minecraft-launcher-1.0.0.zip
```

**记得把仓库根目录的 `catalog.json` 一起上传**（已放在 `dsh-launcher-minecraft\catalog.json`，`_upload\dsh-launcher-minecraft-repo\` 里也有一份）。它让用户在面板「推荐目录」里直接看到并安装，不用手动填仓库名；本体默认的 `catalogUrl` 就指向这个文件的 raw 地址（
`https://raw.githubusercontent.com/<你的用户名>/dsh-launcher-minecraft/main/catalog.json`）。上传后可以把本体 `cordis.patch.yml` 里的 `catalogUrl` 改成你自己的用户名。

发布后，打开启动器面板的「附属启动器」页，填 `<你的用户名>/dsh-launcher-minecraft` 即可安装；也可以在本体对话里说：

```text
安装附属启动器，GitHub 仓库 <你的用户名>/dsh-launcher-minecraft
```

> 这个仓库可以独立迭代：加载器更新、下载源变化，只需要在本仓库发新版本 zip，本体不需要重新发版。
