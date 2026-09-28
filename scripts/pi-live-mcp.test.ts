import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { test } from "node:test";
import { SIDECAR_CDP } from "../src/browser-sidecar.ts";
import {
  BROWSER_TOOL_SCHEMA,
  type BrowserTool,
  type BrowserToolParams,
} from "../src/browser-tool.ts";
import {
  createChromeStarter,
  createMcpServer,
  mcpBrowser,
  MCP_TOOL_NAME,
  STARTED_NOTE,
  type ChromeProcess,
  type ChromeStarter,
  type McpBrowser,
} from "../src/mcp.ts";

const SERVER = path.join(import.meta.dirname, "..", "src", "mcp.ts");

// A browser tool whose actions finish only when the test releases them.
function fakeTool() {
  const calls: Array<{ params: BrowserToolParams; signal?: AbortSignal }> = [];
  const releases: Array<() => void> = [];
  const tool: BrowserTool = {
    run(params, signal) {
      calls.push({ params, signal });
      return new Promise((resolve) =>
        releases.push(() => resolve({ text: `did ${params.action}` })),
      );
    },
    currentPage: async () => undefined,
  };
  return { tool, calls, release: () => releases.shift()?.() };
}

function server(browser: McpBrowser, options?: { timeoutMs?: number }) {
  const sent: Array<Record<string, unknown>> = [];
  const mcp = createMcpServer(
    browser,
    (message) => sent.push(message as Record<string, unknown>),
    options,
  );
  const request = (id: number, method: string, params?: unknown) =>
    mcp.receive(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
  return { sent, receive: mcp.receive, request };
}

const call = (action: string) => ({
  name: MCP_TOOL_NAME,
  arguments: { action },
});
const settle = () => new Promise((resolve) => setImmediate(resolve));

test("the MCP server introduces itself and lists the browser tool", () => {
  const { sent, request } = server({ problem: "unused" });
  request(1, "initialize", { protocolVersion: "2025-06-18" });
  request(2, "tools/list");
  request(3, "ping");
  request(4, "initialize", { protocolVersion: "2099-01-01" });
  assert.equal(
    (sent[3]?.result as Record<string, unknown>).protocolVersion,
    "2025-06-18",
    "an unknown version gets the newest one the server speaks",
  );
  assert.equal(
    (sent[0]?.result as Record<string, unknown>).protocolVersion,
    "2025-06-18",
  );
  const [tool] = (sent[1]?.result as { tools: Array<Record<string, unknown>> })
    .tools;
  assert.equal(tool?.name, "browser");
  assert.equal(tool?.inputSchema, BROWSER_TOOL_SCHEMA);
  assert.match(String(tool?.description), /voice conversation/);
  assert.deepEqual(sent[2], { jsonrpc: "2.0", id: 3, result: {} });
});

test("the MCP server rejects malformed and unknown requests", () => {
  const { sent, receive, request } = server({ problem: "unused" });
  receive("{not json");
  request(1, "resources/list");
  request(2, "tools/call", { name: "shell", arguments: {} });
  receive(
    JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
  );
  assert.deepEqual(
    sent.map((message) => (message.error as { code: number }).code),
    [-32700, -32601, -32602],
  );
});

test("browser calls run one at a time and answer with the tool's text", async () => {
  const fake = fakeTool();
  const { sent, request } = server({ tool: fake.tool, url: SIDECAR_CDP });
  request(1, "tools/call", call("look"));
  request(2, "tools/call", call("tabs"));
  request(3, "tools/call", {
    name: MCP_TOOL_NAME,
    arguments: { action: "fly" },
  });
  await settle();
  assert.equal(fake.calls.length, 1);
  assert.deepEqual(sent[0], {
    jsonrpc: "2.0",
    id: 3,
    result: {
      content: [{ type: "text", text: "Invalid browser arguments." }],
      isError: true,
    },
  });
  fake.release();
  await settle();
  assert.equal(fake.calls.length, 2);
  fake.release();
  await settle();
  assert.deepEqual(
    sent.slice(1).map((message) => message.result),
    [
      { content: [{ type: "text", text: "did look" }] },
      { content: [{ type: "text", text: "did tabs" }] },
    ],
  );
});

test("a cancelled browser call stops and gets no reply", async () => {
  const fake = fakeTool();
  const { sent, receive, request } = server({
    tool: fake.tool,
    url: SIDECAR_CDP,
  });
  const cancel = (requestId: number) =>
    receive(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "notifications/cancelled",
        params: { requestId },
      }),
    );
  request(1, "tools/call", call("look"));
  request(2, "tools/call", call("tabs"));
  await settle();
  cancel(1);
  cancel(2);
  assert.equal(fake.calls[0]?.signal?.aborted, true);
  fake.release();
  await settle();
  assert.equal(fake.calls.length, 1, "the queued call never runs");
  request(3, "tools/call", call("read"));
  await settle();
  fake.release();
  await settle();
  assert.deepEqual(
    sent.map((message) => message.id),
    [3],
  );
});

