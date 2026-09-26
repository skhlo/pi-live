import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { lstat, mkdir, readFile, readdir, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import type { TestContext } from "node:test";

import {
  createLiveLifecycle,
  createNodeOwnershipFileSystem,
  type LiveLifecycle,
  type LiveLifecycleOptions,
  type OwnershipFileHandle,
  type OwnershipFileSystem,
} from "../../src/live.ts";
import {
  admitted,
  approvingConsent,
  certifiedHome,
  cleanupLiveLifecycle,
  createFakeResources,
  deferred,
  fixtureHome,
  ManualClock,
  type FixtureHome,
} from "./live-fixture.ts";
import { waitForCondition } from "./live-wait.ts";

export interface OwnershipFixture extends FixtureHome {
  agentA: string;
  agentB: string;
  createLifecycle(overrides?: LiveLifecycleOptions): LiveLifecycle;
}

export async function createOwnershipFixture(
  t: TestContext,
): Promise<OwnershipFixture> {
  const shared = await fixtureHome(t);
  const root = await realpath(shared.root);
  const home = path.join(root, "home");
  const stateParent = path.join(home, ".local/state/pi-live");
  const fixture = {
    ...shared,
    root,
    home,
    stateParent,
    lock: path.join(stateParent, "active.lock"),
  };
  const agentA = path.join(root, "agent-a");
  const agentB = path.join(root, "agent-b");
  await Promise.all([
    mkdir(agentA, { mode: 0o700 }),
    mkdir(agentB, { mode: 0o700 }),
  ]);
  return {
    ...fixture,
    agentA,
    agentB,
    createLifecycle(overrides = {}) {
      const lifecycle = createLiveLifecycle({
        admission: { check: admitted },
        consent: approvingConsent,
        home: certifiedHome(home),
        resources: createFakeResources(),
        ...overrides,
      });
      const lifecycleClock =
        overrides.clock instanceof ManualClock ? overrides.clock : undefined;
      fixture.beforeRemoval(() =>
        cleanupLiveLifecycle(lifecycle, lifecycleClock),
      );
      return lifecycle;
    },
  };
}

export function eventually(
  check: () => boolean,
  queue: "microtask" | "task" = "microtask",
): Promise<void> {
  return waitForCondition(
    check,
    `condition did not settle within 10 seconds`,
    queue,
  );
}

export interface ChildExit {
  code: number | null;
  signal: NodeJS.Signals | null;
}

export type ChildMode =
  | "silent-exit"
  | "coordination-probe"
  | "start-barrier"
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

export interface ContenderChild {
  process: ChildProcessWithoutNullStreams;
  next(): Promise<unknown>;
  waitExited(): Promise<ChildExit>;
  stderr(): string;
}

let activeChildWatchdogs = 0;

export function activeChildWatchdogCount(): number {
  return activeChildWatchdogs;
}

export async function withChildWatchdog<T>(
  operation: Promise<T>,
  message: () => string,
  timeoutMs = 10_000,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const watchdog = new Promise<never>((_resolve, reject) => {
    activeChildWatchdogs += 1;
    timer = setTimeout(() => reject(new Error(message())), timeoutMs);
  });
  try {
    return await Promise.race([operation, watchdog]);
  } finally {
    if (timer) clearTimeout(timer);
    activeChildWatchdogs -= 1;
  }
}

function childEnvironment(
  home: string,
  agentDirectory: string,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    HOME: home,
    PI_CODING_AGENT_DIR: agentDirectory,
    XDG_CONFIG_HOME: path.join(agentDirectory, "xdg-config"),
    XDG_DATA_HOME: path.join(agentDirectory, "xdg-data"),
    XDG_STATE_HOME: path.join(agentDirectory, "xdg-state"),
    XDG_CACHE_HOME: path.join(agentDirectory, "xdg-cache"),
    PI_LIVE_TEST_SESSION_ROOT: path.join(agentDirectory, "sessions"),
    PI_LIVE_TEST_SETTINGS_ROOT: path.join(agentDirectory, "settings"),
    PI_LIVE_TEST_STORE_ROOT: path.join(agentDirectory, "stores"),
    TMPDIR: process.env.TMPDIR ?? tmpdir(),
  };
  if (process.env.PATH !== undefined) environment.PATH = process.env.PATH;
  return environment;
}

