import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { TestContext } from "node:test";

import {
  createIsolatedLiveCoordination,
  createLiveLifecycle,
  type HomeAuthority,
  type HomeCertificationObservation,
  type LiveAdmissionFacts,
  type LiveAttestation,
  type LiveCapture,
  type LiveClock,
  type LiveConnection,
  type LiveCredentials,
  type LiveCoordination,
  type LiveLifecycle,
  type LiveLifecycleOptions,
  type LiveResources,
  type LiveResourceStart,
  type LiveTimer,
} from "../../src/live.ts";

export interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T | PromiseLike<T>): void;
  reject(reason?: unknown): void;
}

export function deferred<T>(): Deferred<T> {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

const FIXTURE_WATCHDOG_MS = 10_000;

export async function withFixtureWatchdog<T>(
  work: Promise<T>,
  description: string,
  timeoutMs = FIXTURE_WATCHDOG_MS,
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () =>
            reject(
              new Error(
                `${description} did not settle within ${timeoutMs / 1_000}s`,
              ),
            ),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

interface ManualTimer extends LiveTimer {
  due: number;
  order: number;
  callback: () => void;
  cancelled: boolean;
}

export class ManualClock implements LiveClock {
  nowValue = 0;
  onSet?: () => void;
  onClear?: () => void;
  readonly timers = new Set<ManualTimer>();
  private nextOrder = 0;

  now(): number {
    return this.nowValue;
  }

  setTimer(callback: () => void, delayMs: number): LiveTimer {
    const timer: ManualTimer = {
      due: this.nowValue + delayMs,
      order: this.nextOrder++,
      callback,
      cancelled: false,
    };
    this.timers.add(timer);
    this.onSet?.();
    return timer;
  }

  clearTimer(timer: LiveTimer): void {
    const known = timer as ManualTimer;
    known.cancelled = true;
    this.timers.delete(known);
    this.onClear?.();
  }

  advance(milliseconds: number): void {
    this.nowValue += milliseconds;
    for (;;) {
      const ready = this.nextTimer((timer) => timer.due <= this.nowValue);
      if (!ready) return;
      this.timers.delete(ready);
      ready.callback();
    }
  }

  elapseWithoutTimers(milliseconds: number): void {
    this.nowValue += milliseconds;
  }

  fireNextWithoutAdvancing(): void {
    const next = this.nextTimer();
    assert.ok(next);
    this.timers.delete(next);
    next.callback();
  }

  private nextTimer(
    select: (timer: ManualTimer) => boolean = () => true,
  ): ManualTimer | undefined {
    return [...this.timers]
      .filter((timer) => !timer.cancelled && select(timer))
      .sort(
        (left, right) => left.due - right.due || left.order - right.order,
      )[0];
  }
}

export interface FixtureHome {
  root: string;
  home: string;
  stateParent: string;
  lock: string;
  beforeRemoval(cleanup: () => void | Promise<void>): void;
}

export async function fixtureHome(t: TestContext): Promise<FixtureHome> {
  const root = await mkdtemp(path.join(tmpdir(), "pi-live-lifecycle-test-"));
  const cleanupTasks: Array<() => void | Promise<void>> = [];
  let teardownStarted = false;

  t.after(async () => {
    teardownStarted = true;
    const errors: unknown[] = [];
    for (const cleanup of cleanupTasks.reverse()) {
      try {
        await cleanup();
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length > 0) {
      throw new AggregateError(
        errors,
        "fixture resources did not quiesce before home removal",
      );
    }
    await rm(root, { recursive: true });
  });

  const home = path.join(root, "home");
  const stateParent = path.join(home, ".local/state/pi-live");
  await mkdir(stateParent, { recursive: true, mode: 0o700 });
  return {
    root,
    home,
    stateParent,
    lock: path.join(stateParent, "active.lock"),
    beforeRemoval(cleanup) {
      assert.equal(teardownStarted, false, "fixture teardown already started");
      cleanupTasks.push(cleanup);
    },
  };
}

export function admitted(): LiveAdmissionFacts {
  return {
    tui: true,
    compatible: true,
    conflict: false,
    dialog: false,
    idle: true,
    pendingWork: false,
  };
}

export function certifiedHome(home: string): HomeAuthority {
  return {
    accountHome: () => home,
    environmentHome: () => home,
    async certify(observation: HomeCertificationObservation) {
      return { certified: true as const, ...observation };
    },
  };
}

export function settledStart<T>(resource: T): LiveResourceStart<T> {
  return {
    result: Promise.resolve(resource),
    async terminate(dispose) {
      await dispose(resource);
    },
  };
}

export function createFakeCapture(
  overrides: Partial<LiveCapture> = {},
): LiveCapture {
  return {
    stop: async () => undefined,
    ...overrides,
  };
}

export function createFakeConnection(
  overrides: Partial<LiveConnection> = {},
  capture = createFakeCapture(),
): LiveConnection {
  return {
    startCapture: () => settledStart(capture),
    sendSample: () => undefined,
    closeSession: async () => undefined,
    close: async () => undefined,
    ...overrides,
  };
}

export const fixtureCredentials: LiveCredentials = {
  accessToken: "fixture-token",
  accountId: "fixture-account",
};

export const fixtureAttestation: LiveAttestation = {
  header: "fixture-attestation",
  supported: false,
};

export function createFakeResources(
  connection = createFakeConnection(),
  overrides: Partial<LiveResources> = {},
): LiveResources {
  return {
    credentials: async () => fixtureCredentials,
    attestation: async () => fixtureAttestation,
    connect: () => settledStart(connection),
    ...overrides,
  };
}

export const approvingConsent = {
  request: async () => true,
} satisfies NonNullable<LiveLifecycleOptions["consent"]>;

export async function cleanupLiveLifecycle(
  lifecycle: LiveLifecycle,
  clock?: ManualClock,
): Promise<void> {
  const stateBeforeCleanup = lifecycle.snapshot().state;
  const errors: unknown[] = [];
  try {
    const result = await withFixtureWatchdog(
      lifecycle.stop(),
      "lifecycle cleanup",
    );
    assert.notEqual(
      result.status,
      "release-pending",
      "lifecycle release remained pending during fixture cleanup",
    );
    if (result.status === "blocked")
      assert.equal(
        stateBeforeCleanup,
        "blocked",
        "fixture cleanup unexpectedly blocked the lifecycle",
      );
  } catch (error) {
    errors.push(error);
  }
  try {
    if (clock)
      assert.equal(
        clock.timers.size,
        0,
        "fixture cleanup left manual timers armed",
      );
  } catch (error) {
    errors.push(error);
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1)
    throw new AggregateError(errors, "lifecycle fixture cleanup failed");
}

type LifecycleOverrides = Omit<LiveLifecycleOptions, "consent">;

export interface LiveFixture extends FixtureHome {
  clock: ManualClock;
  coordination: LiveCoordination;
  capture: LiveCapture;
  connection: LiveConnection;
  resources: LiveResources;
  createLifecycle(
    consent: NonNullable<LiveLifecycleOptions["consent"]>,
    overrides?: LifecycleOverrides,
  ): LiveLifecycle;
}

export async function createLiveFixture(t: TestContext): Promise<LiveFixture> {
  const home = await fixtureHome(t);
  const clock = new ManualClock();
  const coordination = createIsolatedLiveCoordination();
  const capture = createFakeCapture();
  const connection = createFakeConnection({}, capture);
  const resources = createFakeResources(connection);

  return {
    ...home,
    clock,
    coordination,
    capture,
    connection,
    resources,
    createLifecycle(consent, overrides = {}) {
      const lifecycle = createLiveLifecycle({
        admission: { check: admitted },
        consent,
        home: certifiedHome(home.home),
        coordination,
        resources,
        ...overrides,
      });
      const lifecycleClock =
        overrides.clock instanceof ManualClock ? overrides.clock : undefined;
      home.beforeRemoval(() => cleanupLiveLifecycle(lifecycle, lifecycleClock));
      return lifecycle;
    },
  };
}
