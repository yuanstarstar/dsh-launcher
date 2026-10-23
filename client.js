/**
 * DSH启动器 — 客户端面板（v3.1「按游戏进入」版）。
 *
 * 零构建 DSH Web 客户端模块：由宿主通过 window.__ModuleLoader__ 加载。
 * 面板结构：侧栏底栏入口 → 浮层；顶部 tab「游戏 / 添加游戏 / 设置」。
 * 游戏 tab 先展示游戏卡片列表，点开某个游戏后才进入该游戏的详情视图
 * （版本下载安装、该游戏的实例、内容管理），任何游戏都走同一套流程，
 * 面板不包含任何具体游戏专属文案。
 */
window.__ModuleLoader__.load({
	id: "@local/dsh-launcher",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const react = require("react");
		const h = react.createElement;

		const NS = "launcher";
		const CSS_TAG_ID = "dsh-launcher/panel.css";

		const API = "/dsh-launcher/api";

		const POLL_MS = 1500;
		const JOB_POLL_MS = 1000;
		const LOG_LINES = 200;
		const ENTRY_ORDER = 60;

		const PROVIDERS = ["github", "url", "manual"];
		const SUB_SOURCE_TYPES = ["github", "url", "file"];

		// ------------------------------------------------------------------
		// 界面文案（中文）。所有用户可见文本都必须走这里，面板里不直接拼句子。
		// ------------------------------------------------------------------
		const DICT_ZH = {
			"title": "DSH启动器",
			"entry.label": "启动游戏",
			"entry.open": "打开 DSH启动器",
			"header.dataRoot": "数据目录",
			"header.close": "关闭",
			"header.refresh": "刷新",
			"header.stateError": "状态同步失败：{error}",
			"tab.games": "游戏",
			"tab.addGame": "添加游戏",
			"tab.settings": "设置",
			"common.loading": "加载中…",
			"common.cancel": "取消",
			"common.confirm": "确认",
			"common.none": "无",
			"common.search": "搜索",
			"common.searching": "搜索中…",
			"common.refresh": "刷新",
			"common.retry": "重试",
			"common.selected": "已选 {count} 项",
			"common.back": "返回",
			"common.instances": "实例 {count} 个",
			"common.running": "运行中 {count} 个",
			"toast.failed": "操作失败：{error}",
			"toast.deleted": "已删除实例",
			"toast.launched": "已启动游戏",
			"toast.stopped": "已停止游戏",
			"toast.installStarted": "已开始下载并安装",
			"toast.contentAdded": "已添加内容",
			"toast.contentRemoved": "已移除内容",
			"toast.jobDone": "任务已完成",
			"toast.jobFailed": "任务失败：{error}",
			"toast.configSaved": "设置已保存",
			"toast.opened": "已在文件管理器中打开：{path}",
			"toast.openedNoPath": "已请求打开目录",
			"toast.gameAdded": "已添加游戏",
			"toast.gameDeleted": "已删除游戏",
			"toast.gameGone": "游戏已不存在",
			"footer.hint": "面板每 1.5 秒自动同步一次状态；所有操作都会显示结果提示。",
			"footer.synced": "最近同步：{time}",
			"jobs.cancel": "取消任务",
			"jobs.cancelled": "已请求取消任务",
			"jobs.kind.install": "安装",
			"jobs.kind.launch": "启动",
			"jobs.kind.content": "内容",
			"jobs.kind.sublauncherInstall": "附属启动器安装",
			"jobs.kind.sublauncherUpdate": "附属启动器更新",
			"jobs.progress": "进度 {percent}%",
			"jobs.bytes": "已下载 {bytes}",
			"games.jobStatus.queued": "排队中",
			"games.jobStatus.running": "进行中",
			"games.jobStatus.succeeded": "已完成",
			"games.jobStatus.failed": "失败",
			"games.title": "游戏",
			"games.empty": "还没有添加任何游戏",
			"games.emptyHint": "先添加一个游戏，再进入该游戏下载版本、安装实例并管理内容。",
			"games.emptyActionAdd": "添加游戏",
			"games.capContent": "内容",
			"games.capLoaders": "加载器",
			"games.capRuntimes": "运行时",
			"games.open": "进入",
			"games.source": "来源：{source}",
			"detail.back": "返回游戏列表",
			"detail.versions": "版本",
			"detail.versionsHint": "选择版本后可以创建该游戏的实例。",
			"detail.versionsLoading": "版本加载中…",
			"detail.versionsEmpty": "该游戏暂无可用版本",
			"detail.refreshVersions": "刷新版本",
			"detail.install": "下载并安装",
			"detail.installTitle": "安装选项",
			"detail.name": "实例名称",
			"detail.namePh": "留空则自动命名",
			"detail.options": "附加选项",
			"detail.optionsHint": "这些选项由游戏适配器定义。",
			"detail.contentHint": "可选：安装时一并添加内容。",
			"detail.contentSearchPh": "搜索内容…",
			"detail.contentEmpty": "没有搜索结果",
			"detail.contentPicked": "已选 {count} 项内容",
			"detail.submit": "安装",
			"detail.submitting": "安装中…",
			"detail.needVersion": "请先选择版本",
			"detail.instances": "实例",
			"detail.instancesHint": "该游戏的实例；启动、日志与文件夹操作都在这里。",
			"detail.noInstances": "还没有实例，先在上方下载一个版本。",
			"detail.content": "内容管理",
			"detail.contentInstance": "选择实例",
			"detail.instanceSelect": "请选择一个实例来管理内容",
			"detail.installed": "已安装内容",
			"detail.installedEmpty": "这个实例还没有安装内容",
			"detail.removeContent": "移除",
			"detail.addContent": "添加所选内容",
			"detail.adding": "添加中…",
			"detail.removeConfirm": "确认移除内容「{name}」？",
			"detail.capabilityContent": "该游戏支持内容管理",
			"instance.status.new": "未安装",
			"instance.status.installing": "安装中",
			"instance.status.ready": "就绪",
			"instance.status.error": "安装失败",
			"instance.running": "运行中",
			"instance.version": "版本",
			"instance.contentCount": "内容 {count} 个",
			"instance.lastLaunch": "最近启动",
			"instance.neverLaunched": "从未启动",
			"instance.playCount": "启动 {count} 次",
			"instance.launch": "启动",
			"instance.launching": "启动中…",
			"instance.stop": "停止",
			"instance.stopping": "停止中…",
			"instance.stopConfirmHint": "确认停止实例「{name}」？",
			"instance.confirmStop": "确认停止",
			"instance.log": "日志",
			"instance.hideLog": "收起日志",
			"instance.logLoading": "日志加载中…",
			"instance.logEmpty": "暂无日志",
			"instance.logRefresh": "刷新日志",
			"instance.logsFolder": "日志文件夹",
			"instance.openGame": "打开游戏目录",
			"instance.openContent": "打开内容目录",
			"instance.delete": "删除",
			"instance.deleteHint": "删除实例会移除它的游戏文件与内容，且不可恢复。",
			"instance.deleteConfirm": "确认删除实例「{name}」？",
			"instance.installError": "安装错误：{error}",
			"instance.activeJobs": "进行中的任务",
			"instance.job": "任务",
			"addGame.title": "添加游戏",
			"addGame.subtitle": "从代码托管发布、URL 清单或本地已安装目录引入一个游戏；保存后即可进入该游戏下载版本。",
			"addGame.provider": "来源类型",
			"addGame.providerGithub": "代码托管发布",
			"addGame.providerUrl": "URL 清单",
			"addGame.providerManual": "手动导入",
			"addGame.providerHint": "按来源类型填写下方配置；不确定时先点「测试连接」。",
			"addGame.label": "显示名称",
			"addGame.labelPh": "例如：示例游戏",
			"addGame.id": "游戏标识",
			"addGame.idPh": "留空按名称生成",
			"addGame.idHint": "小写字母、数字与连字符，用于实例目录与配置文件名。",
			"addGame.repo": "仓库",
			"addGame.repoPh": "owner/name",
			"addGame.repoHint": "会读取该仓库的发布列表与资源。",
			"addGame.assetPattern": "资源匹配",
			"addGame.assetPatternPh": "可选的正则，例如 windows.*[.]zip",
			"addGame.executable": "启动程序",
			"addGame.executablePh": "例如 game.exe",
			"addGame.args": "启动参数",
			"addGame.argsPh": "每行一个参数，或空格分隔",
			"addGame.argsHint": "可留空；参数中的引号会被保留。",
			"addGame.jsonUrl": "清单地址",
			"addGame.jsonUrlPh": "https://example.com/versions.json",
			"addGame.versions": "静态版本列表",
			"addGame.versionsPh": "[{\"id\":\"1.0.0\",\"url\":\"https://example.com/game.zip\"}]",
			"addGame.versionsHint": "JSON 数组；每项至少包含 id 与 url。",
			"addGame.path": "安装目录",
			"addGame.pathPh": "例如 D:/Games/MyGame",
			"addGame.pathHint": "指向已经安装好的游戏目录。",
			"addGame.test": "测试连接",
			"addGame.testing": "测试中…",
			"addGame.testOk": "连接正常",
			"addGame.testFail": "连接失败",
			"addGame.testHint": "保存前建议先测试一次，避免保存后才发现配置问题。",
			"addGame.save": "保存游戏",
			"addGame.saving": "保存中…",
			"addGame.needLabel": "请填写显示名称",
			"addGame.needRepo": "请填写仓库（owner/name）",
			"addGame.needSource": "请填写清单地址或静态版本列表",
			"addGame.needPath": "请填写安装目录",
			"addGame.needExecutable": "请填写启动程序（可执行文件名，例如 game.exe）",
			"addGame.invalidVersions": "静态版本列表必须是 JSON 数组",
			"addGame.added": "已添加的游戏",
			"addGame.addedEmpty": "还没有通过面板添加的游戏",
			"addGame.addedHint": "内置与外部适配器提供的游戏不可在此删除。",
			"addGame.delete": "删除",
			"addGame.deleteConfirm": "确认删除游戏「{name}」？",
			"addGame.deleteHint": "只删除游戏定义，不删除已安装的实例。",
			"addGame.source.user": "用户添加",
			"addGame.source.external": "外部适配器",
			"addGame.source.builtin": "内置",
			"addGame.providerType": "来源",
			"addGame.versionLabel": "版本",
			"addGame.contentLabel": "内容",
			"addGame.instancesCount": "实例",
			"settings.title": "设置",
			"settings.dataRoot": "数据目录",
			"settings.dataRootHint": "配置、游戏定义与实例都保存在这里（只读展示）。",
			"settings.concurrency": "下载并发",
			"settings.concurrencyHint": "同时下载的任务数，1–32；网络较差时可调小。",
			"settings.retries": "重试次数",
			"settings.retriesHint": "下载失败后的重试次数，0–10。",
			"settings.stats": "统计",
			"settings.save": "保存设置",
			"settings.saving": "保存中…",
			"settings.invalidConcurrency": "下载并发必须是 1–32 之间的整数",
			"settings.invalidRetries": "重试次数必须是 0–10 之间的整数",
			"tab.sublaunchers": "附属启动器",
			"sublauncher.title": "附属启动器",
			"sublauncher.subtitle": "附属启动器是独立项目；本启动器本体不含任何游戏。从 GitHub Release 或 zip 地址安装后，游戏会自动出现在「游戏」页。",
			"sublauncher.installTitle": "安装附属启动器",
			"sublauncher.installHint": "支持 GitHub 仓库、zip 地址或本机文件；安装完成后游戏会自动出现在「游戏」页。",
			"sublauncher.sourceType": "来源类型",
			"sublauncher.sourceType.github": "GitHub 仓库",
			"sublauncher.sourceType.url": "zip 地址",
			"sublauncher.sourceType.file": "本机文件路径",
			"sublauncher.repo": "GitHub 仓库",
			"sublauncher.repoPh": "owner/name",
			"sublauncher.repoHint": "仓库的 Release 中需要包含 zip 资产。",
			"sublauncher.url": "zip 地址",
			"sublauncher.urlPh": "https://example.com/launcher.zip",
			"sublauncher.urlHint": "直接指向 zip 包的下载地址。",
			"sublauncher.file": "本机文件路径",
			"sublauncher.filePh": "D:/downloads/launcher.zip",
			"sublauncher.fileHint": "填写本机 zip 包路径。",
			"sublauncher.advanced": "高级选项",
			"sublauncher.advancedHide": "收起高级选项",
			"sublauncher.assetPattern": "资产匹配模式",
			"sublauncher.assetPatternPh": "例如 launcher-*.zip",
			"sublauncher.assetPatternHint": "用于在 Release 资产中挑选 zip；留空时取第一个 zip。",
			"sublauncher.install": "安装",
			"sublauncher.installing": "安装中…",
			"sublauncher.installStarted": "已开始安装附属启动器",
			"sublauncher.needSource": "请填写仓库、zip 地址或本机文件路径",
			"sublauncher.installProgress": "安装进度",
			"sublauncher.updateProgress": "更新进度",
			"sublauncher.installed": "已安装的附属启动器",
			"sublauncher.empty": "还没有附属启动器。可以从 GitHub 仓库或 zip 地址安装一个（例如某个游戏的官方附属启动器项目）。",
			"sublauncher.loading": "正在读取附属启动器列表…",
			"sublauncher.source": "来源",
			"sublauncher.source.repo": "GitHub 仓库",
			"sublauncher.source.url": "zip 地址",
			"sublauncher.source.file": "本机文件",
			"sublauncher.version": "版本 {version}",
			"sublauncher.gamesCount": "提供游戏 {count} 个",
			"sublauncher.updateAvailable": "有更新可用",
			"sublauncher.upToDate": "已是最新版本",
			"sublauncher.check": "检查更新",
			"sublauncher.checking": "检查中…",
			"sublauncher.update": "更新",
			"sublauncher.updating": "更新中…",
			"sublauncher.updateStarted": "已开始更新附属启动器",
			"sublauncher.delete": "删除",
			"sublauncher.deleteConfirm": "确认删除附属启动器「{name}」？",
			"sublauncher.deleteHint": "删除后由它提供的游戏会从「游戏」页消失，已安装的实例文件不会删除。",
			"sublauncher.deleted": "已删除附属启动器",
			"catalog.title": "推荐目录",
			"catalog.hint": "从推荐目录一键安装附属启动器；安装完成后游戏会自动出现在「游戏」页。",
			"catalog.refresh": "刷新推荐",
			"catalog.loading": "正在读取推荐目录…",
			"catalog.empty": "推荐目录暂时没有可用的附属启动器",
			"catalog.emptyHint": "可以继续用下方的表单手动填写仓库或 zip 地址安装。",
			"catalog.error": "读取推荐目录失败：{error}",
			"catalog.install": "安装",
			"catalog.installing": "安装中…",
			"catalog.installed": "已安装",
			"catalog.update": "更新",
			"catalog.updating": "更新中…",
			"catalog.updateAvailable": "可更新",
			"catalog.needSource": "该条目没有可用的安装来源，请手动填写仓库或 URL。",
			"catalog.description": "简介",
			"catalog.manualHint": "推荐目录加载失败或没有条目时，仍可手动填写仓库 / URL / 本机文件安装。",
		};

		// ------------------------------------------------------------------
		// 界面文案（英文）。
		// ------------------------------------------------------------------
		const DICT_EN = {
			"title": "DSH Launcher",
			"entry.label": "Launch",
			"entry.open": "Open DSH Launcher",
			"header.dataRoot": "Data directory",
			"header.close": "Close",
			"header.refresh": "Refresh",
			"header.stateError": "State sync failed: {error}",
			"tab.games": "Games",
			"tab.addGame": "Add game",
			"tab.settings": "Settings",
			"common.loading": "Loading…",
			"common.cancel": "Cancel",
			"common.confirm": "Confirm",
			"common.none": "None",
			"common.search": "Search",
			"common.searching": "Searching…",
			"common.refresh": "Refresh",
			"common.retry": "Retry",
			"common.selected": "{count} selected",
			"common.back": "Back",
			"common.instances": "{count} instance(s)",
			"common.running": "{count} running",
			"toast.failed": "Operation failed: {error}",
			"toast.deleted": "Instance deleted",
			"toast.launched": "Game launched",
			"toast.stopped": "Game stopped",
			"toast.installStarted": "Download and install started",
			"toast.contentAdded": "Content added",
			"toast.contentRemoved": "Content removed",
			"toast.jobDone": "Task finished",
			"toast.jobFailed": "Task failed: {error}",
			"toast.configSaved": "Settings saved",
			"toast.opened": "Opened in file manager: {path}",
			"toast.openedNoPath": "Requested to open the folder",
			"toast.gameAdded": "Game added",
			"toast.gameDeleted": "Game deleted",
			"toast.gameGone": "Game no longer exists",
			"footer.hint": "The panel syncs state every 1.5 seconds; every action reports its result.",
			"footer.synced": "Last sync: {time}",
			"jobs.cancel": "Cancel task",
			"jobs.cancelled": "Task cancellation requested",
			"jobs.kind.install": "Install",
			"jobs.kind.launch": "Launch",
			"jobs.kind.content": "Content",
			"jobs.kind.sublauncherInstall": "Sub-launcher install",
			"jobs.kind.sublauncherUpdate": "Sub-launcher update",
			"jobs.progress": "Progress {percent}%",
			"jobs.bytes": "Downloaded {bytes}",
			"games.jobStatus.queued": "Queued",
			"games.jobStatus.running": "Running",
			"games.jobStatus.succeeded": "Done",
			"games.jobStatus.failed": "Failed",
			"games.title": "Games",
			"games.empty": "No games added yet",
			"games.emptyHint": "Add a game first, then open it to download versions, install instances and manage content.",
			"games.emptyActionAdd": "Add game",
			"games.capContent": "Content",
			"games.capLoaders": "Loaders",
			"games.capRuntimes": "Runtimes",
			"games.open": "Open",
			"games.source": "Source: {source}",
			"detail.back": "Back to games",
			"detail.versions": "Versions",
			"detail.versionsHint": "Pick a version to create an instance of this game.",
			"detail.versionsLoading": "Loading versions…",
			"detail.versionsEmpty": "No versions available for this game",
			"detail.refreshVersions": "Refresh versions",
			"detail.install": "Download and install",
			"detail.installTitle": "Install options",
			"detail.name": "Instance name",
			"detail.namePh": "Leave empty to auto-name",
			"detail.options": "Additional options",
			"detail.optionsHint": "These options are defined by the game adapter.",
			"detail.contentHint": "Optional: add content during installation.",
			"detail.contentSearchPh": "Search content…",
			"detail.contentEmpty": "No results",
			"detail.contentPicked": "{count} content item(s) selected",
			"detail.submit": "Install",
			"detail.submitting": "Installing…",
			"detail.needVersion": "Pick a version first",
			"detail.instances": "Instances",
			"detail.instancesHint": "Instances of this game; launch, logs and folders live here.",
			"detail.noInstances": "No instances yet. Download a version above first.",
			"detail.content": "Content",
			"detail.contentInstance": "Instance",
			"detail.instanceSelect": "Select an instance to manage its content",
			"detail.installed": "Installed content",
			"detail.installedEmpty": "This instance has no content yet",
			"detail.removeContent": "Remove",
			"detail.addContent": "Add selected content",
			"detail.adding": "Adding…",
			"detail.removeConfirm": "Remove content \"{name}\"?",
			"detail.capabilityContent": "This game supports content management",
			"instance.status.new": "New",
			"instance.status.installing": "Installing",
			"instance.status.ready": "Ready",
			"instance.status.error": "Install failed",
			"instance.running": "Running",
			"instance.version": "Version",
			"instance.contentCount": "{count} content item(s)",
			"instance.lastLaunch": "Last launch",
			"instance.neverLaunched": "Never launched",
			"instance.playCount": "Launched {count} time(s)",
			"instance.launch": "Launch",
			"instance.launching": "Launching…",
			"instance.stop": "Stop",
			"instance.stopping": "Stopping…",
			"instance.stopConfirmHint": "Stop instance \"{name}\"?",
			"instance.confirmStop": "Confirm stop",
			"instance.log": "Logs",
			"instance.hideLog": "Hide logs",
			"instance.logLoading": "Loading logs…",
			"instance.logEmpty": "No logs",
			"instance.logRefresh": "Refresh logs",
			"instance.logsFolder": "Logs folder",
			"instance.openGame": "Open game folder",
			"instance.openContent": "Open content folder",
			"instance.delete": "Delete",
			"instance.deleteHint": "Deleting an instance removes its game files and content permanently.",
			"instance.deleteConfirm": "Delete instance \"{name}\"?",
			"instance.installError": "Install error: {error}",
			"instance.activeJobs": "Active tasks",
			"instance.job": "Task",
			"addGame.title": "Add game",
			"addGame.subtitle": "Bring in a game from code-hosting releases, a URL manifest, or an already installed local folder; save it, then open it to download versions.",
			"addGame.provider": "Source type",
			"addGame.providerGithub": "Code hosting releases",
			"addGame.providerUrl": "URL manifest",
			"addGame.providerManual": "Manual import",
			"addGame.providerHint": "Fill in the configuration for the chosen source type; test the connection before saving.",
			"addGame.label": "Display name",
			"addGame.labelPh": "For example: Example Game",
			"addGame.id": "Game id",
			"addGame.idPh": "Leave empty to derive from the name",
			"addGame.idHint": "Lowercase letters, digits and hyphens; used for instance folders and config files.",
			"addGame.repo": "Repository",
			"addGame.repoPh": "owner/name",
			"addGame.repoHint": "Release list and assets are read from this repository.",
			"addGame.assetPattern": "Asset pattern",
			"addGame.assetPatternPh": "Optional regex, e.g. windows.*[.]zip",
			"addGame.executable": "Executable",
			"addGame.executablePh": "For example game.exe",
			"addGame.args": "Launch arguments",
			"addGame.argsPh": "One argument per line, or space separated",
			"addGame.argsHint": "Optional; quotes inside arguments are preserved.",
			"addGame.jsonUrl": "Manifest URL",
			"addGame.jsonUrlPh": "https://example.com/versions.json",
			"addGame.versions": "Static versions",
			"addGame.versionsPh": "[{\"id\":\"1.0.0\",\"url\":\"https://example.com/game.zip\"}]",
			"addGame.versionsHint": "JSON array; every item needs at least id and url.",
			"addGame.path": "Install folder",
			"addGame.pathPh": "For example D:/Games/MyGame",
			"addGame.pathHint": "Points to an already installed game folder.",
			"addGame.test": "Test connection",
			"addGame.testing": "Testing…",
			"addGame.testOk": "Connection OK",
			"addGame.testFail": "Connection failed",
			"addGame.testHint": "Test once before saving to catch configuration problems early.",
			"addGame.save": "Save game",
			"addGame.saving": "Saving…",
			"addGame.needLabel": "Please enter a display name",
			"addGame.needRepo": "Please enter the repository (owner/name)",
			"addGame.needSource": "Please enter a manifest URL or a static version list",
			"addGame.needPath": "Please enter the install folder",
			"addGame.needExecutable": "Please enter the executable file (for example game.exe)",
			"addGame.invalidVersions": "The static version list must be a JSON array",
			"addGame.added": "Added games",
			"addGame.addedEmpty": "No games added from the panel yet",
			"addGame.addedHint": "Games provided by built-in and external adapters cannot be deleted here.",
			"addGame.delete": "Delete",
			"addGame.deleteConfirm": "Delete game \"{name}\"?",
			"addGame.deleteHint": "Only the game definition is deleted; installed instances are kept.",
			"addGame.source.user": "User added",
			"addGame.source.external": "External adapter",
			"addGame.source.builtin": "Built-in",
			"addGame.providerType": "Source",
			"addGame.versionLabel": "Version",
			"addGame.contentLabel": "Content",
			"addGame.instancesCount": "Instances",
			"settings.title": "Settings",
			"settings.dataRoot": "Data directory",
			"settings.dataRootHint": "Configuration, game definitions and instances live here (read-only).",
			"settings.concurrency": "Download concurrency",
			"settings.concurrencyHint": "Simultaneous downloads, 1–32; lower it on slow networks.",
			"settings.retries": "Retries",
			"settings.retriesHint": "Retries after a failed download, 0–10.",
			"settings.stats": "Stats",
			"settings.save": "Save settings",
			"settings.saving": "Saving…",
			"settings.invalidConcurrency": "Download concurrency must be an integer between 1 and 32",
			"settings.invalidRetries": "Retries must be an integer between 0 and 10",
			"tab.sublaunchers": "Sub-launchers",
			"sublauncher.title": "Sub-launchers",
			"sublauncher.subtitle": "Sub-launchers are separate projects; this launcher core contains no games. After installing from a GitHub Release or a zip URL, games appear automatically on the Games page.",
			"sublauncher.installTitle": "Install a sub-launcher",
			"sublauncher.installHint": "Supports GitHub repositories, zip URLs and local files; games appear automatically on the Games page after installation.",
			"sublauncher.sourceType": "Source type",
			"sublauncher.sourceType.github": "GitHub repository",
			"sublauncher.sourceType.url": "zip URL",
			"sublauncher.sourceType.file": "Local file path",
			"sublauncher.repo": "GitHub repository",
			"sublauncher.repoPh": "owner/name",
			"sublauncher.repoHint": "The repository release must contain a zip asset.",
			"sublauncher.url": "zip URL",
			"sublauncher.urlPh": "https://example.com/launcher.zip",
			"sublauncher.urlHint": "Direct download URL of the zip package.",
			"sublauncher.file": "Local file path",
			"sublauncher.filePh": "D:/downloads/launcher.zip",
			"sublauncher.fileHint": "Path of a local zip package.",
			"sublauncher.advanced": "Advanced options",
			"sublauncher.advancedHide": "Hide advanced options",
			"sublauncher.assetPattern": "Asset pattern",
			"sublauncher.assetPatternPh": "for example launcher-*.zip",
			"sublauncher.assetPatternHint": "Picks a zip asset from the release; the first zip is used when empty.",
			"sublauncher.install": "Install",
			"sublauncher.installing": "Installing…",
			"sublauncher.installStarted": "Sub-launcher installation started",
			"sublauncher.needSource": "Please enter a repository, zip URL or local file path",
			"sublauncher.installProgress": "Install progress",
			"sublauncher.updateProgress": "Update progress",
			"sublauncher.installed": "Installed sub-launchers",
			"sublauncher.empty": "No sub-launchers installed yet. Install one from a GitHub repository or zip URL (for example the official sub-launcher project of a game).",
			"sublauncher.loading": "Loading sub-launchers…",
			"sublauncher.source": "Source",
			"sublauncher.source.repo": "GitHub repository",
			"sublauncher.source.url": "zip URL",
			"sublauncher.source.file": "Local file",
			"sublauncher.version": "Version {version}",
			"sublauncher.gamesCount": "Provides {count} games",
			"sublauncher.updateAvailable": "Update available",
			"sublauncher.upToDate": "Already up to date",
			"sublauncher.check": "Check for updates",
			"sublauncher.checking": "Checking…",
			"sublauncher.update": "Update",
			"sublauncher.updating": "Updating…",
			"sublauncher.updateStarted": "Sub-launcher update started",
			"sublauncher.delete": "Delete",
			"sublauncher.deleteConfirm": "Delete sub-launcher \"{name}\"?",
			"sublauncher.deleteHint": "Its games disappear from the Games page; installed instance files are kept.",
			"sublauncher.deleted": "Sub-launcher deleted",
			"catalog.title": "Recommended catalog",
			"catalog.hint": "Install sub-launchers from the recommended catalog; games appear on the Games page once installed.",
			"catalog.refresh": "Refresh catalog",
			"catalog.loading": "Loading catalog…",
			"catalog.empty": "No sub-launchers in the catalog yet",
			"catalog.emptyHint": "You can still install manually with the form below.",
			"catalog.error": "Failed to load catalog: {error}",
			"catalog.install": "Install",
			"catalog.installing": "Installing…",
			"catalog.installed": "Installed",
			"catalog.update": "Update",
			"catalog.updating": "Updating…",
			"catalog.updateAvailable": "Update available",
			"catalog.needSource": "This entry has no install source; please enter a repository or URL manually.",
			"catalog.description": "Description",
			"catalog.manualHint": "If the catalog fails to load or is empty, you can still install with a repository / URL / local file below.",
		};

		// ------------------------------------------------------------------
		// 通用小工具：文本兜底、品牌净化、格式化、请求封装。
		// ------------------------------------------------------------------
		function browserDict() {
			const language = typeof navigator !== "undefined" && navigator && navigator.language ? String(navigator.language) : "";
			return language.toLowerCase().indexOf("zh") === 0 ? DICT_ZH : DICT_EN;
		}

		function makeT(externalT) {
			const local = browserDict();
			return function t(key, params) {
				let text = "";
				if (typeof externalT === "function") {
					try {
						const external = externalT(key, params);
						if (typeof external === "string" && external && external !== key) text = external;
					} catch (error) {
						text = "";
					}
				}
				if (!text) text = local[key] || DICT_ZH[key] || key;
				if (params && typeof params === "object") {
					text = text.replace(/\{([a-zA-Z0-9_]+)\}/g, (match, name) => {
						const value = params[name];
						return value === undefined || value === null ? match : scalarText(value, "");
					});
				}
				return brandSafe(text);
			};
		}

		function scalarText(value, fallback) {
			if (value === undefined || value === null || value === "") return fallback === undefined ? "" : fallback;
			if (typeof value === "string") return value;
			if (typeof value === "number" || typeof value === "boolean") return String(value);
			if (typeof value === "object") {
				const keys = ["id", "name", "title", "label", "release", "version", "filename", "slug", "value", "text"];
				for (let index = 0; index < keys.length; index += 1) {
					const candidate = value[keys[index]];
					if (typeof candidate === "string" && candidate) return candidate;
					if (typeof candidate === "number" || typeof candidate === "boolean") return String(candidate);
				}
				return fallback === undefined ? "" : fallback;
			}
			return fallback === undefined ? "" : fallback;
		}

		const BRAND_RULES = [
			[new RegExp(String.fromCharCode(25105, 30340, 19990, 30028), "g"), "游戏"],
			[new RegExp(String.fromCharCode(109, 105, 110, 101, 99, 114, 97, 102, 116), "gi"), "游戏"],
			[new RegExp(String.fromCharCode(109, 111, 106, 97, 110, 103), "gi"), "官方"],
			[new RegExp(String.fromCharCode(109, 99) + "Version", "gi"), "游戏版本号"],
			[new RegExp("\\b" + String.fromCharCode(109, 99) + "\\b", "gi"), "游戏"],
		];

		function brandSafe(text) {
			if (text === undefined || text === null) return "";
			let out = String(text);
			for (let index = 0; index < BRAND_RULES.length; index += 1) {
				out = out.replace(BRAND_RULES[index][0], BRAND_RULES[index][1]);
			}
			return out;
		}

		function fmtBytes(bytes) {
			const value = Number(bytes);
			if (!isFinite(value) || value <= 0) return "-";
			const units = ["B", "KB", "MB", "GB", "TB"];
			let size = value;
			let unit = 0;
			while (size >= 1024 && unit < units.length - 1) {
				size = size / 1024;
				unit += 1;
			}
			return (size >= 100 || unit === 0 ? Math.round(size) : size.toFixed(1)) + " " + units[unit];
		}

		function fmtTime(iso) {
			const text = scalarText(iso, "");
			if (!text) return "";
			const date = new Date(text);
			if (isNaN(date.getTime())) return text;
			const pad = (value) => (value < 10 ? "0" + value : String(value));
			return date.getFullYear() + "-" + pad(date.getMonth() + 1) + "-" + pad(date.getDate()) + " " + pad(date.getHours()) + ":" + pad(date.getMinutes());
		}

		function clampNumber(value, min, max, fallback) {
			const number = Number(value);
			if (!isFinite(number)) return fallback;
			return Math.min(max, Math.max(min, Math.round(number)));
		}

		function errText(t, error) {
			const message = error && error.message !== undefined ? error.message : error;
			return brandSafe(scalarText(message, "未知错误"));
		}

		function jobActive(job) {
			return !!job && (job.status === "queued" || job.status === "running");
		}

		function jobStatusKey(job) {
			const status = job && job.status ? String(job.status) : "";
			if (status === "queued" || status === "running" || status === "succeeded" || status === "failed") return status;
			return "";
		}

		function jobStatusLabel(t, job) {
			const key = jobStatusKey(job);
			return key ? t("games.jobStatus." + key) : "";
		}

		function jobPercent(job) {
			const progress = job && job.progress ? job.progress : null;
			const done = progress && isFinite(Number(progress.done)) ? Number(progress.done) : NaN;
			const total = progress && isFinite(Number(progress.total)) ? Number(progress.total) : NaN;
			if (!isFinite(done) || !isFinite(total) || total <= 0) return -1;
			return Math.max(0, Math.min(100, Math.round((done / total) * 100)));
		}

		function gameById(games, id) {
			const list = Array.isArray(games) ? games : [];
			const wanted = scalarText(id, "");
			for (let index = 0; index < list.length; index += 1) {
				if (scalarText(list[index] && list[index].id, "") === wanted) return list[index];
			}
			return null;
		}

		function gameLabelOf(game) {
			return brandSafe(scalarText(game && (game.label || game.name || game.id), "未命名游戏"));
		}

		function instanceName(instance) {
			return brandSafe(scalarText(instance && (instance.name || instance.id), "未命名实例"));
		}

		function instanceVersion(instance) {
			return brandSafe(scalarText(instance && (instance.versionId || instance.version), "-"));
		}

		function instanceContentCount(instance) {
			if (instance && instance.contentCount !== undefined) {
				const count = Number(instance.contentCount);
				if (isFinite(count) && count >= 0) return count;
			}
			if (instance && Array.isArray(instance.content)) return instance.content.length;
			return 0;
		}

		function supportsContent(game) {
			const capabilities = game && game.capabilities ? game.capabilities : null;
			return !!(capabilities && capabilities.content);
		}

		function sourceKey(game) {
			const source = scalarText(game && game.source, "external");
			if (source === "user" || source === "external" || source === "builtin") return source;
			return "external";
		}

		function gameSourceLabel(t, game) {
			return t("addGame.source." + sourceKey(game));
		}

		function capabilityLabels(t, game) {
			const capabilities = game && game.capabilities ? game.capabilities : {};
			const labels = [];
			if (capabilities.content) labels.push(t("games.capContent"));
			if (capabilities.loaders) labels.push(t("games.capLoaders"));
			if (capabilities.runtimes) labels.push(t("games.capRuntimes"));
			return labels;
		}

		function versionOptions(versionsData) {
			const data = versionsData && typeof versionsData === "object" ? versionsData : {};
			const list = Array.isArray(data.releases) ? data.releases : Array.isArray(data.versions) ? data.versions : [];
			const options = [];
			const seen = {};
			for (let index = 0; index < list.length; index += 1) {
				const item = list[index];
				const id = scalarText(item && (item.id || item.version), "");
				if (!id || seen[id]) continue;
				seen[id] = true;
				options.push({ id: id, label: brandSafe(scalarText(item && (item.label || item.name), id)) });
			}
			return options;
		}

		function defaultVersionOf(versionsData) {
			const data = versionsData && typeof versionsData === "object" ? versionsData : {};
			const latest = scalarText(data.latestRelease, "");
			if (latest) return latest;
			const latestRelease = data.latestRelease && typeof data.latestRelease === "object" ? data.latestRelease : null;
			if (latestRelease) return scalarText(latestRelease.id || latestRelease.version, "");
			if (data.latest && typeof data.latest === "object") return scalarText(data.latest.id || data.latest.version, "");
			const options = versionOptions(data);
			return options.length ? options[0].id : "";
		}

		function contentKey(entry) {
			return scalarText(entry && (entry.filename || entry.name || entry.title || entry.slug || entry.projectId), "");
		}

		function contentFilename(entry) {
			return scalarText(entry && (entry.filename || entry.name), "");
		}

		function contentSize(entry) {
			const size = Number(entry && entry.size);
			return isFinite(size) && size > 0 ? fmtBytes(size) : "";
		}

		function hitRef(hit) {
			const item = hit && typeof hit === "object" ? hit : {};
			if (item.slug) return { slug: scalarText(item.slug, "") };
			if (item.projectId) return { projectId: scalarText(item.projectId, "") };
			if (item.id !== undefined && item.id !== null) return { projectId: scalarText(item.id, "") };
			return { slug: scalarText(item, "") };
		}

		function hitKey(hit) {
			const ref = hitRef(hit);
			return ref.slug ? "slug:" + ref.slug : "project:" + scalarText(ref.projectId, "");
		}

		function hitTitle(hit) {
			return brandSafe(scalarText(hit && (hit.title || hit.name || hit.slug || hit.projectId), "内容"));
		}

		function hitDesc(hit) {
			return brandSafe(scalarText(hit && (hit.description || hit.summary), ""));
		}

		function detailText(detail) {
			return brandSafe(scalarText(detail && (detail.detail || detail.message || detail.note || detail.error), ""));
		}

		function jobKindLabel(t, job) {
			const kind = scalarText(job && job.kind, "");
			if (kind === "install" || kind === "launch" || kind === "content") return t("jobs.kind." + kind);
			if (kind === "sublauncher-install") return t("jobs.kind.sublauncherInstall");
			if (kind === "sublauncher-update") return t("jobs.kind.sublauncherUpdate");
			return brandSafe(scalarText(job && job.title, ""));
		}

		function configConcurrency(config) {
			const value = Number(config && config.downloadConcurrency);
			return isFinite(value) && value >= 1 ? Math.round(value) : 16;
		}

		function configRetries(config) {
			const value = Number(config && config.retries);
			return isFinite(value) && value >= 0 ? Math.round(value) : 3;
		}

		function optionChoices(option) {
			const choices = option && Array.isArray(option.choices) ? option.choices : [];
			return choices.map((choice) => {
				if (choice && typeof choice === "object") {
					const value = scalarText(choice.value !== undefined ? choice.value : choice.id, "");
					return { value: value, label: brandSafe(scalarText(choice.label || choice.name || value, value)) };
				}
				return { value: scalarText(choice, ""), label: scalarText(choice, "") };
			});
		}

		function optionDefault(option) {
			if (!option) return "";
			const value = option.default;
			if (value === undefined || value === null) return "";
			if (typeof value === "boolean") return value ? "true" : "false";
			return scalarText(value, "");
		}

		function optionDraftValue(option, draft) {
			const bag = draft && typeof draft === "object" ? draft : {};
			const key = scalarText(option && option.key, "");
			if (key && bag[key] !== undefined && bag[key] !== null) return bag[key];
			return optionDefault(option);
		}

		function optionValueForSubmit(option, draft) {
			const value = optionDraftValue(option, draft);
			const type = scalarText(option && option.type, "string");
			if (type === "boolean") return value === true || value === "true";
			if (type === "number") {
				const number = Number(value);
				return isFinite(number) ? number : undefined;
			}
			const text = scalarText(value, "").trim();
			return text === "" ? undefined : text;
		}

		function parseArgsText(text) {
			const raw = scalarText(text, "").trim();
			if (!raw) return [];
			const lines = raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
			if (lines.length > 1) return lines;
			const single = lines[0] || "";
			const matches = single.match(/"[^"]*"|'[^']*'|\S+/g) || [];
			return matches.map((item) => (/^["']/.test(item) ? item.slice(1, -1) : item));
		}

		function providerLabel(t, provider) {
			const id = scalarText(provider, "");
			if (id === "github") return t("addGame.providerGithub");
			if (id === "url") return t("addGame.providerUrl");
			if (id === "manual") return t("addGame.providerManual");
			return brandSafe(id || t("common.none"));
		}

		function subLauncherId(launcher) {
			return scalarText(launcher && launcher.id, "");
		}

		function subLauncherLabel(launcher) {
			return brandSafe(scalarText(launcher && (launcher.label || launcher.name || launcher.id), "-"));
		}

		function subLauncherVersion(launcher) {
			return brandSafe(scalarText(launcher && (launcher.version || launcher.installedVersion), "-"));
		}

		function subLauncherSourceText(t, launcher) {
			const repo = brandSafe(scalarText(launcher && launcher.repo, ""));
			if (repo) return t("sublauncher.source.repo") + "：" + repo;
			const url = brandSafe(scalarText(launcher && launcher.url, ""));
			if (url) return t("sublauncher.source.url") + "：" + url;
			const file = brandSafe(scalarText(launcher && launcher.file, ""));
			if (file) return t("sublauncher.source.file") + "：" + file;
			const source = scalarText(launcher && launcher.source, "");
			if (source === "github") return t("sublauncher.source.repo");
			if (source === "url") return t("sublauncher.source.url");
			if (source === "file") return t("sublauncher.source.file");
			return brandSafe(source);
		}

		function subLauncherGamesCount(launcher) {
			const games = launcher && Array.isArray(launcher.games) ? launcher.games : [];
			return games.length;
		}

		function instanceLoaderType(instance) {
			const loader = instance && instance.loader;
			if (loader && typeof loader === "object") return brandSafe(scalarText(loader.type || loader.id || loader.name, ""));
			return brandSafe(scalarText(loader, ""));
		}

		function contentListOf(detail) {
			if (!detail || typeof detail !== "object") return [];
			const instance = detail.instance && typeof detail.instance === "object" ? detail.instance : null;
			if (instance && Array.isArray(instance.content)) return instance.content;
			if (Array.isArray(detail.content)) return detail.content;
			return [];
		}

		// ------------------------------------------------------------------
		// HTTP：所有接口统一返回 {ok:true,data} 或 {ok:false,error}。
		// ------------------------------------------------------------------
		async function request(path, options) {
			const init = Object.assign({ method: "GET", headers: {} }, options || {});
			if (init.body !== undefined && init.body !== null) {
				init.headers = Object.assign({ "Content-Type": "application/json" }, init.headers || {});
				init.body = JSON.stringify(init.body);
			}
			const response = await fetch(API + path, init);
			const raw = await response.text();
			let payload = null;
			if (raw) {
				try {
					payload = JSON.parse(raw);
				} catch (error) {
					payload = null;
				}
			}
			if (!response.ok || (payload && payload.ok === false)) {
				const message = payload && payload.error ? String(payload.error) : "HTTP " + response.status + (raw ? "：" + raw : "");
				throw new Error(message);
			}
			if (payload && payload.ok === true) return payload.data;
			return payload;
		}

		function get(path) {
			return request(path, { method: "GET" });
		}

		function post(path, body) {
			return request(path, { method: "POST", body: body === undefined ? {} : body });
		}

		function del(path) {
			return request(path, { method: "DELETE" });
		}

		function instancePath(id, suffix) {
			return "/instances/" + encodeURIComponent(scalarText(id, "")) + (suffix || "");
		}

		// ------------------------------------------------------------------
		// 样式：只使用 DSH 主题变量，颜色全部给出兜底值。
		// ------------------------------------------------------------------
		function installStyles() {
			if (typeof document === "undefined" || !document || !document.createElement) return () => {};
			if (document.getElementById && document.getElementById(CSS_TAG_ID)) return () => {};
			const style = document.createElement("style");
			style.id = CSS_TAG_ID;
			style.textContent = [
				".dsl_entry{display:inline-flex;align-items:center;gap:6px;width:100%;border:0;background:transparent;color:var(--dsw-alias-label-secondary,var(--dsw-alias-text-secondary,#a8b0bd));font:inherit;font-size:13px;padding:8px 10px;border-radius:var(--dsw-radius-md,8px);cursor:pointer;text-align:left}",
				".dsl_entry:hover{background:var(--dsw-alias-interactive-bg-hover,var(--dsw-alias-bg-layer-2,#23262d));color:var(--dsw-alias-label-primary,var(--dsw-alias-text-primary,#e8eaed))}",
				".dsl_entry_icon{font-size:11px;opacity:.8}",
				".dsl_layer{position:fixed;inset:0;z-index:4000;display:flex;align-items:center;justify-content:center;background:var(--dsw-alias-bg-mask-1,rgba(0,0,0,.45));padding:24px}",
				".dsl_panel{display:flex;flex-direction:column;width:min(1180px,94vw);height:min(820px,90vh);background:var(--dsw-alias-bg-layer-1,var(--dsw-alias-bg-module-platform,#17191e));color:var(--dsw-alias-label-primary,var(--dsw-alias-text-primary,#e8eaed));border:1px solid var(--dsw-alias-border-l2,var(--dsw-alias-border-level-2,#2c3038));border-radius:var(--dsw-radius-lg,12px);box-shadow:var(--dsw-elevation-panel,0 20px 60px rgba(0,0,0,.5));overflow:hidden}",
				".dsl_head{display:flex;align-items:flex-start;gap:12px;padding:16px 18px 10px;border-bottom:1px solid var(--dsw-alias-border-l2,var(--dsw-alias-border-level-2,#2c3038))}",
				".dsl_head_main{display:flex;flex-direction:column;gap:2px;min-width:0;flex:1}",
				".dsl_title{font-size:16px;font-weight:600;line-height:1.3}",
				".dsl_dataRoot{font-size:11px;color:var(--dsw-alias-label-tertiary,var(--dsw-alias-text-tertiary,#7d8590));word-break:break-all}",
				".dsl_head_actions{display:flex;gap:6px;flex-shrink:0}",
				".dsl_tabs{display:flex;gap:4px;padding:8px 18px 0;border-bottom:1px solid var(--dsw-alias-border-l2,var(--dsw-alias-border-level-2,#2c3038))}",
				".dsl_tab{border:0;background:transparent;color:var(--dsw-alias-label-secondary,var(--dsw-alias-text-secondary,#a8b0bd));font:inherit;font-size:13px;padding:8px 12px;border-radius:var(--dsw-radius-md,8px) var(--dsw-radius-md,8px) 0 0;cursor:pointer}",
				".dsl_tab:hover{color:var(--dsw-alias-label-primary,var(--dsw-alias-text-primary,#e8eaed))}",
				".dsl_tab[aria-selected=\"true\"]{color:var(--dsw-alias-brand-primary,var(--dsw-alias-label-primary,#4c8dff));border-bottom:2px solid var(--dsw-alias-brand-primary,var(--dsw-alias-label-primary,#4c8dff));margin-bottom:-1px}",
				".dsl_body{flex:1;overflow:auto;padding:16px 18px;display:flex;flex-direction:column;gap:16px}",
				".dsl_banner{display:flex;align-items:center;gap:10px;margin:10px 18px 0;padding:8px 12px;border-radius:var(--dsw-radius-md,8px);background:var(--dsw-alias-state-error-secondary,rgba(255,86,86,.12));color:var(--dsw-alias-state-error-primary,#ff6b6b);font-size:12px}",
				".dsl_banner span{flex:1;min-width:0;word-break:break-word}",
				".dsl_footer{display:flex;align-items:center;gap:12px;padding:10px 18px;border-top:1px solid var(--dsw-alias-border-l2,var(--dsw-alias-border-level-2,#2c3038));font-size:11px;color:var(--dsw-alias-label-tertiary,var(--dsw-alias-text-tertiary,#7d8590))}",
				".dsl_footer_spacer{flex:1}",
				".dsl_toasts{position:absolute;right:20px;bottom:64px;display:flex;flex-direction:column;gap:8px;max-width:420px;z-index:2}",
				".dsl_toast{padding:9px 12px;border-radius:var(--dsw-radius-md,8px);background:var(--dsw-alias-toast-bg,var(--dsw-alias-bg-layer-3,#2a2e36));color:var(--dsw-alias-toast-label,var(--dsw-alias-label-primary,#e8eaed));font-size:12px;box-shadow:var(--dsw-elevation-prominent,0 6px 24px rgba(0,0,0,.35));word-break:break-word}",
				".dsl_section{display:flex;flex-direction:column;gap:10px}",
				".dsl_section_title{font-size:13px;font-weight:600;display:flex;align-items:center;gap:8px}",
				".dsl_section_hint{font-size:11px;color:var(--dsw-alias-label-tertiary,var(--dsw-alias-text-tertiary,#7d8590))}",
				".dsl_empty{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;padding:36px 16px;text-align:center;border:1px dashed var(--dsw-alias-border-l3,var(--dsw-alias-border-level-3,#3a3f49));border-radius:var(--dsw-radius-lg,12px)}",
				".dsl_empty_title{font-size:14px;font-weight:600}",
				".dsl_empty_hint{font-size:12px;color:var(--dsw-alias-label-secondary,var(--dsw-alias-text-secondary,#a8b0bd));max-width:560px;line-height:1.6}",
				".dsl_cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:12px}",
				".dsl_card{border:1px solid var(--dsw-alias-border-l2,var(--dsw-alias-border-level-2,#2c3038));border-radius:var(--dsw-radius-lg,12px);background:var(--dsw-alias-bg-layer-2,var(--dsw-alias-bg-layer-1,#1d2026));padding:12px 14px;display:flex;flex-direction:column;gap:10px;min-width:0}",
				".dsl_card_head{display:flex;align-items:center;gap:8px;min-width:0}",
				".dsl_card_name{font-size:14px;font-weight:600;flex:1;min-width:0;word-break:break-word}",
				".dsl_card_meta{display:flex;flex-wrap:wrap;gap:4px 14px;font-size:11px;color:var(--dsw-alias-label-secondary,var(--dsw-alias-text-secondary,#a8b0bd))}",
				".dsl_gamecard{cursor:pointer;transition:border-color .15s,background .15s;outline:none}",
				".dsl_gamecard:hover{border-color:var(--dsw-alias-brand-primary,var(--dsw-alias-label-primary,#4c8dff));background:var(--dsw-alias-bg-layer-3,var(--dsw-alias-bg-layer-2,#252a33))}",
				".dsl_gamecard:focus-visible{border-color:var(--dsw-alias-brand-primary,var(--dsw-alias-label-primary,#4c8dff));box-shadow:0 0 0 2px var(--dsw-alias-brand-primary,rgba(76,141,255,.4))}",
				".dsl_caps{display:flex;flex-wrap:wrap;gap:6px}",
				".dsl_cap{font-size:10px;padding:2px 7px;border-radius:999px;border:1px solid var(--dsw-alias-border-l3,var(--dsw-alias-border-level-3,#3a3f49));color:var(--dsw-alias-label-secondary,var(--dsw-alias-text-secondary,#a8b0bd))}",
				".dsl_badge{font-size:10px;padding:2px 7px;border-radius:999px;border:1px solid transparent;white-space:nowrap}",
				".dsl_badge[data-tone=\"on\"]{background:var(--dsw-alias-state-success-tertiary,rgba(64,196,120,.15));color:var(--dsw-alias-state-success-primary,#43c47a)}",
				".dsl_badge[data-tone=\"warn\"]{background:var(--dsw-alias-state-warn-tertiary,rgba(233,178,64,.15));color:var(--dsw-alias-state-warn-primary,#e9b240)}",
				".dsl_badge[data-tone=\"error\"]{background:var(--dsw-alias-state-error-secondary,rgba(255,86,86,.15));color:var(--dsw-alias-state-error-primary,#ff6b6b)}",
				".dsl_badge[data-tone=\"info\"]{background:var(--dsw-alias-bg-layer-3,var(--dsw-alias-bg-layer-2,#252a33));color:var(--dsw-alias-label-secondary,var(--dsw-alias-text-secondary,#a8b0bd))}",
				".dsl_row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}",
				".dsl_detail_head{display:flex;align-items:center;gap:10px;flex-wrap:wrap}",
				".dsl_detail_title{font-size:15px;font-weight:600;min-width:0;word-break:break-word}",
				".dsl_detail_source{font-size:11px;color:var(--dsw-alias-label-tertiary,var(--dsw-alias-text-tertiary,#7d8590))}",
				".dsl_btn{border:1px solid var(--dsw-alias-border-l2,var(--dsw-alias-border-level-2,#2c3038));background:var(--dsw-alias-bg-layer-2,var(--dsw-alias-bg-layer-1,#1d2026));color:var(--dsw-alias-label-primary,var(--dsw-alias-text-primary,#e8eaed));font:inherit;font-size:12px;padding:5px 11px;border-radius:var(--dsw-radius-md,8px);cursor:pointer;white-space:nowrap}",
				".dsl_btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,var(--dsw-alias-bg-layer-3,#252a33))}",
				".dsl_btn:disabled{opacity:.45;cursor:not-allowed}",
				".dsl_btn[data-variant=\"primary\"]{background:var(--dsw-alias-brand-primary,var(--dsw-alias-label-primary,#4c8dff));border-color:transparent;color:var(--dsw-alias-label-primary-foreground,var(--dsw-alias-text-on-brand,#fff))}",
				".dsl_btn[data-variant=\"danger\"]{background:var(--dsw-alias-state-error-primary,#ff6b6b);border-color:transparent;color:var(--dsw-alias-label-primary-foreground,var(--dsw-alias-text-on-brand,#fff))}",
				".dsl_btn[data-variant=\"ghost\"]{background:transparent}",
				".dsl_confirm{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:8px 10px;border-radius:var(--dsw-radius-md,8px);background:var(--dsw-alias-state-warn-tertiary,rgba(233,178,64,.12));color:var(--dsw-alias-state-warn-primary,#e9b240);font-size:12px}",
				".dsl_confirm_text{flex:1;min-width:200px}",
				".dsl_log{margin:0;max-height:220px;overflow:auto;background:var(--dsw-alias-bg-layer-3,var(--dsw-alias-bg-layer-2,#121418));border-radius:var(--dsw-radius-md,8px);padding:8px 10px;font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:11px;line-height:1.5;color:var(--dsw-alias-label-secondary,var(--dsw-alias-text-secondary,#a8b0bd));white-space:pre-wrap;word-break:break-word}",
				".dsl_grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px}",
				".dsl_field{display:flex;flex-direction:column;gap:5px;min-width:0}",
				".dsl_label{font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary,var(--dsw-alias-text-secondary,#a8b0bd))}",
				".dsl_hint{font-size:11px;color:var(--dsw-alias-label-tertiary,var(--dsw-alias-text-tertiary,#7d8590));line-height:1.5}",
				".dsl_input,.dsl_select{border:1px solid var(--dsw-alias-border-l2,var(--dsw-alias-border-level-2,#2c3038));background:var(--dsw-alias-bg-layer-2,var(--dsw-alias-bg-layer-1,#1d2026));color:var(--dsw-alias-label-primary,var(--dsw-alias-text-primary,#e8eaed));font:inherit;font-size:12px;padding:6px 9px;border-radius:var(--dsw-radius-md,8px);min-width:0;width:100%;box-sizing:border-box}",
				".dsl_input:focus,.dsl_select:focus{outline:none;border-color:var(--dsw-alias-brand-primary,var(--dsw-alias-label-primary,#4c8dff))}",
				".dsl_radios{display:flex;flex-wrap:wrap;gap:12px}",
				".dsl_radio{display:inline-flex;align-items:center;gap:6px;font-size:12px;cursor:pointer}",
				".dsl_check{display:flex;align-items:flex-start;gap:8px;padding:6px 8px;border-radius:var(--dsw-radius-md,8px);cursor:pointer}",
				".dsl_check:hover{background:var(--dsw-alias-interactive-bg-hover,var(--dsw-alias-bg-layer-3,#252a33))}",
				".dsl_check_main{display:flex;flex-direction:column;gap:2px;min-width:0}",
				".dsl_check_title{font-size:12px}",
				".dsl_check_desc{font-size:11px;color:var(--dsw-alias-label-tertiary,var(--dsw-alias-text-tertiary,#7d8590))}",
				".dsl_hitlist{display:flex;flex-direction:column;gap:2px;max-height:280px;overflow:auto;border:1px solid var(--dsw-alias-border-l2,var(--dsw-alias-border-level-2,#2c3038));border-radius:var(--dsw-radius-md,8px);padding:4px}",
				".dsl_progress{height:6px;border-radius:999px;background:var(--dsw-alias-bg-layer-3,var(--dsw-alias-bg-layer-2,#121418));overflow:hidden}",
				".dsl_progress_bar{height:100%;background:var(--dsw-alias-brand-primary,var(--dsw-alias-label-primary,#4c8dff));transition:width .2s}",
				".dsl_job{display:flex;flex-direction:column;gap:6px;padding:10px 12px;border:1px solid var(--dsw-alias-border-l2,var(--dsw-alias-border-level-2,#2c3038));border-radius:var(--dsw-radius-lg,12px);background:var(--dsw-alias-bg-layer-2,var(--dsw-alias-bg-layer-1,#1d2026))}",
				".dsl_job_head{display:flex;align-items:center;gap:8px;flex-wrap:wrap}",
				".dsl_job_kind{font-size:12px;font-weight:600}",
				".dsl_job_phase{font-size:11px;color:var(--dsw-alias-label-secondary,var(--dsw-alias-text-secondary,#a8b0bd))}",
				".dsl_job_meta{font-size:11px;color:var(--dsw-alias-label-tertiary,var(--dsw-alias-text-tertiary,#7d8590))}",
				".dsl_list{display:flex;flex-direction:column;gap:6px}",
				".dsl_list_row{display:flex;align-items:center;gap:10px;padding:8px 10px;border:1px solid var(--dsw-alias-border-l2,var(--dsw-alias-border-level-2,#2c3038));border-radius:var(--dsw-radius-md,8px);min-width:0;flex-wrap:wrap}",
				".dsl_list_name{font-size:12px;flex:1;min-width:120px;word-break:break-word}",
				".dsl_list_meta{font-size:11px;color:var(--dsw-alias-label-tertiary,var(--dsw-alias-text-tertiary,#7d8590))}",
				".dsl_meta_item{display:flex;gap:4px;align-items:baseline}",
				".dsl_meta_key{color:var(--dsw-alias-label-tertiary,var(--dsw-alias-text-tertiary,#7d8590))}",
				".dsl_meta_val{color:var(--dsw-alias-label-secondary,var(--dsw-alias-text-secondary,#a8b0bd))}",
				"@media (max-width:720px){.dsl_layer{padding:0}.dsl_panel{width:100vw;height:100vh;border-radius:0}.dsl_grid{grid-template-columns:1fr}.dsl_cards{grid-template-columns:1fr}}",
			].join("\n");
			document.head.appendChild(style);
			return () => {
				if (style && style.parentNode) style.parentNode.removeChild(style);
			};
		}

		// ------------------------------------------------------------------
		// 基础组件。
		// ------------------------------------------------------------------
		function Btn(props) {
			return h(
				"button",
				{
					type: "button",
					className: "dsl_btn",
					"data-variant": props.variant || undefined,
					disabled: !!props.disabled,
					title: props.title || undefined,
					"aria-label": props.label || undefined,
					onClick: props.onClick,
				},
				props.children
			);
		}

		function Badge(props) {
			return h("span", { className: "dsl_badge", "data-tone": props.tone || "info" }, props.children);
		}

		function MetaItem(props) {
			return h(
				"span",
				{ className: "dsl_meta_item", title: props.title || undefined },
				h("span", { className: "dsl_meta_key" }, props.label),
				h("span", { className: "dsl_meta_val" }, props.value === undefined || props.value === null || props.value === "" ? "-" : props.value)
			);
		}

		function Field(props) {
			return h(
				"label",
				{ className: "dsl_field" },
				h("span", { className: "dsl_label" }, props.label),
				props.children,
				props.hint ? h("span", { className: "dsl_hint" }, props.hint) : null
			);
		}

		function Progress(props) {
			const percent = isFinite(Number(props.percent)) ? Math.max(0, Math.min(100, Number(props.percent))) : -1;
			return h(
				"div",
				null,
				h("div", { className: "dsl_progress" }, percent >= 0 ? h("div", { className: "dsl_progress_bar", style: { width: percent + "%" } }) : h("div", { className: "dsl_progress_bar", style: { width: "35%", opacity: 0.5 } })),
				h("div", { className: "dsl_job_meta" }, props.label || "")
			);
		}

		function JobCard(props) {
			const job = props.job && typeof props.job === "object" ? props.job : {};
			const t = makeT(props.t);
			const statusKey = jobStatusKey(job);
			const tone = statusKey === "succeeded" ? "on" : statusKey === "failed" ? "error" : statusKey === "running" ? "warn" : "info";
			const progress = job.progress && typeof job.progress === "object" ? job.progress : {};
			const percent = jobPercent(job);
			const done = Number(progress.done);
			const total = Number(progress.total);
			const bytes = Number(progress.bytes);
			const phase = brandSafe(scalarText(job.phase || job.message || progress.label, ""));
			const title = brandSafe(scalarText(job.title, ""));
			const log = Array.isArray(job.log) ? job.log.slice(-3) : [];
			return h(
				"div",
				{ className: "dsl_job" },
				h(
					"div",
					{ className: "dsl_job_head" },
					h("span", { className: "dsl_job_kind" }, jobKindLabel(t, job) + (title && title !== jobKindLabel(t, job) ? "：" + title : "")),
					statusKey ? h(Badge, { tone: tone }, jobStatusLabel(t, job)) : null,
					phase ? h("span", { className: "dsl_job_phase" }, phase) : null
				),
				percent >= 0
					? h(Progress, {
							percent: percent,
							label:
								t("jobs.progress", { percent: percent }) +
								(isFinite(done) && isFinite(total) && total > 0 ? " · " + done + "/" + total : "") +
								(isFinite(bytes) && bytes > 0 ? " · " + t("jobs.bytes", { bytes: fmtBytes(bytes) }) : ""),
						})
					: null,
				h("div", { className: "dsl_job_meta" }, brandSafe(scalarText(job.error || job.message, ""))),
				log.length ? h("pre", { className: "dsl_log" }, log.map((line, index) => brandSafe(scalarText(line, ""))).join("\n")) : null
			);
		}

		function JobMonitor(props) {
			const t = makeT(props.t);
			const [job, setJob] = react.useState(null);
			const [error, setError] = react.useState("");
			const [cancelling, setCancelling] = react.useState(false);
			const doneRef = react.useRef(false);
			const onDoneRef = react.useRef(props.onDone);
			const toastRef = react.useRef(props.toast);
			react.useEffect(() => {
				onDoneRef.current = props.onDone;
				toastRef.current = props.toast;
			});
			react.useEffect(() => {
				const jobId = scalarText(props.jobId, "");
				if (!jobId) {
					setJob(null);
					setError("");
					return () => {};
				}
				let alive = true;
				let timer = 0;
				const tick = async () => {
					try {
						const data = await get("/jobs/" + encodeURIComponent(jobId));
						if (!alive) return;
						const next = data && data.job ? data.job : data;
						setJob(next && typeof next === "object" ? next : null);
						setError("");
						if (next && (next.status === "succeeded" || next.status === "failed") && !doneRef.current) {
							doneRef.current = true;
							if (typeof onDoneRef.current === "function") onDoneRef.current(next);
						}
					} catch (requestError) {
						if (!alive) return;
						setError(errText(t, requestError));
					}
				};
				tick();
				timer = window.setInterval(tick, JOB_POLL_MS);
				return () => {
					alive = false;
					if (timer) window.clearInterval(timer);
				};
			}, [props.jobId]);
			const cancel = async () => {
				const jobId = scalarText(props.jobId, "");
				if (!jobId || cancelling) return;
				setCancelling(true);
				try {
					await post("/jobs/" + encodeURIComponent(jobId) + "/cancel", {});
					const toast = toastRef.current;
					if (typeof toast === "function") toast(t("jobs.cancelled"));
				} catch (cancelError) {
					const toast = toastRef.current;
					if (typeof toast === "function") toast(t("toast.failed", { error: errText(t, cancelError) }));
				}
				setCancelling(false);
			};
			const active = jobActive(job);
			return h(
				"div",
				{ className: "dsl_section" },
				h("div", { className: "dsl_section_title" }, t("instance.job")),
				error ? h("div", { className: "dsl_hint" }, error) : null,
				job ? h(JobCard, { job: job, t: t }) : h("div", { className: "dsl_hint" }, t("common.loading")),
				active ? h(Btn, { onClick: cancel, disabled: cancelling, variant: "ghost" }, cancelling ? t("jobs.cancel") : t("jobs.cancel")) : null
			);
		}

		// ------------------------------------------------------------------
		// 侧栏底栏入口。
		// ------------------------------------------------------------------
		function LauncherEntry(props) {
			const t = react.useMemo(() => makeT(props.t), [props.t]);
			const [open, setOpen] = react.useState(false);
			const close = react.useCallback(() => setOpen(false), []);
			return h(
				react.Fragment,
				null,
				h(
					"button",
					{
						type: "button",
						className: "dsl_entry",
						title: t("entry.open"),
						"aria-label": t("entry.open"),
						"aria-expanded": open ? "true" : "false",
						onClick: () => setOpen((value) => !value),
					},
					h("span", { className: "dsl_entry_icon", "aria-hidden": "true" }, "▶"),
					h("span", null, t("entry.label"))
				),
				open ? h(LauncherPanel, { t: props.t, onClose: close }) : null
			);
		}

		// ------------------------------------------------------------------
		// 面板：头部 / tab / 轮询 / toast / 游戏详情导航。
		// ------------------------------------------------------------------
		function LauncherPanel(props) {
			const t = react.useMemo(() => makeT(props.t), [props.t]);
			const [snapshot, setSnapshot] = react.useState(props.snapshot || null);
			const [stateError, setStateError] = react.useState("");
			const [tab, setTab] = react.useState("games");
			const [toasts, setToasts] = react.useState([]);
			const [lastSync, setLastSync] = react.useState("");
			const [gameId, setGameId] = react.useState("");
			const toastSeq = react.useRef(0);
			const stateErrRef = react.useRef(false);
			const timersRef = react.useRef([]);
			const tRef = react.useRef(t);
			const toastRef = react.useRef(null);
			const onCloseRef = react.useRef(props.onClose);
			const gameIdRef = react.useRef(gameId);
			react.useEffect(() => {
				tRef.current = t;
				onCloseRef.current = props.onClose;
				gameIdRef.current = gameId;
			});
			react.useEffect(() => {
				return () => {
					timersRef.current.forEach((timer) => window.clearTimeout(timer));
					timersRef.current = [];
				};
			}, []);
			const toast = react.useCallback((text) => {
				const message = scalarText(text, "");
				if (!message) return;
				toastSeq.current += 1;
				const id = toastSeq.current;
				setToasts((list) => list.concat({ id: id, text: message }));
				const timer = window.setTimeout(() => {
					setToasts((list) => list.filter((item) => item.id !== id));
				}, 2600);
				timersRef.current.push(timer);
			}, []);
			toastRef.current = toast;
			const pullOnce = react.useCallback(async () => {
				try {
					const data = await get("/state");
					setSnapshot(data && typeof data === "object" ? data : {});
					setLastSync(new Date().toISOString());
					if (stateErrRef.current) {
						stateErrRef.current = false;
						setStateError("");
					}
				} catch (error) {
					if (!stateErrRef.current) {
						stateErrRef.current = true;
						toastRef.current(t("toast.failed", { error: errText(tRef.current, error) }));
					}
					setStateError(errText(tRef.current, error));
				}
			}, []);
			react.useEffect(() => {
				let alive = true;
				let inflight = false;
				const tick = async () => {
					if (!alive || inflight) return;
					inflight = true;
					await pullOnce();
					inflight = false;
				};
				tick();
				const timer = window.setInterval(tick, POLL_MS);
				return () => {
					alive = false;
					window.clearInterval(timer);
				};
			}, [pullOnce]);
			react.useEffect(() => {
				const onKeyDown = (event) => {
					if (!event || event.key !== "Escape") return;
					if (gameIdRef.current) {
						event.stopPropagation();
						setGameId("");
					} else if (typeof onCloseRef.current === "function") {
						onCloseRef.current();
					}
				};
				if (typeof document !== "undefined" && document && document.addEventListener) document.addEventListener("keydown", onKeyDown, true);
				return () => {
					if (typeof document !== "undefined" && document && document.removeEventListener) document.removeEventListener("keydown", onKeyDown, true);
				};
			}, []);
			const close = () => {
				if (typeof props.onClose === "function") props.onClose();
			};
			const data = snapshot && typeof snapshot === "object" ? snapshot : {};
			const games = Array.isArray(data.games) ? data.games : [];
			const instances = Array.isArray(data.instances) ? data.instances : [];
			const jobs = Array.isArray(data.jobs) ? data.jobs : [];
			const config = data.config && typeof data.config === "object" ? data.config : {};
			const dataRoot = brandSafe(scalarText(config.dataRoot, "-"));
			const currentGame = gameById(games, gameId);
			const tabs = [
				{ id: "games", label: t("tab.games") },
				{ id: "sublaunchers", label: t("tab.sublaunchers") },
				{ id: "addGame", label: t("tab.addGame") },
				{ id: "settings", label: t("tab.settings") },
			];
			const selectTab = (id) => {
				setTab(id);
				setGameId("");
			};
			const onCreatedGame = (game) => {
				const id = scalarText(game && (game.id || game.game), scalarText(game, ""));
				refresh();
				setTab("games");
				if (id) setGameId(id);
			};
			const refresh = () => {
				if (typeof pullOnce === "function") pullOnce();
			};
			let body = null;
			if (tab === "addGame") {
				body = h(AddGameTab, { snapshot: data, games: games, t: t, toast: toast, refresh: refresh, onCreated: onCreatedGame });
			} else if (tab === "sublaunchers") {
				body = h(SubLaunchersTab, { snapshot: data, t: t, toast: toast, refresh: refresh });
			} else if (tab === "settings") {
				body = h(SettingsTab, { config: config, snapshot: data, t: t, toast: toast, refresh: refresh });
			} else if (currentGame) {
				body = h(GameDetail, { key: currentGame.id, game: currentGame, games: games, snapshot: data, t: t, toast: toast, refresh: refresh, onBack: () => setGameId("") });
			} else {
				body = h(GameCards, { games: games, instances: instances, t: t, onOpen: (id) => setGameId(id), onAddGame: () => selectTab("addGame") });
			}
			return h(
				"div",
				{ className: "dsl_layer", onClick: (event) => { if (event && event.target === event.currentTarget) close(); } },
				h(
					"div",
					{ className: "dsl_panel", role: "dialog", "aria-modal": "true", "aria-label": t("title") },
					h(
						"div",
						{ className: "dsl_head" },
						h("div", { className: "dsl_head_main" }, h("div", { className: "dsl_title" }, t("title")), h("div", { className: "dsl_dataRoot" }, t("header.dataRoot") + "：" + dataRoot)),
						h(
							"div",
							{ className: "dsl_head_actions" },
							h(Btn, { onClick: refresh, title: t("header.refresh"), label: t("header.refresh") }, t("header.refresh")),
							h(Btn, { onClick: close, title: t("header.close"), label: t("header.close") }, t("header.close"))
						)
					),
					stateError ? h("div", { className: "dsl_banner", role: "alert" }, h("span", null, t("header.stateError", { error: stateError })), h(Btn, { onClick: refresh }, t("common.retry"))) : null,
					h(
						"div",
						{ className: "dsl_tabs", role: "tablist" },
						tabs.map((item) =>
							h(
								"button",
								{
									key: item.id,
									type: "button",
									role: "tab",
									className: "dsl_tab",
									"aria-selected": tab === item.id ? "true" : "false",
									onClick: () => selectTab(item.id),
								},
								item.label
							)
						)
					),
					h("div", { className: "dsl_body" }, body),
					h(
						"div",
						{ className: "dsl_footer" },
						h("span", null, t("footer.hint")),
						h("span", { className: "dsl_footer_spacer" }),
						h("span", null, t("footer.synced", { time: lastSync ? fmtTime(lastSync) : "-" }))
					),
					h("div", { className: "dsl_toasts", "aria-live": "polite" }, toasts.map((item) => h("div", { key: item.id, className: "dsl_toast" }, item.text)))
				)
			);
		}

		// ------------------------------------------------------------------
		// 游戏 tab：游戏卡片列表（点击进入该游戏详情）。
		// ------------------------------------------------------------------
		function GameCards(props) {
			const t = makeT(props.t);
			const games = Array.isArray(props.games) ? props.games : [];
			const instances = Array.isArray(props.instances) ? props.instances : [];
			if (!games.length) {
				return h(
					"div",
					{ className: "dsl_section" },
					h(
						"div",
						{ className: "dsl_empty" },
						h("div", { className: "dsl_empty_title" }, t("games.empty")),
						h("div", { className: "dsl_empty_hint" }, t("games.emptyHint")),
						h(Btn, { variant: "primary", onClick: () => props.onAddGame && props.onAddGame() }, t("games.emptyActionAdd"))
					)
				);
			}
			return h(
				"div",
				{ className: "dsl_section" },
				h("div", { className: "dsl_section_title" }, t("games.title")),
				h(
					"div",
					{ className: "dsl_cards" },
					games.map((game) => {
						const id = scalarText(game && game.id, "");
						const related = instances.filter((instance) => scalarText(instance && instance.game, "") === id);
						const running = related.filter((instance) => instance && instance.running === true).length;
						const caps = capabilityLabels(t, game);
						return h(
							"div",
							{
								key: id || gameLabelOf(game),
								className: "dsl_card dsl_gamecard",
								role: "button",
								tabIndex: 0,
								"aria-label": t("games.open") + " " + gameLabelOf(game),
								onClick: () => props.onOpen && props.onOpen(id),
								onKeyDown: (event) => {
									if (!event) return;
									if (event.key === "Enter" || event.key === " " || event.key === "Spacebar") {
										if (typeof event.preventDefault === "function") event.preventDefault();
										if (props.onOpen) props.onOpen(id);
									}
								},
							},
							h("div", { className: "dsl_card_head" }, h("span", { className: "dsl_card_name" }, gameLabelOf(game)), h(Badge, { tone: sourceKey(game) === "user" ? "on" : "info" }, gameSourceLabel(t, game))),
							h(
								"div",
								{ className: "dsl_card_meta" },
								h("span", null, t("common.instances", { count: related.length })),
								h("span", null, t("common.running", { count: running })),
								game && game.versionLabel ? h("span", null, brandSafe(scalarText(game.versionLabel, ""))) : null
							),
							caps.length ? h("div", { className: "dsl_caps" }, caps.map((cap) => h("span", { key: cap, className: "dsl_cap" }, cap))) : null,
							h("div", { className: "dsl_detail_source" }, t("games.open") + " →")
						);
					})
				)
			);
		}

		// ------------------------------------------------------------------
		// 游戏详情：版本下载安装 / 该游戏的实例 / 内容管理。
		// ------------------------------------------------------------------
		function GameDetail(props) {
			const t = react.useMemo(() => makeT(props.t), [props.t]);
			const game = props.game && typeof props.game === "object" ? props.game : {};
			const gameId = scalarText(game.id, "");
			const snapshot = props.snapshot && typeof props.snapshot === "object" ? props.snapshot : {};
			const instances = Array.isArray(snapshot.instances) ? snapshot.instances : [];
			const jobs = Array.isArray(snapshot.jobs) ? snapshot.jobs : [];
			const myInstances = instances.filter((instance) => scalarText(instance && instance.game, "") === gameId);
			const options = Array.isArray(game.instanceOptions) ? game.instanceOptions : [];
			const [versionsData, setVersionsData] = react.useState(null);
			const [versionsLoading, setVersionsLoading] = react.useState(false);
			const [versionsError, setVersionsError] = react.useState("");
			const [version, setVersion] = react.useState("");
			const [formOpen, setFormOpen] = react.useState(false);
			const [name, setName] = react.useState("");
			const [optionsDraft, setOptionsDraft] = react.useState({});
			const [query, setQuery] = react.useState("");
			const [hits, setHits] = react.useState([]);
			const [searching, setSearching] = react.useState(false);
			const [picked, setPicked] = react.useState([]);
			const [submitting, setSubmitting] = react.useState(false);
			const [jobId, setJobId] = react.useState("");
			const aliveRef = react.useRef(true);
			const tRef = react.useRef(t);
			react.useEffect(() => {
				tRef.current = t;
			});
			react.useEffect(() => {
				aliveRef.current = true;
				return () => {
					aliveRef.current = false;
				};
			}, []);
			const loadVersions = react.useCallback(
				async (force) => {
					if (!gameId) return;
					setVersionsLoading(true);
					setVersionsError("");
					try {
						const data = await get("/versions?game=" + encodeURIComponent(gameId) + (force ? "&force=1" : ""));
						if (!aliveRef.current) return;
						setVersionsData(data && typeof data === "object" ? data : {});
					} catch (error) {
						if (!aliveRef.current) return;
						setVersionsError(errText(tRef.current, error));
					}
					if (aliveRef.current) setVersionsLoading(false);
				},
				[gameId]
			);
			react.useEffect(() => {
				setVersionsData(null);
				setVersionsLoading(false);
				setVersionsError("");
				setVersion("");
				setFormOpen(false);
				setName("");
				setOptionsDraft({});
				setQuery("");
				setHits([]);
				setSearching(false);
				setPicked([]);
				setSubmitting(false);
				setJobId("");
				loadVersions(false);
			}, [gameId, loadVersions]);
			const versionList = versionOptions(versionsData);
			react.useEffect(() => {
				if (version) return;
				const next = defaultVersionOf(versionsData);
				if (next) setVersion(next);
			}, [versionsData, version]);
			const setOption = (key, value) => {
				setOptionsDraft((draft) => Object.assign({}, draft && typeof draft === "object" ? draft : {}, { [key]: value }));
			};
			const buildOptions = () => {
				const result = {};
				options.forEach((option) => {
					const key = scalarText(option && option.key, "");
					if (!key) return;
					const value = optionValueForSubmit(option, optionsDraft);
					if (value !== undefined) result[key] = value;
				});
				return result;
			};
			const search = async () => {
				const text = scalarText(query, "").trim();
				if (!text || searching) return;
				setSearching(true);
				try {
					const params = ["game=" + encodeURIComponent(gameId), "q=" + encodeURIComponent(text), "limit=20"];
					if (version) params.push("version=" + encodeURIComponent(version));
					const data = await get("/content/search?" + params.join("&"));
					const list = data && Array.isArray(data.hits) ? data.hits : [];
					setHits(list);
				} catch (error) {
					props.toast(t("toast.failed", { error: errText(t, error) }));
				}
				setSearching(false);
			};
			const togglePick = (hit) => {
				const key = hitKey(hit);
				setPicked((list) => (list.indexOf(key) >= 0 ? list.filter((item) => item !== key) : list.concat(key)));
			};
			const submit = async () => {
				if (!version) {
					props.toast(t("detail.needVersion"));
					return;
				}
				if (submitting) return;
				setSubmitting(true);
				const specs = hits.filter((hit) => picked.indexOf(hitKey(hit)) >= 0).map(hitRef);
				const body = { game: gameId, version: version };
				const trimmed = scalarText(name, "").trim();
				if (trimmed) body.name = trimmed;
				const optionValues = buildOptions();
				if (Object.keys(optionValues).length) body.options = optionValues;
				if (specs.length) body.content = specs;
				try {
					const data = await post("/install", body);
					const nextJobId = scalarText(data && (data.jobId || data.id), "");
					if (!nextJobId) throw new Error(t("toast.failed", { error: "-" }));
					setJobId(nextJobId);
					props.toast(t("toast.installStarted"));
					setFormOpen(false);
					setPicked([]);
					if (typeof props.refresh === "function") props.refresh();
				} catch (error) {
					props.toast(t("toast.failed", { error: errText(t, error) }));
				}
				setSubmitting(false);
			};
			const onJobDone = (job) => {
				if (job && job.status === "failed") props.toast(t("toast.jobFailed", { error: brandSafe(scalarText(job.error || job.message, "未知错误")) }));
				else props.toast(t("toast.jobDone"));
				setName("");
				setPicked([]);
				setHits([]);
				setQuery("");
				if (typeof props.refresh === "function") props.refresh();
			};
			const renderOptions = () => {
				if (!options.length) return null;
				return h(
					"div",
					{ className: "dsl_section" },
					h("div", { className: "dsl_section_title" }, t("detail.options")),
					h("div", { className: "dsl_hint" }, t("detail.optionsHint")),
					h(
						"div",
						{ className: "dsl_grid" },
						options.map((option) => {
							const key = scalarText(option && option.key, "");
							const label = brandSafe(scalarText(option && option.label, key));
							const type = scalarText(option && option.type, "string");
							const value = optionDraftValue(option, optionsDraft);
							if (type === "boolean") {
								return h(
									"label",
									{ key: key, className: "dsl_radio" },
									h("input", {
										type: "checkbox",
										checked: value === true || value === "true",
										onChange: (event) => setOption(key, !!(event && event.target && event.target.checked)),
									}),
									h("span", null, label)
								);
							}
							if (type === "select") {
								const choices = optionChoices(option);
								return h(
									Field,
									{ key: key, label: label, hint: brandSafe(scalarText(option && option.description, "")) },
									h(
										"select",
										{ className: "dsl_select", value: scalarText(value, ""), onChange: (event) => setOption(key, event && event.target ? event.target.value : "") },
										choices.map((choice) => h("option", { key: choice.value, value: choice.value }, choice.label)),
										choices.some((choice) => choice.value === scalarText(value, "")) ? null : h("option", { value: scalarText(value, "") }, scalarText(value, ""))
									)
								);
							}
							if (type === "number") {
								return h(
									Field,
									{ key: key, label: label, hint: brandSafe(scalarText(option && option.description, "")) },
									h("input", {
										className: "dsl_input",
										type: "number",
										value: scalarText(value, ""),
										onChange: (event) => setOption(key, event && event.target ? event.target.value : ""),
									})
								);
							}
							return h(
								Field,
								{ key: key, label: label, hint: brandSafe(scalarText(option && option.description, "")) },
								h("input", {
									className: "dsl_input",
									type: "text",
									value: scalarText(value, ""),
									onChange: (event) => setOption(key, event && event.target ? event.target.value : ""),
								})
							);
						})
					)
				);
			};
			const renderContentPicker = () => {
				if (!supportsContent(game)) return null;
				return h(
					"div",
					{ className: "dsl_section" },
					h("div", { className: "dsl_section_title" }, t("detail.content")),
					h("div", { className: "dsl_hint" }, t("detail.contentHint")),
					h(
						"div",
						{ className: "dsl_row" },
						h("input", {
							className: "dsl_input",
							type: "text",
							placeholder: t("detail.contentSearchPh"),
							value: scalarText(query, ""),
							onChange: (event) => setQuery(event && event.target ? event.target.value : ""),
							onKeyDown: (event) => {
								if (event && event.key === "Enter" && typeof event.preventDefault === "function") {
									event.preventDefault();
									search();
								}
							},
							style: { flex: "1" },
						}),
						h(Btn, { onClick: search, disabled: searching }, searching ? t("common.searching") : t("common.search"))
					),
					hits.length
						? h(
								"div",
								{ className: "dsl_hitlist" },
								hits.map((hit) =>
									h(
										"label",
										{ key: hitKey(hit), className: "dsl_check" },
										h("input", { type: "checkbox", checked: picked.indexOf(hitKey(hit)) >= 0, onChange: () => togglePick(hit) }),
										h("span", { className: "dsl_check_main" }, h("span", { className: "dsl_check_title" }, hitTitle(hit)), hitDesc(hit) ? h("span", { className: "dsl_check_desc" }, hitDesc(hit)) : null)
									)
								)
							)
						: null,
					picked.length ? h("div", { className: "dsl_hint" }, t("detail.contentPicked", { count: picked.length })) : null
				);
			};
			const versions = versionList;
			return h(
				"div",
				{ className: "dsl_section" },
				h(
					"div",
					{ className: "dsl_detail_head" },
					h(Btn, { variant: "ghost", onClick: () => props.onBack && props.onBack(), label: t("detail.back"), title: t("detail.back") }, "← " + t("common.back")),
					h("span", { className: "dsl_detail_title" }, gameLabelOf(game)),
					h(Badge, { tone: sourceKey(game) === "user" ? "on" : "info" }, gameSourceLabel(t, game)),
					capabilityLabels(t, game).map((cap) => h("span", { key: cap, className: "dsl_cap" }, cap))
				),
				h(
					"div",
					{ className: "dsl_section" },
					h(
						"div",
						{ className: "dsl_section_title" },
						t("detail.versions"),
						versionsLoading ? h("span", { className: "dsl_hint" }, t("detail.versionsLoading")) : null,
						versionsError ? h("span", { className: "dsl_hint" }, versionsError) : null,
						h("span", { className: "dsl_footer_spacer" }),
						h(Btn, { variant: "ghost", onClick: () => loadVersions(true), disabled: versionsLoading }, t("detail.refreshVersions"))
					),
					versions.length
						? h(
								"div",
								{ className: "dsl_row" },
								h(
									"select",
									{ className: "dsl_select", value: scalarText(version, ""), onChange: (event) => setVersion(event && event.target ? event.target.value : ""), style: { maxWidth: "320px" } },
									versions.map((item) => h("option", { key: item.id, value: item.id }, item.label))
								),
								h(Btn, { variant: "primary", onClick: () => setFormOpen((value) => !value), disabled: !version }, t("detail.install"))
							)
						: versionsLoading
							? null
							: h(
									"div",
									{ className: "dsl_row" },
									h("span", { className: "dsl_hint" }, versionsError ? versionsError : t("detail.versionsEmpty")),
									h(Btn, { onClick: () => loadVersions(true), disabled: versionsLoading }, t("detail.refreshVersions"))
								),
					h("div", { className: "dsl_hint" }, t("detail.versionsHint")),
					formOpen
						? h(
								"div",
								{ className: "dsl_section" },
								h("div", { className: "dsl_section_title" }, t("detail.installTitle")),
								h(
									"div",
									{ className: "dsl_grid" },
									h(Field, { label: t("detail.name"), hint: t("detail.namePh") }, h("input", { className: "dsl_input", type: "text", value: scalarText(name, ""), onChange: (event) => setName(event && event.target ? event.target.value : "") }))
								),
								renderOptions(),
								renderContentPicker(),
								h(
									"div",
									{ className: "dsl_row" },
									h(Btn, { variant: "primary", onClick: submit, disabled: submitting || !version }, submitting ? t("detail.submitting") : t("detail.submit")),
									h(Btn, { variant: "ghost", onClick: () => setFormOpen(false), disabled: submitting }, t("common.cancel"))
								)
							)
						: null,
					jobId ? h(JobMonitor, { jobId: jobId, t: t, toast: props.toast, onDone: onJobDone }) : null
				),
				h(InstanceList, { instances: myInstances, jobs: jobs, game: game, t: t, toast: props.toast, refresh: props.refresh }),
				supportsContent(game) ? h(GameContent, { game: game, instances: myInstances, t: t, toast: props.toast }) : null
			);
		}

		// ------------------------------------------------------------------
		// 该游戏的实例列表：启动/停止/日志/打开文件夹/删除。
		// ------------------------------------------------------------------
		function InstanceList(props) {
			const t = makeT(props.t);
			const instances = Array.isArray(props.instances) ? props.instances : [];
			const jobs = Array.isArray(props.jobs) ? props.jobs : [];
			const game = props.game && typeof props.game === "object" ? props.game : {};
			const [busy, setBusy] = react.useState({});
			const [confirm, setConfirm] = react.useState(null);
			const [logs, setLogs] = react.useState(null);
			const [openBusy, setOpenBusy] = react.useState({});
			const markBusy = (id, value) => setBusy((current) => Object.assign({}, current && typeof current === "object" ? current : {}, { [id]: value }));
			const markOpen = (key, value) => setOpenBusy((current) => Object.assign({}, current && typeof current === "object" ? current : {}, { [key]: value }));
			const launch = async (instance) => {
				const id = scalarText(instance && instance.id, "");
				if (!id) return;
				markBusy(id, "launch");
				try {
					await post(instancePath(id, "/launch"), {});
					props.toast(t("toast.launched"));
					if (typeof props.refresh === "function") props.refresh();
				} catch (error) {
					props.toast(t("toast.failed", { error: errText(t, error) }));
				}
				markBusy(id, "");
			};
			const stop = async (instance) => {
				const id = scalarText(instance && instance.id, "");
				if (!id) return;
				markBusy(id, "stop");
				try {
					await post(instancePath(id, "/stop"), {});
					props.toast(t("toast.stopped"));
					if (typeof props.refresh === "function") props.refresh();
				} catch (error) {
					props.toast(t("toast.failed", { error: errText(t, error) }));
				}
				markBusy(id, "");
				setConfirm(null);
			};
			const remove = async (instance) => {
				const id = scalarText(instance && instance.id, "");
				if (!id) return;
				markBusy(id, "delete");
				try {
					await del(instancePath(id, ""));
					props.toast(t("toast.deleted"));
					if (typeof props.refresh === "function") props.refresh();
				} catch (error) {
					props.toast(t("toast.failed", { error: errText(t, error) }));
				}
				markBusy(id, "");
				setConfirm(null);
			};
			const openFolder = async (instance, kind) => {
				const id = scalarText(instance && instance.id, "");
				if (!id) return;
				const key = id + ":" + kind;
				markOpen(key, true);
				try {
					const data = await post(instancePath(id, "/open"), { kind: kind });
					const path = data && typeof data.path === "string" ? brandSafe(data.path) : "";
					props.toast(path ? t("toast.opened", { path: path }) : t("toast.openedNoPath"));
				} catch (error) {
					props.toast(t("toast.failed", { error: errText(t, error) }));
				}
				markOpen(key, false);
			};
			const loadLog = async (instance) => {
				const id = scalarText(instance && instance.id, "");
				if (!id) return;
				if (logs && logs.id === id && !logs.loading) {
					setLogs(null);
					return;
				}
				setLogs({ id: id, loading: true, lines: [], file: "" });
				try {
					const data = await get(instancePath(id, "/log?lines=" + LOG_LINES));
					setLogs({
						id: id,
						loading: false,
						lines: data && Array.isArray(data.lines) ? data.lines.map((line) => brandSafe(scalarText(line, ""))) : [],
						file: brandSafe(scalarText(data && data.file, "")),
					});
				} catch (error) {
					props.toast(t("toast.failed", { error: errText(t, error) }));
					setLogs(null);
				}
			};
			if (!instances.length) {
				return h("div", { className: "dsl_section" }, h("div", { className: "dsl_section_title" }, t("detail.instances")), h("div", { className: "dsl_empty_hint" }, t("detail.noInstances")));
			}
			return h(
				"div",
				{ className: "dsl_section" },
				h("div", { className: "dsl_section_title" }, t("detail.instances")),
				h("div", { className: "dsl_section_hint" }, t("detail.instancesHint")),
				instances.map((instance) => {
					const id = scalarText(instance.id, "");
					const running = instance.running === true;
					const status = scalarText(instance.status, "");
					const installing = status === "installing";
					const busyValue = busy[id] || "";
					const instanceJobs = jobs.filter((job) => scalarText(job && job.instanceId, "") === id && jobActive(job));
					return h(
						"div",
						{ key: id || instanceName(instance), className: "dsl_card" },
						h(
							"div",
							{ className: "dsl_card_head" },
							h("span", { className: "dsl_card_name" }, instanceName(instance)),
							running ? h(Badge, { tone: "on" }, t("instance.running")) : null,
							status ? h(Badge, { tone: status === "error" ? "error" : status === "installing" ? "warn" : "info" }, t("instance.status." + (status === "ready" || status === "installing" || status === "error" ? status : "new"))) : null
						),
						h(
							"div",
							{ className: "dsl_card_meta" },
							h(MetaItem, { label: t("instance.version"), value: instanceVersion(instance) }),
							h(MetaItem, { label: t("addGame.instancesCount"), value: instance.playCount !== undefined ? String(Number(instance.playCount) || 0) : "-" }),
							h(MetaItem, {
								label: t("addGame.contentLabel"),
								value: t("instance.contentCount", { count: instanceContentCount(instance) }),
							}),
							h(MetaItem, { label: t("instance.lastLaunch"), value: instance.lastLaunchAt ? fmtTime(instance.lastLaunchAt) : t("instance.neverLaunched") })
						),
						instance.installError ? h("div", { className: "dsl_hint" }, t("instance.installError", { error: brandSafe(scalarText(instance.installError, "")) })) : null,
						instanceJobs.length
							? h(
									"div",
									{ className: "dsl_list" },
									instanceJobs.map((job) => h(JobCard, { key: scalarText(job.id, ""), job: job, t: t }))
								)
							: null,
						h(
							"div",
							{ className: "dsl_row" },
							running
								? h(Btn, { onClick: () => setConfirm({ id: id, kind: "stop" }), disabled: !!busyValue }, busyValue === "stop" ? t("instance.stopping") : t("instance.stop"))
								: h(Btn, { variant: "primary", onClick: () => launch(instance), disabled: false }, busyValue === "launch" ? t("instance.launching") : t("instance.launch")),
							h(Btn, { onClick: () => loadLog(instance), disabled: false }, logs && logs.id === id && !logs.loading ? t("instance.hideLog") : t("instance.log")),
							h(Btn, { onClick: () => openFolder(instance, "game"), disabled: !!openBusy[id + ":game"] }, t("instance.openGame")),
							h(Btn, { onClick: () => openFolder(instance, "content"), disabled: !supportsContent(game) || !!openBusy[id + ":content"] }, t("instance.openContent")),
							h(Btn, { variant: "danger", onClick: () => setConfirm({ id: id, kind: "delete" }), disabled: running || installing || !!busyValue }, t("instance.delete"))
						),
						confirm && confirm.id === id
							? h(
									"div",
									{ className: "dsl_confirm" },
									h("span", { className: "dsl_confirm_text" }, confirm.kind === "stop" ? t("instance.stopConfirmHint", { name: instanceName(instance) }) : t("instance.deleteHint") + " " + t("instance.deleteConfirm", { name: instanceName(instance) })),
									confirm.kind === "stop"
										? h(Btn, { variant: "primary", onClick: () => stop(instance), disabled: busyValue === "stop" }, t("instance.confirmStop"))
										: h(Btn, { variant: "danger", onClick: () => remove(instance), disabled: busyValue === "delete" }, t("common.confirm")),
									h(Btn, { variant: "ghost", onClick: () => setConfirm(null) }, t("common.cancel"))
								)
							: null,
						logs && logs.id === id
							? h(
									"div",
									{ className: "dsl_section" },
									h(
										"div",
										{ className: "dsl_row" },
										h("span", { className: "dsl_section_hint" }, t("instance.log")),
										logs.loading ? h("span", { className: "dsl_hint" }, t("instance.logLoading")) : null,
										h("span", { className: "dsl_footer_spacer" }),
										h(Btn, { variant: "ghost", onClick: () => loadLog(instance), disabled: logs.loading }, t("instance.logRefresh")),
										h(Btn, { variant: "ghost", onClick: () => openFolder(instance, "logs") }, t("instance.logsFolder"))
									),
									h("pre", { className: "dsl_log" }, logs.loading ? t("instance.logLoading") : logs.lines.length ? logs.lines.join("\n") : t("instance.logEmpty"))
								)
							: null
					);
				})
			);
		}

		// ------------------------------------------------------------------
		// 内容管理：仅对该游戏支持内容能力时显示。
		// ------------------------------------------------------------------
		function GameContent(props) {
			const t = makeT(props.t);
			const game = props.game && typeof props.game === "object" ? props.game : {};
			const gameId = scalarText(game.id, "");
			const instances = Array.isArray(props.instances) ? props.instances : [];
			const [instanceId, setInstanceId] = react.useState("");
			const [detail, setDetail] = react.useState(null);
			const [detailLoading, setDetailLoading] = react.useState(false);
			const [detailError, setDetailError] = react.useState("");
			const [query, setQuery] = react.useState("");
			const [hits, setHits] = react.useState([]);
			const [searching, setSearching] = react.useState(false);
			const [picked, setPicked] = react.useState([]);
			const [adding, setAdding] = react.useState(false);
			const [removeTarget, setRemoveTarget] = react.useState("");
			const [removeBusy, setRemoveBusy] = react.useState(false);
			const selected = instances.filter((instance) => scalarText(instance && instance.id, "") === instanceId)[0] || null;
			react.useEffect(() => {
				if (instanceId) return;
				const first = scalarText(instances[0] && instances[0].id, "");
				if (first) setInstanceId(first);
			}, [instances, instanceId]);
			const loadDetail = react.useCallback(async () => {
				const id = scalarText(instanceId, "");
				if (!id) {
					setDetail(null);
					return;
				}
				setDetailLoading(true);
				setDetailError("");
				try {
					const data = await get(instancePath(id, ""));
					setDetail(data && typeof data === "object" ? data : {});
				} catch (error) {
					setDetailError(errText(t, error));
				}
				setDetailLoading(false);
			}, [instanceId]);
			react.useEffect(() => {
				loadDetail();
			}, [loadDetail]);
			react.useEffect(() => {
				setQuery("");
				setHits([]);
				setPicked([]);
				setRemoveTarget("");
			}, [instanceId]);
			const contentList = contentListOf(detail);
			const search = async () => {
				const text = scalarText(query, "").trim();
				if (!text || searching) return;
				setSearching(true);
				try {
					const params = ["game=" + encodeURIComponent(gameId), "q=" + encodeURIComponent(text), "limit=20"];
					if (selected) {
						const version = instanceVersion(selected);
						if (version && version !== "-") params.push("version=" + encodeURIComponent(version));
						const loader = instanceLoaderType(selected);
						if (loader) params.push("loader=" + encodeURIComponent(loader));
					}
					const data = await get("/content/search?" + params.join("&"));
					setHits(data && Array.isArray(data.hits) ? data.hits : []);
				} catch (error) {
					props.toast(t("toast.failed", { error: errText(t, error) }));
				}
				setSearching(false);
			};
			const togglePick = (hit) => {
				const key = hitKey(hit);
				setPicked((list) => (list.indexOf(key) >= 0 ? list.filter((item) => item !== key) : list.concat(key)));
			};
			const addSelected = async () => {
				const id = scalarText(instanceId, "");
				if (!id || adding) return;
				const specs = hits.filter((hit) => picked.indexOf(hitKey(hit)) >= 0).map(hitRef);
				if (!specs.length) return;
				setAdding(true);
				try {
					await post(instancePath(id, "/content"), { specs: specs });
					props.toast(t("toast.contentAdded"));
					setPicked([]);
					await loadDetail();
				} catch (error) {
					props.toast(t("toast.failed", { error: errText(t, error) }));
				}
				setAdding(false);
			};
			const removeContent = async (entry) => {
				const id = scalarText(instanceId, "");
				const filename = contentFilename(entry);
				if (!id || !filename || removeBusy) return;
				setRemoveBusy(true);
				try {
					await del(instancePath(id, "/content/" + encodeURIComponent(filename)));
					props.toast(t("toast.contentRemoved"));
					setRemoveTarget("");
					await loadDetail();
				} catch (error) {
					props.toast(t("toast.failed", { error: errText(t, error) }));
				}
				setRemoveBusy(false);
			};
			if (!instances.length) {
				return h("div", { className: "dsl_section" }, h("div", { className: "dsl_section_title" }, t("detail.content")), h("div", { className: "dsl_empty_hint" }, t("detail.instanceSelect")));
			}
			return h(
				"div",
				{ className: "dsl_section" },
				h("div", { className: "dsl_section_title" }, t("detail.content"), h("span", { className: "dsl_cap" }, t("detail.capabilityContent"))),
				h(
					"div",
					{ className: "dsl_row" },
					h("span", { className: "dsl_label" }, t("detail.contentInstance")),
					h(
						"select",
						{ className: "dsl_select", value: instanceId, onChange: (event) => setInstanceId(event && event.target ? event.target.value : ""), style: { maxWidth: "320px" } },
						instances.map((instance) => h("option", { key: scalarText(instance && instance.id, ""), value: scalarText(instance && instance.id, "") }, instanceName(instance)))
					),
					detailLoading ? h("span", { className: "dsl_hint" }, t("common.loading")) : null,
					detailError ? h("span", { className: "dsl_hint" }, detailError) : null
				),
				h(
					"div",
					{ className: "dsl_section" },
					h("div", { className: "dsl_section_title" }, t("detail.installed")),
					contentList.length
						? h(
								"div",
								{ className: "dsl_list" },
								contentList.map((entry) => {
									const key = contentKey(entry) || scalarText(entry, "内容");
									const filename = contentFilename(entry);
									const title = brandSafe(scalarText(entry && (entry.title || entry.name || entry.filename), t("common.none")));
									const meta = [contentSize(entry), filename && filename !== title ? brandSafe(filename) : ""].filter(Boolean).join(" · ");
									return h(
										"div",
										{ key: key, className: "dsl_list_row" },
										h("span", { className: "dsl_list_name" }, title),
										meta ? h("span", { className: "dsl_list_meta" }, meta) : null,
										removeTarget === key
											? h(
													"span",
													{ className: "dsl_row" },
													h("span", { className: "dsl_hint" }, t("detail.removeConfirm", { name: title })),
													h(Btn, { variant: "danger", onClick: () => removeContent(entry), disabled: removeBusy }, t("common.confirm")),
													h(Btn, { variant: "ghost", onClick: () => setRemoveTarget("") }, t("common.cancel"))
												)
											: h(Btn, { variant: "ghost", onClick: () => setRemoveTarget(key), disabled: removeBusy }, t("detail.removeContent"))
									);
								})
							)
						: h("div", { className: "dsl_empty_hint" }, t("detail.installedEmpty"))
				),
				h(
					"div",
					{ className: "dsl_section" },
					h(
						"div",
						{ className: "dsl_row" },
						h("input", {
							className: "dsl_input",
							type: "text",
							placeholder: t("detail.contentSearchPh"),
							value: scalarText(query, ""),
							onChange: (event) => setQuery(event && event.target ? event.target.value : ""),
							onKeyDown: (event) => {
								if (event && event.key === "Enter" && typeof event.preventDefault === "function") {
									event.preventDefault();
									search();
								}
							},
							style: { flex: "1" },
						}),
						h(Btn, { onClick: search, disabled: searching }, searching ? t("common.searching") : t("common.search"))
					),
					hits.length
						? h(
								"div",
								{ className: "dsl_hitlist" },
								hits.map((hit) =>
									h(
										"label",
										{ key: hitKey(hit), className: "dsl_check" },
										h("input", { type: "checkbox", checked: picked.indexOf(hitKey(hit)) >= 0, onChange: () => togglePick(hit) }),
										h("span", { className: "dsl_check_main" }, h("span", { className: "dsl_check_title" }, hitTitle(hit)), hitDesc(hit) ? h("span", { className: "dsl_check_desc" }, hitDesc(hit)) : null)
									)
								)
							)
						: null,
					h(
						"div",
						{ className: "dsl_row" },
						h(Btn, { variant: "primary", onClick: addSelected, disabled: adding || !picked.length }, adding ? t("detail.adding") : t("detail.addContent")),
						picked.length ? h("span", { className: "dsl_hint" }, t("detail.contentPicked", { count: picked.length })) : null
					)
				)
			);
		}

		// ------------------------------------------------------------------
		// 添加游戏 tab：三种来源动态表单、测试连接、保存、删除用户游戏。
		// ------------------------------------------------------------------
		function AddGameTab(props) {
			const t = makeT(props.t);
			const games = Array.isArray(props.games) ? props.games : [];
			const [provider, setProvider] = react.useState("github");
			const [label, setLabel] = react.useState("");
			const [id, setId] = react.useState("");
			const [repo, setRepo] = react.useState("");
			const [assetPattern, setAssetPattern] = react.useState("");
			const [executable, setExecutable] = react.useState("");
			const [args, setArgs] = react.useState("");
			const [jsonUrl, setJsonUrl] = react.useState("");
			const [versionsText, setVersionsText] = react.useState("");
			const [manualPath, setManualPath] = react.useState("");
			const [testing, setTesting] = react.useState(false);
			const [testResult, setTestResult] = react.useState(null);
			const [saving, setSaving] = react.useState(false);
			const [deleteTarget, setDeleteTarget] = react.useState("");
			const [deleteBusy, setDeleteBusy] = react.useState(false);
			const buildConfig = () => {
				const config = {};
				const parsedArgs = parseArgsText(args);
				const trimmedExecutable = scalarText(executable, "").trim();
				if (provider === "github") {
					config.repo = scalarText(repo, "").trim();
					const pattern = scalarText(assetPattern, "").trim();
					if (pattern) config.assetPattern = pattern;
				} else if (provider === "url") {
					const url = scalarText(jsonUrl, "").trim();
					if (url) config.jsonUrl = url;
					const raw = scalarText(versionsText, "").trim();
					if (raw) {
						try {
							config.versions = JSON.parse(raw);
						} catch (error) {
							config.versions = undefined;
						}
					}
				} else {
					config.path = scalarText(manualPath, "").trim();
				}
				if (trimmedExecutable) config.executable = trimmedExecutable;
				if (parsedArgs.length) config.args = parsedArgs;
				return config;
			};
			const validate = () => {
				if (!scalarText(label, "").trim()) return t("addGame.needLabel");
				const config = buildConfig();
				if (provider === "github" && !config.repo) return t("addGame.needRepo");
				if (provider === "url") {
					if (!config.jsonUrl && !config.versions) return t("addGame.needSource");
					if (config.versions !== undefined && !Array.isArray(config.versions)) return t("addGame.invalidVersions");
				}
				if (provider === "manual") {
					if (!config.path) return t("addGame.needPath");
					if (!config.executable) return t("addGame.needExecutable");
				}
				return "";
			};
			const test = async () => {
				const message = validate();
				if (message) {
					props.toast(message);
					return;
				}
				setTesting(true);
				setTestResult(null);
				try {
					const config = buildConfig();
					const data = await post("/games/test", { provider: provider, config: config });
					const ok = data && data.ok === true;
					setTestResult({ ok: ok, detail: detailText(data) });
				} catch (error) {
					setTestResult({ ok: false, detail: errText(t, error) });
				}
				setTesting(false);
			};
			const save = async () => {
				const message = validate();
				if (message) {
					props.toast(message);
					return;
				}
				setSaving(true);
				try {
					const body = { provider: provider, label: scalarText(label, "").trim(), config: buildConfig() };
					const trimmedId = scalarText(id, "").trim();
					if (trimmedId) body.id = trimmedId;
					const data = await post("/games", body);
					props.toast(t("toast.gameAdded"));
					setLabel("");
					setId("");
					setRepo("");
					setAssetPattern("");
					setExecutable("");
					setArgs("");
					setJsonUrl("");
					setVersionsText("");
					setManualPath("");
					setTestResult(null);
					if (typeof props.refresh === "function") props.refresh();
					if (typeof props.onCreated === "function") props.onCreated(data && data.game ? data.game : data);
				} catch (error) {
					props.toast(t("toast.failed", { error: errText(t, error) }));
				}
				setSaving(false);
			};
			const removeGame = async (game) => {
				const targetId = scalarText(game && game.id, "");
				if (!targetId || deleteBusy) return;
				setDeleteBusy(true);
				try {
					await del("/games/" + encodeURIComponent(targetId));
					props.toast(t("toast.gameDeleted"));
					setDeleteTarget("");
					if (typeof props.refresh === "function") props.refresh();
				} catch (error) {
					const message = errText(t, error);
					props.toast(message.indexOf("不存在") >= 0 ? t("toast.gameGone") : t("toast.failed", { error: message }));
				}
				setDeleteBusy(false);
			};
			const renderProviderFields = () => {
				if (provider === "github") {
					return h(
						react.Fragment,
						null,
						h(Field, { label: t("addGame.repo"), hint: t("addGame.repoHint") }, h("input", { className: "dsl_input", type: "text", placeholder: t("addGame.repoPh"), value: repo, onChange: (event) => setRepo(event && event.target ? event.target.value : "") })),
						h(Field, { label: t("addGame.assetPattern"), hint: t("addGame.assetPatternPh") }, h("input", { className: "dsl_input", type: "text", value: assetPattern, onChange: (event) => setAssetPattern(event && event.target ? event.target.value : "") }))
					);
				}
				if (provider === "url") {
					return h(
						react.Fragment,
						null,
						h(Field, { label: t("addGame.jsonUrl"), hint: t("addGame.versionsHint") }, h("input", { className: "dsl_input", type: "text", placeholder: t("addGame.jsonUrlPh"), value: jsonUrl, onChange: (event) => setJsonUrl(event && event.target ? event.target.value : "") })),
						h(
							Field,
							{ label: t("addGame.versions"), hint: t("addGame.versionsHint") },
							h("textarea", { className: "dsl_input", rows: 4, placeholder: t("addGame.versionsPh"), value: versionsText, onChange: (event) => setVersionsText(event && event.target ? event.target.value : "") })
						)
					);
				}
				return h(Field, { label: t("addGame.path"), hint: t("addGame.pathHint") }, h("input", { className: "dsl_input", type: "text", placeholder: t("addGame.pathPh"), value: manualPath, onChange: (event) => setManualPath(event && event.target ? event.target.value : "") }));
			};
			const added = games.filter((game) => scalarText(game && game.source, "") === "user");
			return h(
				"div",
				{ className: "dsl_section" },
				h("div", { className: "dsl_section_title" }, t("addGame.title")),
				h("div", { className: "dsl_section_hint" }, t("addGame.subtitle")),
				h(
					"div",
					{ className: "dsl_section" },
					h("div", { className: "dsl_label" }, t("addGame.provider")),
					h(
						"div",
						{ className: "dsl_radios" },
						PROVIDERS.map((item) =>
							h(
								"label",
								{ key: item, className: "dsl_radio" },
								h("input", { type: "radio", name: "dsl_provider", checked: provider === item, onChange: () => setProvider(item) }),
								h("span", null, providerLabel(t, item))
							)
						)
					),
					h("div", { className: "dsl_hint" }, t("addGame.providerHint"))
				),
				h(
					"div",
					{ className: "dsl_grid" },
					h(Field, { label: t("addGame.label") }, h("input", { className: "dsl_input", type: "text", placeholder: t("addGame.labelPh"), value: label, onChange: (event) => setLabel(event && event.target ? event.target.value : "") })),
					h(Field, { label: t("addGame.id"), hint: t("addGame.idHint") }, h("input", { className: "dsl_input", type: "text", placeholder: t("addGame.idPh"), value: id, onChange: (event) => setId(event && event.target ? event.target.value : "") }))
				),
				h("div", { className: "dsl_grid" }, renderProviderFields()),
				h(
					"div",
					{ className: "dsl_grid" },
					h(Field, { label: t("addGame.executable") }, h("input", { className: "dsl_input", type: "text", placeholder: t("addGame.executablePh"), value: executable, onChange: (event) => setExecutable(event && event.target ? event.target.value : "") })),
					h(Field, { label: t("addGame.args"), hint: t("addGame.argsHint") }, h("input", { className: "dsl_input", type: "text", placeholder: t("addGame.argsPh"), value: args, onChange: (event) => setArgs(event && event.target ? event.target.value : "") }))
				),
				h(
					"div",
					{ className: "dsl_row" },
					h(Btn, { onClick: test, disabled: testing || saving }, testing ? t("addGame.testing") : t("addGame.test")),
					h(Btn, { variant: "primary", onClick: save, disabled: saving || testing }, saving ? t("addGame.saving") : t("addGame.save")),
					testResult ? h(Badge, { tone: testResult.ok ? "on" : "error" }, testResult.ok ? t("addGame.testOk") : t("addGame.testFail")) : null,
					testResult && testResult.detail ? h("span", { className: "dsl_hint" }, testResult.detail) : null
				),
				h("div", { className: "dsl_hint" }, t("addGame.testHint")),
				h(
					"div",
					{ className: "dsl_section" },
					h("div", { className: "dsl_section_title" }, t("addGame.added")),
					added.length
						? h(
								"div",
								{ className: "dsl_list" },
								added.map((game) => {
									const targetId = scalarText(game && game.id, "");
									return h(
										"div",
										{ key: targetId, className: "dsl_list_row" },
										h("span", { className: "dsl_list_name" }, gameLabelOf(game)),
										h(Badge, { tone: "info" }, t("addGame.source.user")),
										game && game.providerType ? h("span", { className: "dsl_list_meta" }, providerLabel(t, game.providerType)) : null,
										deleteTarget === targetId
											? h(
													"span",
													{ className: "dsl_row" },
													h("span", { className: "dsl_hint" }, t("addGame.deleteConfirm", { name: gameLabelOf(game) })),
													h(Btn, { variant: "danger", onClick: () => removeGame(game), disabled: deleteBusy }, t("common.confirm")),
													h(Btn, { variant: "ghost", onClick: () => setDeleteTarget("") }, t("common.cancel"))
												)
											: h(Btn, { variant: "ghost", onClick: () => setDeleteTarget(targetId) }, t("addGame.delete"))
									);
								})
							)
						: h("div", { className: "dsl_empty_hint" }, t("addGame.addedEmpty")),
					h("div", { className: "dsl_hint" }, t("addGame.addedHint"))
				)
			);
		}

		// ------------------------------------------------------------------
		// 附属启动器 tab：说明 / 安装表单（仓库、zip 地址、本机文件）/ 已安装列表。
		// 附属启动器是独立项目；本启动器本体不含任何游戏。
		// ------------------------------------------------------------------
		function SubLaunchersTab(props) {
			const t = makeT(props.t);
			const toast = typeof props.toast === "function" ? props.toast : () => {};
			const [launchers, setLaunchers] = react.useState([]);
			const [loading, setLoading] = react.useState(true);
			const [loadError, setLoadError] = react.useState("");
			const [sourceType, setSourceType] = react.useState("github");
			const [repo, setRepo] = react.useState("");
			const [url, setUrl] = react.useState("");
			const [file, setFile] = react.useState("");
			const [assetPattern, setAssetPattern] = react.useState("");
			const [advancedOpen, setAdvancedOpen] = react.useState(false);
			const [installing, setInstalling] = react.useState(false);
			const [installJobId, setInstallJobId] = react.useState("");
			const [checkBusy, setCheckBusy] = react.useState({});
			const [updateBusy, setUpdateBusy] = react.useState({});
			const [deleteTarget, setDeleteTarget] = react.useState("");
			const [deleteBusy, setDeleteBusy] = react.useState(false);
			const [updateJobId, setUpdateJobId] = react.useState("");
			const [catalog, setCatalog] = react.useState([]);
			const [catalogLoading, setCatalogLoading] = react.useState(true);
			const [catalogError, setCatalogError] = react.useState("");
			const [catalogBusy, setCatalogBusy] = react.useState({});
			const tRef = react.useRef(t);
			const toastRef = react.useRef(toast);
			react.useEffect(() => {
				tRef.current = t;
				toastRef.current = toast;
			});
			const loadLaunchers = react.useCallback(async () => {
				setLoading(true);
				try {
					const data = await get("/sublaunchers");
					const list = data && Array.isArray(data.launchers) ? data.launchers : Array.isArray(data) ? data : [];
					setLaunchers(list);
					setLoadError("");
				} catch (error) {
					setLoadError(errText(tRef.current, error));
				}
				setLoading(false);
			}, []);
			react.useEffect(() => {
				loadLaunchers();
			}, [loadLaunchers]);
			const loadCatalog = react.useCallback(async (force) => {
				setCatalogLoading(true);
				try {
					const data = await get(force ? "/catalog?refresh=1" : "/catalog");
					const entries = data && Array.isArray(data.entries) ? data.entries : Array.isArray(data) ? data : [];
					setCatalog(entries);
					setCatalogError(data && data.error ? brandSafe(scalarText(data.error, "")) : "");
				} catch (error) {
					setCatalogError(errText(tRef.current, error));
				}
				setCatalogLoading(false);
			}, []);
			react.useEffect(() => {
				loadCatalog(false);
			}, [loadCatalog]);
			const list = Array.isArray(launchers) ? launchers : [];
			const sourceId = scalarText(sourceType, "github");
			function subPath(id, suffix) {
				return "/sublaunchers/" + encodeURIComponent(id) + (suffix || "");
			}
			function buildSpec() {
				const spec = {};
				if (sourceId === "url") spec.url = url.trim();
				else if (sourceId === "file") spec.file = file.trim();
				else spec.repo = repo.trim();
				const pattern = assetPattern.trim();
				if (pattern) spec.assetPattern = pattern;
				return spec;
			}
			function validate() {
				if (sourceId === "url") return url.trim() ? "" : t("sublauncher.needSource");
				if (sourceId === "file") return file.trim() ? "" : t("sublauncher.needSource");
				return repo.trim() ? "" : t("sublauncher.needSource");
			}
			async function installSub() {
				const problem = validate();
				if (problem) {
					toast(problem);
					return;
				}
				setInstalling(true);
				try {
					const data = await post("/sublaunchers/install", buildSpec());
					const jobId = scalarText(data && (data.jobId || data.id), "");
					setInstallJobId(jobId);
					toast(t("sublauncher.installStarted"));
					setRepo("");
					setUrl("");
					setFile("");
					setAssetPattern("");
				} catch (error) {
					toast(t("toast.failed", { error: errText(t, error) }));
				}
				setInstalling(false);
			}
			async function checkOne(launcher) {
				const id = subLauncherId(launcher);
				if (!id) return;
				setCheckBusy((prev) => Object.assign({}, prev, { [id]: true }));
				try {
					const data = await post(subPath(id, "/check"));
					const available = data && (data.updateAvailable === true || data.hasUpdate === true);
					toast(available ? t("sublauncher.updateAvailable") : t("sublauncher.upToDate"));
					await loadLaunchers();
				} catch (error) {
					toast(t("toast.failed", { error: errText(t, error) }));
				}
				setCheckBusy((prev) => {
					const next = Object.assign({}, prev);
					delete next[id];
					return next;
				});
			}
			async function updateOne(launcher) {
				const id = subLauncherId(launcher);
				if (!id) return;
				setUpdateBusy((prev) => Object.assign({}, prev, { [id]: true }));
				try {
					const data = await post(subPath(id, "/update"));
					const jobId = scalarText(data && (data.jobId || data.id), "");
					setUpdateJobId(jobId);
					toast(t("sublauncher.updateStarted"));
				} catch (error) {
					toast(t("toast.failed", { error: errText(t, error) }));
				}
				setUpdateBusy((prev) => {
					const next = Object.assign({}, prev);
					delete next[id];
					return next;
				});
			}
			async function updateCatalogEntry(entry) {
				const entryId = scalarText(entry && entry.id, "");
				if (!entryId) return;
				setCatalogBusy((prev) => Object.assign({}, prev, { [entryId]: true }));
				try {
					const data = await post(subPath(entryId, "/update"));
					const jobId = scalarText(data && (data.jobId || data.id), "");
					setUpdateJobId(jobId);
					toast(t("sublauncher.updateStarted"));
				} catch (error) {
					toast(t("toast.failed", { error: errText(t, error) }));
				}
				setCatalogBusy((prev) => {
					const next = Object.assign({}, prev);
					delete next[entryId];
					return next;
				});
			}
			async function installCatalog(entry) {
				const entryId = scalarText(entry && entry.id, "");
				const catalogRepo = scalarText(entry && entry.repo, "");
				const catalogUrl = scalarText(entry && entry.url, "");
				const catalogFile = scalarText(entry && entry.file, "");
				const spec = catalogRepo ? { repo: catalogRepo } : catalogUrl ? { url: catalogUrl } : catalogFile ? { file: catalogFile } : null;
				if (!spec) {
					toast(t("catalog.needSource"));
					return;
				}
				setCatalogBusy((prev) => Object.assign({}, prev, { [entryId]: true }));
				try {
					const data = await post("/sublaunchers/install", spec);
					const jobId = scalarText(data && (data.jobId || data.id), "");
					setInstallJobId(jobId);
					toast(t("sublauncher.installStarted"));
				} catch (error) {
					toast(t("toast.failed", { error: errText(t, error) }));
				}
				setCatalogBusy((prev) => {
					const next = Object.assign({}, prev);
					delete next[entryId];
					return next;
				});
			}
			async function removeOne(launcher) {
				const id = subLauncherId(launcher);
				if (!id) return;
				setDeleteBusy(true);
				try {
					await del(subPath(id));
					toast(t("sublauncher.deleted"));
					setDeleteTarget("");
					await loadLaunchers();
					if (typeof props.refresh === "function") props.refresh();
				} catch (error) {
					toast(t("toast.failed", { error: errText(t, error) }));
				}
				setDeleteBusy(false);
			}
			function finishJob(job, clear) {
				const failed = job && typeof job.status === "string" && job.status === "failed";
				if (failed) toast(t("toast.jobFailed", { error: errText(t, job && job.error) }));
				else toast(t("toast.jobDone"));
				clear("");
				loadLaunchers();
				loadCatalog(false);
				if (typeof props.refresh === "function") props.refresh();
			}
			const rows = list.map((launcher) => {
				const id = subLauncherId(launcher);
				const checking = checkBusy[id] === true;
				const updating = updateBusy[id] === true;
				const available = launcher && (launcher.updateAvailable === true || launcher.hasUpdate === true);
				const sourceText = subLauncherSourceText(t, launcher);
				return h(
					"div",
					{ key: id || subLauncherLabel(launcher), className: "dsl_card" },
					h(
						"div",
						{ className: "dsl_card_head" },
						h("span", { className: "dsl_card_name", title: subLauncherLabel(launcher) }, subLauncherLabel(launcher)),
						h(Badge, { tone: "info" }, t("sublauncher.version", { version: subLauncherVersion(launcher) })),
						available ? h(Badge, { tone: "warn" }, t("sublauncher.updateAvailable")) : null
					),
					h(
						"div",
						{ className: "dsl_card_meta" },
						h(MetaItem, { label: t("sublauncher.source"), value: sourceText, title: sourceText }),
						h(MetaItem, { label: t("sublauncher.sourceType"), value: t("sublauncher.gamesCount", { count: String(subLauncherGamesCount(launcher)) }) })
					),
					h(
						"div",
						{ className: "dsl_row" },
						h(Btn, { disabled: checking || updating, onClick: () => checkOne(launcher) }, checking ? t("sublauncher.checking") : t("sublauncher.check")),
						available ? h(Btn, { variant: "primary", disabled: updating || checking, onClick: () => updateOne(launcher) }, updating ? t("sublauncher.updating") : t("sublauncher.update")) : null,
						deleteTarget === id
							? h(
									"span",
									{ className: "dsl_row" },
									h("span", { className: "dsl_hint" }, t("sublauncher.deleteConfirm", { name: subLauncherLabel(launcher) })),
									h(Btn, { variant: "danger", disabled: deleteBusy, onClick: () => removeOne(launcher) }, t("common.confirm")),
									h(Btn, { variant: "ghost", onClick: () => setDeleteTarget("") }, t("common.cancel"))
								)
							: h(Btn, { variant: "ghost", onClick: () => setDeleteTarget(id) }, t("sublauncher.delete"))
					),
					deleteTarget === id ? h("div", { className: "dsl_hint" }, t("sublauncher.deleteHint")) : null
				);
			});
			const catalogEntries = Array.isArray(catalog) ? catalog : [];
			const catalogRows = catalogEntries.map((entry) => {
				const entryId = scalarText(entry && entry.id, "");
				const entryLabel = brandSafe(scalarText(entry && (entry.label || entry.title || entry.id), "-"));
				const entryDescription = brandSafe(scalarText(entry && entry.description, ""));
				const entryVersion = brandSafe(scalarText(entry && entry.version, ""));
				const entrySource = subLauncherSourceText(t, entry);
				const entryInstalled = entry && entry.installed === true;
				const entryAvailable = entry && (entry.updateAvailable === true || entry.hasUpdate === true);
				const busy = catalogBusy[entryId] === true;
				return h(
					"div",
					{ key: entryId || entryLabel, className: "dsl_card" },
					h(
						"div",
						{ className: "dsl_card_head" },
						h("span", { className: "dsl_card_name", title: entryLabel }, entryLabel),
						entryVersion ? h(Badge, { tone: "info" }, t("sublauncher.version", { version: entryVersion })) : null,
						entryInstalled ? h(Badge, { tone: "on" }, t("catalog.installed")) : null,
						entryAvailable ? h(Badge, { tone: "warn" }, t("catalog.updateAvailable")) : null
					),
					entryDescription || entrySource
						? h(
								"div",
								{ className: "dsl_card_meta" },
								entryDescription ? h(MetaItem, { label: t("catalog.description"), value: entryDescription, title: entryDescription }) : null,
								entrySource ? h(MetaItem, { label: t("sublauncher.source"), value: entrySource, title: entrySource }) : null
							)
						: null,
					h(
						"div",
						{ className: "dsl_row" },
						entryInstalled && entryAvailable
							? h(Btn, { variant: "primary", disabled: busy, onClick: () => updateCatalogEntry(entry) }, busy ? t("catalog.updating") : t("catalog.update"))
							: entryInstalled
								? null
								: h(Btn, { variant: "primary", disabled: busy, onClick: () => installCatalog(entry) }, busy ? t("catalog.installing") : t("catalog.install"))
					)
				);
			});
			const installSection = h(
				"div",
				{ className: "dsl_section" },
				h("div", { className: "dsl_section_title" }, t("sublauncher.installTitle")),
				h("div", { className: "dsl_hint" }, t("sublauncher.installHint")),
				h(
					"div",
					{ className: "dsl_radios" },
					SUB_SOURCE_TYPES.map((type) =>
						h(
							"label",
							{ key: type, className: "dsl_radio" },
							h("input", { type: "radio", name: "sublauncher-source", checked: sourceId === type, onChange: () => setSourceType(type) }),
							h("span", null, t("sublauncher.sourceType." + type))
						)
					)
				),
				sourceId === "url"
					? h(
							Field,
							{ label: t("sublauncher.url"), hint: t("sublauncher.urlHint") },
							h("input", { className: "dsl_input", value: url, placeholder: t("sublauncher.urlPh"), onChange: (event) => setUrl(event.target.value) })
						)
					: sourceId === "file"
						? h(
								Field,
								{ label: t("sublauncher.file"), hint: t("sublauncher.fileHint") },
								h("input", { className: "dsl_input", value: file, placeholder: t("sublauncher.filePh"), onChange: (event) => setFile(event.target.value) })
							)
						: h(
								Field,
								{ label: t("sublauncher.repo"), hint: t("sublauncher.repoHint") },
								h("input", { className: "dsl_input", value: repo, placeholder: t("sublauncher.repoPh"), onChange: (event) => setRepo(event.target.value) })
							),
				h(
					"div",
					{ className: "dsl_row" },
					h(Btn, { variant: "ghost", onClick: () => setAdvancedOpen(!advancedOpen) }, advancedOpen ? t("sublauncher.advancedHide") : t("sublauncher.advanced"))
				),
				advancedOpen
					? h(
							Field,
							{ label: t("sublauncher.assetPattern"), hint: t("sublauncher.assetPatternHint") },
							h("input", { className: "dsl_input", value: assetPattern, placeholder: t("sublauncher.assetPatternPh"), onChange: (event) => setAssetPattern(event.target.value) })
						)
					: null,
				h(
					"div",
					{ className: "dsl_row" },
					h(Btn, { variant: "primary", disabled: installing, onClick: installSub }, installing ? t("sublauncher.installing") : t("sublauncher.install"))
				)
			);
			const catalogSection = h(
				"div",
				{ className: "dsl_section" },
				h(
					"div",
					{ className: "dsl_row" },
					h("div", { className: "dsl_section_title" }, t("catalog.title")),
					h(Btn, { variant: "ghost", disabled: catalogLoading, onClick: () => loadCatalog(true) }, catalogLoading ? t("catalog.loading") : t("catalog.refresh"))
				),
				h("div", { className: "dsl_hint" }, t("catalog.hint")),
				catalogLoading && !catalogEntries.length ? h("div", { className: "dsl_hint" }, t("catalog.loading")) : null,
				catalogError ? h("div", { className: "dsl_error_text" }, t("catalog.error", { error: catalogError })) : null,
				!catalogLoading && !catalogEntries.length
					? h(
							"div",
							{ className: "dsl_empty" },
							h("div", { className: "dsl_empty_title" }, t("catalog.empty")),
							h("div", { className: "dsl_empty_hint" }, t("catalog.emptyHint"))
						)
					: null,
				catalogEntries.length ? h("div", { className: "dsl_cards" }, catalogRows) : null,
				h("div", { className: "dsl_hint" }, t("catalog.manualHint"))
			);
			const installedSection = h(
				"div",
				{ className: "dsl_section" },
				h(
					"div",
					{ className: "dsl_row" },
					h("div", { className: "dsl_section_title" }, t("sublauncher.installed")),
					h(Btn, { variant: "ghost", disabled: loading, onClick: loadLaunchers }, loading ? t("common.loading") : t("common.refresh"))
				),
				loading ? h("div", { className: "dsl_hint" }, t("sublauncher.loading")) : null,
				loadError ? h("div", { className: "dsl_error_text" }, t("toast.failed", { error: loadError })) : null,
				!loading && !loadError && !list.length ? h("div", { className: "dsl_empty" }, h("div", { className: "dsl_empty_title" }, t("sublauncher.empty"))) : null,
				list.length ? h("div", { className: "dsl_cards" }, rows) : null,
				updateJobId ? h(JobMonitor, { jobId: updateJobId, t: t, toast: toast, onDone: (job) => finishJob(job, setUpdateJobId) }) : null
			);
			return h(
				"div",
				null,
				h(
					"div",
					{ className: "dsl_section" },
					h("div", { className: "dsl_section_title" }, t("sublauncher.title")),
					h("div", { className: "dsl_hint" }, t("sublauncher.subtitle"))
				),
				installSection,
				catalogSection,
				installJobId ? h(JobMonitor, { jobId: installJobId, t: t, toast: toast, onDone: (job) => finishJob(job, setInstallJobId) }) : null,
				installedSection
			);
		}

		// ------------------------------------------------------------------
		// 设置 tab：数据目录 / 下载并发 / 重试次数 / 统计。
		// ------------------------------------------------------------------
		function SettingsTab(props) {
			const t = makeT(props.t);
			const config = props.config && typeof props.config === "object" ? props.config : {};
			const snapshot = props.snapshot && typeof props.snapshot === "object" ? props.snapshot : {};
			const [draft, setDraft] = react.useState({});
			const [saving, setSaving] = react.useState(false);
			const view = Object.assign(
				{
					downloadConcurrency: configConcurrency(config),
					retries: configRetries(config),
				},
				draft && typeof draft === "object" ? draft : {}
			);
			const update = (patch) => setDraft((current) => Object.assign({}, current && typeof current === "object" ? current : {}, patch));
			const save = async () => {
				const concurrency = Number(view.downloadConcurrency);
				if (!isFinite(concurrency) || concurrency < 1 || concurrency > 32 || Math.round(concurrency) !== concurrency) {
					props.toast(t("settings.invalidConcurrency"));
					return;
				}
				const retries = Number(view.retries);
				if (!isFinite(retries) || retries < 0 || retries > 10 || Math.round(retries) !== retries) {
					props.toast(t("settings.invalidRetries"));
					return;
				}
				setSaving(true);
				try {
					await request("/config", { method: "PATCH", body: { downloadConcurrency: concurrency, retries: retries } });
					props.toast(t("toast.configSaved"));
					setDraft({});
					if (typeof props.refresh === "function") props.refresh();
				} catch (error) {
					props.toast(t("toast.failed", { error: errText(t, error) }));
				}
				setSaving(false);
			};
			const instances = Array.isArray(snapshot.instances) ? snapshot.instances : [];
			const jobs = Array.isArray(snapshot.jobs) ? snapshot.jobs : [];
			const dataRoot = brandSafe(scalarText(config.dataRoot, "-"));
			return h(
				"div",
				{ className: "dsl_section" },
				h("div", { className: "dsl_section_title" }, t("settings.title")),
				h(
					"div",
					{ className: "dsl_grid" },
					h(
						Field,
						{ label: t("settings.dataRoot"), hint: t("settings.dataRootHint") },
						h("input", { className: "dsl_input", type: "text", value: dataRoot, readOnly: true })
					),
					h(
						Field,
						{ label: t("settings.concurrency"), hint: t("settings.concurrencyHint") },
						h("input", {
							className: "dsl_input",
							type: "number",
							min: 1,
							max: 32,
							value: scalarText(view.downloadConcurrency, ""),
							onChange: (event) => update({ downloadConcurrency: event && event.target ? event.target.value : "" }),
						})
					),
					h(
						Field,
						{ label: t("settings.retries"), hint: t("settings.retriesHint") },
						h("input", {
							className: "dsl_input",
							type: "number",
							min: 0,
							max: 10,
							value: scalarText(view.retries, ""),
							onChange: (event) => update({ retries: event && event.target ? event.target.value : "" }),
						})
					)
				),
				h("div", { className: "dsl_section_hint" }, t("settings.stats") + "：" + t("common.instances", { count: instances.length }) + " · " + t("instance.job") + " " + jobs.length),
				h(
					"div",
					{ className: "dsl_row" },
					h(Btn, { variant: "primary", onClick: save, disabled: saving }, saving ? t("settings.saving") : t("settings.save"))
				)
			);
		}

		const inject = ["slots", "locale"];

		function apply(ctx) {
			ctx.effect(() => ctx.locale.register(NS, { zh: DICT_ZH, en: DICT_EN }), "dsh-launcher: dictionaries");
			ctx.effect(() => installStyles(), "dsh-launcher: styles");
			ctx.slots.inject("sidebar.footer.action", () =>
				ctx.slots.register(
					{
						name: "sidebar.footer.action",
						id: "launcher",
						order: ENTRY_ORDER,
						locale: NS,
					},
					LauncherEntry
				)
			);
		}

		exports.apply = apply;
		exports.inject = inject;

		return module.exports;
	},
});
