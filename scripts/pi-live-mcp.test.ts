import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { createInterface } from "node:readline";
import { test } from "node:test";
import { SIDECAR_CDP } from "../src/browser-sidecar.ts";
import {
  BROWSER_TOOL_SCHEMA,
  type BrowserTool,
  type BrowserToolParams,
} from "../src/browser-tool.ts";
import {
  createMcpServer,
  mcpBrowser,
  MCP_TOOL_NAME,
  type McpBrowser,
} from "../src/mcp.ts";

const SERVER = new URL("../src/mcp.ts", import.meta.url).pathname;

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

function server(browser: McpBrowser) {
  const sent: Array<Record<string, unknown>> = [];
  const mcp = createMcpServer(browser, (message) =>
    sent.push(message as Record<string, unknown>),
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

test("the browser comes from PI_LIVE_BROWSER_CDP or the sidecar", () => {
  const urls: string[] = [];
  const create = (url: string): BrowserTool => {
    urls.push(url);
    return fakeTool().tool;
  };
  assert.equal(
    (mcpBrowser({}, create) as { url: string }).url,
    "http://127.0.0.1:9333",
  );
  assert.equal(
    (
      mcpBrowser({ PI_LIVE_BROWSER_CDP: "http://127.0.0.1:9444" }, create) as {
        url: string;
      }
    ).url,
    "http://127.0.0.1:9444",
  );
  assert.deepEqual(urls, [SIDECAR_CDP, "http://127.0.0.1:9444"]);
  const bad = mcpBrowser({ PI_LIVE_BROWSER_CDP: "http://example.com:9333" });
  assert.match((bad as { problem: string }).problem, /loopback/);
});

test("the MCP server runs as a process and names the sidecar when Chrome is absent", async (t) => {
  // A port that was free a moment ago stands in for a Chrome that is not running.
  const port = await new Promise<number>((resolve) => {
    const probe = createServer().listen(0, "127.0.0.1", () => {
      const address = probe.address();
      probe.close(() =>
        resolve(typeof address === "object" && address ? address.port : 0),
      );
    });
  });
  const child = spawn(process.execPath, [SERVER], {
    env: {
      ...process.env,
      PI_LIVE_BROWSER_CDP: `http://127.0.0.1:${port}`,
    },
    stdio: ["pipe", "pipe", "inherit"],
  });
  t.after(() => child.kill());
  const lines = createInterface({ input: child.stdout })[
    Symbol.asyncIterator
  ]();
  const next = async () =>
    JSON.parse(String((await lines.next()).value)) as Record<string, unknown>;
  const send = (id: number, method: string, params?: unknown) =>
    child.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`,
    );

  send(1, "initialize", { protocolVersion: "2025-06-18" });
  assert.deepEqual((await next()).id, 1);
  send(2, "tools/call", call("look"));
  const result = (await next()).result as {
    content: Array<{ text: string }>;
    isError: boolean;
  };
  assert.equal(result.isError, true);
  assert.match(
    result.content[0]?.text ?? "",
    /No Chrome answers at http:\/\/127\.0\.0\.1:\d+/,
  );
  assert.match(result.content[0]?.text ?? "", /scripts\/browser-sidecar\.sh/);
});
