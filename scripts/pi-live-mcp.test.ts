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
  assert.match(timedOut ?? "", /scripts\/browser-sidecar\.sh/);
  assert.deepEqual(sent[1]?.result, {
    content: [{ type: "text", text: "did read" }],
  });
});

test("the first action after starting Chrome says so", async () => {
  const fake = fakeTool();
  const starts = [true, false];
  const starter: ChromeStarter = {
    chrome: "chrome",
    profile: "profile",
    ensure: async () => starts.shift() ?? false,
    stop: () => undefined,
  };
  const { sent, request } = server({
    tool: fake.tool,
    url: SIDECAR_CDP,
    starter,
  });
  request(1, "tools/call", call("look"));
  await settle();
  fake.release();
  await settle();
  request(2, "tools/call", call("tabs"));
  await settle();
  fake.release();
  await settle();
  assert.deepEqual(
    sent.map((message) => message.result),
    [
      { content: [{ type: "text", text: `${STARTED_NOTE}\ndid look` }] },
      { content: [{ type: "text", text: "did tabs" }] },
    ],
  );
});

// A Chrome process that exits when told to, or on its own.
function fakeChrome() {
  const events = new EventEmitter();
  const signals: string[] = [];
  const chrome: ChromeProcess = {
    kill(signal) {
      signals.push(signal ?? "SIGTERM");
      events.emit("exit");
      return true;
    },
    once(event: string, listener: (error: Error) => void) {
      return events.once(event, listener);
    },
  };
  return { chrome, signals, exit: () => events.emit("exit") };
}

test("the starter launches Chrome only when nothing answers, and stops only its own", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "pi-live-mcp-"));
  t.after(() => rm(root, { recursive: true }));
  const profile = path.join(root, "profile");
  let answering = false;
  const launches: string[][] = [];
  let current = fakeChrome();
  const starter = createChromeStarter({
    url: "http://127.0.0.1:9444",
    chrome: process.execPath,
    profile,
    launch: (_command, args) => {
      launches.push(args);
      current = fakeChrome();
      answering = true;
      return current.chrome;
    },
    answers: async () => answering,
  });
  const signal = new AbortController().signal;

  answering = true;
  assert.equal(
    await starter.ensure(signal),
    false,
    "a running Chrome is reused",
  );
  starter.stop();
  assert.equal(launches.length, 0);

  answering = false;
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

  // The user closed the window: the next action starts Chrome again.
  current.exit();
  answering = false;
  assert.equal(await starter.ensure(signal), true);
  assert.equal(launches.length, 2);
  const second = current;
  starter.stop();
  assert.deepEqual(second.signals, ["SIGTERM"]);
});

test("the starter reports a missing or failing Chrome", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "pi-live-mcp-"));
  t.after(() => rm(root, { recursive: true }));
  const signal = new AbortController().signal;
  const missing = createChromeStarter({
    url: "http://127.0.0.1:9444",
    chrome: path.join(root, "no-chrome"),
    profile: path.join(root, "profile"),
    answers: async () => false,
  });
  await assert.rejects(missing.ensure(signal), /Chrome executable is missing/);
  const dying = fakeChrome();
  const failing = createChromeStarter({
    url: "http://127.0.0.1:9444",
    chrome: process.execPath,
    profile: path.join(root, "profile"),
    launch: () => {
      setImmediate(dying.exit);
      return dying.chrome;
    },
    answers: async () => false,
  });
  await assert.rejects(failing.ensure(signal), /Chrome exited while starting/);
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
require("node:fs").writeFileSync(${JSON.stringify(record)}, JSON.stringify({ pid: process.pid, args: process.argv.slice(2) }));
http.createServer((request, response) => response.end(request.url === "/json/version" ? "{}" : "[]")).listen(Number(port), "127.0.0.1");
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
    for (let i = 0; i < 100 && alive(pid); i++)
      await new Promise((resolve) => setTimeout(resolve, 20));
    return !alive(pid);
  };
  return { root, port, start, chromeRecord, gone };
}

test("the server process starts Chrome and closes it when stdin closes", async (t) => {
  const fixture = await serverProcess(t);
  const server = fixture.start({});
  // The fake has no tabs, so the action fails after Chrome is started.
  const result = await server.call(1, "look");
  assert.equal(result.isError, true);
  assert.match(result.content[0]?.text ?? "", /Chrome has no open tab/);
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

test("the server process explains a missing Chrome", async (t) => {
  const fixture = await serverProcess(t);
  const server = fixture.start({
    SIDECAR_CHROME: path.join(fixture.root, "no-chrome"),
  });
  const result = await server.call(1, "look");
  assert.equal(result.isError, true);
  assert.match(
    result.content[0]?.text ?? "",
    /^Browser action failed: Chrome executable is missing: .*no-chrome; SIDECAR_CHROME names another\. If no Chrome is running with DevTools at http:\/\/127\.0\.0\.1:\d+/,
  );
  server.child.stdin.end();
  assert.equal(await server.exited, 0);
});