export function spawnContender(
  fixture: OwnershipFixture,
  agentDirectory: string,
  mode?: ChildMode,
): ContenderChild {
  const child = spawn(
    process.execPath,
    [
      "--no-addons",
      path.join(import.meta.dirname, "..", "pi-live-lifecycle-child.ts"),
      fixture.home,
      ...(mode === undefined ? [] : [mode]),
    ],
    {
      cwd: path.resolve(import.meta.dirname, "../.."),
      env: childEnvironment(fixture.home, agentDirectory),
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  let standardError = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    standardError += chunk;
  });
  const exited = once(child, "close").then(([code, signal]) => ({
    code: typeof code === "number" ? code : null,
    signal: typeof signal === "string" ? (signal as NodeJS.Signals) : null,
  }));
  let cleanupChild = async (): Promise<void> => {
    if (child.exitCode === null && child.signalCode === null)
      child.kill("SIGKILL");
    await withChildWatchdog(
      exited,
      () => `contender child fallback join timed out: ${standardError}`,
      2_000,
    );
  };
  fixture.beforeRemoval(() => cleanupChild());

  const lines = createInterface({ input: child.stdout, terminal: false });
  let state: "other" | "active" | "boundary" = "other";
  let joining: Promise<ChildExit> | undefined;
  let taskOwnedSignal = false;

  const waitExited = (): Promise<ChildExit> => {
    joining ??= (async () => {
      try {
        return await withChildWatchdog(
          exited,
          () => `contender child exit timed out: ${standardError}`,
        );
      } catch (error) {
        if (child.exitCode === null && child.signalCode === null)
          child.kill("SIGKILL");
        try {
          await withChildWatchdog(
            exited,
            () => `contender child forced join timed out: ${standardError}`,
            2_000,
          );
        } catch (joinError) {
          throw new AggregateError(
            [error, joinError],
            "contender child timed out and could not be joined",
          );
        }
        throw error;
      }
    })();
    return joining;
  };

  const signalAndJoin = async (): Promise<ChildExit> => {
    if (child.exitCode === null && child.signalCode === null)
      taskOwnedSignal = child.kill();
    return waitExited();
  };

  const controller: ContenderChild = {
    process: child,
    async next(): Promise<unknown> {
      const line = once(lines, "line").then(([value]) => String(value));
      const lineOrExit = Promise.race([
        line,
        exited.then((result) => {
          throw new Error(
            `contender child exited before output (${JSON.stringify(result)}): ${standardError}`,
          );
        }),
      ]);
      try {
        const report = JSON.parse(
          await withChildWatchdog(
            lineOrExit,
            () => `contender child output timed out: ${standardError}`,
          ),
        ) as unknown;
        if (report && typeof report === "object") {
          const event = (report as { event?: unknown }).event;
          state =
            event === "exit-boundary"
              ? "boundary"
              : event === "started" &&
                  (report as { result?: { kind?: unknown } }).result?.kind ===
                    "started"
                ? "active"
                : "other";
        }
        return report;
      } catch (error) {
        try {
          await signalAndJoin();
        } catch (cleanupError) {
          throw new AggregateError(
            [error, cleanupError],
            "contender output failed and child cleanup also failed",
          );
        }
        throw error;
      }
    },
    waitExited,
    stderr: () => standardError,
  };

  cleanupChild = async () => {
    let graceful = false;
    if (child.exitCode === null && child.signalCode === null) {
      if (
        (state === "active" || state === "boundary") &&
        child.stdin.writable
      ) {
        graceful = true;
        child.stdin.end(state === "active" ? "stop\n" : "exit\n");
      } else {
        taskOwnedSignal = child.kill();
      }
    }
    const result = await waitExited();
    if (graceful || !taskOwnedSignal)
      assert.deepEqual(
        result,
        { code: 0, signal: null },
        `contender child cleanup failed: ${standardError}`,
      );
    else
      assert.ok(
        result.code === 0 || result.signal === "SIGTERM",
        `contender child cleanup had an unexpected exit (${JSON.stringify(result)}): ${standardError}`,
      );
  };
  return controller;
}

export type LockInventory =
  | { kind: "absent" }
  | {
      kind: "directory";
      mode: number;
      entries: Array<{
        name: string;
        kind: "directory" | "file" | "symlink" | "other";
        mode: number;
        bytes?: string;
      }>;
    }
  | { kind: "other"; mode: number };

