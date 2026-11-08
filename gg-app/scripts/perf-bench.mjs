/**
 * Repeatable performance bench for the desktop webview and the sidecar.
 *
 * The webview runs in headless Chromium (a stand-in for WebView2 / WKWebView)
 * against a built `dist` served by a tiny static server, with a FAKE Tauri IPC
 * (`window.__TAURI_INTERNALS__`) modelled on capture-screenshots.mjs. All data
 * below is deliberately fictional. Keep it that way.
 *
 * Usage:
 *   node gg-app/scripts/perf-bench.mjs [--dist gg-app/dist] [--runs 7]
 *     [--out results.json] [--only bundle|startup|transcript|streaming|sidecar]
 *     [--profile]   also record one CDP CPU profile for transcript + streaming
 *     [--messages 300]  transcript history size (default 300, comparable with earlier runs)
 *     [--sidecar <app-sidecar.js>]   time this sidecar build instead of packages/ggcoder/dist
 *     [--node <exe>]                 run the sidecar with this Node (e.g. the staged ggnode-*
 *                                    binary with --sidecar gg-app/src-tauri/sidecar/app-sidecar.mjs)
 *
 * Sections:
 *   bundle      eager JS/CSS (manifest walk from index.html) + every lazy chunk;
 *               when the entry chunk has a .map, attributes its bytes to modules
 *   startup     FCP, app visible (.home-actions), script/task time, long tasks, heap
 *   transcript  open a ~300-message session; time until its last message renders
 *   streaming   ~30 text_delta events/s for 10 s; busy ms/s, long tasks, fps
 *   sidecar     spawn packages/ggcoder/dist/app-sidecar.js: port up, /state 200
 * Each browser section runs at CPU 1x and with CDP CPU throttling at 4x.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import http from "node:http";
import { cpus, tmpdir, totalmem } from "node:os";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const here = dirname(fileURLToPath(import.meta.url));
const SECTIONS = ["bundle", "startup", "transcript", "streaming", "sidecar"];

function parseArgs(argv) {
  const opts = {
    dist: resolve(here, "../dist"),
    runs: 7,
    out: null,
    only: null,
    profile: false,
    messages: 300,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dist") opts.dist = resolve(argv[++i]);
    else if (a === "--runs") opts.runs = Number(argv[++i]);
    else if (a === "--out") opts.out = resolve(argv[++i]);
    else if (a === "--only") opts.only = argv[++i];
    else if (a === "--profile") opts.profile = true;
    else if (a === "--messages") opts.messages = Number(argv[++i]);
    else if (a === "--sidecar") opts.sidecar = resolve(argv[++i]);
    else if (a === "--node") opts.node = resolve(argv[++i]);
    else throw new Error(`unknown argument: ${a}`);
  }
  if (opts.only && !SECTIONS.includes(opts.only)) throw new Error(`--only must be ${SECTIONS}`);
  if (!(opts.messages >= 2)) throw new Error("--messages must be >= 2");
  if (!(opts.runs >= 1)) throw new Error("--runs must be >= 1");
  return opts;
}

// ── Stats ────────────────────────────────────────────────────────────────────
const round = (n, d = 1) => (n == null || Number.isNaN(n) ? null : Number(n.toFixed(d)));
function quantile(values, q) {
  const v = values.filter((x) => typeof x === "number").sort((a, b) => a - b);
  if (v.length === 0) return null;
  const pos = (v.length - 1) * q;
  const lo = Math.floor(pos);
  return v[lo] + (v[Math.ceil(pos)] - v[lo]) * (pos - lo);
}
/** { key: {median, p90} } over an array of flat numeric run records. */
function summarize(runs) {
  const out = {};
  for (const key of Object.keys(runs[0] ?? {})) {
    if (typeof runs[0][key] !== "number") continue;
    const vals = runs.map((r) => r[key]);
    out[key] = { median: round(quantile(vals, 0.5)), p90: round(quantile(vals, 0.9)) };
  }
  return out;
}