test("a hung browser call releases the queue on cancel or after its bound", async () => {
  const fake = fakeTool();
  const { sent, receive, request } = server(
    { tool: fake.tool, url: SIDECAR_CDP },
    { timeoutMs: 200 },
  );
  // Calls 1 and 2 never finish; the fake ignores their signals.
  request(1, "tools/call", call("look"));
  request(2, "tools/call", call("tabs"));
  request(3, "tools/call", call("read"));
  await settle();
  receive(
    JSON.stringify({
      jsonrpc: "2.0",
      method: "notifications/cancelled",
      params: { requestId: 1 },
    }),
  );
  await settle();
  assert.equal(fake.calls.length, 2, "the cancel frees the queue at once");
  const started = Date.now();
  while (fake.calls.length < 3 && Date.now() - started < 2_000)
    await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(fake.calls.length, 3, "the bound frees it again");
  fake.release();
  fake.release();
  fake.release();
  await settle();
  assert.deepEqual(
    sent.map((message) => message.id),
    [2, 3],
  );
  const timedOut = (sent[0]?.result as { content: Array<{ text: string }> })
    .content[0]?.text;
  assert.match(timedOut ?? "", /^Browser action timed out after 0\.2 s\./);
  assert.match(timedOut ?? "", /--remote-debugging-port/);
  assert.deepEqual(sent[1]?.result, {
    content: [{ type: "text", text: "did read" }],
  });
});

test("the reply after starting Chrome says so, even when the action fails", async () => {
  const outcomes = [
    () => Promise.reject(new Error("no tab yet")),
    () => Promise.resolve({ text: "did tabs" }),
  ];
  const tool: BrowserTool = {
    run: () => outcomes.shift()?.() ?? Promise.resolve({ text: "" }),
    currentPage: async () => undefined,
  };
  const starts = [true, false];
  const starter: ChromeStarter = {
    chrome: "chrome",
    profile: "profile",
    ensure: async () => starts.shift() ?? false,
    stop: async () => undefined,
  };
  const { sent, request } = server({ tool, url: SIDECAR_CDP, starter });
  request(1, "tools/call", call("look"));
  request(2, "tools/call", call("tabs"));
  await settle();
  await settle();
  const texts = sent.map(
    (message) =>
      (message.result as { content: Array<{ text: string }> }).content[0]?.text,
  );
  assert.match(
    texts[0] ?? "",
    /^Started a Chrome window for browser actions\.\nBrowser action failed: no tab yet\. This server starts Chrome/,
  );
  assert.equal(texts[1], "did tabs");
});

// A Chrome process that exits when told to, unless it ignores SIGTERM.
function fakeChrome({ ignoreTerm = false } = {}) {
  const events = new EventEmitter();
  const signals: string[] = [];
  const chrome: ChromeProcess = {
    kill(signal = "SIGTERM") {
      signals.push(signal);
      if (!(ignoreTerm && signal === "SIGTERM")) events.emit("exit");
      return true;
    },
    once(event: string, listener: (error: Error) => void) {
      return events.once(event, listener);
    },
  };
  return {
    chrome,
    signals,
    exit: () => events.emit("exit"),
    fail: () => events.emit("error", new Error("spawn EACCES")),
  };
}

