// Codex's browser: a stdio MCP server that gives Codex, including Codex voice,
// Pi Live's browser tool on the Chrome that `live_browser` drives. It speaks
// newline-delimited JSON-RPC with Node built-ins only, runs one browser action
// at a time, and never starts or owns a browser.

import path from "node:path";
import { createInterface } from "node:readline";
import { SIDECAR_CDP } from "./browser-sidecar.ts";
import {
  BROWSER_TOOL_SCHEMA,
  browserToolParams,
  createBrowserTool,
  type BrowserTool,
} from "./browser-tool.ts";
import { browserDevToolsUrl, browserEnvironment, isRecord } from "./browser.ts";

export const MCP_TOOL_NAME = "browser";
// Newest first; the tools-only subset used here is the same in each.
const PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const ACTION_TIMEOUT_MS = 30_000;

export const MCP_TOOL = {
  name: MCP_TOOL_NAME,
  description:
    "Drive the user's Chrome: look at, open, click, type into, scroll, read and switch tabs. In a voice conversation (requests arriving as realtime delegation), use this tool for every web browser action instead of any other browser or computer-use tool. Every action except read and tabs returns the resulting page with numbered element refs; click or type by ref, or by visible text in target. Buying, paying, deleting, sending, booking and signing in are refused and stay with the user.",
  inputSchema: BROWSER_TOOL_SCHEMA,
};

export type McpBrowser =
  { tool: BrowserTool; url: string } | { problem: string };

type Id = string | number;

/** Handles one JSON-RPC line at a time and sends each reply through send. */
export function createMcpServer(
  browser: McpBrowser,
  send: (message: unknown) => void,
  { timeoutMs = ACTION_TIMEOUT_MS }: { timeoutMs?: number } = {},
): { receive(line: string): void } {
  const running = new Map<Id, AbortController>();
  let queue: Promise<void> = Promise.resolve();

  const reply = (id: Id, result: unknown): void =>
    send({ jsonrpc: "2.0", id, result });
  const fail = (id: Id | null, code: number, message: string): void =>
    send({ jsonrpc: "2.0", id, error: { code, message } });
  const toolResult = (id: Id, text: string, isError = false): void =>
    reply(id, {
      content: [{ type: "text", text }],
      ...(isError ? { isError } : {}),
    });

  const call = (id: Id, params: Record<string, unknown>): void => {
    if (params.name !== MCP_TOOL_NAME) {
      fail(id, -32602, `Unknown tool: ${String(params.name)}`);
      return;
    }
    if (!("tool" in browser)) {
      toolResult(id, browser.problem, true);
      return;
    }
    const checked = browserToolParams(params.arguments);
    if (!checked) {
      toolResult(id, "Invalid browser arguments.", true);
      return;
    }
    const controller = new AbortController();
    running.set(id, controller);
    queue = queue.then(async () => {
      try {
        if (controller.signal.aborted) return;
        const signal = AbortSignal.any([
          controller.signal,
          AbortSignal.timeout(timeoutMs),
        ]);
        // Some DevTools requests ignore the signal, so a cancel or the time
        // bound releases the queue without waiting for them.
        const run = browser.tool.run(checked, signal);
        const stopped = new Promise<never>((_, reject) =>
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          }),
        );
        run.catch(() => undefined);
        stopped.catch(() => undefined);
        const result = await Promise.race([run, stopped]);
        if (!controller.signal.aborted) toolResult(id, result.text);
      } catch (error) {
        if (!controller.signal.aborted)
          toolResult(id, failure(browser.url, error, timeoutMs), true);
      } finally {
        running.delete(id);
      }
    });
  };

  return {
    receive(line) {
      if (!line.trim()) return;
      let message: unknown;
      try {
        message = JSON.parse(line);
      } catch {
        fail(null, -32700, "Parse error");
        return;
      }
      if (!isRecord(message) || typeof message.method !== "string") {
        if (isRecord(message) && isId(message.id))
          fail(message.id, -32600, "Invalid request");
        return;
      }
      const params = isRecord(message.params) ? message.params : {};
      if (!isId(message.id)) {
        // Notifications get no reply; a cancelled call gets none either.
        if (
          message.method === "notifications/cancelled" &&
          isId(params.requestId)
        )
          running.get(params.requestId)?.abort();
        return;
      }
      const id = message.id;
      switch (message.method) {
        case "initialize":
          reply(id, {
            protocolVersion: PROTOCOL_VERSIONS.includes(
              String(params.protocolVersion),
            )
              ? params.protocolVersion
              : PROTOCOL_VERSIONS[0],
            capabilities: { tools: {} },
            serverInfo: { name: "pi-live-browser", version: "0.1.0" },
          });
          return;
        case "ping":
          reply(id, {});
          return;
        case "tools/list":
          reply(id, { tools: [MCP_TOOL] });
          return;
        case "tools/call":
          call(id, params);
          return;
        default:
          fail(id, -32601, `Method not found: ${message.method}`);
      }
    },
  };
}

function failure(url: string, error: unknown, timeoutMs: number): string {
  const cause =
    error instanceof Error && error.name === "TimeoutError"
      ? `Browser action timed out after ${timeoutMs / 1000} s.`
      : `Browser action failed: ${error instanceof Error ? error.message : String(error)}.`;
  return `${cause} If no Chrome is running with DevTools at ${url}, tell the user to start one there: the browser sidecar (scripts/browser-sidecar.sh), or Chrome with --remote-debugging-port and its own --user-data-dir. PI_LIVE_BROWSER_CDP selects another address.`;
}

function isId(value: unknown): value is Id {
  return typeof value === "string" || typeof value === "number";
}

/** The Chrome to drive: PI_LIVE_BROWSER_CDP, or else the sidecar's. */
export function mcpBrowser(
  values: { PI_LIVE_BROWSER_CDP?: string },
  create: (url: string) => BrowserTool = createBrowserTool,
): McpBrowser {
  const configured = values.PI_LIVE_BROWSER_CDP;
  const url = configured ? browserDevToolsUrl(configured) : SIDECAR_CDP;
  return url
    ? { tool: create(url), url }
    : {
        problem:
          "PI_LIVE_BROWSER_CDP is not an http:// loopback address, so there is no browser to drive.",
      };
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
  const { values, notice } = browserEnvironment(
    process.env,
    path.join(import.meta.dirname, "..", ".env"),
  );
  if (notice) process.stderr.write(`pi-live-browser: ${notice}\n`);
  const server = createMcpServer(mcpBrowser(values), (message) =>
    process.stdout.write(`${JSON.stringify(message)}\n`),
  );
  createInterface({ input: process.stdin })
    .on("line", (line) => server.receive(line))
    // Codex closing stdin ends the server, even with a DevTools request pending.
    .on("close", () => process.exit(0));
}