// ── Bundle ───────────────────────────────────────────────────────────────────
const B64 = Object.fromEntries(
  [..."ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"].map((c, i) => [c, i]),
);
/** Decode source-map `mappings` → per generated line: [[col, sourceIndex, origLine]]. */
function decodeMappings(mappings) {
  const lines = [];
  let src = 0;
  let origLine = 0;
  for (const line of mappings.split(";")) {
    const segs = [];
    let col = 0;
    if (line) {
      for (const seg of line.split(",")) {
        const v = [];
        let shift = 0;
        let value = 0;
        for (const ch of seg) {
          const d = B64[ch];
          value += (d & 31) * 2 ** shift;
          if (d & 32) shift += 5;
          else {
            v.push(value % 2 ? -Math.floor(value / 2) : value / 2);
            value = 0;
            shift = 0;
          }
        }
        col += v[0];
        if (v.length >= 4) {
          src += v[1];
          origLine += v[2];
          segs.push([col, src, origLine]);
        } else segs.push([col, -1, 0]);
      }
    }
    lines.push(segs);
  }
  return lines;
}

function loadSourceMap(file) {
  const mapFile = `${file}.map`;
  if (!existsSync(mapFile)) return null;
  const map = JSON.parse(readFileSync(mapFile, "utf8"));
  return { sources: map.sources, lines: decodeMappings(map.mappings), dir: dirname(mapFile) };
}

/** Group a source path as a node_modules package or an app module. */
function ownerOf(source, mapDir) {
  const norm = source.replace(/\\/g, "/");
  const i = norm.lastIndexOf("node_modules/");
  if (i >= 0) {
    const rest = norm.slice(i + 13).split("/");
    return { pkg: rest[0].startsWith("@") ? `${rest[0]}/${rest[1]}` : rest[0], module: norm };
  }
  const abs = resolve(mapDir, norm);
  const rel = relative(resolve(here, ".."), abs).replace(/\\/g, "/");
  return { pkg: "(app source)", module: rel.startsWith("..") ? norm : rel };
}

/** Attribute every byte of a generated file to its source module via its .map. */
function attribute(file) {
  const sm = loadSourceMap(file);
  if (!sm) return null;
  const code = readFileSync(file, "utf8").split("\n");
  const bySource = new Map();
  let unmapped = 0;
  const add = (src, bytes) => {
    if (src < 0) unmapped += bytes;
    else bySource.set(src, (bySource.get(src) ?? 0) + bytes);
  };
  code.forEach((line, n) => {
    const segs = sm.lines[n] ?? [];
    unmapped += 1; // newline
    if (segs.length === 0) return add(-1, Buffer.byteLength(line));
    add(-1, Buffer.byteLength(line.slice(0, segs[0][0])));
    segs.forEach((seg, j) => {
      const end = j + 1 < segs.length ? segs[j + 1][0] : line.length;
      add(seg[1], Buffer.byteLength(line.slice(seg[0], end)));
    });
  });
  const modules = new Map();
  const packages = new Map();
  for (const [src, bytes] of bySource) {
    const { pkg, module } = ownerOf(sm.sources[src], sm.dir);
    modules.set(module, (modules.get(module) ?? 0) + bytes);
    packages.set(pkg, (packages.get(pkg) ?? 0) + bytes);
  }
  const top = (m, n) =>
    [...m.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, n)
      .map(([name, bytes]) => ({ name, bytes }));
  return {
    totalBytes: statSync(file).size,
    unmappedBytes: unmapped,
    topModules: top(modules, 30),
    topPackages: top(packages, 30),
  };
}

function sizes(file) {
  const buf = readFileSync(file);
  return { raw: buf.length, gzip: gzipSync(buf).length };
}

function benchBundle(dist) {
  const manifestPath = join(dist, ".vite", "manifest.json");
  if (!existsSync(manifestPath)) throw new Error(`no manifest at ${manifestPath}`);
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const entryKey = Object.keys(manifest).find(
    (k) => manifest[k].isEntry && /index\.html$/.test(manifest[k].src ?? k),
  );
  if (!entryKey) throw new Error("manifest has no index.html entry");
  const eager = new Set();
  const walk = (key) => {
    if (eager.has(key)) return;
    eager.add(key);
    for (const dep of manifest[key].imports ?? []) walk(dep);
  };
  walk(entryKey);
  const eagerJs = [];
  const eagerCss = new Set();
  for (const key of eager) {
    eagerJs.push({ file: manifest[key].file, ...sizes(join(dist, manifest[key].file)) });
    for (const css of manifest[key].css ?? []) eagerCss.add(css);
  }
  const eagerFiles = new Set(eagerJs.map((c) => c.file));
  const css = [...eagerCss].map((file) => ({ file, ...sizes(join(dist, file)) }));
  const lazy = [];
  const seen = new Set();
  for (const item of Object.values(manifest)) {
    if (!item.file.endsWith(".js") || eagerFiles.has(item.file) || seen.has(item.file)) continue;
    seen.add(item.file);
    lazy.push({ file: item.file, ...sizes(join(dist, item.file)) });
  }
  lazy.sort((a, b) => b.raw - a.raw);
  const sum = (list, k) => list.reduce((n, c) => n + c[k], 0);
  return {
    entry: manifest[entryKey].file,
    eagerJs: { raw: sum(eagerJs, "raw"), gzip: sum(eagerJs, "gzip"), chunks: eagerJs },
    eagerCss: { raw: sum(css, "raw"), gzip: sum(css, "gzip"), files: css },
    lazy: { raw: sum(lazy, "raw"), gzip: sum(lazy, "gzip"), chunks: lazy },
    entryComposition: attribute(join(dist, manifest[entryKey].file)),
  };
}

