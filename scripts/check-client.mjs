// 静态检查 + 渲染冒烟测试（零依赖，node 直接运行）。
// 用法：node scripts/check-client.mjs
// 通过：打印 PASS 汇总并以 0 退出；失败：打印 FAIL 原因并以 1 退出。
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CLIENT_FILE = join(ROOT, "client.js");
const LOCALE_DIR = join(ROOT, "locale");
const MODULE_ID = "@local/dsh-launcher";
const SLOT_NAME = "sidebar.footer.action";
const API = "/dsh-launcher/api";

// 品牌词用码点拼装，避免本检查脚本自身命中品牌扫描。
const BRAND_A = String.fromCharCode(109, 105, 110, 101, 99, 114, 97, 102, 116);
const BRAND_B = String.fromCharCode(109, 111, 106, 97, 110, 103);
const BRAND_C = String.fromCharCode(25105, 30340, 19990, 30028);
const SHORT = String.fromCharCode(109, 99);
const BANNED = [
	{ label: "具体游戏名（英文）", re: new RegExp(BRAND_A, "i") },
	{ label: "具体平台名（英文）", re: new RegExp(BRAND_B, "i") },
	{ label: "具体游戏名（中文）", re: new RegExp(BRAND_C) },
	{ label: "独立缩写", re: new RegExp("(^|[^A-Za-z0-9])" + SHORT + "([^A-Za-z0-9]|$)", "i") },
];

const results = { pass: 0, fail: 0, failures: [] };

function assert(value, message) {
	if (!value) throw new Error(message || "断言失败");
}

function eq(actual, expected, message) {
	const left = JSON.stringify(actual);
	const right = JSON.stringify(expected);
	if (left !== right) throw new Error((message || "值不相等") + "：actual=" + left + " expected=" + right);
}

function includes(haystack, needle, message) {
	if (String(haystack).indexOf(needle) < 0) throw new Error((message || "缺少内容") + "：" + needle);
}

function excludes(haystack, needle, message) {
	if (String(haystack).indexOf(needle) >= 0) throw new Error((message || "不应包含") + "：" + needle);
}

async function check(name, fn) {
	try {
		await fn();
		results.pass += 1;
		console.log("PASS  " + name);
	} catch (error) {
		results.fail += 1;
		results.failures.push({ name: name, error: error });
		console.log("FAIL  " + name);
		console.log("      " + String((error && error.message) || error).split("\n")[0]);
	}
}

function assertNoBanned(text, label) {
	const value = String(text || "");
	BANNED.forEach((entry) => {
		const match = value.match(entry.re);
		if (match) throw new Error(label + " 命中禁用词「" + entry.label + "」：" + match[0]);
	});
}

// ---------------------------------------------------------------------------
// 假 DOM / window
// ---------------------------------------------------------------------------
function makeFakeDocument() {
	const log = { createElementCount: 0, appendCount: 0, styles: [], listeners: {} };
	const document = {
		head: {
			appendChild(node) {
				log.appendCount += 1;
				if (node && typeof node.textContent === "string" && node.textContent) log.styles.push(node.textContent);
			},
		},
		createElement(tag) {
			log.createElementCount += 1;
			return { tagName: String(tag).toUpperCase(), id: "", textContent: "", remove() {} };
		},
		getElementById() {
			return null;
		},
		addEventListener(type, fn) {
			if (!log.listeners[type]) log.listeners[type] = [];
			log.listeners[type].push(fn);
		},
		removeEventListener(type, fn) {
			const list = log.listeners[type] || [];
			const index = list.indexOf(fn);
			if (index >= 0) list.splice(index, 1);
		},
	};
	return {
		document: document,
		log: log,
		dispatch(type, event) {
			(log.listeners[type] || []).slice().forEach((fn) => fn(event));
		},
	};
}

// ---------------------------------------------------------------------------
// 假 React 运行时：状态 / ref / memo / callback / effect / 重渲染
// ---------------------------------------------------------------------------
const FRAGMENT = Symbol.for("react.fragment");

function createRuntime() {
	const feeds = [];
	const stores = new Map();
	const setterCalls = [];
	let current = null;
	let effectQueue = [];
	let pending = false;
	let visited = new Set();
	let renderCount = 0;
	let lastTree = null;
	let lastRoot = null;

	const flatten = (list) => {
		const out = [];
		const walk = (value) => {
			if (Array.isArray(value)) value.forEach(walk);
			else out.push(value);
		};
		list.forEach(walk);
		return out;
	};

	const hookSlot = () => {
		const store = current;
		const index = store.index;
		store.index += 1;
		if (!store.hooks[index]) store.hooks[index] = { initialized: false };
		return store.hooks[index];
	};

	const depsChanged = (slot, deps) => {
		if (!slot.initialized) return true;
		if (!deps) return true;
		const previous = slot.deps;
		if (!previous || previous.length !== deps.length) return true;
		for (let i = 0; i < deps.length; i += 1) {
			if (!Object.is(previous[i], deps[i])) return true;
		}
		return false;
	};

	const useEffectImpl = (fn, deps) => {
		const slot = hookSlot();
		if (!depsChanged(slot, deps)) return;
		slot.initialized = true;
		slot.deps = deps;
		effectQueue.push({ slot: slot, fn: fn });
	};

	const react = {
		createElement(type, props, ...children) {
			return { type: type, props: props || {}, children: flatten(children) };
		},
		Fragment: FRAGMENT,
		useState(initial) {
			const slot = hookSlot();
			const store = current;
			if (!slot.initialized) {
				slot.initialized = true;
				slot.value = feeds.length ? feeds.shift() : typeof initial === "function" ? initial() : initial;
			}
			const setValue = (update) => {
				const next = typeof update === "function" ? update(slot.value) : update;
				if (Object.is(next, slot.value)) return;
				slot.value = next;
				pending = true;
				setterCalls.push({ component: store.type && store.type.name ? store.type.name : "?", value: next });
			};
			return [slot.value, setValue];
		},
		useRef(initial) {
			const slot = hookSlot();
			if (!slot.initialized) {
				slot.initialized = true;
				slot.value = { current: initial };
			}
			return slot.value;
		},
		useMemo(factory, deps) {
			const slot = hookSlot();
			if (depsChanged(slot, deps)) {
				slot.initialized = true;
				slot.deps = deps;
				slot.value = factory();
			}
			return slot.value;
		},
		useCallback(fn, deps) {
			const slot = hookSlot();
			if (depsChanged(slot, deps)) {
				slot.initialized = true;
				slot.deps = deps;
				slot.value = fn;
			}
			return slot.value;
		},
		useEffect: useEffectImpl,
		useLayoutEffect: useEffectImpl,
		useReducer(state) {
			return [state, () => {}];
		},
	};

	const invoke = (type, node) => {
		let store = stores.get(type);
		if (!store) {
			store = { type: type, hooks: [], index: 0 };
			stores.set(type, store);
		}
		visited.add(type);
		const props = Object.assign({}, node.props || {});
		if (node.children && node.children.length) props.children = node.children.length === 1 ? node.children[0] : node.children;
		const previous = current;
		current = store;
		store.index = 0;
		let output;
		try {
			output = type(props);
		} finally {
			current = previous;
		}
		return output;
	};

	const renderNode = (node, depth) => {
		if (depth > 200) throw new Error("渲染层级过深");
		if (node === null || node === undefined || node === false || node === true) return node;
		if (Array.isArray(node)) return node.map((child) => renderNode(child, depth + 1));
		if (typeof node !== "object") return node;
		if (node.type === FRAGMENT) return renderNode(flatten(node.children), depth + 1);
		if (typeof node.type === "function") return renderNode(invoke(node.type, node), depth + 1);
		const props = Object.assign({}, node.props || {});
		const kids = flatten(node.children && node.children.length ? node.children : props.children !== undefined ? [].concat(props.children) : []);
		return { type: node.type, props: props, children: kids.map((child) => renderNode(child, depth + 1)) };
	};

	const runEffects = () => {
		const queue = effectQueue;
		effectQueue = [];
		queue.forEach((item) => {
			const slot = item.slot;
			if (typeof slot.cleanup === "function") slot.cleanup();
			slot.cleanup = null;
			const cleanup = item.fn();
			slot.cleanup = typeof cleanup === "function" ? cleanup : null;
		});
	};

	const cleanupUnmounted = () => {
		Array.from(stores.keys()).forEach((type) => {
			if (visited.has(type)) return;
			const store = stores.get(type);
			store.hooks.forEach((slot) => {
				if (slot && typeof slot.cleanup === "function") {
					try {
						slot.cleanup();
					} catch (error) {
						/* 卸载清理异常不参与断言 */
					}
					slot.cleanup = null;
				}
			});
			stores.delete(type);
		});
	};

	const renderRoot = (component, props) => {
		lastRoot = { component: component, props: props };
		for (let pass = 0; pass < 40; pass += 1) {
			pending = false;
			visited = new Set();
			effectQueue = [];
			renderCount += 1;
			lastTree = renderNode({ type: component, props: props || {}, children: [] }, 0);
			runEffects();
			cleanupUnmounted();
			if (!pending) return lastTree;
		}
		throw new Error("渲染未收敛（疑似状态循环）");
	};

	const flush = async () => {
		const root = lastRoot;
		if (!root) return lastTree;
		for (let round = 0; round < 12; round += 1) {
			await new Promise((tick) => setImmediate(tick));
			lastTree = renderRoot(root.component, root.props);
			await new Promise((tick) => setImmediate(tick));
			if (!pending) return lastTree;
		}
		return lastTree;
	};

	return {
		react: react,
		setterCalls: setterCalls,
		renderCount: () => renderCount,
		mount(component, props, initialFeeds) {
			if (Array.isArray(initialFeeds)) initialFeeds.forEach((value) => feeds.push(value));
			return renderRoot(component, props || {});
		},
		feedRemaining: () => feeds.length,
		tree: () => lastTree,
		flush: flush,
	};
}

