import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, openSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { loopbackUrl } from "./browser.ts";

export const SIDECAR_CDP = "http://127.0.0.1:9333";
const STOP_MS = 5_000;
export const SIDECAR_PROMPT = "Start the browser sidecar?";
export const SIDECAR_DISCLOSURE =
  "Starts Chrome and third-party voice-browser code with your TypeSafe key. Both run until this Pi session ends, including after voice stops. A Pi crash leaves them running for the next session to reuse.";

export interface BrowserSidecar {
  logPath: string;
  /** Undefined while running; a fixed, non-secret cause after exit. */
  failure(): string | undefined;
  /**
   * Ends the sidecar within a bounded time. The log is deleted only after a
   * clean stop of a running sidecar, unless a notice names it (`keepLog`).
   */
  stop(options?: { keepLog?: boolean }): Promise<void>;
}

export interface BrowserSidecarSetup {
  url: string;
  directory?: string;
  probe(): Promise<boolean>;
  start(): BrowserSidecar;
}

/** Only the script's fixed controller endpoint is eligible for an offer. */
export function isSidecarUrl(value: string): boolean {
  const loopback = loopbackUrl(value, "ws:");
  if (!loopback) return false;
  const url = new URL(loopback);
  // The script's voice-browser listens on IPv4 loopback, not ::1.
  return (
    url.hostname !== "[::1]" &&
    url.port === "8787" &&
    url.pathname === "/" &&
    !url.search &&
    !url.hash
  );
}

/** A WebSocket handshake, without sending a browser instruction. */
export function probeBrowserController(
  url: string,
  timeoutMs = 500,
): Promise<boolean> {
  return new Promise((resolve) => {
    let socket: WebSocket | undefined;
    let done = false;
    const finish = (answers: boolean): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket?.close();
      resolve(answers);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    try {
      socket = new WebSocket(url);
      socket.addEventListener("open", () => finish(true));
      socket.addEventListener("error", () => finish(false));
      socket.addEventListener("close", () => finish(false));
    } catch {
      finish(false);
    }
  });
}

function exitCause(logPath: string): string {
  let log = "";
  try {
    log = readFileSync(logPath, "utf8");
  } catch {
    // The fixed fallback still identifies the log, without exposing raw output.
  }
  if (log.includes("set VOICE_BROWSER_DIR"))
    return "voice-browser checkout is missing";
  if (log.includes("Chrome executable is missing")) return "Chrome is missing";
  if (log.includes("set TYPESAFE_API_KEY"))
    return "no TypeSafe key is configured";
  if (log.includes("key file is not a readable file"))
    return "the key file is unreadable";
  if (log.includes("Chrome DevTools did not answer"))
    return "Chrome DevTools did not answer";
  return "browser sidecar exited early";
}

/** The shell script alone owns the Chrome and voice-browser processes. */
export function startBrowserSidecar(
  environment: NodeJS.ProcessEnv,
  options: { stopMs?: number } = {},
): BrowserSidecar {
  const logPath = path.join(tmpdir(), `pi-live-browser-${randomUUID()}.log`);
  let failure: string | undefined;
  let stop = async (_keepLog: boolean): Promise<void> => {};
  let fd: number | undefined;
  try {
    fd = openSync(logPath, "wx", 0o600);
    const child = spawn(
      "/bin/bash",
      [path.join(import.meta.dirname, "../scripts/browser-sidecar.sh")],
      {
        env: environment,
        stdio: ["ignore", fd, fd],
        // Its own process group, so a stalled stop can end every process in it.
        detached: true,
      },
    );
    const exited = new Promise<void>((resolve) => {
      child.once("error", () => {
        failure = "could not start the browser sidecar script";
        resolve();
      });
      child.once("exit", () => {
        failure ??= exitCause(logPath);
        resolve();
      });
    });
    let stopping: Promise<void> | undefined;
    stop = (keepLog) =>
      (stopping ??= (async () => {
        if (failure) return;
        // The script's traps stop Chrome and voice-browser; force only a stall.
        let forced = false;
        const force = setTimeout(() => {
          forced = true;
          try {
            if (child.pid) process.kill(-child.pid, "SIGKILL");
          } catch {
            // The group has already exited.
          }
        }, options.stopMs ?? STOP_MS);
        child.kill("SIGTERM");
        await exited;
        clearTimeout(force);
        if (forced || keepLog) return;
        try {
          rmSync(logPath, { force: true });
        } catch {
          // A leftover private log is harmless; stopping must not fail on it.
        }
      })());
  } catch {
    failure = "could not create the sidecar log or start its script";
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  return {
    logPath,
    failure: () => failure,
    stop: (stopOptions) => stop(stopOptions?.keepLog ?? false),
  };
}

/** One owner per Pi session. Calls may come and go without stopping Chrome. */
export function createBrowserSidecarSession(
  options: { timeoutMs?: number; pollMs?: number } = {},
) {
  let declined = false;
  let owned: BrowserSidecar | undefined;
  const shutdown = new AbortController();
  let stopping: Promise<void> | undefined;
  return {
    async prepare(
      setup: BrowserSidecarSetup,
      confirm: (signal: AbortSignal) => Promise<boolean>,
    ): Promise<{ owned: boolean; notice?: string }> {
      const probe = () => setup.probe().catch(() => false);
      const result = () => ({
        owned: !!owned && !owned.failure() && !shutdown.signal.aborted,
      });
      if (!isSidecarUrl(setup.url) || shutdown.signal.aborted)
        return { owned: false };
      if (await probe()) return result();
      if (shutdown.signal.aborted || declined || !setup.directory)
        return { owned: false };
      // An exited sidecar may be replaced, but a slow running one is still ours.
      if (owned?.failure()) {
        await owned.stop();
        owned = undefined;
      }
      if (!owned) {
        if (shutdown.signal.aborted) return { owned: false };
        const accepted = await confirm(shutdown.signal);
        if (shutdown.signal.aborted) return { owned: false };
        if (!accepted) {
          declined = true;
          return { owned: false };
        }
        // Another controller may have appeared while the dialog was open.
        if (await probe()) return result();
        if (shutdown.signal.aborted) return { owned: false };
        owned = setup.start();
      }
      const sidecar = owned;
      const deadline = Date.now() + (options.timeoutMs ?? 15_000);
      while (
        !shutdown.signal.aborted &&
        !sidecar.failure() &&
        Date.now() < deadline
      ) {
        if (await probe()) {
          if (!sidecar.failure()) return result();
          break;
        }
        await delay(options.pollMs ?? 100, undefined, {
          signal: shutdown.signal,
        }).catch(() => {});
      }
      const cause =
        sidecar.failure() ?? "browser controller did not answer in time";
      await (stopping ?? sidecar.stop({ keepLog: true }));
      if (owned === sidecar) owned = undefined;
      return {
        owned: false,
        ...(!shutdown.signal.aborted
          ? { notice: `${cause}. Log: ${sidecar.logPath}` }
          : {}),
      };
    },
    stop(): Promise<void> {
      shutdown.abort();
      return (stopping ??= owned?.stop() ?? Promise.resolve());
    },
  };
}