// ── Static server ────────────────────────────────────────────────────────────
const MIME = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".json": "application/json",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".mp3": "audio/mpeg",
  ".wasm": "application/wasm",
};
async function serve(dist) {
  const root = resolve(dist);
  const server = http.createServer((req, res) => {
    let path = decodeURIComponent(new URL(req.url, "http://x").pathname);
    if (path === "/") path = "/index.html";
    const file = resolve(join(root, path));
    if (!file.startsWith(root) || !existsSync(file) || statSync(file).isDirectory()) {
      res.writeHead(404);
      return res.end();
    }
    res.writeHead(200, {
      "content-type": MIME[extname(file)] ?? "application/octet-stream",
      "cache-control": "no-store",
    });
    res.end(readFileSync(file));
  });
  await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
  return { url: `http://127.0.0.1:${server.address().port}/`, close: () => server.close() };
}

// ── Fictional demo data + fake Tauri IPC ─────────────────────────────────────
const CWD = "/Users/demo/projects/aurora-store";
const BASE_STATE = {
  provider: "anthropic",
  model: "claude-sonnet-4-6",
  cwd: CWD,
  mode: "code",
  running: false,
  runState: "idle",
  thinkingLevel: "medium",
  supportedThinkingLevels: ["low", "medium", "high"],
  planMode: false,
  contextWindow: 200000,
  gitBranch: "main",
  isGitRepo: true,
  gitDirtyFileCount: 0,
  supportsVideo: false,
  autopilot: false,
  tasks: [],
};
const SESSION_PREVIEW = "Benchmark session: checkout retry";
const END_MARKER = "bench-transcript-end-7f3a";

function baseResponses(history) {
  return {
    sidecar_port: 45678,
    agent_state: BASE_STATE,
    app_settings_get: { projectsRoot: "/Users/demo/projects", configured: true },
    app_auth_status: {
      providers: [
        {
          value: "anthropic",
          label: "Anthropic",
          description: "Claude models",
          methods: ["oauth"],
          connected: true,
        },
      ],
    },
    agent_serve_status: { running: false, configured: false },
    agent_models: {
      models: [
        {
          id: "claude-sonnet-4-6",
          name: "Claude Sonnet 4.6",
          provider: "anthropic",
          supportsThinking: true,
          contextWindow: 200000,
        },
      ],
    },
    agent_commands: { commands: [] },
    agent_tasks: { tasks: [] },
    agent_memories: { memories: [] },
    agent_radio_state: { playing: false, station: null },
    permissions_status: { screenRecording: true, accessibility: true, microphone: true },
    agent_projects: {
      projects: [
        { name: "aurora-store", path: CWD, lastActiveDisplay: "2m ago", sources: ["gg-coder"] },
      ],
    },
    agent_sessions: {
      sessions: [
        {
          id: "bench-session-1",
          path: CWD,
          preview: SESSION_PREVIEW,
          lastActiveDisplay: "5m ago",
          messageCount: history.length,
        },
      ],
    },
    agent_history: { history },
  };
}

const LANGS = [
  [
    "ts",
    "export function retry<T>(fn: () => Promise<T>, tries = 3): Promise<T> {\n  return fn().catch((err) => (tries > 1 ? retry(fn, tries - 1) : Promise.reject(err)));\n}",
  ],
  [
    "python",
    "def chunk(items, size):\n    for i in range(0, len(items), size):\n        yield items[i : i + size]",
  ],
  [
    "rust",
    'fn depth(s: &str) -> usize {\n    s.matches("/*").count().saturating_sub(s.matches("*/").count())\n}',
  ],
  ["bash", "pnpm vitest run src/routes --reporter=dot"],
];