// ---------------------------------------------------------------------------
// 渲染树工具
// ---------------------------------------------------------------------------
function textOf(node) {
	const parts = [];
	const walk = (value) => {
		if (value === null || value === undefined || value === false || value === true) return;
		if (Array.isArray(value)) {
			value.forEach(walk);
			return;
		}
		if (typeof value === "string" || typeof value === "number") {
			parts.push(String(value));
			return;
		}
		if (typeof value === "object") {
			const props = value.props || {};
			["title", "placeholder", "aria-label", "alt"].forEach((key) => {
				if (typeof props[key] === "string") parts.push(props[key]);
			});
			(value.children || []).forEach(walk);
		}
	};
	walk(node);
	return parts.join(" ").replace(/\s+/g, " ").trim();
}

function walkNodes(node, visit) {
	if (!node) return;
	if (Array.isArray(node)) {
		node.forEach((child) => walkNodes(child, visit));
		return;
	}
	if (typeof node !== "object") return;
	visit(node);
	(node.children || []).forEach((child) => walkNodes(child, visit));
}

function findAll(node, predicate) {
	const found = [];
	walkNodes(node, (item) => {
		if (typeof item.type === "string" && predicate(item, textOf(item))) found.push(item);
	});
	return found;
}

function findByClass(tree, className) {
	return (
		findAll(tree, (node) => typeof node.props.className === "string" && node.props.className.split(/\s+/).indexOf(className) >= 0)[0] || null
	);
}

function findClickableByText(tree, text) {
	return findAll(tree, (node, own) => typeof node.props.onClick === "function" && own === text)[0] || null;
}

function findClickableContaining(tree, text) {
	return findAll(tree, (node, own) => typeof node.props.onClick === "function" && own.indexOf(text) >= 0)[0] || null;
}

async function clickNode(client, node) {
	assert(node, "找不到可点击元素");
	assert(typeof node.props.onClick === "function", "元素没有 onClick");
	await node.props.onClick({ target: node, currentTarget: node });
	return client.runtime.flush();
}

async function clickText(client, text) {
	const tree = client.runtime.tree();
	const node = findClickableByText(tree, text);
	if (!node) throw new Error("找不到按钮「" + text + "」；当前文本：" + textOf(tree).slice(0, 500));
	return clickNode(client, node);
}

// ---------------------------------------------------------------------------
// 假服务端数据
// ---------------------------------------------------------------------------
const JOB_FIXTURE = {
	id: "job-1",
	kind: "install",
	title: "安装示例实例",
	status: "running",
	phase: "正在下载",
	message: "正在下载内容",
	progress: { done: 2, total: 5, label: "下载中", bytes: 1048576 },
	log: ["准备安装", "开始下载"],
	instanceId: "inst-1",
	cancelRequested: false,
};

const FIXTURE_GAMES = [
	{
		id: "example",
		label: "示例游戏",
		versionLabel: "游戏版本",
		contentLabel: "内容",
		capabilities: { content: true, loaders: true, runtimes: false },
		instanceOptions: [
			{ key: "memory", label: "内存 (MB)", type: "number", default: 2048, description: "分配给实例的内存" },
			{
				key: "channel",
				label: "更新通道",
				type: "select",
				default: "stable",
				choices: [
					{ value: "stable", label: "稳定版" },
					{ value: "beta", label: "测试版" },
				],
			},
			{ key: "beta", label: "参与测试", type: "boolean", default: false },
		],
		source: "user",
		providerType: "github",
	},
	{
		id: "second",
		label: "另一个游戏",
		versionLabel: "游戏版本",
		capabilities: { content: false, loaders: false, runtimes: true },
		instanceOptions: [],
		source: "external",
	},
	{
		id: "third",
		label: "内置示例",
		capabilities: { content: true, loaders: false, runtimes: false },
		instanceOptions: [],
		source: "builtin",
	},
];

const FIXTURE_INSTANCES = [
	{
		id: "inst-1",
		name: "示例实例",
		game: "example",
		gameLabel: "示例游戏",
		versionId: "2.0.0",
		status: "ready",
		memoryMb: 2048,
		contentCount: 1,
		playCount: 2,
		lastLaunchAt: "2026-10-20T12:34:00.000Z",
		running: false,
		installError: "",
	},
	{
		id: "inst-2",
		name: "另一个实例",
		game: "second",
		gameLabel: "另一个游戏",
		versionId: "1.0.0",
		status: "ready",
		contentCount: 0,
		playCount: 0,
		lastLaunchAt: null,
		running: false,
	},
];

function makeSnapshot(extra) {
	return Object.assign(
		{
			config: { dataRoot: "C:/DSH/data", downloadConcurrency: 16, retries: 3 },
			games: FIXTURE_GAMES,
			instances: FIXTURE_INSTANCES,
			running: [],
			jobs: [JOB_FIXTURE],
		},
		extra || {}
	);
}