export async function lockInventory(lockPath: string): Promise<LockInventory> {
  let lockInfo;
  try {
    lockInfo = await lstat(lockPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return { kind: "absent" };
    throw error;
  }
  if (!lockInfo.isDirectory())
    return { kind: "other", mode: lockInfo.mode & 0o7777 };
  const inventory: Extract<LockInventory, { kind: "directory" }> = {
    kind: "directory",
    mode: lockInfo.mode & 0o7777,
    entries: [],
  };
  for (const name of (await readdir(lockPath)).sort()) {
    const target = path.join(lockPath, name);
    const info = await lstat(target);
    const kind = info.isDirectory()
      ? "directory"
      : info.isFile()
        ? "file"
        : info.isSymbolicLink()
          ? "symlink"
          : "other";
    inventory.entries.push({
      name,
      kind,
      mode: info.mode & 0o7777,
      ...(kind === "file"
        ? { bytes: (await readFile(target)).toString("utf8") }
        : {}),
    });
  }
  return inventory;
}

export function assertEmptyLock(inventory: LockInventory): void {
  assert.deepEqual(inventory, {
    kind: "directory",
    mode: 0o700,
    entries: [],
  });
}

export function assertCompleteOwner(inventory: LockInventory): void {
  assert.equal(inventory.kind, "directory");
  if (inventory.kind !== "directory") return;
  assert.equal(inventory.mode, 0o700);
  assert.equal(inventory.entries.length, 1);
  const entry = inventory.entries[0];
  assert.deepEqual(
    entry && { name: entry.name, kind: entry.kind, mode: entry.mode },
    { name: "owner.json", kind: "file", mode: 0o600 },
  );
  assert.ok(entry?.bytes?.endsWith("\n"));
  const record: unknown = JSON.parse(entry?.bytes ?? "");
  assert.ok(record && typeof record === "object");
  assert.equal((record as { version?: unknown }).version, 1);
  assert.equal(
    typeof (record as { generation?: unknown }).generation,
    "string",
  );
  assert.equal(
    typeof (record as { ownerToken?: unknown }).ownerToken,
    "string",
  );
  assert.equal(typeof (record as { pid?: unknown }).pid, "number");
}

export async function exitChildAtBarrier(child: ContenderChild): Promise<void> {
  child.process.stdin.end("exit\n");
  assert.deepEqual(
    await child.waitExited(),
    { code: 0, signal: null },
    child.stderr(),
  );
}

export async function assertChildBusy(
  fixture: OwnershipFixture,
): Promise<void> {
  const contender = spawnContender(fixture, fixture.agentB);
  const line = await contender.next();
  assert.ok(line && typeof line === "object");
  assert.deepEqual(
    (line as { result?: unknown }).result,
    { kind: "refused", state: "off", diagnostic: "busy" },
    contender.stderr(),
  );
  assert.deepEqual(
    await contender.waitExited(),
    { code: 0, signal: null },
    contender.stderr(),
  );
}

export async function startAndStopChild(
  fixture: OwnershipFixture,
): Promise<ContenderChild> {
  const contender = spawnContender(fixture, fixture.agentB);
  assert.deepEqual(await contender.next(), {
    event: "started",
    result: { kind: "started", state: "active" },
    snapshot: { state: "active", muted: false, voice: "marin" },
  });
  const stopped = contender.next();
  contender.process.stdin.end("stop\n");
  assert.deepEqual(await stopped, {
    event: "stopped",
    result: { status: "off" },
    snapshot: { state: "off", muted: false, voice: "marin" },
  });
  assert.deepEqual(
    await contender.waitExited(),
    { code: 0, signal: null },
    contender.stderr(),
  );
  return contender;
}

export type PublicationFault =
  | "mkdir-return"
  | "lock-inspect"
  | "owner-open"
  | "owner-write"
  | "owner-sync"
  | "owner-handle-inspect"
  | "owner-close"
  | "owner-path-inspect"
  | "owner-read"
  | "owner-reinspect"
  | "lock-reinspect"
  | "directory-entries";

export function publicationFaultFileSystem(
  point: PublicationFault,
  lockPath: string,
): OwnershipFileSystem {
  const base = createNodeOwnershipFileSystem();
  const ownerPath = path.join(lockPath, "owner.json");
  let created = false;
  let ownerClosed = false;
  let ownerPathInspections = 0;
  let lockInspections = 0;
  const fail = (): never => {
    throw new Error(`injected publication fault: ${point}`);
  };
  return {
    ...base,
    async mkdirExclusive(target, mode) {
      await base.mkdirExclusive(target, mode);
      created = true;
      if (point === "mkdir-return") fail();
    },
    async inspect(target) {
      if (created && target === lockPath) {
        lockInspections += 1;
        if (point === "lock-inspect" && lockInspections === 1) fail();
        if (point === "lock-reinspect" && lockInspections === 2) fail();
      }
      if (target === ownerPath && ownerClosed) {
        ownerPathInspections += 1;
        if (
          (point === "owner-path-inspect" && ownerPathInspections === 1) ||
          (point === "owner-reinspect" && ownerPathInspections === 2)
        )
          fail();
      }
      return base.inspect(target);
    },
    async openOwner(target, mode) {
      if (point === "owner-open") fail();
      const handle = await base.openOwner(target, mode);
      const wrapped: OwnershipFileHandle = {
        async write(bytes) {
          if (point === "owner-write") fail();
          await handle.write(bytes);
        },
        async sync() {
          if (point === "owner-sync") fail();
          await handle.sync();
        },
        async inspect() {
          if (point === "owner-handle-inspect") fail();
          return handle.inspect();
        },
        async close() {
          ownerClosed = true;
          await handle.close();
          if (point === "owner-close") fail();
        },
      };
      return wrapped;
    },
    async read(target, maxBytes) {
      if (point === "owner-read" && target === ownerPath) fail();
      return base.read(target, maxBytes);
    },
    async entries(target) {
      if (point === "directory-entries" && target === lockPath) fail();
      return base.entries(target);
    },
  };
}

export type ReleaseParkPoint =
  | "validation-realpath"
  | "validation-inspect"
  | "validation-read"
  | "validation-entries"
  | "unlink"
  | "deletion-inspect"
  | "deletion-entries"
  | "rmdir";

export type ReleaseSettlement = "success" | "failure";

export function parkedReleaseFileSystem(
  fixture: OwnershipFixture,
  point: ReleaseParkPoint,
) {
  const base = createNodeOwnershipFileSystem();
  const entered = deferred<{ operation: string; target: string }>();
  const gate = deferred<ReleaseSettlement>();
  const selectedSettled = deferred<void>();
  const records: Array<{ operation: string; target: string }> = [];
  let armed = false;
  let parked = false;
  let unlinkCompleted = false;
  let active = 0;
  let maximumActive = 0;

  const run = async <T>(
    operation: string,
    target: string,
    effect: () => Promise<T>,
    selected: boolean,
  ): Promise<T> => {
    if (!armed) return effect();
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    records.push({ operation, target });
    const shouldPark = selected && !parked;
    if (shouldPark) {
      parked = true;
      entered.resolve({ operation, target });
    }
    try {
      if (shouldPark && (await gate.promise) === "failure")
        throw new Error(`injected settled release failure: ${point}`);
      return await effect();
    } finally {
      active -= 1;
      if (shouldPark) selectedSettled.resolve();
    }
  };

  const fileSystem: OwnershipFileSystem = {
    ...base,
    realpath(target) {
      return run(
        "realpath",
        target,
        () => base.realpath(target),
        point === "validation-realpath",
      );
    },
    inspect(target) {
      const ownerValidation =
        !unlinkCompleted && path.basename(target) === "owner.json";
      const directoryAfterUnlink =
        unlinkCompleted && path.basename(target) === "active.lock";
      return run(
        "inspect",
        target,
        () => base.inspect(target),
        (point === "validation-inspect" && ownerValidation) ||
          (point === "deletion-inspect" && directoryAfterUnlink),
      );
    },
    read(target, maxBytes) {
      return run(
        "read",
        target,
        () => base.read(target, maxBytes),
        point === "validation-read",
      );
    },
    entries(target) {
      return run(
        "entries",
        target,
        () => base.entries(target),
        (point === "validation-entries" && !unlinkCompleted) ||
          (point === "deletion-entries" && unlinkCompleted),
      );
    },
    async unlink(target) {
      await run(
        "unlink",
        target,
        () => base.unlink(target),
        point === "unlink",
      );
      unlinkCompleted = true;
    },
    rmdir(target) {
      return run("rmdir", target, () => base.rmdir(target), point === "rmdir");
    },
  };

  fixture.beforeRemoval(async () => {
    if (!parked) return;
    gate.resolve("failure");
    await withChildWatchdog(
      selectedSettled.promise,
      () => `parked ${point} cleanup did not settle`,
    );
    let previousRecordCount = -1;
    await eventually(() => {
      const stable = active === 0 && records.length === previousRecordCount;
      previousRecordCount = records.length;
      return stable;
    }, "task");
  });

  return {
    fileSystem,
    entered: entered.promise,
    selectedSettled: selectedSettled.promise,
    arm() {
      armed = true;
      records.length = 0;
    },
    settle(settlement: ReleaseSettlement) {
      gate.resolve(settlement);
    },
    records: () => [...records],
    maximumActive: () => maximumActive,
  };
}