/** ~300 fictional mixed history entries: markdown, code, tables, shell, sub-agents. */
function makeHistory(count = 300) {
  const history = [];
  for (let i = 0; history.length < count; i++) {
    if (i % 2 === 0) {
      history.push({
        role: "user",
        text: `Step ${i / 2 + 1}: tighten the checkout flow, part ${i}`,
      });
      continue;
    }
    if (i % 13 === 7) {
      history.push({
        role: "user",
        text: "",
        shell: {
          runId: `bench-shell-${i}`,
          command: "pnpm vitest run src/routes",
          cwd: CWD,
          exitCode: 0,
          durationMs: 2140,
          cancelled: false,
          output: " ✓ src/routes/checkout.test.ts (6 tests) 41ms\n Test Files  1 passed (1)",
          truncated: false,
        },
      });
    }
    const [lang, code] = LANGS[i % LANGS.length];
    const entry = {
      role: "assistant",
      text: [
        `### Change ${i}`,
        `The \`POST /api/checkout\` handler now **reuses** the stored response for repeat keys. See [the notes](https://example.com/notes/${i}).`,
        "",
        "- hashed the cart and user into an idempotency key",
        "- cached the first response for 24 hours",
        "- added a regression test",
        "",
        "```" + lang,
        code,
        "```",
        i % 5 === 1
          ? "\n| file | lines |\n| --- | --- |\n| src/lib/idempotency.ts | 62 |\n| src/routes/checkout.ts | 14 |"
          : "",
      ].join("\n"),
    };
    if (i % 7 === 3) {
      entry.subagentGroup = [
        { agentName: "explorer", status: "done", toolUseCount: 6 },
        { agentName: "tester", status: "done", toolUseCount: 3 },
      ];
    }
    if (i % 11 === 5) {
      entry.todos = [
        { content: "Hash the cart", activeForm: "Hashing the cart", status: "completed" },
        {
          content: "Cache the response",
          activeForm: "Caching the response",
          status: "in_progress",
        },
      ];
    }
    history.push(entry);
  }
  history.length = count;
  // The last entry carries the marker the transcript timer waits for.
  history[count - 1] = { role: "assistant", text: `All done. ${END_MARKER}` };
  return history;
}

/** Runs in the page before any app script. */
function initScript({ responses, appVersion, visibleSelector }) {
  sessionStorage.setItem("ic-boot-seen", "1"); // skip the ~3 s decorative boot screen
  const perf = { longTasks: [], appVisibleAt: null };
  window.__perf = perf;
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries())
        perf.longTasks.push({ start: e.startTime, duration: e.duration });
    }).observe({ type: "longtask", buffered: true });
  } catch {
    /* longtask unsupported */
  }
  const mo = new MutationObserver(() => {
    if (perf.appVisibleAt == null && document.querySelector(visibleSelector)) {
      // Next frame after the node lands ≈ when it is painted.
      perf.appVisibleAt = -1;
      requestAnimationFrame(() => (perf.appVisibleAt = performance.now()));
      mo.disconnect();
    }
  });
  mo.observe(document, { childList: true, subtree: true });

  const callbacks = new Map();
  const eventHandlers = new Map();
  let nextId = 1;
  window.__TAURI_INTERNALS__ = {
    metadata: {
      currentWindow: { label: "main" },
      currentWebview: { windowLabel: "main", label: "main" },
    },
    plugins: {},
    convertFileSrc: (p) => p,
    transformCallback(cb) {
      const id = nextId++;
      callbacks.set(id, cb);
      return id;
    },
    unregisterCallback(id) {
      callbacks.delete(id);
    },
    invoke(cmd, args) {
      if (cmd === "plugin:app|version") return Promise.resolve(appVersion);
      if (cmd === "plugin:event|listen") {
        if (typeof args?.event === "string" && typeof args?.handler === "number") {
          if (!eventHandlers.has(args.event)) eventHandlers.set(args.event, new Set());
          eventHandlers.get(args.event).add(args.handler);
        }
        return Promise.resolve(nextId++);
      }
      if (cmd.startsWith("plugin:updater|")) return Promise.reject(new Error("no updates"));
      if (cmd.startsWith("plugin:")) return Promise.resolve(null);
      return Promise.resolve(cmd in responses ? responses[cmd] : null);
    },
  };
  window.__ggEmit = (type, data) => {
    const ids = eventHandlers.get("agent-event");
    if (!ids) return 0;
    for (const id of ids)
      callbacks.get(id)?.({ event: "agent-event", id, payload: { type, data: data ?? {} } });
    return ids.size;
  };
  Object.defineProperty(navigator, "mediaDevices", { value: undefined, configurable: true });
}