const SNAPSHOT = makeSnapshot();
const SNAPSHOT_EMPTY = makeSnapshot({ games: [] });

const VERSIONS_FIXTURE = {
	game: "example",
	latestRelease: "2.0.0",
	releases: [
		{ id: "1.0.0", label: "1.0.0", releaseTime: "2026-01-01T00:00:00.000Z" },
		{ id: "2.0.0", label: "2.0.0", releaseTime: "2026-02-01T00:00:00.000Z" },
	],
	count: 2,
};

const DETAIL_FIXTURE = {
	instance: {
		id: "inst-1",
		name: "示例实例",
		game: "example",
		versionId: "2.0.0",
		status: "ready",
		content: [{ filename: "mod-a.zip", title: "示例内容 A", size: 1048576 }],
	},
	game: "example",
	gameLabel: "示例游戏",
	gameDir: "C:/DSH/data/instances/inst-1/game",
	contentDir: "C:/DSH/data/instances/inst-1/game/content",
	logsDir: "C:/DSH/data/instances/inst-1/logs",
	running: false,
	capabilities: { content: true },
};

const HITS_FIXTURE = [
	{ slug: "alpha", title: "示例内容 A", description: "示例描述 A", downloads: 10 },
	{ projectId: "project-2", title: "示例内容 B", description: "示例描述 B", downloads: 4 },
];

const SUB_LAUNCHERS_FIXTURE = [
	{
		id: "sub-example",
		label: "示例附属启动器",
		version: "1.0.0",
		source: "repo",
		repo: "owner/name",
		updateAvailable: true,
		installedAt: "2026-10-20T00:00:00.000Z",
		updatedAt: "2026-10-20T00:00:00.000Z",
		games: ["example"],
	},
];

const CATALOG_FIXTURE = [
	{
		id: "sub-example",
		label: "示例附属启动器",
		repo: "owner/name",
		description: "示例推荐条目",
		version: "1.1.0",
		installed: true,
		updateAvailable: true,
	},
	{
		id: "sub-catalog",
		label: "推荐附属启动器",
		url: "https://example.com/sub.zip",
		description: "推荐条目描述",
		version: "2.0.0",
		installed: false,
		updateAvailable: false,
	},
];

const HOSTILE_SNAPSHOT = {
	config: { dataRoot: { bad: true }, downloadConcurrency: { bad: 1 }, retries: { bad: 1 } },
	games: [
		{
			id: { bad: true },
			label: { bad: true },
			versionLabel: { bad: true },
			capabilities: { content: {}, loaders: {}, runtimes: {} },
			instanceOptions: [{ key: { bad: true }, label: { bad: true }, type: { bad: true }, default: { bad: true }, choices: [{ value: {}, label: {} }] }],
			source: {},
		},
	],
	instances: [
		{
			id: { bad: true },
			name: { bad: true },
			game: { bad: true },
			gameLabel: { bad: true },
			versionId: { bad: true },
			status: { bad: true },
			contentCount: { bad: true },
			lastLaunchAt: { bad: true },
			running: { bad: true },
			installError: { bad: true },
		},
	],
	running: [{}],
	jobs: [
		{
			id: { bad: true },
			kind: { bad: true },
			title: { bad: true },
			status: { bad: true },
			phase: { bad: true },
			message: { bad: true },
			progress: { done: {}, total: {}, bytes: {} },
			log: [{}],
		},
	],
};

const BRAND_CAP = BRAND_A.charAt(0).toUpperCase() + BRAND_A.slice(1);
const BRAND_SNAPSHOT = {
	config: { dataRoot: "C:/Users/demo/." + BRAND_A, downloadConcurrency: 4, retries: 2 },
	games: [
		{
			id: "brand-game",
			label: BRAND_CAP + " 生存",
			versionLabel: "游戏版本",
			capabilities: { content: true, loaders: true, runtimes: false },
			instanceOptions: [],
			source: "user",
			providerType: "github",
		},
	],
	instances: [
		{
			id: "brand-inst",
			name: BRAND_CAP + " 实例",
			game: "brand-game",
			gameLabel: BRAND_CAP + " 生存",
			versionId: BRAND_A + "-1.20",
			status: "ready",
			contentCount: 0,
			playCount: 1,
			lastLaunchAt: "2026-10-20T00:00:00.000Z",
			running: false,
			installError: "无法连接 " + BRAND_CAP + " 服务（" + BRAND_B + "）",
		},
	],
	running: [],
	jobs: [
		{
			id: "brand-job",
			kind: "install",
			title: BRAND_CAP + " 安装",
			status: "running",
			phase: "下载 " + BRAND_CAP,
			message: BRAND_B + " 服务",
			progress: { done: 1, total: 2, label: BRAND_CAP },
			log: [BRAND_CAP + " 日志"],
			instanceId: "brand-inst",
			cancelRequested: false,
		},
	],
};