test("the starter starts Chrome only when nothing answers, and keeps a tab open", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "pi-live-mcp-"));
  t.after(() => rm(root, { recursive: true }));
  const profile = path.join(root, "profile");
  let tabs: number | undefined = 1;
  let opened = 0;
  const launches: string[][] = [];
  let current = fakeChrome();
  const starter = createChromeStarter({
    url: "http://127.0.0.1:9444",
    chrome: process.execPath,
    profile,
    launch: (_command, args) => {
      launches.push(args);
      current = fakeChrome();
      tabs = 1;
      return current.chrome;
    },
    pages: {
      count: async () => tabs,
      open: async () => {
        opened++;
        tabs = 1;
      },
    },
  });
  const signal = new AbortController().signal;

  assert.equal(
    await starter.ensure(signal),
    false,
    "a running Chrome is reused",
  );
  await starter.stop();
  assert.equal(launches.length, 0, "and never stopped");

  // Its last window was closed; Chrome keeps running on macOS.
  tabs = 0;
  assert.equal(await starter.ensure(signal), false);
  assert.equal(opened, 1, "a new tab is opened");

  tabs = undefined;
  assert.equal(await starter.ensure(signal), true);
  assert.deepEqual(launches[0], [
    "--remote-debugging-address=127.0.0.1",
    "--remote-debugging-port=9444",
    `--user-data-dir=${profile}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--window-size=1280,900",
    "about:blank",
  ]);
  assert.equal(await starter.ensure(signal), false, "then it is reused");

  // Chrome quit: the next action starts it again.
  current.exit();
  tabs = undefined;
  assert.equal(await starter.ensure(signal), true);
  assert.equal(launches.length, 2);
  const second = current;
  await starter.stop();
  assert.deepEqual(second.signals, ["SIGTERM"]);
});

test("the server launches Chrome as the sidecar script does", async () => {
  // The two share a profile, so their Chrome flags and defaults stay in step.
  const script = await readFile(
    path.join(import.meta.dirname, "browser-sidecar.sh"),
    "utf8",
  );
  for (const expected of [
    "--remote-debugging-address=127.0.0.1",
    '--user-data-dir="$profile" --no-first-run --no-default-browser-check',
    "--window-size=1280,900 about:blank",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "${XDG_CACHE_HOME:-$HOME/.cache}/pi-live/browser-profile",
  ])
    assert.ok(script.includes(expected), `the script has ${expected}`);
});

test("the starter kills a Chrome that outlasts its stop", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "pi-live-mcp-"));
  t.after(() => rm(root, { recursive: true }));
  let tabs: number | undefined;
  const stubborn = fakeChrome({ ignoreTerm: true });
  const starter = createChromeStarter({
    url: "http://127.0.0.1:9444",
    chrome: process.execPath,
    profile: path.join(root, "profile"),
    launch: () => {
      tabs = 1;
      return stubborn.chrome;
    },
    pages: { count: async () => tabs, open: async () => undefined },
    stopMs: 20,
  });
  await starter.ensure(new AbortController().signal);
  await starter.stop();
  assert.deepEqual(stubborn.signals, ["SIGTERM", "SIGKILL"]);
});

test("the starter reports a missing or failing Chrome", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "pi-live-mcp-"));
  t.after(() => rm(root, { recursive: true }));
  const signal = new AbortController().signal;
  const none = { count: async () => undefined, open: async () => undefined };
  for (const chrome of [path.join(root, "no-chrome"), root]) {
    const missing = createChromeStarter({
      url: "http://127.0.0.1:9444",
      chrome,
      profile: path.join(root, "profile"),
      pages: none,
    });
    await assert.rejects(
      missing.ensure(signal),
      /Chrome executable is missing/,
    );
  }
  const launched: Array<ReturnType<typeof fakeChrome>> = [];
  const failing = createChromeStarter({
    url: "http://127.0.0.1:9444",
    chrome: process.execPath,
    profile: path.join(root, "profile"),
    launch: () => {
      const chrome = fakeChrome();
      launched.push(chrome);
      // The first dies while starting; the second cannot be spawned at all.
      setImmediate(launched.length === 1 ? chrome.exit : chrome.fail);
      return chrome.chrome;
    },
    pages: none,
  });
  await assert.rejects(failing.ensure(signal), /Chrome exited while starting/);
  await assert.rejects(
    failing.ensure(signal),
    /Chrome could not start: spawn EACCES/,
  );
  assert.equal(
    launched.length,
    2,
    "each failure is retried by the next action",
  );
});

test("the browser comes from PI_LIVE_BROWSER_CDP or the sidecar", () => {
  const urls: string[] = [];
  const create = (url: string): BrowserTool => {
    urls.push(url);
    return fakeTool().tool;
  };
  const home = mcpBrowser({}, { HOME: "/home/a" }, create);
  assert.equal((home as { url: string }).url, SIDECAR_CDP);
  assert.equal(
    (home as { starter: ChromeStarter }).starter.profile,
    "/home/a/.cache/pi-live/browser-profile",
  );
  assert.equal(
    (home as { starter: ChromeStarter }).starter.chrome,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  );
  const custom = mcpBrowser(
    { PI_LIVE_BROWSER_CDP: "http://127.0.0.1:9444" },
    { XDG_CACHE_HOME: "/cache", SIDECAR_CHROME: "/bin/chrome" },
    create,
  ) as { url: string; starter: ChromeStarter };
  assert.equal(custom.url, "http://127.0.0.1:9444");
  assert.equal(custom.starter.profile, "/cache/pi-live/browser-profile");
  assert.equal(custom.starter.chrome, "/bin/chrome");
  const named = mcpBrowser(
    {},
    { HOME: "/home/a", SIDECAR_CHROME_PROFILE: "/profiles/codex" },
    create,
  ) as { starter: ChromeStarter };
  assert.equal(named.starter.profile, "/profiles/codex");
  // Chrome listens on 127.0.0.1 only, so another loopback name gets no starter.
  const localhost = mcpBrowser(
    { PI_LIVE_BROWSER_CDP: "http://localhost:9444" },
    {},
    create,
  );
  assert.equal("starter" in localhost, false);
  assert.deepEqual(urls, [
    SIDECAR_CDP,
    "http://127.0.0.1:9444",
    SIDECAR_CDP,
    "http://localhost:9444",
  ]);
  const bad = mcpBrowser({ PI_LIVE_BROWSER_CDP: "http://example.com:9333" });
  assert.match((bad as { problem: string }).problem, /loopback/);
});

// The real server process with a fake Chrome executable that serves DevTools'
// version and an empty tab list on its port and records how it was started.
async function serverProcess(t: import("node:test").TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), "pi-live-mcp-"));
  const record = path.join(root, "chrome.json");
  // A failed test must not leave its fake Chrome running.
  t.after(async () => {
    try {
      const { pid } = JSON.parse(await readFile(record, "utf8")) as {
        pid: number;
      };
      process.kill(pid, "SIGKILL");
    } catch {
      // Never started, or already stopped.
    }
    await rm(root, { recursive: true, force: true });
  });
  const port = await new Promise<number>((resolve) => {
    const probe = createServer().listen(0, "127.0.0.1", () => {
      const address = probe.address();
      probe.close(() =>
        resolve(typeof address === "object" && address ? address.port : 0),
      );
    });
  });
  const chrome = path.join(root, "chrome");
  await writeFile(
    chrome,
    `#!${process.execPath}
const http = require("node:http");
const port = process.argv.find((arg) => arg.startsWith("--remote-debugging-port=")).split("=")[1];
if (process.env.FAKE_IGNORE_TERM) process.on("SIGTERM", () => undefined);
const page = [{ id: "1", type: "page", title: "", url: "about:blank", webSocketDebuggerUrl: "ws://127.0.0.1:1/devtools/page/1" }];
require("node:fs").writeFileSync(${JSON.stringify(record)}, JSON.stringify({ pid: process.pid, args: process.argv.slice(2) }));
http.createServer((request, response) => response.end(JSON.stringify(request.url === "/json/list" ? page : {}))).listen(Number(port), "127.0.0.1");
`,
  );
  await chmod(chrome, 0o755);
  const start = (environment: Record<string, string>) => {
    const child = spawn(process.execPath, [SERVER], {
      env: {
        PATH: process.env.PATH,
        HOME: root,
        PI_LIVE_BROWSER_CDP: `http://127.0.0.1:${port}`,
        SIDECAR_CHROME: chrome,
        SIDECAR_CHROME_PROFILE: path.join(root, "profile"),
        ...environment,
      },
      stdio: ["pipe", "pipe", "inherit"],
    });
    t.after(() => child.kill("SIGKILL"));
    const lines = createInterface({ input: child.stdout })[
      Symbol.asyncIterator
    ]();
    const exited = new Promise((resolve) => child.on("exit", resolve));
    return {
      child,
      exited,
      async call(id: number, action: string) {
        child.stdin.write(
          `${JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: call(action) })}\n`,
        );
        const reply = JSON.parse(String((await lines.next()).value)) as {
          result: { content: Array<{ text: string }>; isError?: boolean };
        };
        return reply.result;
      },
    };
  };
  const chromeRecord = async () =>
    JSON.parse(await readFile(record, "utf8")) as {
      pid: number;
      args: string[];
    };
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  const gone = async (pid: number) => {
    for (let i = 0; i < 300 && alive(pid); i++)
      await new Promise((resolve) => setTimeout(resolve, 20));
    return !alive(pid);
  };
  return { root, port, start, chromeRecord, gone };
}