// ── Browser helpers ──────────────────────────────────────────────────────────
const VIEWPORT = { width: 1440, height: 900 };
const VISIBLE_SELECTOR = ".home-actions";

async function openPage(browser, url, { history = [], throttle = 1 } = {}) {
  const context = await browser.newContext({ viewport: VIEWPORT });
  await context.addInitScript(initScript, {
    responses: baseResponses(history),
    appVersion: "0.0.0-bench",
    visibleSelector: VISIBLE_SELECTOR,
  });
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send("Performance.enable");
  if (throttle > 1) await cdp.send("Emulation.setCPUThrottlingRate", { rate: throttle });
  const metrics = async () => {
    const { metrics: m } = await cdp.send("Performance.getMetrics");
    return Object.fromEntries(m.map((x) => [x.name, x.value]));
  };
  await page.goto(url, { waitUntil: "commit" });
  return { context, page, cdp, metrics };
}

/** Long tasks with startTime in [from, to] (page clock). */
const longTasksIn = (page, from, to) =>
  page.evaluate(
    ([a, b]) => {
      const t = window.__perf.longTasks.filter((x) => x.start >= a && x.start <= (b ?? Infinity));
      return { count: t.length, total: t.reduce((n, x) => n + x.duration, 0) };
    },
    [from, to],
  );

async function startupRun(browser, url, throttle) {
  const { context, page, metrics } = await openPage(browser, url, { throttle });
  await page.waitForFunction(() => window.__perf.appVisibleAt > 0, null, { timeout: 60_000 });
  const atVisible = await metrics();
  await page.waitForTimeout(2000);
  const after = await metrics();
  const r = await page.evaluate(() => ({
    fcp: performance.getEntriesByName("first-contentful-paint")[0]?.startTime ?? null,
    appVisible: window.__perf.appVisibleAt,
  }));
  const lt = await longTasksIn(page, 0, r.appVisible);
  const ltAll = await longTasksIn(page, 0, null);
  await context.close();
  return {
    fcpMs: r.fcp,
    appVisibleMs: r.appVisible,
    scriptMsToVisible: atVisible.ScriptDuration * 1000,
    taskMsToVisible: atVisible.TaskDuration * 1000,
    longTaskMsToVisible: lt.total,
    longTaskCountToVisible: lt.count,
    longTaskMsTo2sAfter: ltAll.total,
    jsHeapUsedMB: after.JSHeapUsedSize / 2 ** 20,
  };
}

/** From home: Code → project → the session list. */
async function openProjectSessionList(page) {
  await page.waitForFunction(() => window.__perf.appVisibleAt > 0, null, { timeout: 60_000 });
  await page.click("text=Code", { timeout: 15_000 });
  await page.click(".picker-item", { timeout: 15_000 });
  await page.waitForSelector(`.picker-item:has-text("${SESSION_PREVIEW}")`, { timeout: 15_000 });
}

async function startProfile(cdp) {
  await cdp.send("Profiler.enable");
  await cdp.send("Profiler.setSamplingInterval", { interval: 200 });
  await cdp.send("Profiler.start");
}

