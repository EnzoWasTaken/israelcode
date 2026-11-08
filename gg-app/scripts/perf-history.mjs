#!/usr/bin/env node
/**
 * Times the sidecar half of opening a past chat: a fictional long session
 * file is written into a throwaway HOME, then reopened the way the app does it
 * (POST /session with its sessionPath → GET /state until ready → GET /history).
 * Never touches the real ~/.israelcode; the temp dir is removed afterwards.
 *
 *   node gg-app/scripts/perf-history.mjs [--turns 500] [--images 20] [--runs 5]
 *     [--sidecar packages/ggcoder/dist/app-sidecar.js] [--out results.json] [--git]
 *
 * One turn = your message, a reply with a tool call, its result, and a final
 * markdown reply (~4 history rows). Every `--images`-th turn's tool result
 * carries a 1400×860 PNG screenshot (inside the model's image budget, as live
 * tools store them), which the history route downscales to a preview.
 * `--git` makes the project a git repo (400 committed files, 10 uncommitted),
 * as a real project is, so the git reads on open are timed too.
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const opts = {
  turns: 500,
  images: 20,
  runs: 5,
  sidecar: null,
  out: null,
  profile: false,
  git: false,
};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--turns") opts.turns = Number(argv[++i]);
  else if (a === "--images") opts.images = Number(argv[++i]);
  else if (a === "--runs") opts.runs = Number(argv[++i]);
  else if (a === "--sidecar") opts.sidecar = resolve(argv[++i]);
  else if (a === "--out") opts.out = resolve(argv[++i]);
  else if (a === "--profile") opts.profile = true;
  else if (a === "--git") opts.git = true;
  else throw new Error(`unknown arg ${a}`);
}
const script = opts.sidecar ?? resolve(here, "../../packages/ggcoder/dist/app-sidecar.js");

const round = (n) => Math.round(n * 10) / 10;
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor((xs.length - 1) / 2)];

async function screenshot() {
  const req = createRequire(resolve(here, "../../packages/ggcoder/package.json"));
  const sharp = req("sharp");
  const width = 1400;
  const height = 860;
  const raw = Buffer.alloc(width * height * 3);
  // A UI-like picture: flat panels with rows of "text" strokes, which
  // compresses like a real screenshot (pure noise would be far bigger).
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const panel = x < 280 ? 30 : y < 64 ? 45 : 240;
      const text = x >= 300 && y % 28 > 8 && y % 28 < 20 && (x * 7 + y) % 13 < 7 && x % 400 < 330;
      const v = text ? 40 : panel;
      const i = (y * width + x) * 3;
      raw[i] = v;
      raw[i + 1] = v + (x < 280 ? 10 : 0);
      raw[i + 2] = v + (y < 64 ? 30 : 0);
    }
  }
  const png = await sharp(raw, { raw: { width, height, channels: 3 } })
    .png()
    .toBuffer();
  return png.toString("base64");
}

function sessionLines(header, png) {
  const lines = [JSON.stringify(header)];
  let parentId = null;
  let n = 0;
  const push = (message) => {
    const id = `m${++n}`;
    lines.push(
      JSON.stringify({ type: "message", id, parentId, timestamp: header.timestamp, message }),
    );
    parentId = id;
  };
  for (let t = 0; t < opts.turns; t++) {
    push({ role: "user", content: `Step ${t + 1}: tighten the checkout flow, part ${t}` });
    const callId = `call_${t}`;
    push({
      role: "assistant",
      content: [
        { type: "text", text: `Looking at \`src/routes/checkout.ts\` for part ${t}.` },
        {
          type: "tool_call",
          id: callId,
          name: "read",
          args: { file_path: "src/routes/checkout.ts" },
        },
      ],
    });
    const output = Array.from(
      { length: 60 },
      (_, i) => `${i + 1}\texport const line${i} = ${t};`,
    ).join("\n");
    const withImage = opts.images > 0 && t % opts.images === opts.images - 1;
    push({
      role: "tool",
      content: [
        {
          type: "tool_result",
          toolCallId: callId,
          content: withImage
            ? [
                { type: "text", text: "Screenshot saved → /tmp/shot.png" },
                { type: "image", mediaType: "image/png", data: png },
              ]
            : output,
        },
      ],
    });
    push({
      role: "assistant",
      content: [
        {
          type: "text",
          text: [
            `### Change ${t}`,
            "The `POST /api/checkout` handler now **reuses** the stored response for repeat keys.",
            "",
            "- hashed the cart and user into an idempotency key",
            "- cached the first response for 24 hours",
            "",
            "```ts",
            "export function retry<T>(fn: () => Promise<T>, tries = 3): Promise<T> {",
            "  return fn().catch((err) => (tries > 1 ? retry(fn, tries - 1) : Promise.reject(err)));",
            "}",
            "```",
          ].join("\n"),
        },
      ],
    });
  }
  return { text: lines.join("\n") + "\n", leafId: parentId };
}

function makeRepo(dir) {
  const git = (...args) => {
    const r = spawnSync("git", args, { cwd: dir, stdio: "ignore" });
    if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed`);
  };
  git("init", "-q");
  for (let i = 0; i < 400; i++) {
    mkdirSync(join(dir, "src", `m${i % 20}`), { recursive: true });
    writeFileSync(join(dir, "src", `m${i % 20}`, `f${i}.ts`), `export const v${i} = ${i};\n`);
  }
  git("add", "-A");
  git("-c", "user.name=bench", "-c", "user.email=bench@example.com", "commit", "-qm", "init");
  for (let i = 0; i < 10; i++) writeFileSync(join(dir, "src", "m0", `f${i * 20}.ts`), "changed\n");
}

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

/** CPU profile of the sidecar over the timed opens, through its inspector. */
async function attachProfiler(stderrText) {
  let url = null;
  for (let i = 0; i < 200 && !url; i++) {
    url = stderrText().match(/ws:\/\/\S+/)?.[0] ?? null;
    if (!url) await new Promise((r) => setTimeout(r, 25));
  }
  if (!url) throw new Error("no inspector URL on the sidecar's stderr");
  const ws = new WebSocket(url);
  await new Promise((ok, fail) => ((ws.onopen = ok), (ws.onerror = fail)));
  let next = 1;
  const pending = new Map();
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.id && pending.has(msg.id)) pending.get(msg.id)(msg.result);
  };
  const send = (method, params = {}) =>
    new Promise((ok) => {
      const id = next++;
      pending.set(id, ok);
      ws.send(JSON.stringify({ id, method, params }));
    });
  await send("Profiler.enable");
  await send("Profiler.setSamplingInterval", { interval: 200 });
  await send("Profiler.start");
  return {
    async stop() {
      const { profile } = await send("Profiler.stop");
      ws.close();
      const byId = new Map(profile.nodes.map((n) => [n.id, n]));
      const parent = new Map();
      for (const n of profile.nodes) for (const c of n.children ?? []) parent.set(c, n.id);
      const label = (n) => {
        const cf = byId.get(n).callFrame;
        const file = cf.url.split(/[\\/]/).pop() || "(native)";
        return `${cf.functionName || "(anonymous)"} — ${file}:${cf.lineNumber + 1}`;
      };
      const self = new Map();
      const total = new Map();
      profile.samples.forEach((id, i) => {
        const ms = (profile.timeDeltas[i] ?? 0) / 1000;
        if (/^\((idle|program)\)/.test(label(id))) return;
        self.set(label(id), (self.get(label(id)) ?? 0) + ms);
        const seen = new Set();
        for (let n = id; n != null; n = parent.get(n)) seen.add(label(n));
        for (const k of seen) total.set(k, (total.get(k) ?? 0) + ms);
      });
      const top = (m) =>
        [...m.entries()]
          .sort((a, b) => b[1] - a[1])
          .slice(0, 25)
          .map(([name, ms]) => `${round(ms)} ms  ${name}`);
      return { self: top(self), inclusive: top(total) };
    },
  };
}