// ---------------------------------------------------------------------------
// 加载 client.js
// ---------------------------------------------------------------------------
function loadClient(options) {
	const config = options || {};
	const fake = makeFakeDocument();
	const fetchCalls = [];
	const routes = [];
	const capture = { definition: null };
	const windowStub = {
		__ModuleLoader__: {
			load(definition) {
				capture.definition = definition;
			},
		},
		setTimeout() {
			return 0;
		},
		clearTimeout() {},
		setInterval() {
			return 0;
		},
		clearInterval() {},
		addEventListener() {},
		removeEventListener() {},
		location: { href: "http://127.0.0.1/" },
	};

	const apiPathOf = (url) => {
		const text = String(url);
		const index = text.indexOf(API);
		return index >= 0 ? text.slice(index + API.length) : text;
	};

	const stateData = config.stateData || SNAPSHOT;
	const fallbackPayload = (path, method) => {
		if (path === "/state") return stateData;
		if (path === "/catalog" || path.indexOf("/catalog?") === 0) {
			return config.catalogData || { entries: CATALOG_FIXTURE, source: "builtin", fetchedAt: "2026-10-22T00:00:00.000Z" };
		}
		if (path === "/sublaunchers" || path.indexOf("/sublaunchers?") === 0) return { launchers: config.launchersData || SUB_LAUNCHERS_FIXTURE };
		if (path === "/sublaunchers/install" && method === "POST") return { jobId: "job-sub" };
		if (/^\/sublaunchers\/[^/]+\/check$/.test(path) && method === "POST") return { id: "sub-example", installedVersion: "1.0.0", latestVersion: "1.1.0", updateAvailable: true };
		if (/^\/sublaunchers\/[^/]+\/update$/.test(path) && method === "POST") return { jobId: "job-up" };
		if (path.indexOf("/sublaunchers/") === 0 && method === "DELETE") return { removed: true };
		if (path.indexOf("/versions?") === 0) return config.versionsData || VERSIONS_FIXTURE;
		if (path.indexOf("/jobs/") === 0) return { job: config.jobData || JOB_FIXTURE };
		if (/^\/instances\/[^/?#]+$/.test(path) && method === "GET") return config.detailData || DETAIL_FIXTURE;
		if (path.indexOf("/content/search") === 0) {
			const hits = config.hitsData || HITS_FIXTURE;
			return { hits: hits, totalHits: hits.length };
		}
		if (path.indexOf("/instances/") === 0 && path.indexOf("/content") > 0 && method === "POST") return { added: [{}], contentCount: 2 };
		if (path.indexOf("/instances/") === 0 && path.indexOf("/content/") > 0 && method === "DELETE") return { removed: true, contentCount: 1 };
		if (path === "/install" && method === "POST") return { jobId: "job-test", instanceId: "inst-test" };
		if (path === "/games/test" && method === "POST") return { ok: true, detail: "连接正常" };
		if (path === "/games" && method === "POST") return { game: { id: "new-game", label: "新游戏", source: "user" } };
		if (path === "/games") return { games: stateData.games || [] };
		if (path === "/instances") return { instances: stateData.instances || [] };
		return {};
	};

	const fakeFetch = async (url, init) => {
		const method = init && init.method ? String(init.method) : "GET";
		let body = null;
		if (init && typeof init.body === "string" && init.body) {
			try {
				body = JSON.parse(init.body);
			} catch (error) {
				body = null;
			}
		}
		fetchCalls.push({ url: String(url), method: method, body: body });
		const path = apiPathOf(url);
		for (let i = 0; i < routes.length; i += 1) {
			const route = routes[i];
			if (route.test(path, method, body)) {
				const payload = typeof route.payload === "function" ? route.payload(path, method, body) : route.payload;
				return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, data: payload }) };
			}
		}
		return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, data: fallbackPayload(path, method) }) };
	};

	const sandbox = {
		window: windowStub,
		document: fake.document,
		navigator: { language: config.language || "zh-CN" },
		console: { log() {}, warn() {}, error() {}, info() {} },
		setTimeout() {
			return 0;
		},
		clearTimeout() {},
		setInterval() {
			return 0;
		},
		clearInterval() {},
		fetch: fakeFetch,
	};
	vm.createContext(sandbox);
	const source = readFileSync(CLIENT_FILE, "utf8");
	vm.runInContext(source, sandbox, { filename: CLIENT_FILE });
	const definition = capture.definition;
	if (!definition) throw new Error("client.js 没有通过 window.__ModuleLoader__.load 注册模块");

	const runtime = createRuntime();
	const requireCalls = [];
	const moduleExports = definition.factory((id) => {
		requireCalls.push(id);
		if (id !== "react") throw new Error('模块只允许 require("react")，实际：' + id);
		return runtime.react;
	});
	const afterFactory = {
		createElementCount: fake.log.createElementCount,
		appendCount: fake.log.appendCount,
		fetchCount: fetchCalls.length,
	};
	const calls = { locales: [], registrations: [], injects: [], effects: [], cleanups: [] };
	const ctx = {
		effect(fn, label) {
			calls.effects.push(String(label || ""));
			const cleanup = fn();
			calls.cleanups.push(cleanup);
			return cleanup;
		},
		locale: {
			register(namespace, dicts) {
				calls.locales.push({ namespace: namespace, zh: dicts.zh, en: dicts.en });
			},
		},
		slots: {
			inject(name, callback) {
				calls.injects.push(name);
				return callback();
			},
			register(opts, component) {
				calls.registrations.push({ opts: opts, component: component });
				return () => {};
			},
		},
	};
	moduleExports.apply(ctx);
	return {
		source: source,
		definition: definition,
		moduleExports: moduleExports,
		requireCalls: requireCalls,
		afterFactory: afterFactory,
		calls: calls,
		documentLog: fake.log,
		dispatch: fake.dispatch,
		fetchCalls: fetchCalls,
		runtime: runtime,
		addRoute(test, payload) {
			routes.unshift({ test: test, payload: payload });
		},
	};
}

function styleText(client) {
	return client.documentLog.styles.join("\n");
}

function dictionary(client, language) {
	const entry = client.calls.locales[0];
	assert(entry, "没有调用 ctx.locale.register");
	return language === "en" ? entry.en : entry.zh;
}

// ---------------------------------------------------------------------------
// 渲染夹具：喂值顺序必须与组件内 hooks 顺序一致
// ---------------------------------------------------------------------------
function entryFeeds(snapshot, tab, gameId) {
	return [true, snapshot || SNAPSHOT, "", tab || "games", [], "", gameId || ""];
}

function gameDetailFeeds() {
	// GameDetail：versionsData, versionsLoading, versionsError, version, formOpen, name,
	// optionsDraft, query, hits, searching, picked, submitting, jobId
	return [VERSIONS_FIXTURE, false, "", "2.0.0", false, "", {}, "", [], false, [], false, ""];
}

function instanceListFeeds() {
	// InstanceList：busy, confirm, logs, openBusy
	return [{}, null, null, {}];
}

function gameContentFeeds() {
	// GameContent：instanceId, detail, detailLoading, detailError, query, hits, searching,
	// picked, adding, removeTarget, removeBusy
	return ["inst-1", null, false, "", "", [], false, [], false, "", false];
}

function addGameFeeds() {
	return ["github", "示例游戏", "", "owner/name", "", "run.exe", "", "", "", "", false, { ok: true, detail: "连接正常" }, false, "", false];
}

function settingsFeeds() {
	return [{}, false];
}

function subLauncherFeeds() {
	// SubLaunchersTab：launchers, loading, loadError, sourceType, repo, url, file,
	// assetPattern, advancedOpen, installing, installJobId, checkBusy, updateBusy,
	// deleteTarget, deleteBusy, updateJobId, catalog, catalogLoading, catalogError, catalogBusy
	return [SUB_LAUNCHERS_FIXTURE, false, "", "github", "owner/name", "", "", "", false, false, "", {}, {}, "", false, "", CATALOG_FIXTURE, false, "", {}];
}

function fullDetailFeeds(snapshot, gameId) {
	return entryFeeds(snapshot, "games", gameId || "example").concat(gameDetailFeeds()).concat(instanceListFeeds()).concat(gameContentFeeds());
}

async function mountEntry(client, feeds) {
	const component = client.calls.registrations[0].component;
	client.runtime.mount(component, {}, feeds);
	const remaining = client.runtime.feedRemaining();
	await client.runtime.flush();
	return { tree: client.runtime.tree(), remaining: remaining };
}

// ---------------------------------------------------------------------------
// 静态工具
// ---------------------------------------------------------------------------
function stripVarExpressions(text) {
	let out = "";
	let index = 0;
	while (index < text.length) {
		if (text.slice(index, index + 4) === "var(") {
			let depth = 0;
			let cursor = index + 3;
			for (; cursor < text.length; cursor += 1) {
				const ch = text[cursor];
				if (ch === "(") depth += 1;
				else if (ch === ")") {
					depth -= 1;
					if (depth === 0) {
						cursor += 1;
						break;
					}
				}
			}
			index = cursor;
			continue;
		}
		out += text[index];
		index += 1;
	}
	return out;
}