async function transcriptRun(browser, url, throttle, history, profile = false) {
  const { context, page, cdp, metrics } = await openPage(browser, url, { history, throttle });
  await openProjectSessionList(page);
  await page.waitForTimeout(500);
  if (profile) await startProfile(cdp);
  const m0 = await metrics();
  const t = await page.evaluate(
    ([preview, marker]) =>
      new Promise((done) => {
        const item = [...document.querySelectorAll(".picker-item")].find((el) =>
          el.textContent.includes(preview),
        );
        const t0 = performance.now();
        const mo = new MutationObserver(() => {
          const last = [...document.querySelectorAll(".transcript .assistant-msg")].at(-1);
          if (!last?.textContent.includes(marker)) return;
          mo.disconnect();
          // After the frame that shows it has been produced.
          requestAnimationFrame(() => setTimeout(() => done({ t0, t1: performance.now() }), 0));
        });
        mo.observe(document.body, { childList: true, subtree: true, characterData: true });
        item.click();
      }),
    [SESSION_PREVIEW, END_MARKER],
  );
  const m1 = await metrics();
  // Until the transcript's row list stops changing (older rows mounting above
  // the fold after the first paint): quiet for 300 ms counts as settled.
  const settledAt = await page.evaluate(
    (t1) =>
      new Promise((done) => {
        const box = document.querySelector(".transcript");
        let last = t1;
        let timer = setTimeout(finish, 300);
        function finish() {
          mo.disconnect();
          done(last);
        }
        const mo = new MutationObserver(() => {
          last = performance.now();
          clearTimeout(timer);
          timer = setTimeout(finish, 300);
        });
        if (box) mo.observe(box, { childList: true });
      }),
    t.t1,
  );
  const hot = profile ? (await cdp.send("Profiler.stop")).profile : null;
  const lt = await longTasksIn(page, t.t0, t.t1);
  const nodes = await page.evaluate(() => ({
    rows: document.querySelectorAll(".transcript > *").length,
    dom: document.getElementsByTagName("*").length,
  }));
  const heap = (await metrics()).JSHeapUsedSize / 2 ** 20;
  await context.close();
  return {
    run: {
      renderMs: t.t1 - t.t0,
      settledMs: settledAt - t.t0,
      scriptMs: (m1.ScriptDuration - m0.ScriptDuration) * 1000,
      taskMs: (m1.TaskDuration - m0.TaskDuration) * 1000,
      longTaskMs: lt.total,
      longTaskCount: lt.count,
      transcriptRows: nodes.rows,
      domNodes: nodes.dom,
      jsHeapUsedMB: heap,
    },
    profile: hot,
  };
}

const STREAM_REPLY = (() => {
  const words = [];
  for (let p = 0; p < 40; p++) {
    words.push(`\n\n### Part ${p + 1}\n\nThe retry wrapper now keys each **checkout** attempt`);
    words.push("on a hashed cart, so a replayed request returns the cached charge instead of");
    words.push("creating a new one. Notes:\n\n- keys expire after 24 hours\n- the cache is shared");
    if (p % 3 === 0)
      words.push(
        "\n\n```ts\nconst key = hash(cart, user);\nreturn cache.get(key) ?? charge(cart);\n```\n",
      );
  }
  return words.join(" ").match(/[\s\S]{1,14}/g); // ~14-char deltas
})();

async function streamingRun(browser, url, throttle, profile = false) {
  const rate = 30;
  const seconds = 10;
  const { context, page, cdp, metrics } = await openPage(browser, url, {
    history: makeHistory(6),
    throttle,
  });
  await openProjectSessionList(page);
  await page.click(`.picker-item:has-text("${SESSION_PREVIEW}")`);
  await page.waitForSelector("textarea", { timeout: 15_000 });
  await page.fill("textarea", "Explain the checkout retry change");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(300);
  await page.evaluate(() => window.__ggEmit("run_start", {}));
  await page.waitForTimeout(500);
  if (profile) await startProfile(cdp);
  const start = await page.evaluate(
    ([chunks, total, interval]) => {
      const s = { frames: 0, t0: performance.now(), t1: null, sent: 0 };
      window.__stream = s;
      const frame = () => {
        s.frames++;
        if (s.t1 == null) requestAnimationFrame(frame);
      };
      requestAnimationFrame(frame);
      const id = setInterval(() => {
        window.__ggEmit("text_delta", { text: chunks[s.sent % chunks.length] });
        if (++s.sent >= total) {
          clearInterval(id);
          s.t1 = performance.now();
        }
      }, interval);
      return s.t0;
    },
    [STREAM_REPLY, rate * seconds, 1000 / rate],
  );
  const busyPerSecond = [];
  let prev = (await metrics()).TaskDuration;
  for (;;) {
    await page.waitForTimeout(1000);
    const done = await page.evaluate(() => window.__stream.t1 != null);
    const now = (await metrics()).TaskDuration;
    // The last sample is a partial second; drop it.
    if (!done) busyPerSecond.push((now - prev) * 1000);
    prev = now;
    if (done || busyPerSecond.length > seconds * 6) break;
  }
  const hot = profile ? (await cdp.send("Profiler.stop")).profile : null;
  const s = await page.evaluate(() => window.__stream);
  const lt = await longTasksIn(page, start, s.t1);
  const rendered = await page.evaluate(
    () => document.querySelector(".transcript .assistant-msg:last-of-type")?.textContent.length,
  );
  await context.close();
  const dur = ((s.t1 ?? performance.now()) - s.t0) / 1000;
  return {
    run: {
      durationS: dur,
      eventsPerS: s.sent / dur,
      fps: s.frames / dur,
      busyMsPerS: quantile(busyPerSecond, 0.5),
      busyMsPerSMax: Math.max(...busyPerSecond),
      longTaskMs: lt.total,
      longTaskCount: lt.count,
      renderedChars: rendered ?? 0,
    },
    profile: hot,
  };
}

