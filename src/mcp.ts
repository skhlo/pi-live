// Codex's browser: a stdio MCP server that gives Codex, including Codex voice,
// Pi Live's browser tool on the Chrome that `live_browser` drives. It speaks
// newline-delimited JSON-RPC with Node built-ins only and runs one browser
// action at a time. When no Chrome answers on loopback, it starts one on the
// browser sidecar's profile and stops it when Codex closes the server.

import { spawn } from "node:child_process";
import { accessSync, constants, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
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
const CHROME_START_MS = 15_000;
const DEFAULT_CHROME =
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
export const STARTED_NOTE =
  "Started a Chrome window for browser actions; it closes when Codex quits.";

export const MCP_TOOL = {
  name: MCP_TOOL_NAME,
  description:
    "Drive the user's Chrome: look at, open, click, type into, scroll, read and switch tabs. In a voice conversation (requests arriving as realtime delegation), use this tool for every web browser action instead of any other browser or computer-use tool. Every action except read and tabs returns the resulting page with numbered element refs; click or type by ref, or by visible text in target. Buying, paying, deleting, sending, booking and signing in are refused and stay with the user.",
  inputSchema: BROWSER_TOOL_SCHEMA,
};

export type McpBrowser =
  | { tool: BrowserTool; url: string; starter?: ChromeStarter }
  | { problem: string };

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
        const run = (async () => {
          const started = (await browser.starter?.ensure(signal)) ?? false;
          const result = await browser.tool.run(checked, signal);
          return started ? `${STARTED_NOTE}\n${result.text}` : result.text;
        })();
        const stopped = new Promise<never>((_, reject) =>
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          }),
        );
        run.catch(() => undefined);
        stopped.catch(() => undefined);
        const result = await Promise.race([run, stopped]);
        if (!controller.signal.aborted) toolResult(id, result);
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

/** A Chrome this server starts, on the browser sidecar's profile. */
export interface ChromeStarter {
  readonly chrome: string;
  readonly profile: string;
  /** Starts Chrome when nothing answers; true when this call started it. */
  ensure(signal: AbortSignal): Promise<boolean>;
  /** Stops the Chrome this server started; a reused one keeps running. */
  stop(): void;
}

/** The part of a child process the starter uses, so tests can fake Chrome. */
export interface ChromeProcess {
  kill(signal?: NodeJS.Signals): boolean;
  once(event: "exit", listener: () => void): unknown;
  once(event: "error", listener: (error: Error) => void): unknown;
}

export function createChromeStarter(options: {
  url: string;
  chrome: string;
  profile: string;
  launch?: (chrome: string, args: string[]) => ChromeProcess;
  answers?: (url: string, signal: AbortSignal) => Promise<boolean>;
}): ChromeStarter {
  const { url, chrome, profile } = options;
  const launch =
    options.launch ??
    // Chrome stays in the server's process group, so Codex's stop reaches it.
    ((command, args) => spawn(command, args, { stdio: "ignore" }));
  const answers = options.answers ?? devToolsAnswers;
  let owned:
    { process: ChromeProcess; exited: boolean; failure?: string } | undefined;

  const start = () => {
    try {
      accessSync(chrome, constants.X_OK);
    } catch {
      throw new Error(
        `Chrome executable is missing: ${chrome}; SIDECAR_CHROME names another`,
      );
    }
    mkdirSync(profile, { recursive: true });
    const child = launch(chrome, [
      "--remote-debugging-address=127.0.0.1",
      `--remote-debugging-port=${new URL(url).port}`,
      `--user-data-dir=${profile}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--window-size=1280,900",
      "about:blank",
    ]);
    const state: NonNullable<typeof owned> = { process: child, exited: false };
    child.once("error", (error) => {
      state.failure = `Chrome could not start: ${error.message}`;
    });
    child.once("exit", () => {
      state.exited = true;
      state.failure ??= "Chrome exited while starting";
    });
    return state;
  };

  return {
    chrome,
    profile,
    async ensure(signal) {
      if (await answers(url, signal)) return false;
      if (!owned || owned.exited) owned = start();
      const current = owned;
      const deadline = Date.now() + CHROME_START_MS;
      while (!(await answers(url, signal))) {
        if (current.failure) throw new Error(current.failure);
        if (Date.now() > deadline)
          throw new Error(
            `Chrome did not answer at ${url} within ${CHROME_START_MS / 1000} s`,
          );
        await delay(200, undefined, { signal });
      }
      return true;
    },
    stop() {
      if (owned && !owned.exited) owned.process.kill("SIGTERM");
    },
  };
}

async function devToolsAnswers(
  url: string,
  signal: AbortSignal,
): Promise<boolean> {
  try {
    const response = await fetch(`${url}/json/version`, {
      signal: AbortSignal.any([signal, AbortSignal.timeout(1_000)]),
    });
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * The Chrome to drive: PI_LIVE_BROWSER_CDP, or else the sidecar's. Only a
 * 127.0.0.1 address gets a starter, because Chrome listens there.
 */
export function mcpBrowser(
  values: { PI_LIVE_BROWSER_CDP?: string },
  environment: Readonly<Record<string, string | undefined>> = {},
  create: (url: string) => BrowserTool = createBrowserTool,
): McpBrowser {
  const configured = values.PI_LIVE_BROWSER_CDP;
  const url = configured ? browserDevToolsUrl(configured) : SIDECAR_CDP;
  if (!url)
    return {
      problem:
        "PI_LIVE_BROWSER_CDP is not an http:// loopback address, so there is no browser to drive.",
    };
  if (new URL(url).hostname !== "127.0.0.1") return { tool: create(url), url };
  const cache =
    environment.XDG_CACHE_HOME ||
    path.join(environment.HOME || homedir(), ".cache");
  return {
    tool: create(url),
    url,
    starter: createChromeStarter({
      url,
      chrome: environment.SIDECAR_CHROME || DEFAULT_CHROME,
      profile:
        environment.SIDECAR_CHROME_PROFILE ||
        path.join(cache, "pi-live", "browser-profile"),
    }),
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
  const { values, notice } = browserEnvironment(
    process.env,
    path.join(import.meta.dirname, "..", ".env"),
  );
  if (notice) process.stderr.write(`pi-live-browser: ${notice}\n`);
  const browser = mcpBrowser(values, process.env);
  const server = createMcpServer(browser, (message) =>
    process.stdout.write(`${JSON.stringify(message)}\n`),
  );
  // Codex closing stdin or stopping the server ends it, even with a DevTools
  // request pending, and closes the Chrome it started.
  const shutdown = (): void => {
    if ("starter" in browser) browser.starter?.stop();
    process.exit(0);
  };
  createInterface({ input: process.stdin })
    .on("line", (line) => server.receive(line))
    .on("close", shutdown);
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const)
    process.on(signal, shutdown);
}