test("the server process starts Chrome and closes it when stdin closes", async (t) => {
  const fixture = await serverProcess(t);
  const server = fixture.start({});
  // The fake's tab has no DevTools socket, so the action fails after Chrome
  // is started, and the reply still says Chrome was started.
  const result = await server.call(1, "look");
  assert.equal(result.isError, true);
  assert.match(
    result.content[0]?.text ?? "",
    /^Started a Chrome window for browser actions\.\nBrowser action failed: /,
  );
  const chrome = await fixture.chromeRecord();
  assert.ok(chrome.args.includes(`--remote-debugging-port=${fixture.port}`));
  assert.ok(
    chrome.args.includes(
      `--user-data-dir=${path.join(fixture.root, "profile")}`,
    ),
  );
  server.child.stdin.end();
  assert.equal(await server.exited, 0);
  assert.ok(await fixture.gone(chrome.pid), "Chrome stops with the server");
});

test("the server process closes its Chrome when it is stopped", async (t) => {
  const fixture = await serverProcess(t);
  const server = fixture.start({});
  await server.call(1, "look");
  const chrome = await fixture.chromeRecord();
  server.child.kill("SIGTERM");
  assert.equal(await server.exited, 0);
  assert.ok(await fixture.gone(chrome.pid), "Chrome stops with the server");
});

test("the server process kills a Chrome that ignores its stop", async (t) => {
  const fixture = await serverProcess(t);
  const server = fixture.start({ FAKE_IGNORE_TERM: "1" });
  await server.call(1, "look");
  const chrome = await fixture.chromeRecord();
  server.child.stdin.end();
  assert.equal(await server.exited, 0);
  assert.ok(await fixture.gone(chrome.pid), "Chrome is killed after the bound");
});

test("the server process explains a missing Chrome", async (t) => {
  const fixture = await serverProcess(t);
  const server = fixture.start({
    SIDECAR_CHROME: path.join(fixture.root, "no-chrome"),
  });
  const result = await server.call(1, "look");
  assert.equal(result.isError, true);
  assert.match(
    result.content[0]?.text ?? "",
    /^Browser action failed: Chrome executable is missing: .*no-chrome; SIDECAR_CHROME names another\. This server starts Chrome at http:\/\/127\.0\.0\.1:\d+ itself/,
  );
  server.child.stdin.end();
  assert.equal(await server.exited, 0);
});