/** Top self-time frames of a CDP profile; resolved through .map files when present. */
function hotspots(profile, dist) {
  if (!profile) return null;
  const byId = new Map(profile.nodes.map((n) => [n.id, n]));
  const self = new Map();
  profile.samples.forEach((id, i) => {
    self.set(id, (self.get(id) ?? 0) + (profile.timeDeltas[i] ?? 0) / 1000);
  });
  const maps = new Map();
  const where = (cf) => {
    if (!cf.url) return { file: `(${cf.functionName || "native"})`, fn: cf.functionName };
    let path;
    try {
      path = new URL(cf.url).pathname;
    } catch {
      return { file: cf.url, fn: cf.functionName };
    }
    if (!maps.has(path)) maps.set(path, loadSourceMap(join(dist, path)));
    const sm = maps.get(path);
    if (!sm) return { file: path, fn: cf.functionName || "(anonymous)" };
    let hit = null;
    for (const s of sm.lines[cf.lineNumber] ?? []) if (s[0] <= cf.columnNumber) hit = s;
    if (!hit || hit[1] < 0) return { file: path, fn: cf.functionName || "(anonymous)" };
    const { module } = ownerOf(sm.sources[hit[1]], sm.dir);
    return { file: module, fn: `${cf.functionName || "(anonymous)"}:${hit[2] + 1}` };
  };
  const byFn = new Map();
  const byFile = new Map();
  let total = 0;
  for (const [id, ms] of self) {
    const { file, fn } = where(byId.get(id).callFrame);
    if (file === "(idle)" || file === "(program)") continue;
    total += ms;
    const k = `${fn} — ${file}`;
    byFn.set(k, (byFn.get(k) ?? 0) + ms);
    byFile.set(file, (byFile.get(file) ?? 0) + ms);
  }
  const top = (m) =>
    [...m.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 15)
      .map(([name, ms]) => ({ name, selfMs: round(ms) }));
  // Inclusive time of the app's own functions (each sample counted once per frame).
  const parent = new Map();
  for (const n of profile.nodes) for (const c of n.children ?? []) parent.set(c, n.id);
  const keyOf = new Map();
  const inclusive = new Map();
  profile.samples.forEach((id, i) => {
    const seen = new Set();
    for (let n = id; n != null; n = parent.get(n)) {
      if (!keyOf.has(n)) {
        const { file, fn } = where(byId.get(n).callFrame);
        keyOf.set(n, file.startsWith("src/") ? `${fn} — ${file}` : null);
      }
      const k = keyOf.get(n);
      if (k) seen.add(k);
    }
    for (const k of seen)
      inclusive.set(k, (inclusive.get(k) ?? 0) + (profile.timeDeltas[i] ?? 0) / 1000);
  });
  return {
    busySelfMs: round(total),
    topFunctions: top(byFn),
    topFiles: top(byFile),
    topAppInclusive: top(inclusive).map(({ name, selfMs }) => ({ name, totalMs: selfMs })),
  };
}

// ── Sidecar ──────────────────────────────────────────────────────────────────
function killTree(child) {
  return new Promise((done) => {
    if (child.exitCode !== null || child.signalCode !== null) return done();
    child.once("exit", () => done());
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    } else {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    }
  });
}

async function removeWhenReleased(dir) {
  for (let i = 0; i < 40; i++) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  console.error(`warning: could not remove ${dir}`);
}