async function main() {
  const home = mkdtempSync(join(tmpdir(), "gg-perf-history-"));
  const project = join(home, "project");
  mkdirSync(project);
  if (opts.git) makeRepo(project);
  // A fake login, so the reopened session's provider counts as connected.
  mkdirSync(join(home, ".israelcode"));
  writeFileSync(
    join(home, ".israelcode", "auth.json"),
    JSON.stringify({
      anthropic: { accessToken: "bench", refreshToken: "bench", expiresAt: Date.now() + 864e5 },
    }),
  );
  const child = spawn(process.execPath, [...(opts.profile ? ["--inspect=0"] : []), script], {
    env: { ...process.env, HOME: home, USERPROFILE: home, GG_APP_PORT: "0", GG_APP_CWD: project },
    stdio: ["ignore", "pipe", "pipe"],
    detached: process.platform !== "win32",
  });
  let stderr = "";
  child.stderr.on("data", (d) => (stderr += d));
  const results = { script, turns: opts.turns, images: opts.images, git: opts.git, runs: [] };
  try {
    const { port, token } = await new Promise((ok, fail) => {
      let out = "";
      child.stdout.on("data", (d) => {
        out += d;
        const m = out.match(/GG_APP_LISTENING (\d+) (\S+)/);
        if (m) ok({ port: Number(m[1]), token: m[2] });
      });
      child.once("exit", (code) =>
        fail(new Error(`sidecar exited (${code}): ${stderr.slice(-400)}`)),
      );
    });
    const base = `http://127.0.0.1:${port}`;
    const inspector = opts.profile ? await attachProfiler(() => stderr) : null;
    const call = async (method, path, { session, body } = {}) => {
      const headers = { "x-gg-token": token };
      if (session) headers["x-gg-session"] = session;
      if (body) headers["content-type"] = "application/json";
      const res = await fetch(base + path, { method, headers, body: body && JSON.stringify(body) });
      const text = await res.text();
      return { status: res.status, text };
    };
    for (;;) {
      try {
        await call("GET", "/state");
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 20));
      }
    }
    const made = JSON.parse(
      (await call("POST", "/session", { body: { mode: "code", cwd: project } })).text,
    );
    const sessionPath = made.sessionPath;
    if (!sessionPath) throw new Error("POST /session returned no sessionPath");
    await call("DELETE", `/session/${made.sessionId}`);
    const header = JSON.parse(readFileSync(sessionPath, "utf8").split("\n")[0]);
    const { text, leafId } = sessionLines(header, await screenshot());
    writeFileSync(sessionPath, text.replace(/"leafId":null/, `"leafId":"${leafId}"`));
    results.sessionFileBytes = Buffer.byteLength(text);

    for (let i = 0; i < opts.runs; i++) {
      const t0 = performance.now();
      const opened = JSON.parse(
        (await call("POST", "/session", { body: { mode: "code", cwd: project, sessionPath } }))
          .text,
      );
      const tSession = performance.now();
      const id = opened.sessionId;
      if (!id) throw new Error(`reopen failed: ${JSON.stringify(opened)}`);
      for (;;) {
        if ((await call("GET", "/state", { session: id })).status === 200) break;
        await new Promise((r) => setTimeout(r, 5));
      }
      const tReady = performance.now();
      const history = await call("GET", "/history", { session: id });
      const tHistory = performance.now();
      const rows = JSON.parse(history.text).history?.length ?? 0;
      results.runs.push({
        sessionMs: round(tSession - t0),
        readyMs: round(tReady - t0),
        historyMs: round(tHistory - tReady),
        totalMs: round(tHistory - t0),
        historyBytes: history.text.length,
        historyRows: rows,
      });
      console.error(`run ${i + 1}/${opts.runs}: ${JSON.stringify(results.runs.at(-1))}`);
      await call("DELETE", `/session/${id}`);
    }
    if (inspector) results.hotspots = await inspector.stop();
  } finally {
    await killTree(child);
    await removeWhenReleased(home);
  }
  const keys = ["sessionMs", "readyMs", "historyMs", "totalMs", "historyBytes", "historyRows"];
  results.median = Object.fromEntries(keys.map((k) => [k, median(results.runs.map((r) => r[k]))]));
  results.firstOpen = results.runs[0];
  const json = JSON.stringify(results, null, 2);
  if (opts.out) writeFileSync(opts.out, json);
  console.log(json);
}

await main();