function countMatches(text, regex) {
	const matches = text.match(regex);
	return matches ? matches.length : 0;
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------
async function main() {
	const zhJson = JSON.parse(readFileSync(join(LOCALE_DIR, "zh.json"), "utf8"));
	const enJson = JSON.parse(readFileSync(join(LOCALE_DIR, "en.json"), "utf8"));
	const base = loadClient({});
	const zh = dictionary(base, "zh");
	const en = dictionary(base, "en");

	// ---------------- 1. 模块契约 ----------------
	await check("模块通过 window.__ModuleLoader__.load 注册且 id 正确", async () => {
		includes(base.source, "window.__ModuleLoader__.load", "缺少零构建模块入口");
		eq(base.definition.id, MODULE_ID, "模块 id 不符");
		assert(typeof base.definition.factory === "function", "factory 不是函数");
	});

	await check("工厂零副作用（渲染前无 DOM / fetch 调用）", async () => {
		eq(base.afterFactory.createElementCount, 0, "factory 阶段创建了 DOM 元素");
		eq(base.afterFactory.appendCount, 0, "factory 阶段挂载了 DOM");
		eq(base.afterFactory.fetchCount, 0, "factory 阶段发起了网络请求");
	});

	await check("导出 apply / inject，inject 含 slots 与 locale", async () => {
		assert(typeof base.moduleExports.apply === "function", "缺少 apply");
		eq(base.moduleExports.inject, ["slots", "locale"], "inject 不正确");
	});

	await check('工厂只 require("react")', async () => {
		eq(base.requireCalls, ["react"], "require 依赖不符");
	});

	await check("注册 sidebar.footer.action（id launcher / order 60 / locale launcher）", async () => {
		eq(base.calls.injects, [SLOT_NAME], "slot 注入名不符");
		eq(base.calls.registrations.length, 1, "slot 注册数量不符");
		const registration = base.calls.registrations[0];
		eq(registration.opts.name, SLOT_NAME, "slot 名不符");
		eq(registration.opts.id, "launcher", "slot id 不符");
		eq(registration.opts.order, 60, "slot order 不符");
		eq(registration.opts.locale, "launcher", "slot locale 不符");
		assert(typeof registration.component === "function", "slot 组件不是函数");
	});

	await check("locale 注册 zh / en，键集合一致且数量 >= 150", async () => {
		eq(base.calls.locales.length, 1, "locale.register 调用次数不符");
		const entry = base.calls.locales[0];
		eq(entry.namespace, "launcher", "locale 命名空间不符");
		const zhKeys = Object.keys(entry.zh);
		const enKeys = Object.keys(entry.en);
		assert(zhKeys.length >= 150, "词典键数量过少：" + zhKeys.length);
		eq(zhKeys.slice().sort(), enKeys.slice().sort(), "zh / en 键集合不一致");
	});

	await check("样式经 ctx.effect 注入（固定浮层 z-index 4000 + 主题变量）", async () => {
		assert(base.calls.effects.length >= 2, "ctx.effect 数量不足");
		assert(base.calls.cleanups.filter((item) => typeof item === "function").length >= 1, "样式 effect 没有返回清理函数");
		eq(base.documentLog.createElementCount, 1, "样式元素创建次数不符");
		eq(base.documentLog.appendCount, 1, "样式挂载次数不符");
		const css = styleText(base);
		assert(css.length > 4000, "样式内容过短：" + css.length);
		includes(css, ".dsl_layer", "缺少浮层样式");
		includes(css, "position:fixed", "浮层不是 fixed");
		includes(css, "z-index:4000", "浮层 z-index 不是 4000");
		includes(css, ".dsl_panel", "缺少面板样式");
		includes(css, "var(--dsw-alias-", "缺少主题变量");
		assert(countMatches(css, /var\(--dsw-alias-/g) >= 30, "主题变量数量不足");
	});

	await check("样式颜色全部走主题变量（无裸色值）", async () => {
		const stripped = stripVarExpressions(styleText(base));
		const bare = stripped.match(/#[0-9a-fA-F]{3,8}\b|\brgba?\s*\(|\bhsla?\s*\(/g) || [];
		eq(bare, [], "存在未包裹在 var() 中的颜色值");
	});

	await check("常量：轮询间隔 / 任务轮询 / 日志行数 / 入口顺序 / 来源", async () => {
		includes(base.source, "POLL_MS = 1500", "POLL_MS 应为 1500");
		includes(base.source, "JOB_POLL_MS = 1000", "JOB_POLL_MS 应为 1000");
		includes(base.source, "LOG_LINES = 200", "LOG_LINES 应为 200");
		includes(base.source, "ENTRY_ORDER = 60", "ENTRY_ORDER 应为 60");
		includes(base.source, '["github", "url", "manual"]', "来源提供者列表不符");
	});

	await check("API 路径字面量齐全（含 PATCH 配置）", async () => {
		const literals = [
			'"/state"',
			'"/games"',
			'"/games/test"',
			'"/versions?game="',
			'"/content/search?"',
			'"/install"',
			'"/instances/"',
			'"/launch"',
			'"/stop"',
			'"/log?lines="',
			'"/open"',
			'"/jobs/"',
			'"/cancel"',
			'"/config"',
			'"/content/"',
			'"/catalog"',
			'"PATCH"',
		];
		literals.forEach((literal) => includes(base.source, literal, "缺少接口字面量"));
	});

	await check("源码无 import / export 语句", async () => {
		assert(!/^\s*import\s/m.test(base.source), "源码包含 import");
		assert(!/^\s*export\s/m.test(base.source), "源码包含 export");
	});

	await check("client.js 无禁用品牌词", async () => {
		assertNoBanned(base.source, "client.js");
	});

	// ---------------- 2. 词典与 locale JSON ----------------
	await check("词典标题 / 入口 / 四个 tab 文案", async () => {
		eq(zh.title, "DSH启动器", "中文标题不符");
		eq(en.title, "DSH Launcher", "英文标题不符");
		eq(zh["entry.label"], "启动游戏", "中文入口文案不符");
		eq(en["entry.label"], "Launch", "英文入口文案不符");
		eq(zh["tab.games"], "游戏", "游戏 tab 文案不符");
		eq(zh["tab.sublaunchers"], "附属启动器", "附属启动器 tab 文案不符");
		eq(en["tab.sublaunchers"], "Sub-launchers", "附属启动器英文 tab 文案不符");
		eq(zh["tab.addGame"], "添加游戏", "添加游戏 tab 文案不符");
		eq(zh["tab.settings"], "设置", "设置 tab 文案不符");
	});

	await check("词典只保留游戏 / 附属启动器 / 添加游戏 / 设置四个 tab", async () => {
		const keys = Object.keys(zh);
		assert(keys.indexOf("tab.create") < 0, "不应再存在 tab.create");
		assert(keys.indexOf("tab.content") < 0, "不应再存在 tab.content");
		eq(
			keys.filter((key) => key.indexOf("tab.") === 0).sort(),
			["tab.addGame", "tab.games", "tab.settings", "tab.sublaunchers"],
			"tab 键集合不符"
		);
	});

	await check("词典关键键族齐全（中英均非空）", async () => {
		const required = [
			"title",
			"entry.label",
			"entry.open",
			"header.dataRoot",
			"header.stateError",
			"common.back",
			"common.confirm",
			"common.cancel",
			"common.loading",
			"footer.hint",
			"games.title",
			"games.empty",
			"games.emptyHint",
			"games.emptyActionAdd",
			"games.open",
			"detail.back",
			"detail.versions",
			"detail.versionsLoading",
			"detail.versionsEmpty",
			"detail.install",
			"detail.installTitle",
			"detail.submit",
			"detail.instances",
			"detail.noInstances",
			"detail.content",
			"detail.contentInstance",
			"detail.installed",
			"detail.installedEmpty",
			"detail.addContent",
			"detail.removeContent",
			"detail.removeConfirm",
			"instance.launch",
			"instance.stop",
			"instance.log",
			"instance.openGame",
			"instance.openContent",
			"instance.delete",
			"instance.deleteConfirm",
			"addGame.provider",
			"addGame.providerGithub",
			"addGame.providerUrl",
			"addGame.providerManual",
			"tab.sublaunchers",
			"sublauncher.title",
			"sublauncher.installTitle",
			"sublauncher.install",
			"sublauncher.installed",
			"sublauncher.check",
			"sublauncher.update",
			"sublauncher.delete",
			"sublauncher.needSource",
			"sublauncher.deleteConfirm",
			"addGame.repo",
			"addGame.test",
			"addGame.save",
			"addGame.source.user",
			"addGame.added",
			"settings.dataRoot",
			"settings.concurrency",
			"settings.retries",
			"settings.save",
			"jobs.cancel",
			"toast.failed",
			"toast.gameAdded",
		];
		required.forEach((key) => {
			assert(typeof zh[key] === "string" && zh[key].length > 0, "中文词典缺少或为空：" + key);
			assert(typeof en[key] === "string" && en[key].length > 0, "英文词典缺少或为空：" + key);
		});
	});

	await check("词典无禁用品牌词", async () => {
		assertNoBanned(Object.values(zh).join("\n"), "zh 词典");
		assertNoBanned(Object.values(en).join("\n"), "en 词典");
	});

	await check("locale JSON 的 meta 正确（标题 + 通用描述）", async () => {
		eq(zhJson.meta && zhJson.meta.title, "DSH启动器", "zh.json meta.title 不符");
		eq(enJson.meta && enJson.meta.title, "DSH Launcher", "en.json meta.title 不符");
		assert(typeof zhJson.meta.description === "string" && zhJson.meta.description.length > 0, "zh.json 缺少 description");
		assert(typeof enJson.meta.description === "string" && enJson.meta.description.length > 0, "en.json 缺少 description");
		assertNoBanned(zhJson.meta.description, "zh.json description");
		assertNoBanned(enJson.meta.description, "en.json description");
	});

	await check("locale JSON 的 ui 与代码词典逐键一致", async () => {
		eq(Object.keys(zhJson.ui || {}).slice().sort(), Object.keys(zh).slice().sort(), "zh.json ui 与代码词典不一致");
		eq(Object.keys(enJson.ui || {}).slice().sort(), Object.keys(en).slice().sort(), "en.json ui 与代码词典不一致");
		assertNoBanned(Object.values(zhJson.ui || {}).join("\n"), "zh.json ui");
		assertNoBanned(Object.values(enJson.ui || {}).join("\n"), "en.json ui");
	});

	// ---------------- 3. 渲染场景 ----------------
	const stats = { count: 0, nodes: 0, chars: 0 };

	function countNodes(tree) {
		let total = 0;
		walkNodes(tree, () => {
			total += 1;
		});
		return total;
	}

	async function scenario(label, client, feeds, expect) {
		const mounted = await mountEntry(client, feeds);
		eq(mounted.remaining, 0, label + "：状态喂值未消费完（剩余 " + mounted.remaining + "）");
		const text = textOf(mounted.tree);
		assert(text.length > 0, label + "：渲染文本为空");
		const nodes = countNodes(mounted.tree);
		stats.count += 1;
		stats.nodes += nodes;
		stats.chars += text.length;
		excludes(text, "[object Object]", label + "：出现 [object Object]");
		excludes(text, "undefined", label + "：出现 undefined");
		excludes(text, "NaN", label + "：出现 NaN");
		assertNoBanned(text, label);
		(expect || []).forEach((needle) => includes(text, needle, label + "：缺少文案 " + needle));
		return { text: text, tree: mounted.tree };
	}

	await check("入口默认渲染（面板未打开）", async () => {
		const client = loadClient({});
		const mounted = await mountEntry(client, [false]);
		eq(mounted.remaining, 0, "入口 state 未消费完");
		const text = textOf(mounted.tree);
		includes(text, "启动游戏", "缺少入口文案");
		excludes(text, "数据目录", "面板不应在关闭时渲染");
	});

	await scenario("游戏列表", loadClient({}), entryFeeds(SNAPSHOT), ["DSH启动器", "游戏", "添加游戏", "设置", "示例游戏", "另一个游戏", "内置示例", "进入"]);

	await scenario("游戏列表空态", loadClient({ stateData: SNAPSHOT_EMPTY }), [true, SNAPSHOT_EMPTY, "", "games", [], "", ""], ["还没有添加任何游戏", "先添加一个游戏"]);

	const detailScene = await scenario(
		"游戏详情",
		loadClient({}),
		fullDetailFeeds(SNAPSHOT, "example"),
		["示例游戏", "返回游戏列表", "下载并安装", "示例实例", "内容管理", "已安装内容"]
	);
	excludes(detailScene.text, "另一个实例", "详情不应显示其他游戏的实例");

	await scenario("添加游戏", loadClient({}), entryFeeds(SNAPSHOT, "addGame").concat(addGameFeeds()), [
		"来源类型",
		"代码托管发布",
		"URL 清单",
		"手动导入",
		"测试连接",
		"保存游戏",
		"已添加的游戏",
		"连接正常",
		"示例游戏",
	]);

	await scenario("设置", loadClient({}), entryFeeds(SNAPSHOT, "settings").concat(settingsFeeds()), ["数据目录", "C:/DSH/data", "下载并发", "重试次数", "统计", "保存设置"]);

	await scenario("附属启动器", loadClient({}), entryFeeds(SNAPSHOT, "sublaunchers").concat(subLauncherFeeds()), [
		"附属启动器",
		"独立项目",
		"安装附属启动器",
		"推荐目录",
		"刷新推荐",
		"示例推荐条目",
		"推荐附属启动器",
		"可更新",
		"已安装",
		"已安装的附属启动器",
		"示例附属启动器",
		"版本 1.0.0",
		"有更新可用",
		"检查更新",
		"更新",
		"删除",
		"来源",
		"提供游戏 1 个",
	]);

	await scenario("附属启动器推荐目录空态", loadClient({ catalogData: [] }), entryFeeds(SNAPSHOT, "sublaunchers").concat(subLauncherFeeds()), [
		"推荐目录暂时没有可用的附属启动器",
		"仍可手动填写仓库",
	]);

	await scenario(
		"附属启动器推荐目录读取失败",
		loadClient({ catalogData: { entries: [], source: "builtin", error: "目录服务不可用" } }),
		entryFeeds(SNAPSHOT, "sublaunchers").concat(subLauncherFeeds()),
		["读取推荐目录失败：目录服务不可用", "仍可手动填写仓库"]
	);

	await scenario("英文界面", loadClient({ language: "en-US" }), entryFeeds(SNAPSHOT), ["DSH Launcher", "Launch", "Games", "Sub-launchers", "Add game", "Settings"]);

	await scenario("状态同步失败", loadClient({}), [true, SNAPSHOT, "网络断开", "games", [], "", ""], ["状态同步失败", "网络断开"]);

	await scenario("品牌词净化（游戏详情）", loadClient({ stateData: BRAND_SNAPSHOT, detailData: { instance: { id: "brand-inst", name: BRAND_CAP + " 实例", content: [] }, game: "brand-game" } }), fullDetailFeeds(BRAND_SNAPSHOT, "brand-game"), ["生存"]);

	await scenario("异常数据（游戏列表）", loadClient({ stateData: HOSTILE_SNAPSHOT }), [true, HOSTILE_SNAPSHOT, "", "games", [], "", ""], []);

	await scenario(
		"异常数据（添加游戏）",
		loadClient({ stateData: HOSTILE_SNAPSHOT }),
		[true, HOSTILE_SNAPSHOT, "", "addGame", [], "", ""].concat(["github", { bad: true }, {}, { bad: true }, {}, {}, {}, {}, {}, {}, false, { ok: {}, detail: {} }, false, {}, false]),
		[]
	);

	await scenario("异常数据（设置）", loadClient({ stateData: HOSTILE_SNAPSHOT }), [true, HOSTILE_SNAPSHOT, "", "settings", [], "", "", {}, false], []);

	await check("渲染场景数量与规模达标", async () => {
		assert(stats.count >= 14, "渲染场景数量不足：" + stats.count);
		assert(stats.nodes >= 700, "渲染节点总数不足：" + stats.nodes);
	});

	// ---------------- 4. 游戏卡 / 详情 / 返回 / Esc ----------------
	await check("点击游戏卡进入详情，Esc 先返回列表再关闭面板", async () => {
		const client = loadClient({});
		const mounted = await mountEntry(client, entryFeeds(SNAPSHOT));
		eq(mounted.remaining, 0, "面板 state 未消费完");
		const card = findByClass(mounted.tree, "dsl_gamecard");
		assert(card, "找不到游戏卡");
		let tree = await clickNode(client, card);
		includes(textOf(tree), "返回游戏列表", "点击游戏卡后未进入详情");
		client.dispatch("keydown", { key: "Escape", stopPropagation() {} });
		tree = await client.runtime.flush();
		includes(textOf(tree), "进入", "Esc 后未返回游戏列表");
		excludes(textOf(tree), "返回游戏列表", "Esc 后仍在详情");
		client.dispatch("keydown", { key: "Escape", stopPropagation() {} });
		tree = await client.runtime.flush();
		excludes(textOf(tree), "数据目录", "Esc 第二次没有关闭面板");
		includes(textOf(tree), "启动游戏", "关闭后入口按钮丢失");
	});

	await check("游戏卡键盘 Enter 也可进入详情", async () => {
		const client = loadClient({});
		const mounted = await mountEntry(client, entryFeeds(SNAPSHOT));
		const card = findByClass(mounted.tree, "dsl_gamecard");
		assert(card, "找不到游戏卡");
		card.props.onKeyDown({ key: "Enter", preventDefault() {} });
		const tree = await client.runtime.flush();
		includes(textOf(tree), "返回游戏列表", "键盘 Enter 未进入详情");
	});

	await check("详情返回按钮回到游戏列表", async () => {
		const client = loadClient({});
		const mounted = await mountEntry(client, entryFeeds(SNAPSHOT));
		const card = findByClass(mounted.tree, "dsl_gamecard");
		let tree = await clickNode(client, card);
		const back = findAll(tree, (node, own) => {
			const className = node.props && typeof node.props.className === "string" ? node.props.className.split(/\s+/) : [];
			return className.indexOf("dsl_btn") >= 0 && typeof node.props.onClick === "function" && own.indexOf("返回") >= 0;
		})[0];
		assert(back, "找不到返回按钮");
		tree = await clickNode(client, back);
		includes(textOf(tree), "进入", "返回按钮未回到列表");
		excludes(textOf(tree), "返回游戏列表", "返回后仍在详情");
	});

	await check("面板可在游戏 / 附属启动器 / 添加游戏 / 设置之间切换", async () => {
		const client = loadClient({});
		const mounted = await mountEntry(client, entryFeeds(SNAPSHOT));
		const subTab = findAll(mounted.tree, (node, own) => node.props.className === "dsl_tab" && own === "附属启动器")[0];
		assert(subTab, "找不到附属启动器 tab");
		let tree = await clickNode(client, subTab);
		includes(textOf(tree), "安装附属启动器", "切换到附属启动器 tab 失败");
		const settingsTab = findAll(tree, (node, own) => node.props.className === "dsl_tab" && own === "设置")[0];
		assert(settingsTab, "找不到设置 tab");
		tree = await clickNode(client, settingsTab);
		includes(textOf(tree), "保存设置", "切换到设置 tab 失败");
		const addTab = findAll(tree, (node, own) => node.props.className === "dsl_tab" && own === "添加游戏")[0];
		assert(addTab, "找不到添加游戏 tab");
		tree = await clickNode(client, addTab);
		includes(textOf(tree), "保存游戏", "切换到添加游戏 tab 失败");
	});

	// ---------------- 5. 安装流程 ----------------
	await check("安装提交 POST /install 携带 game / version / options", async () => {
		const client = loadClient({});
		const mounted = await mountEntry(client, entryFeeds(SNAPSHOT));
		const card = findByClass(mounted.tree, "dsl_gamecard");
		let tree = await clickNode(client, card);
		const installButton = findClickableByText(tree, "下载并安装");
		assert(installButton, "找不到「下载并安装」按钮");
		tree = await clickNode(client, installButton);
		const submit = findClickableByText(tree, "安装");
		assert(submit, "找不到「安装」提交按钮");
		await clickNode(client, submit);
		const installCall = client.fetchCalls.filter((call) => call.method === "POST" && call.url.indexOf("/install") >= 0).pop();
		assert(installCall, "没有发起 POST /install");
		eq(installCall.body.game, "example", "安装 body.game 不符");
		eq(installCall.body.version, "2.0.0", "安装 body.version 不符");
		eq(installCall.body.options, { memory: 2048, channel: "stable", beta: false }, "安装 body.options 不符");
		assert(client.fetchCalls.some((call) => call.url.indexOf("/jobs/") >= 0), "提交后没有轮询任务详情");
	});

	// ---------------- 6. 实例操作 ----------------
	await check("实例启动 POST /instances/:id/launch", async () => {
		const client = loadClient({});
		const mounted = await mountEntry(client, entryFeeds(SNAPSHOT));
		const card = findByClass(mounted.tree, "dsl_gamecard");
		const tree = await clickNode(client, card);
		const launchButton = findClickableByText(tree, "启动");
		assert(launchButton, "找不到启动按钮");
		await clickNode(client, launchButton);
		assert(client.fetchCalls.some((call) => call.method === "POST" && call.url.indexOf("/instances/inst-1/launch") >= 0), "没有发起启动请求");
	});

	// ---------------- 7. 内容添加 / 移除 ----------------
	await check("内容添加与移除（POST /content 与 DELETE /content/:filename）", async () => {
		const client = loadClient({});
		const mounted = await mountEntry(client, entryFeeds(SNAPSHOT));
		const card = findByClass(mounted.tree, "dsl_gamecard");
		await clickNode(client, card);
		const searchInput = findAll(client.runtime.tree(), (node) => node.type === "input" && node.props.placeholder === "搜索内容…")[0];
		assert(searchInput, "找不到内容搜索框");
		searchInput.props.onChange({ target: { value: "alpha" } });
		await client.runtime.flush();
		await clickText(client, "搜索");
		const checkboxes = findAll(client.runtime.tree(), (node) => node.type === "input" && node.props.type === "checkbox");
		assert(checkboxes.length > 0, "搜索结果没有勾选项");
		checkboxes[0].props.onChange({ target: { checked: true } });
		await client.runtime.flush();
		await clickText(client, "添加所选内容");
		const addCall = client.fetchCalls.filter((call) => call.method === "POST" && call.url.indexOf("/content") >= 0).pop();
		assert(addCall, "没有发起内容添加请求");
		includes(addCall.url, "/instances/inst-1/content", "内容添加地址不符");
		assert(Array.isArray(addCall.body.specs) && addCall.body.specs.length === 1, "内容添加 body.specs 不符");
		eq(addCall.body.specs[0], { slug: "alpha" }, "内容添加 specs 内容不符");
		const removeButton = findClickableByText(client.runtime.tree(), "移除");
		assert(removeButton, "找不到移除按钮");
		const confirmTree = await clickNode(client, removeButton);
		const confirmButton = findClickableByText(confirmTree, "确认");
		assert(confirmButton, "找不到移除确认按钮");
		await clickNode(client, confirmButton);
		const deleteCall = client.fetchCalls.filter((call) => call.method === "DELETE").pop();
		assert(deleteCall, "没有发起内容删除请求");
		includes(deleteCall.url, "/instances/inst-1/content/mod-a.zip", "内容删除地址不符");
	});

	// ---------------- 8. 添加游戏保存 ----------------
	await check("添加游戏保存 POST /games（含 provider / label / config）", async () => {
		const client = loadClient({});
		const mounted = await mountEntry(client, entryFeeds(SNAPSHOT, "addGame").concat(addGameFeeds()));
		eq(mounted.remaining, 0, "添加游戏表单 state 未消费完");
		await clickText(client, "保存游戏");
		const saveCall = client.fetchCalls.filter((call) => call.method === "POST" && /\/games$/.test(call.url)).pop();
		assert(saveCall, "没有发起 POST /games");
		eq(saveCall.body.provider, "github", "保存 body.provider 不符");
		eq(saveCall.body.label, "示例游戏", "保存 body.label 不符");
		eq(saveCall.body.config, { repo: "owner/name", executable: "run.exe" }, "保存 body.config 不符");
	});

	// ---------------- 9. 设置保存 ----------------
	await check("设置保存 PATCH /config 只发下载并发与重试次数", async () => {
		const client = loadClient({});
		await mountEntry(client, entryFeeds(SNAPSHOT, "settings").concat(settingsFeeds()));
		await clickText(client, "保存设置");
		const patchCall = client.fetchCalls.filter((call) => call.method === "PATCH").pop();
		assert(patchCall, "没有发起 PATCH /config");
		includes(patchCall.url, "/config", "PATCH 地址不符");
		eq(patchCall.body, { downloadConcurrency: 16, retries: 3 }, "PATCH body 不符");
	});

	// ---------------- 10. 附属启动器安装 / 检查更新 / 更新 / 删除 ----------------
	await check("附属启动器安装、检查更新、更新与删除", async () => {
		const client = loadClient({});
		const mounted = await mountEntry(client, entryFeeds(SNAPSHOT, "sublaunchers").concat(subLauncherFeeds()));
		eq(mounted.remaining, 0, "附属启动器表单 state 未消费完");
		let text = textOf(mounted.tree);
		includes(text, "安装附属启动器", "缺少安装表单");
		includes(text, "示例附属启动器", "缺少已安装列表");
		includes(text, "有更新可用", "缺少更新徽标");
		await clickText(client, "安装");
		const installCall = client.fetchCalls.filter((call) => call.method === "POST" && call.url.indexOf("/sublaunchers/install") >= 0).pop();
		assert(installCall, "没有发起 POST /sublaunchers/install");
		eq(installCall.body.repo, "owner/name", "安装 body.repo 不符");
		await clickText(client, "检查更新");
		assert(
			client.fetchCalls.some((call) => call.method === "POST" && call.url.indexOf("/sublaunchers/sub-example/check") >= 0),
			"没有发起检查更新请求"
		);
		await clickText(client, "更新");
		assert(
			client.fetchCalls.some((call) => call.method === "POST" && call.url.indexOf("/sublaunchers/sub-example/update") >= 0),
			"没有发起更新请求"
		);
		assert(client.fetchCalls.some((call) => call.url.indexOf("/jobs/job-up") >= 0), "更新后没有轮询任务详情");
		await clickText(client, "删除");
		text = textOf(client.runtime.tree());
		includes(text, "确认删除附属启动器", "删除没有二次确认");
		await clickText(client, "确认");
		const deleteCall = client.fetchCalls.filter((call) => call.method === "DELETE" && call.url.indexOf("/sublaunchers/") >= 0).pop();
		assert(deleteCall, "没有发起 DELETE /sublaunchers/:id");
		includes(deleteCall.url, "/sublaunchers/sub-example", "删除地址不符");
	});

	// ---------------- 11. 推荐目录（catalog） ----------------
	await check("推荐目录渲染、刷新与一键安装", async () => {
		const client = loadClient({});
		const mounted = await mountEntry(client, entryFeeds(SNAPSHOT, "sublaunchers").concat(subLauncherFeeds()));
		eq(mounted.remaining, 0, "推荐目录 state 未消费完");
		const text = textOf(mounted.tree);
		includes(text, "推荐目录", "缺少推荐目录区域");
		includes(text, "刷新推荐", "缺少刷新按钮");
		includes(text, "示例推荐条目", "缺少推荐条目描述");
		includes(text, "推荐附属启动器", "缺少未安装推荐条目");
		includes(text, "可更新", "缺少可更新徽标");
		const installButtons = findAll(mounted.tree, (node, own) => node.props && typeof node.props.onClick === "function" && own === "安装");
		assert(installButtons.length >= 2, "推荐目录缺少安装按钮（找到 " + installButtons.length + " 个）");
		await clickNode(client, installButtons[installButtons.length - 1]);
		const installCall = client.fetchCalls.filter((call) => call.method === "POST" && call.url.indexOf("/sublaunchers/install") >= 0).pop();
		assert(installCall, "推荐目录安装没有发起 POST /sublaunchers/install");
		eq(installCall.body, { url: "https://example.com/sub.zip" }, "推荐目录安装 body 不符");
		await clickText(client, "刷新推荐");
		assert(client.fetchCalls.some((call) => call.url.indexOf("/catalog?refresh=1") >= 0), "刷新推荐没有携带 refresh=1");
	});

	// ---------------- 汇总 ----------------
	console.log("");
	console.log("------------------------------------------------------------");
	console.log("checks: " + (results.pass + results.fail) + "（PASS " + results.pass + " / FAIL " + results.fail + "）");
	console.log("renders: " + stats.count + " 个场景，共 " + stats.nodes + " 个节点 / " + stats.chars + " 个可见字符");
	console.log("dictionary: zh " + Object.keys(zh).length + " / en " + Object.keys(en).length + "；locale/zh.json ui " + Object.keys(zhJson.ui || {}).length);
	console.log("slot: " + MODULE_ID + " -> " + SLOT_NAME + "（order 60）");
	console.log("------------------------------------------------------------");
	if (results.fail) {
		results.failures.forEach((item) => {
			console.log("");
			console.log("FAILED: " + item.name);
			console.log(String(item.error && item.error.stack ? item.error.stack : item.error));
		});
		console.log("RESULT: FAIL");
		process.exit(1);
	}
	console.log("RESULT: PASS");
}

main().catch((error) => {
	console.log("");
	console.log("RESULT: FAIL");
	console.log(String(error && error.stack ? error.stack : error));
	process.exit(1);
});