async function sidecarRun(script, node = process.execPath) {
  // Isolated home + project so the user's MCP servers/auth don't make runs vary.
  const home = mkdtempSync(join(tmpdir(), "gg-perf-home-"));
  const t0 = performance.now();
  const child = spawn(node, [script], {
    env: { ...process.env, HOME: home, USERPROFILE: home, GG_APP_PORT: "0", GG_APP_CWD: home },
    stdio: ["ignore", "pipe", "pipe"],
    detached: process.platform !== "win32",
  });
  let stderr = "";
  child.stderr.on("data", (d) => (stderr += d));
  try {
    const { port, token } = await new Promise((ok, fail) => {
      const timer = setTimeout(() => fail(new Error("no GG_APP_LISTENING in 120s")), 120_000);
      let out = "";
      child.stdout.on("data", (d) => {
        out += d;
        const m = out.match(/GG_APP_LISTENING (\d+) (\S+)/);
        if (m) {
          clearTimeout(timer);
          ok({ port: Number(m[1]), token: m[2] });
        }
      });
      child.once("exit", (code) => {
        clearTimeout(timer);
        fail(new Error(`sidecar exited (${code}): ${stderr.slice(-400)}`));
      });
    });
    const listeningMs = performance.now() - t0;
    const base = `http://127.0.0.1:${port}`;
    for (;;) {
      try {
        await fetch(`${base}/state`, { headers: { "x-gg-token": token } });
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 10));
      }
    }
    const portAnswersMs = performance.now() - t0;
    const mk = await fetch(`${base}/session`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-gg-token": token },
      body: JSON.stringify({ cwd: home }),
    });
    const { sessionId } = await mk.json();
    if (!sessionId) throw new Error(`POST /session returned ${mk.status}`);
    for (;;) {
      const res = await fetch(`${base}/state`, {
        headers: { "x-gg-session": sessionId, "x-gg-token": token },
      });
      if (res.status === 200) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    return { listeningMs, portAnswersMs, sessionReadyMs: performance.now() - t0 };
  } finally {
    await killTree(child);
    await removeWhenReleased(home);
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const want = (s) => !opts.only || opts.only === s;
  const log = (...a) => console.error(...a);
  const results = {
    meta: {
      date: new Date().toISOString(),
      dist: opts.dist,
      runs: opts.runs,
      cpu: cpus()[0]?.model.trim(),
      cores: cpus().length,
      memoryGB: round(totalmem() / 2 ** 30),
      platform: `${process.platform} ${process.arch}`,
      node: process.version,
      browser: null,
      note: "Headless Chromium stands in for the WebView2/WKWebView webview.",
    },
  };

  if (want("bundle")) {
    results.bundle = benchBundle(opts.dist);
    const b = results.bundle;
    log(`bundle: eager JS ${b.eagerJs.raw} B (${b.eagerJs.gzip} gz), CSS ${b.eagerCss.raw} B`);
  }

  const browserSections = ["startup", "transcript", "streaming"].filter(want);
  if (browserSections.length > 0) {
    const { chromium } = await import("playwright");
    const browser = await chromium.launch();
    results.meta.browser = `Chromium ${browser.version()} (headless)`;
    const server = await serve(opts.dist);
    const history = makeHistory(opts.messages);
    try {
      for (const section of browserSections) {
        results[section] = {};
        for (const throttle of [1, 4]) {
          const runs = [];
          for (let i = 0; i < opts.runs; i++) {
            if (section === "startup") runs.push(await startupRun(browser, server.url, throttle));
            if (section === "transcript")
              runs.push((await transcriptRun(browser, server.url, throttle, history)).run);
            if (section === "streaming")
              runs.push((await streamingRun(browser, server.url, throttle)).run);
            log(`${section} ${throttle}x run ${i + 1}/${opts.runs}`);
          }
          results[section][`cpu${throttle}x`] = { summary: summarize(runs), runs };
        }
        if (section === "transcript") results.transcript.messages = history.length;
        if (opts.profile && section !== "startup") {
          const run =
            section === "transcript"
              ? await transcriptRun(browser, server.url, 1, history, true)
              : await streamingRun(browser, server.url, 1, true);
          results[section].hotspots = hotspots(run.profile, opts.dist);
        }
      }
    } finally {
      server.close();
      await browser.close();
    }
  }

  if (want("sidecar")) {
    const script = opts.sidecar ?? resolve(here, "../../packages/ggcoder/dist/app-sidecar.js");
    if (!existsSync(script)) throw new Error(`build ggcoder first: ${script} missing`);
    const runs = [];
    for (let i = 0; i < opts.runs; i++) {
      runs.push(await sidecarRun(script, opts.node));
      log(`sidecar run ${i + 1}/${opts.runs}`);
    }
    results.sidecar = {
      script,
      node: opts.node ?? process.execPath,
      summary: summarize(runs),
      runs,
    };
  }

  const json = JSON.stringify(results, null, 2);
  if (opts.out) await writeFile(opts.out, json);
  console.log(opts.out ? `wrote ${opts.out}` : json);
}

await main();
