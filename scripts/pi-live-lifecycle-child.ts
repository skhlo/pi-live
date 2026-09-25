import assert from "node:assert/strict";
import path from "node:path";
import { createInterface } from "node:readline";

import {
  createIsolatedLiveCoordination,
  createLiveLifecycle,
  createNodeOwnershipFileSystem,
  type HomeCertificationObservation,
  type LiveCapture,
  type LiveConnection,
  type LiveCoordination,
  type LiveLifecycle,
  type LiveResourceStart,
  type OwnershipFileHandle,
  type OwnershipFileSystem,
} from "../src/live.ts";

function settledStart<T>(resource: T): LiveResourceStart<T> {
  return {
    result: Promise.resolve(resource),
    async terminate(dispose) {
      await dispose(resource);
    },
  };
}

function output(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

async function waitForCommand(
  input: ReturnType<typeof createInterface>,
  expected: "start" | "stop" | "exit",
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      clearTimeout(watchdog);
      input.off("line", onLine);
      input.off("close", onClose);
    };
    const finish = (effect: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      effect();
    };
    const onLine = (line: string) => {
      finish(() => {
        if (line !== expected) {
          reject(new Error(`unexpected child command: ${line}`));
          return;
        }
        resolve();
      });
    };
    const onClose = () => {
      finish(() => reject(new Error(`parent closed before child ${expected}`)));
    };
    const watchdog = setTimeout(
      () =>
        finish(() =>
          reject(new Error(`parent did not request child ${expected}`)),
        ),
      15_000,
    );
    input.on("line", onLine);
    input.on("close", onClose);
  });
}

type ExitBoundaryMode =
  | "exit-before-mkdir"
  | "exit-mkdir-submitted"
  | "exit-mkdir-completed"
  | "exit-owner-open"
  | "exit-owner-write"
  | "exit-owner-sync"
  | "exit-owner-close"
  | "exit-owner-verification"
  | "exit-verified-ownership"
  | "exit-unlink-complete"
  | "exit-rmdir-pending"
  | "exit-rmdir-complete-callback-parked";

function isExitBoundaryMode(
  value: string | undefined,
): value is ExitBoundaryMode {
  return (
    value === "exit-before-mkdir" ||
    value === "exit-mkdir-submitted" ||
    value === "exit-mkdir-completed" ||
    value === "exit-owner-open" ||
    value === "exit-owner-write" ||
    value === "exit-owner-sync" ||
    value === "exit-owner-close" ||
    value === "exit-owner-verification" ||
    value === "exit-verified-ownership" ||
    value === "exit-unlink-complete" ||
    value === "exit-rmdir-pending" ||
    value === "exit-rmdir-complete-callback-parked"
  );
}

function boundaryFileSystem(
  mode: ExitBoundaryMode,
  barrier: (boundary: ExitBoundaryMode) => Promise<never>,
): OwnershipFileSystem {
  const base = createNodeOwnershipFileSystem();
  return {
    ...base,
    async mkdirExclusive(target, permissions) {
      if (mode === "exit-before-mkdir") await barrier(mode);
      if (mode === "exit-mkdir-submitted") {
        const pending = base.mkdirExclusive(target, permissions);
        void pending.catch(() => undefined);
        await barrier(mode);
      }
      await base.mkdirExclusive(target, permissions);
      if (mode === "exit-mkdir-completed") await barrier(mode);
    },
    async openOwner(target, permissions) {
      const handle = await base.openOwner(target, permissions);
      if (mode === "exit-owner-open") await barrier(mode);
      const wrapped: OwnershipFileHandle = {
        async write(bytes) {
          await handle.write(bytes);
          if (mode === "exit-owner-write") await barrier(mode);
        },
        async sync() {
          await handle.sync();
          if (mode === "exit-owner-sync") await barrier(mode);
        },
        inspect: () => handle.inspect(),
        async close() {
          await handle.close();
          if (mode === "exit-owner-close") await barrier(mode);
        },
      };
      return wrapped;
    },
    async read(target, maxBytes) {
      const bytes = await base.read(target, maxBytes);
      if (mode === "exit-owner-verification") await barrier(mode);
      return bytes;
    },
    async unlink(target) {
      await base.unlink(target);
      if (mode === "exit-unlink-complete") await barrier(mode);
    },
    async rmdir(target) {
      if (mode === "exit-rmdir-pending") {
        const pending = base.rmdir(target);
        void pending.catch(() => undefined);
        await barrier(mode);
      }
      await base.rmdir(target);
      if (mode === "exit-rmdir-complete-callback-parked") await barrier(mode);
    },
  };
}

async function main(): Promise<void> {
  const home = process.argv[2];
  assert.ok(home, "Usage: pi-live-lifecycle-child <fixture-home>");
  assert.equal(process.env.HOME, home);
  const allowedEnvironment = new Set([
    "HOME",
    "PATH",
    "TMPDIR",
    "PI_CODING_AGENT_DIR",
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
    "XDG_STATE_HOME",
    "XDG_CACHE_HOME",
    "PI_LIVE_TEST_SESSION_ROOT",
    "PI_LIVE_TEST_SETTINGS_ROOT",
    "PI_LIVE_TEST_STORE_ROOT",
    "__CF_USER_TEXT_ENCODING",
  ]);
  for (const key of Object.keys(process.env))
    assert.equal(
      allowedEnvironment.has(key),
      true,
      `unexpected child env: ${key}`,
    );
  for (const key of [
    "PI_CODING_AGENT_DIR",
    "PI_LIVE_TEST_SESSION_ROOT",
    "PI_LIVE_TEST_SETTINGS_ROOT",
    "PI_LIVE_TEST_STORE_ROOT",
  ])
    assert.ok(process.env[key]?.startsWith(path.dirname(home)));

  const mode = process.argv[3];
  if (mode === "silent-exit") return;
  if (mode === "coordination-probe") {
    const globals = globalThis as typeof globalThis & Record<string, unknown>;
    const key = "__pi_live_lifecycle_coordination_v1__";
    globals[key] = {
      version: 2,
      poolingRefused: false,
      ownership: { kind: "none" },
    };
    const defaultLifecycle = createLiveLifecycle();
    const isolatedLifecycle = createLiveLifecycle({
      coordination: createIsolatedLiveCoordination(),
    });
    output({
      event: "coordination-probe",
      defaultSnapshot: defaultLifecycle.snapshot(),
      isolatedSnapshot: isolatedLifecycle.snapshot(),
      globalVersion: (globals[key] as { version: number }).version,
    });
    return;
  }

  const capture: LiveCapture = { stop: async () => undefined };
  const connection: LiveConnection = {
    startCapture: () => settledStart(capture),
    sendSample: () => undefined,
    closeSession: async () => undefined,
    close: async () => undefined,
  };
  const exitMode = isExitBoundaryMode(mode) ? mode : undefined;
  const isolatedCoordination = exitMode
    ? undefined
    : createIsolatedLiveCoordination();
  let lifecycle: LiveLifecycle;
  let input: ReturnType<typeof createInterface> | undefined;
  if (exitMode)
    input = createInterface({ input: process.stdin, terminal: false });
  const barrier = async (boundary: ExitBoundaryMode): Promise<never> => {
    assert.ok(input);
    const processCoordination = (
      globalThis as typeof globalThis & Record<string, unknown>
    )["__pi_live_lifecycle_coordination_v1__"] as LiveCoordination | undefined;
    const coordination = exitMode ? processCoordination : isolatedCoordination;
    assert.ok(coordination);
    output({
      event: "exit-boundary",
      boundary,
      exitKind: "process-without-sdk-dispose",
      snapshot: lifecycle.snapshot(),
      coordination: coordination.ownership,
    });
    await waitForCommand(input, "exit");
    process.exit(0);
  };

  lifecycle = createLiveLifecycle({
    admission: {
      check: () => ({
        tui: true,
        compatible: true,
        conflict: false,
        dialog: false,
        idle: true,
        pendingWork: false,
      }),
    },
    consent: { request: async () => true },
    home: {
      accountHome: () => home,
      environmentHome: () => process.env.HOME,
      async certify(observation: HomeCertificationObservation) {
        return { certified: true, ...observation };
      },
    },
    resources: {
      credentials: async () => undefined,
      attestation: async () => undefined,
      connect: () => settledStart(connection),
    },
    ownershipFileSystem: exitMode
      ? boundaryFileSystem(exitMode, barrier)
      : undefined,
    ...(isolatedCoordination ? { coordination: isolatedCoordination } : {}),
  });

  if (mode === "start-barrier") {
    input = createInterface({ input: process.stdin, terminal: false });
    output({ event: "ready", barrier: "start" });
    await waitForCommand(input, "start");
  }

  const started = await lifecycle.start();
  if (mode === "exit-verified-ownership") {
    assert.equal(started.kind, "started");
    await barrier(mode);
  }
  output({ event: "started", result: started, snapshot: lifecycle.snapshot() });
  if (started.kind !== "started") {
    input?.close();
    return;
  }

  input ??= createInterface({ input: process.stdin, terminal: false });
  await waitForCommand(input, "stop");
  const stopped = await lifecycle.stop();
  output({ event: "stopped", result: stopped, snapshot: lifecycle.snapshot() });
  input.close();
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
});
