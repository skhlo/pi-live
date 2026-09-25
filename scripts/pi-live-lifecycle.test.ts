import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";

import {
  createIsolatedLiveCoordination,
  createLiveLifecycle,
  createNodeOwnershipFileSystem,
  type HomeCertificationObservation,
  type LiveCapture,
  type LiveClock,
  type LiveConnection,
  type LiveMutationResult,
  type LiveResourceStart,
  type LiveTimer,
} from "../src/live.ts";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

class TestClock implements LiveClock {
  nowValue = 0;
  onSet?: () => void;
  onClear?: () => void;
  readonly timers = new Set<
    LiveTimer & { due: number; callback: () => void; cancelled: boolean }
  >();

  now(): number {
    return this.nowValue;
  }

  setTimer(callback: () => void, delayMs: number): LiveTimer {
    const timer = {
      due: this.nowValue + delayMs,
      callback,
      cancelled: false,
    };
    this.timers.add(timer);
    this.onSet?.();
    return timer;
  }

  clearTimer(timer: LiveTimer): void {
    const known = timer as LiveTimer & { cancelled?: boolean };
    known.cancelled = true;
    this.timers.delete(
      timer as LiveTimer & {
        due: number;
        callback: () => void;
        cancelled: boolean;
      },
    );
    this.onClear?.();
  }

  advance(milliseconds: number): void {
    this.nowValue += milliseconds;
    for (;;) {
      const ready = [...this.timers]
        .filter((timer) => !timer.cancelled && timer.due <= this.nowValue)
        .sort((left, right) => left.due - right.due)[0];
      if (!ready) return;
      this.timers.delete(ready);
      ready.callback();
    }
  }

  elapseWithoutTimers(milliseconds: number): void {
    this.nowValue += milliseconds;
  }

  fireNextWithoutAdvancing(): void {
    const next = [...this.timers]
      .filter((timer) => !timer.cancelled)
      .sort((left, right) => left.due - right.due)[0];
    assert.ok(next);
    this.timers.delete(next);
    next.callback();
  }
}

async function fixtureHome(t: TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), "pi-live-lifecycle-test-"));
  const home = path.join(root, "home");
  const stateParent = path.join(home, ".local/state/pi-live");
  await mkdir(stateParent, { recursive: true, mode: 0o700 });
  t.after(async () => rm(root, { recursive: true }));
  return {
    home,
    lock: path.join(stateParent, "active.lock"),
  };
}

function admitted() {
  return {
    tui: true,
    compatible: true,
    conflict: false,
    dialog: false,
    idle: true,
    pendingWork: false,
  };
}

function certifiedHome(home: string) {
  return {
    accountHome: () => home,
    environmentHome: () => home,
    async certify(observation: HomeCertificationObservation) {
      return { certified: true as const, ...observation };
    },
  };
}

function settledStart<T>(resource: T): LiveResourceStart<T> {
  return {
    result: Promise.resolve(resource),
    async terminate(dispose) {
      await dispose(resource);
    },
  };
}

async function eventually(check: () => boolean): Promise<void> {
  for (let turn = 0; turn < 1_000; turn += 1) {
    if (check()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.fail("condition did not settle within 1,000 event-loop turns");
}

test("the dormant lifecycle is lazy and refuses unsupported admission before consent or resources", async () => {
  const effects: string[] = [];
  const lifecycle = createLiveLifecycle({
    admission: {
      check() {
        effects.push("admission");
        return {
          tui: false,
          compatible: true,
          conflict: false,
          dialog: false,
          idle: true,
          pendingWork: false,
        };
      },
    },
    consent: {
      request() {
        effects.push("consent");
        return Promise.resolve(true);
      },
    },
    home: {
      accountHome() {
        effects.push("account-home");
        return "/unused";
      },
      environmentHome() {
        return "/unused";
      },
      certify() {
        throw new Error("home certification must stay lazy");
      },
    },
    resources: {
      credentials() {
        effects.push("credentials");
        return Promise.resolve();
      },
      attestation() {
        effects.push("attestation");
        return Promise.resolve();
      },
      connect() {
        throw new Error("resource construction must stay lazy");
      },
    },
  });

  assert.deepEqual(lifecycle.snapshot(), {
    state: "off",
    muted: false,
    voice: "sol",
  });
  assert.deepEqual(effects, []);
  assert.deepEqual(await lifecycle.stop(), { status: "off" });
  assert.deepEqual(await lifecycle.setMuted(true), {
    kind: "refused",
    state: "off",
    diagnostic: "busy",
  });
  assert.deepEqual(await lifecycle.selectVoice("unknown"), {
    kind: "refused",
    state: "off",
    diagnostic: "denied",
  });
  assert.deepEqual(effects, []);

  assert.deepEqual(await lifecycle.start(), {
    kind: "refused",
    state: "off",
    diagnostic: "denied",
  });
  assert.deepEqual(effects, ["admission"]);
  assert.deepEqual(await lifecycle.toggle(), {
    kind: "refused",
    state: "off",
    diagnostic: "denied",
  });
  assert.deepEqual(effects, ["admission", "admission"]);
});

test("consent is single-flight, immediately cancellable, and late approval cannot revive it", async () => {
  const approvals = [deferred<boolean>(), deferred<boolean>()];
  const consentEntered = [deferred<void>(), deferred<void>()];
  const generations: string[] = [];
  const signals: AbortSignal[] = [];
  let consentCalls = 0;
  let homeCalls = 0;
  const lifecycle = createLiveLifecycle({
    admission: {
      check() {
        return {
          tui: true,
          compatible: true,
          conflict: false,
          dialog: false,
          idle: true,
          pendingWork: false,
        };
      },
    },
    consent: {
      request(input) {
        generations.push(input.generation);
        signals.push(input.signal);
        const call = consentCalls++;
        consentEntered[call]!.resolve();
        return approvals[call]!.promise;
      },
    },
    home: {
      accountHome() {
        homeCalls += 1;
        return "/unused";
      },
      environmentHome() {
        return "/unused";
      },
      certify() {
        throw new Error("late consent must not reach certification");
      },
    },
  });

  assert.deepEqual(await lifecycle.selectVoice("vale"), {
    kind: "updated",
    state: "off",
    voice: "vale",
  });
  const firstStart = lifecycle.start();
  await consentEntered[0]!.promise;
  assert.equal(lifecycle.snapshot().state, "consent");
  assert.deepEqual(await lifecycle.start(), {
    kind: "existing",
    state: "consent",
  });
  assert.deepEqual(await lifecycle.selectVoice("sol"), {
    kind: "refused",
    state: "consent",
    diagnostic: "busy",
  });
  assert.deepEqual(await lifecycle.setMuted(true), {
    kind: "refused",
    state: "consent",
    diagnostic: "busy",
  });

  assert.deepEqual(await lifecycle.stop(), { status: "off" });
  assert.equal(signals[0]?.aborted, true);
  approvals[0]!.resolve(true);
  assert.deepEqual(await firstStart, { kind: "cancelled", state: "off" });
  assert.equal(homeCalls, 0);

  const secondStart = lifecycle.start();
  await consentEntered[1]!.promise;
  assert.equal(lifecycle.snapshot().state, "consent");
  assert.notEqual(generations[0], generations[1]);
  assert.deepEqual(await lifecycle.toggle(), { status: "off" });
  approvals[1]!.resolve(true);
  assert.deepEqual(await secondStart, { kind: "cancelled", state: "off" });
  assert.equal(homeCalls, 0);
});

test("acquiring and connecting expose the complete pending-state command rows", async (t) => {
  await t.test("acquiring", async (t) => {
    const fixture = await fixtureHome(t);
    const clock = new TestClock();
    const mkdirEntered = deferred<void>();
    const allowMkdir = deferred<void>();
    const baseFileSystem = createNodeOwnershipFileSystem();
    const capture: LiveCapture = { stop: async () => undefined };
    const connection: LiveConnection = {
      startCapture: () => settledStart(capture),
      sendSample: () => undefined,
      closeSession: async () => undefined,
      close: async () => undefined,
    };
    const lifecycle = createLiveLifecycle({
      admission: { check: admitted },
      consent: { request: async () => true },
      home: certifiedHome(fixture.home),
      clock,
      coordination: createIsolatedLiveCoordination(),
      ownershipFileSystem: {
        ...baseFileSystem,
        async mkdirExclusive(target, mode) {
          mkdirEntered.resolve();
          await allowMkdir.promise;
          await baseFileSystem.mkdirExclusive(target, mode);
        },
      },
      resources: {
        credentials: async () => undefined,
        attestation: async () => undefined,
        connect: () => settledStart(connection),
      },
    });
    const starting = lifecycle.start();
    await mkdirEntered.promise;
    assert.deepEqual(await lifecycle.start(), {
      kind: "existing",
      state: "acquiring",
    });
    assert.deepEqual(await lifecycle.setMuted(true), {
      kind: "refused",
      state: "acquiring",
      diagnostic: "busy",
    });
    assert.deepEqual(await lifecycle.selectVoice("vale"), {
      kind: "refused",
      state: "acquiring",
      diagnostic: "busy",
    });
    const toggled = lifecycle.toggle();
    assert.equal(lifecycle.snapshot().state, "stopping");
    const joined = lifecycle.stop();
    allowMkdir.resolve();
    assert.deepEqual(await toggled, { status: "off" });
    assert.deepEqual(await joined, { status: "off" });
    assert.equal((await starting).kind, "cancelled");
    await assert.rejects(stat(fixture.lock), { code: "ENOENT" });
  });

  await t.test("connecting", async (t) => {
    const fixture = await fixtureHome(t);
    const clock = new TestClock();
    const connectEntered = deferred<void>();
    const connectionResult = deferred<LiveConnection>();
    let terminateCalls = 0;
    const lifecycle = createLiveLifecycle({
      admission: { check: admitted },
      consent: { request: async () => true },
      home: certifiedHome(fixture.home),
      clock,
      coordination: createIsolatedLiveCoordination(),
      resources: {
        credentials: async () => undefined,
        attestation: async () => undefined,
        connect() {
          connectEntered.resolve();
          return {
            result: connectionResult.promise,
            async terminate() {
              terminateCalls += 1;
            },
          };
        },
      },
    });
    const starting = lifecycle.start();
    await connectEntered.promise;
    assert.deepEqual(await lifecycle.start(), {
      kind: "existing",
      state: "connecting",
    });
    assert.deepEqual(await lifecycle.setMuted(false), {
      kind: "refused",
      state: "connecting",
      diagnostic: "busy",
    });
    assert.deepEqual(await lifecycle.selectVoice("vale"), {
      kind: "refused",
      state: "connecting",
      diagnostic: "busy",
    });
    assert.deepEqual(await lifecycle.toggle(), { status: "off" });
    assert.equal((await starting).kind, "cancelled");
    assert.equal(terminateCalls, 1);
    assert.deepEqual(await lifecycle.stop(), { status: "off" });
    await assert.rejects(stat(fixture.lock), { code: "ENOENT" });
  });
});

test("CORE: in-flight consent rechecks shared pending, blocked, and pooling state", async (t) => {
  await t.test(
    "pending release is projected before home or lock effects",
    async (t) => {
      const fixture = await fixtureHome(t);
      const coordination = createIsolatedLiveCoordination();
      const clock = new TestClock();
      const baseFileSystem = createNodeOwnershipFileSystem();
      const rmdirCompleted = deferred<void>();
      const allowRmdirCallback = deferred<void>();
      const approval = deferred<boolean>();
      const consentEntered = deferred<void>();
      let contenderHomeCalls = 0;
      const connection: LiveConnection = {
        startCapture: () => settledStart({ stop: async () => undefined }),
        sendSample: () => undefined,
        closeSession: async () => undefined,
        close: async () => undefined,
      };
      const owner = createLiveLifecycle({
        admission: { check: admitted },
        consent: { request: async () => true },
        home: certifiedHome(fixture.home),
        coordination,
        clock,
        ownershipFileSystem: {
          ...baseFileSystem,
          async rmdir(target) {
            await baseFileSystem.rmdir(target);
            rmdirCompleted.resolve();
            await allowRmdirCallback.promise;
          },
        },
        resources: {
          credentials: async () => undefined,
          attestation: async () => undefined,
          connect: () => settledStart(connection),
        },
      });
      const contender = createLiveLifecycle({
        admission: { check: admitted },
        consent: {
          request() {
            consentEntered.resolve();
            return approval.promise;
          },
        },
        home: {
          ...certifiedHome(fixture.home),
          accountHome() {
            contenderHomeCalls += 1;
            return fixture.home;
          },
        },
        coordination,
        clock,
        resources: {
          credentials: async () => undefined,
          attestation: async () => undefined,
          connect: () => settledStart(connection),
        },
      });

      assert.equal((await owner.start()).kind, "started");
      const contenderStart = contender.start();
      await consentEntered.promise;
      const ownerStop = owner.stop();
      await rmdirCompleted.promise;
      assert.equal(coordination.ownership.kind, "pending");

      approval.resolve(true);
      assert.equal((await contenderStart).kind, "cancelled");
      assert.equal(contender.snapshot().state, "releasing");
      assert.equal(contenderHomeCalls, 0);
      await assert.rejects(stat(fixture.lock), { code: "ENOENT" });

      allowRmdirCallback.resolve();
      assert.deepEqual(await ownerStop, { status: "off" });
      await eventually(() => contender.snapshot().state === "off");
    },
  );

  for (const sharedChange of ["blocked", "pooling"] as const) {
    await t.test(
      `${sharedChange} invalidates late consent without effects`,
      async (t) => {
        const fixture = await fixtureHome(t);
        const coordination = createIsolatedLiveCoordination();
        const clock = new TestClock();
        const approval = deferred<boolean>();
        const consentEntered = deferred<void>();
        let homeCalls = 0;
        const contender = createLiveLifecycle({
          admission: { check: admitted },
          consent: {
            request() {
              consentEntered.resolve();
              return approval.promise;
            },
          },
          home: {
            ...certifiedHome(fixture.home),
            accountHome() {
              homeCalls += 1;
              return fixture.home;
            },
          },
          coordination,
          clock,
          resources: {
            credentials: async () => undefined,
            attestation: async () => undefined,
            connect: () =>
              settledStart({
                startCapture: () =>
                  settledStart({ stop: async () => undefined }),
                sendSample: () => undefined,
                closeSession: async () => undefined,
                close: async () => undefined,
              }),
          },
        });

        const starting = contender.start();
        await consentEntered.promise;
        if (sharedChange === "blocked") {
          coordination.ownership = { kind: "blocked" };
        } else {
          const observer = createLiveLifecycle({ coordination, clock });
          assert.deepEqual(await observer.interrupt("pooling"), {
            status: "off",
          });
        }
        approval.resolve(true);

        assert.equal((await starting).kind, "cancelled");
        assert.equal(
          contender.snapshot().state,
          sharedChange === "blocked" ? "blocked" : "off",
        );
        assert.equal(homeCalls, 0);
        await assert.rejects(stat(fixture.lock), { code: "ENOENT" });
      },
    );
  }
});

test("pooling interruption stops the current attempt and permanently refuses later starts without inventing blocked", async (t) => {
  const fixture = await fixtureHome(t);
  const coordination = createIsolatedLiveCoordination();
  const capture: LiveCapture = { stop: async () => undefined };
  const connection: LiveConnection = {
    startCapture: () => settledStart(capture),
    sendSample: () => undefined,
    closeSession: async () => undefined,
    close: async () => undefined,
  };
  const lifecycle = createLiveLifecycle({
    admission: { check: admitted },
    consent: { request: async () => true },
    home: certifiedHome(fixture.home),
    resources: {
      credentials: async () => undefined,
      attestation: async () => undefined,
      connect: () => settledStart(connection),
    },
    coordination,
  });
  assert.equal((await lifecycle.start()).kind, "started");
  assert.deepEqual(await lifecycle.start(), {
    kind: "existing",
    state: "active",
  });
  assert.deepEqual(await lifecycle.setMuted(false), {
    kind: "unchanged",
    state: "active",
    muted: false,
  });
  assert.deepEqual(await lifecycle.selectVoice("vale"), {
    kind: "refused",
    state: "active",
    diagnostic: "busy",
  });
  assert.deepEqual(await lifecycle.interrupt("pooling"), { status: "off" });
  assert.equal(lifecycle.snapshot().state, "off");
  assert.equal(coordination.poolingRefused, true);
  await assert.rejects(stat(fixture.lock), { code: "ENOENT" });
  assert.deepEqual(await lifecycle.start(), {
    kind: "refused",
    state: "off",
    diagnostic: "denied",
  });
  await assert.rejects(stat(fixture.lock), { code: "ENOENT" });
});

test("pooling timing before active uses exact terminal diagnostics and leaves no lock", async (t) => {
  await t.test("off", async () => {
    let homeCalls = 0;
    const lifecycle = createLiveLifecycle({
      admission: { check: admitted },
      home: {
        accountHome() {
          homeCalls += 1;
          return "/unused";
        },
        environmentHome: () => "/unused",
        certify: () => ({ certified: false }),
      },
      coordination: createIsolatedLiveCoordination(),
    });
    assert.deepEqual(await lifecycle.interrupt("pooling"), { status: "off" });
    assert.deepEqual(lifecycle.snapshot(), {
      state: "off",
      muted: false,
      voice: "sol",
      lastFailure: "denied",
    });
    assert.deepEqual(await lifecycle.start(), {
      kind: "refused",
      state: "off",
      diagnostic: "denied",
    });
    assert.equal(homeCalls, 0);
  });

  await t.test("consent", async () => {
    const approval = deferred<boolean>();
    const entered = deferred<void>();
    const lifecycle = createLiveLifecycle({
      admission: { check: admitted },
      consent: {
        request() {
          entered.resolve();
          return approval.promise;
        },
      },
      coordination: createIsolatedLiveCoordination(),
    });
    const starting = lifecycle.start();
    await entered.promise;
    assert.deepEqual(await lifecycle.interrupt("pooling"), { status: "off" });
    approval.resolve(true);
    assert.equal((await starting).kind, "cancelled");
    assert.deepEqual(await lifecycle.start(), {
      kind: "refused",
      state: "off",
      diagnostic: "denied",
    });
    assert.equal(lifecycle.snapshot().lastFailure, "denied");
  });

  await t.test("acquiring", async (t) => {
    const fixture = await fixtureHome(t);
    const certificationEntered = deferred<void>();
    const allowCertification = deferred<void>();
    const lifecycle = createLiveLifecycle({
      admission: { check: admitted },
      consent: { request: async () => true },
      home: {
        ...certifiedHome(fixture.home),
        async certify(observation) {
          certificationEntered.resolve();
          await allowCertification.promise;
          return { certified: true as const, ...observation };
        },
      },
      coordination: createIsolatedLiveCoordination(),
    });
    const starting = lifecycle.start();
    await certificationEntered.promise;
    assert.deepEqual(await lifecycle.interrupt("pooling"), { status: "off" });
    allowCertification.resolve();
    assert.equal((await starting).kind, "cancelled");
    assert.deepEqual(await lifecycle.start(), {
      kind: "refused",
      state: "off",
      diagnostic: "denied",
    });
    await assert.rejects(stat(fixture.lock), { code: "ENOENT" });
  });

  await t.test("connecting", async (t) => {
    const fixture = await fixtureHome(t);
    const connectEntered = deferred<void>();
    let terminateCalls = 0;
    const lifecycle = createLiveLifecycle({
      admission: { check: admitted },
      consent: { request: async () => true },
      home: certifiedHome(fixture.home),
      coordination: createIsolatedLiveCoordination(),
      resources: {
        credentials: async () => undefined,
        attestation: async () => undefined,
        connect() {
          connectEntered.resolve();
          return {
            result: new Promise<LiveConnection>(() => undefined),
            async terminate() {
              terminateCalls += 1;
            },
          };
        },
      },
    });
    const starting = lifecycle.start();
    await connectEntered.promise;
    assert.deepEqual(await lifecycle.interrupt("pooling"), { status: "off" });
    assert.equal((await starting).kind, "cancelled");
    assert.equal(terminateCalls, 1);
    assert.deepEqual(await lifecycle.start(), {
      kind: "refused",
      state: "off",
      diagnostic: "denied",
    });
    await assert.rejects(stat(fixture.lock), { code: "ENOENT" });
  });

  await t.test("stopping", async (t) => {
    const fixture = await fixtureHome(t);
    const closeEntered = deferred<void>();
    const allowClose = deferred<void>();
    const capture: LiveCapture = { stop: async () => undefined };
    const lifecycle = createLiveLifecycle({
      admission: { check: admitted },
      consent: { request: async () => true },
      home: certifiedHome(fixture.home),
      coordination: createIsolatedLiveCoordination(),
      resources: {
        credentials: async () => undefined,
        attestation: async () => undefined,
        connect: () =>
          settledStart({
            startCapture: () => settledStart(capture),
            sendSample: () => undefined,
            closeSession: async () => undefined,
            async close() {
              closeEntered.resolve();
              await allowClose.promise;
            },
          }),
      },
    });
    assert.equal((await lifecycle.start()).kind, "started");
    const stopping = lifecycle.stop();
    await closeEntered.promise;
    const pooling = lifecycle.interrupt("pooling");
    allowClose.resolve();
    assert.deepEqual(await stopping, { status: "off" });
    assert.deepEqual(await pooling, { status: "off" });
    assert.deepEqual(await lifecycle.start(), {
      kind: "refused",
      state: "off",
      diagnostic: "denied",
    });
    await assert.rejects(stat(fixture.lock), { code: "ENOENT" });
  });
});

test("data-only cancellation releases ownership, while an unquiet resource start becomes process-sticky blocked", async (t) => {
  const fixture = await fixtureHome(t);
  const clock = new TestClock();
  const credentialEntered = deferred<void>();
  const neverData = deferred<void>();
  const unusedCapture: LiveCapture = { stop: async () => undefined };
  const unusedConnection: LiveConnection = {
    startCapture: () => settledStart(unusedCapture),
    sendSample: () => undefined,
    closeSession: async () => undefined,
    close: async () => undefined,
  };
  const dataOnly = createLiveLifecycle({
    admission: { check: admitted },
    consent: { request: async () => true },
    home: certifiedHome(fixture.home),
    clock,
    coordination: createIsolatedLiveCoordination(),
    resources: {
      credentials() {
        credentialEntered.resolve();
        return neverData.promise;
      },
      attestation: async () => undefined,
      connect: () => settledStart(unusedConnection),
    },
  });
  const dataStarting = dataOnly.start();
  await credentialEntered.promise;
  assert.equal(dataOnly.snapshot().state, "acquiring");
  assert.equal((await stat(fixture.lock)).isDirectory(), true);
  assert.deepEqual(await dataOnly.stop(), { status: "off" });
  assert.equal((await dataStarting).kind, "cancelled");
  await assert.rejects(stat(fixture.lock), { code: "ENOENT" });

  const connectEntered = deferred<void>();
  const allowTermination = deferred<void>();
  const neverConnection = deferred<LiveConnection>();
  const resourceBearing = createLiveLifecycle({
    admission: { check: admitted },
    consent: { request: async () => true },
    home: certifiedHome(fixture.home),
    clock,
    coordination: createIsolatedLiveCoordination(),
    resources: {
      credentials: async () => undefined,
      attestation: async () => undefined,
      connect() {
        connectEntered.resolve();
        return {
          result: neverConnection.promise,
          async terminate() {
            await allowTermination.promise;
          },
        };
      },
    },
  });
  const resourceStarting = resourceBearing.start();
  await connectEntered.promise;
  assert.equal(resourceBearing.snapshot().state, "connecting");
  const resourceStopping = resourceBearing.stop();
  clock.advance(5_000);
  assert.deepEqual(await resourceStopping, { status: "blocked" });
  assert.deepEqual(resourceBearing.snapshot(), {
    state: "blocked",
    muted: false,
    voice: "sol",
    lastFailure: "cleanup-blocked",
  });
  assert.equal((await stat(fixture.lock)).isDirectory(), true);
  assert.deepEqual(await resourceBearing.start(), {
    kind: "refused",
    state: "blocked",
    diagnostic: "cleanup-blocked",
  });
  allowTermination.resolve();
  assert.equal((await resourceStarting).kind, "cancelled");
  await eventually(() => resourceBearing.snapshot().state === "blocked");
  assert.equal((await stat(fixture.lock)).isDirectory(), true);
});

test("preparation invocation and settlement are fenced before the next startup effect", async (t) => {
  for (const fenceAt of ["invoke", "settlement"] as const) {
    await t.test(fenceAt, async (t) => {
      const fixture = await fixtureHome(t);
      const effects: string[] = [];
      const clock = new TestClock();
      const capture: LiveCapture = { stop: async () => undefined };
      const connection: LiveConnection = {
        startCapture: () => settledStart(capture),
        sendSample: () => undefined,
        closeSession: async () => undefined,
        close: async () => undefined,
      };
      let lifecycle!: ReturnType<typeof createLiveLifecycle>;
      let armed = true;
      let scheduled = 0;
      const fence = () => {
        if (!armed) return;
        if (fenceAt === "invoke" && ++scheduled !== 3) return;
        if (fenceAt === "settlement" && !effects.includes("credentials"))
          return;
        armed = false;
        void lifecycle.stop();
      };
      if (fenceAt === "invoke") clock.onSet = fence;
      else clock.onClear = fence;
      lifecycle = createLiveLifecycle({
        admission: { check: admitted },
        consent: { request: async () => true },
        home: certifiedHome(fixture.home),
        clock,
        coordination: createIsolatedLiveCoordination(),
        resources: {
          credentials() {
            effects.push("credentials");
            return Promise.resolve();
          },
          attestation() {
            effects.push("attestation");
            return Promise.resolve();
          },
          connect() {
            effects.push("connect");
            return settledStart(connection);
          },
        },
      });

      const starting = lifecycle.start();
      if (fenceAt === "settlement")
        await eventually(() => effects.includes("credentials"));
      assert.equal((await starting).kind, "cancelled");
      await eventually(() => lifecycle.snapshot().state === "off");
      assert.deepEqual(effects, fenceAt === "invoke" ? [] : ["credentials"]);
      assert.equal(clock.timers.size, 0);
    });
  }
});

test("connection construction is tracked before synchronous stop reentrancy", async (t) => {
  const fixture = await fixtureHome(t);
  const effects: string[] = [];
  let lifecycle!: ReturnType<typeof createLiveLifecycle>;
  const connection: LiveConnection = {
    startCapture() {
      effects.push("capture-started");
      return settledStart({ stop: async () => undefined });
    },
    sendSample: () => undefined,
    closeSession: async () => {
      effects.push("semantic-close");
    },
    close: async () => {
      effects.push("connection-close");
    },
  };
  lifecycle = createLiveLifecycle({
    admission: { check: admitted },
    consent: { request: async () => true },
    home: certifiedHome(fixture.home),
    coordination: createIsolatedLiveCoordination(),
    resources: {
      credentials: async () => undefined,
      attestation: async () => undefined,
      connect() {
        effects.push("connection-constructor");
        void lifecycle.stop();
        return settledStart(connection);
      },
    },
  });

  assert.equal((await lifecycle.start()).kind, "cancelled");
  await eventually(() => lifecycle.snapshot().state === "off");
  assert.deepEqual(effects, ["connection-constructor", "connection-close"]);
  await assert.rejects(stat(fixture.lock), { code: "ENOENT" });
});

test("CORE: synchronous abort-listener stop reentrancy shares one published cleanup", async (t) => {
  const fixture = await fixtureHome(t);
  const clock = new TestClock();
  let lifecycle!: ReturnType<typeof createLiveLifecycle>;
  let nestedStop:
    Promise<{ status: "off" | "blocked" | "release-pending" }> | undefined;
  let semanticCloseCalls = 0;
  let captureStopCalls = 0;
  let connectionCloseCalls = 0;
  lifecycle = createLiveLifecycle({
    admission: { check: admitted },
    consent: { request: async () => true },
    home: certifiedHome(fixture.home),
    coordination: createIsolatedLiveCoordination(),
    clock,
    resources: {
      credentials: async () => undefined,
      attestation: async () => undefined,
      connect({ signal }) {
        signal.addEventListener(
          "abort",
          () => {
            nestedStop = lifecycle.stop();
          },
          { once: true },
        );
        return settledStart({
          startCapture: () =>
            settledStart({
              async stop() {
                captureStopCalls += 1;
              },
            }),
          sendSample: () => undefined,
          async closeSession() {
            semanticCloseCalls += 1;
          },
          async close() {
            connectionCloseCalls += 1;
          },
        });
      },
    },
  });

  assert.equal((await lifecycle.start()).kind, "started");
  let outerResult: unknown;
  let nestedResult: unknown;
  const outerStop = lifecycle.stop().then((result) => {
    outerResult = result;
  });
  assert.ok(nestedStop);
  const observedNestedStop = nestedStop.then((result) => {
    nestedResult = result;
  });

  await eventually(
    () => outerResult !== undefined && nestedResult !== undefined,
  );
  await Promise.all([outerStop, observedNestedStop]);
  assert.deepEqual(outerResult, { status: "off" });
  assert.deepEqual(nestedResult, { status: "off" });
  assert.equal(semanticCloseCalls, 1);
  assert.equal(captureStopCalls, 1);
  assert.equal(connectionCloseCalls, 1);
  await assert.rejects(stat(fixture.lock), { code: "ENOENT" });
});

test("resource construction is tracked before a synchronous callback can reenter stop", async (t) => {
  const fixture = await fixtureHome(t);
  const effects: string[] = [];
  let lifecycle!: ReturnType<typeof createLiveLifecycle>;
  const capture: LiveCapture = {
    async stop() {
      effects.push("capture-stopped");
    },
  };
  const connection: LiveConnection = {
    startCapture(callback) {
      callback([1]);
      return settledStart(capture);
    },
    sendSample() {
      effects.push("sample");
      void lifecycle.stop();
    },
    async closeSession() {
      effects.push("semantic-close");
    },
    async close() {
      effects.push("connection-closed");
    },
  };
  lifecycle = createLiveLifecycle({
    admission: { check: admitted },
    consent: { request: async () => true },
    home: certifiedHome(fixture.home),
    resources: {
      credentials: async () => undefined,
      attestation: async () => undefined,
      connect: () => settledStart(connection),
    },
    coordination: createIsolatedLiveCoordination(),
  });

  assert.equal((await lifecycle.start()).kind, "cancelled");
  await eventually(() => lifecycle.snapshot().state === "off");
  assert.deepEqual(effects, [
    "sample",
    "semantic-close",
    "connection-closed",
    "capture-stopped",
  ]);
  await assert.rejects(stat(fixture.lock), { code: "ENOENT" });
});

test("a resource constructor throw remains uncertain while known resources still close once", async (t) => {
  const fixture = await fixtureHome(t);
  const effects: string[] = [];
  const coordination = createIsolatedLiveCoordination();
  const lifecycle = createLiveLifecycle({
    admission: { check: admitted },
    consent: { request: async () => true },
    home: certifiedHome(fixture.home),
    coordination,
    resources: {
      credentials: async () => undefined,
      attestation: async () => undefined,
      connect: () =>
        settledStart({
          startCapture() {
            effects.push("capture-constructor");
            throw new Error("opaque capture constructor failed");
          },
          sendSample: () => undefined,
          closeSession: async () => {
            effects.push("semantic-close");
          },
          close: async () => {
            effects.push("connection-close");
          },
        }),
    },
  });

  assert.equal((await lifecycle.start()).kind, "cancelled");
  await eventually(() =>
    ["off", "blocked"].includes(lifecycle.snapshot().state),
  );
  assert.deepEqual(lifecycle.snapshot(), {
    state: "blocked",
    muted: false,
    voice: "sol",
    lastFailure: "cleanup-blocked",
  });
  assert.deepEqual(effects, [
    "capture-constructor",
    "semantic-close",
    "connection-close",
  ]);
  assert.equal((await stat(fixture.lock)).isDirectory(), true);
  assert.deepEqual(await lifecycle.toggle(), {
    kind: "refused",
    state: "blocked",
    diagnostic: "cleanup-blocked",
  });
  assert.deepEqual(await lifecycle.setMuted(true), {
    kind: "refused",
    state: "blocked",
    diagnostic: "busy",
  });
  assert.deepEqual(await lifecycle.selectVoice("vale"), {
    kind: "refused",
    state: "blocked",
    diagnostic: "busy",
  });
  assert.deepEqual(await lifecycle.interrupt("pooling"), {
    status: "blocked",
  });
  assert.equal(coordination.poolingRefused, true);
  assert.equal((await stat(fixture.lock)).isDirectory(), true);
  assert.deepEqual(await lifecycle.stop(), { status: "blocked" });
  assert.deepEqual(await lifecycle.start(), {
    kind: "refused",
    state: "blocked",
    diagnostic: "cleanup-blocked",
  });
  assert.deepEqual(
    effects.filter((effect) => effect === "connection-close"),
    ["connection-close"],
  );
});

test("a synchronous capture stop failure blocks after other known shutdown starts", async (t) => {
  const fixture = await fixtureHome(t);
  const effects: string[] = [];
  const lifecycle = createLiveLifecycle({
    admission: { check: admitted },
    consent: { request: async () => true },
    home: certifiedHome(fixture.home),
    coordination: createIsolatedLiveCoordination(),
    resources: {
      credentials: async () => undefined,
      attestation: async () => undefined,
      connect: () =>
        settledStart({
          startCapture: () =>
            settledStart({
              stop(): Promise<void> {
                effects.push("capture-stop");
                throw new Error("synchronous capture stop failure");
              },
            }),
          sendSample: () => undefined,
          closeSession: async () => {
            effects.push("semantic-close");
          },
          close: async () => {
            effects.push("connection-close");
          },
        }),
    },
  });

  assert.equal((await lifecycle.start()).kind, "started");
  assert.deepEqual(await lifecycle.stop(), { status: "blocked" });
  assert.deepEqual(effects, [
    "semantic-close",
    "capture-stop",
    "connection-close",
  ]);
  assert.equal((await stat(fixture.lock)).isDirectory(), true);
});

test("cleanup starts independent shutdowns promptly for an uncertain resource start", async (t) => {
  const fixture = await fixtureHome(t);
  const clock = new TestClock();
  const captureStartEntered = deferred<void>();
  const terminateEntered = deferred<void>();
  const allowTerminate = deferred<void>();
  const closeEntered = deferred<void>();
  const effects: string[] = [];
  const lifecycle = createLiveLifecycle({
    admission: { check: admitted },
    consent: { request: async () => true },
    home: certifiedHome(fixture.home),
    coordination: createIsolatedLiveCoordination(),
    clock,
    resources: {
      credentials: async () => undefined,
      attestation: async () => undefined,
      connect: () =>
        settledStart({
          startCapture() {
            captureStartEntered.resolve();
            return {
              result: new Promise<LiveCapture>(() => undefined),
              async terminate() {
                effects.push("capture-terminate");
                terminateEntered.resolve();
                await allowTerminate.promise;
                throw new Error("capture shutdown remained uncertain");
              },
            };
          },
          sendSample: () => undefined,
          closeSession: async () => {
            effects.push("semantic-close");
          },
          close() {
            effects.push("connection-close");
            closeEntered.resolve();
            return Promise.resolve();
          },
        }),
    },
  });

  const starting = lifecycle.start();
  await captureStartEntered.promise;
  const stopping = lifecycle.stop();
  await Promise.all([terminateEntered.promise, closeEntered.promise]);
  assert.equal(effects[0], "semantic-close");
  assert.deepEqual(
    new Set(effects.slice(1)),
    new Set(["capture-terminate", "connection-close"]),
  );
  clock.advance(5_000);
  assert.deepEqual(await stopping, { status: "blocked" });
  allowTerminate.resolve();
  assert.equal((await starting).kind, "cancelled");
  await eventually(() => lifecycle.snapshot().state === "blocked");
  assert.equal((await stat(fixture.lock)).isDirectory(), true);
});

test("the one semantic close receives the shared remaining deadline and cancellation", async (t) => {
  const fixture = await fixtureHome(t);
  const clock = new TestClock();
  const allowConnectionClose = deferred<void>();
  const closeRequests: Array<{
    deadline: number;
    remainingMs: number;
    signal: AbortSignal;
  }> = [];
  const capture: LiveCapture = { stop: async () => undefined };
  const lifecycle = createLiveLifecycle({
    admission: { check: admitted },
    consent: { request: async () => true },
    home: certifiedHome(fixture.home),
    coordination: createIsolatedLiveCoordination(),
    clock,
    resources: {
      credentials: async () => undefined,
      attestation: async () => undefined,
      connect: () =>
        settledStart({
          startCapture: () => settledStart(capture),
          sendSample: () => undefined,
          closeSession(request) {
            closeRequests.push(request);
            return new Promise<void>(() => undefined);
          },
          async close() {
            await allowConnectionClose.promise;
          },
        }),
    },
  });

  assert.equal((await lifecycle.start()).kind, "started");
  clock.advance(125);
  const stopping = lifecycle.stop();
  const joined = lifecycle.stop();
  assert.equal(closeRequests.length, 1);
  assert.deepEqual(
    {
      deadline: closeRequests[0]?.deadline,
      remainingMs: closeRequests[0]?.remainingMs,
      aborted: closeRequests[0]?.signal.aborted,
    },
    { deadline: 5_125, remainingMs: 5_000, aborted: false },
  );
  clock.advance(4_999);
  assert.equal(closeRequests[0]?.signal.aborted, false);
  clock.advance(1);
  assert.equal(closeRequests[0]?.signal.aborted, true);
  assert.deepEqual(await stopping, { status: "blocked" });
  assert.deepEqual(await joined, { status: "blocked" });
  allowConnectionClose.resolve();
  await eventually(() => lifecycle.snapshot().state === "blocked");
  assert.equal(closeRequests.length, 1);
});

test("quiescence one millisecond before the stop deadline may begin release", async (t) => {
  const fixture = await fixtureHome(t);
  const clock = new TestClock();
  const closeEntered = deferred<void>();
  const allowClose = deferred<void>();
  const baseFileSystem = createNodeOwnershipFileSystem();
  let unlinkCalls = 0;
  const capture: LiveCapture = { stop: async () => undefined };
  const lifecycle = createLiveLifecycle({
    admission: { check: admitted },
    consent: { request: async () => true },
    home: certifiedHome(fixture.home),
    coordination: createIsolatedLiveCoordination(),
    clock,
    ownershipFileSystem: {
      ...baseFileSystem,
      async unlink(target) {
        unlinkCalls += 1;
        await baseFileSystem.unlink(target);
      },
    },
    resources: {
      credentials: async () => undefined,
      attestation: async () => undefined,
      connect: () =>
        settledStart({
          startCapture: () => settledStart(capture),
          sendSample: () => undefined,
          closeSession: async () => undefined,
          async close() {
            closeEntered.resolve();
            await allowClose.promise;
          },
        }),
    },
  });

  assert.equal((await lifecycle.start()).kind, "started");
  const stopping = lifecycle.stop();
  await closeEntered.promise;
  clock.advance(4_999);
  allowClose.resolve();
  assert.deepEqual(await stopping, { status: "off" });
  assert.equal(unlinkCalls, 1);
  await assert.rejects(stat(fixture.lock), { code: "ENOENT" });
});

test("quiescence at the exact stop deadline blocks and prohibits every release operation", async (t) => {
  const fixture = await fixtureHome(t);
  const clock = new TestClock();
  const closeEntered = deferred<void>();
  const allowClose = deferred<void>();
  const baseFileSystem = createNodeOwnershipFileSystem();
  let unlinkCalls = 0;
  const capture: LiveCapture = { stop: async () => undefined };
  const connection: LiveConnection = {
    startCapture: () => settledStart(capture),
    sendSample: () => undefined,
    closeSession: async () => undefined,
    async close() {
      closeEntered.resolve();
      await allowClose.promise;
    },
  };
  const lifecycle = createLiveLifecycle({
    admission: { check: admitted },
    consent: { request: async () => true },
    home: certifiedHome(fixture.home),
    resources: {
      credentials: async () => undefined,
      attestation: async () => undefined,
      connect: () => settledStart(connection),
    },
    ownershipFileSystem: {
      ...baseFileSystem,
      async unlink(target: string) {
        unlinkCalls += 1;
        await baseFileSystem.unlink(target);
      },
    },
    coordination: createIsolatedLiveCoordination(),
    clock,
  });
  assert.equal((await lifecycle.start()).kind, "started");
  const stopping = lifecycle.stop();
  await closeEntered.promise;
  assert.deepEqual(await lifecycle.start(), {
    kind: "refused",
    state: "stopping",
    diagnostic: "busy",
  });
  assert.deepEqual(await lifecycle.toggle(), {
    kind: "refused",
    state: "stopping",
    diagnostic: "busy",
  });
  assert.deepEqual(await lifecycle.setMuted(true), {
    kind: "refused",
    state: "stopping",
    diagnostic: "busy",
  });
  assert.deepEqual(await lifecycle.selectVoice("vale"), {
    kind: "refused",
    state: "stopping",
    diagnostic: "busy",
  });
  const joined = lifecycle.stop();
  clock.advance(5_000);
  assert.deepEqual(await stopping, { status: "blocked" });
  assert.deepEqual(await joined, { status: "blocked" });
  assert.equal(unlinkCalls, 0);
  allowClose.resolve();
  await eventually(() => lifecycle.snapshot().state === "blocked");
  assert.equal(unlinkCalls, 0);
  assert.equal((await stat(fixture.lock)).isDirectory(), true);
});

test("old-generation sample and data callbacks cannot send or affect a later call", async (t) => {
  const fixture = await fixtureHome(t);
  const callbacks: Array<(samples: readonly number[]) => void> = [];
  const sends: string[] = [];
  const dataSends: string[] = [];
  const closes: string[] = [];
  const oldDataResult = deferred<void>();
  let connectionNumber = 0;
  const lifecycle = createLiveLifecycle({
    admission: { check: admitted },
    consent: { request: async () => true },
    home: certifiedHome(fixture.home),
    coordination: createIsolatedLiveCoordination(),
    resources: {
      credentials: async () => undefined,
      attestation: async () => undefined,
      connect() {
        const number = ++connectionNumber;
        const capture: LiveCapture = {
          async stop() {
            closes.push(`capture-${number}`);
          },
        };
        const connection: LiveConnection = {
          startCapture(callback) {
            callbacks.push(callback);
            return settledStart(capture);
          },
          sendSample() {
            sends.push(`sample-${number}`);
          },
          sendData(data) {
            dataSends.push(`${data.kind}-${number}:${data.text}`);
            return number === 1 ? oldDataResult.promise : undefined;
          },
          async closeSession() {
            closes.push(`semantic-${number}`);
          },
          async close() {
            closes.push(`connection-${number}`);
          },
        };
        return settledStart(connection);
      },
    },
  });

  assert.equal((await lifecycle.start()).kind, "started");
  const firstDataSender = lifecycle.createOutgoingSender();
  assert.ok(firstDataSender);
  callbacks[0]?.([1]);
  assert.equal(firstDataSender({ kind: "application", text: "first" }), true);
  assert.deepEqual(sends, ["sample-1"]);
  assert.deepEqual(dataSends, ["application-1:first"]);
  const firstStop = lifecycle.stop();
  const joinedStop = lifecycle.stop();
  callbacks[0]?.([2]);
  assert.equal(firstDataSender({ kind: "final", text: "late" }), false);
  assert.deepEqual(await firstStop, { status: "off" });
  assert.deepEqual(await joinedStop, { status: "off" });
  assert.deepEqual(closes, ["semantic-1", "capture-1", "connection-1"]);
  assert.deepEqual(sends, ["sample-1"]);

  assert.equal((await lifecycle.start()).kind, "started");
  assert.equal(firstDataSender({ kind: "application", text: "stale" }), false);
  callbacks[0]?.([3]);
  callbacks[1]?.([4]);
  const secondDataSender = lifecycle.createOutgoingSender();
  assert.ok(secondDataSender);
  assert.equal(secondDataSender({ kind: "final", text: "second" }), true);
  oldDataResult.reject(new Error("old send failed late"));
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(lifecycle.snapshot().state, "active");
  assert.deepEqual(sends, ["sample-1", "sample-2"]);
  assert.deepEqual(dataSends, ["application-1:first", "final-2:second"]);
  await lifecycle.stop();
  assert.deepEqual(
    closes.filter((effect) => effect.startsWith("semantic-")),
    ["semantic-1", "semantic-2"],
  );
});

test("mute gates samples immediately and a pending stop plus unmute creates no overlapping capture", async (t) => {
  const fixture = await fixtureHome(t);
  const allowFirstStop = deferred<void>();
  const callbacks: Array<(samples: readonly number[]) => void> = [];
  const sent: number[] = [];
  let capturesStarted = 0;
  let activeCaptures = 0;
  const connection: LiveConnection = {
    startCapture(callback) {
      callbacks.push(callback);
      capturesStarted += 1;
      assert.equal(activeCaptures, 0);
      activeCaptures += 1;
      const captureNumber = capturesStarted;
      return settledStart({
        async stop() {
          if (captureNumber === 1) await allowFirstStop.promise;
          activeCaptures -= 1;
        },
      });
    },
    sendSample(samples) {
      sent.push(samples[0] ?? -1);
    },
    closeSession: async () => undefined,
    async close() {
      assert.equal(activeCaptures, 0);
    },
  };
  const lifecycle = createLiveLifecycle({
    admission: { check: admitted },
    consent: { request: async () => true },
    home: certifiedHome(fixture.home),
    coordination: createIsolatedLiveCoordination(),
    resources: {
      credentials: async () => undefined,
      attestation: async () => undefined,
      connect: () => settledStart(connection),
    },
  });
  assert.equal((await lifecycle.start()).kind, "started");
  assert.equal(activeCaptures, 1);

  const muting = lifecycle.setMuted(true);
  assert.equal(lifecycle.snapshot().muted, true);
  callbacks[0]?.([1]);
  assert.deepEqual(sent, []);
  const unmuting = lifecycle.setMuted(false);
  assert.equal(lifecycle.snapshot().muted, false);
  allowFirstStop.resolve();
  await Promise.all([muting, unmuting]);
  assert.equal(capturesStarted, 2);
  assert.equal(activeCaptures, 1);
  callbacks[0]?.([2]);
  callbacks[1]?.([3]);
  assert.deepEqual(sent, [3]);

  assert.deepEqual(await lifecycle.toggle(), { status: "off" });
  assert.deepEqual(await lifecycle.stop(), { status: "off" });
  assert.equal(activeCaptures, 0);
});

test("CORE: synchronous mute reentrancy preserves final intent without overlapping capture", async (t) => {
  const fixture = await fixtureHome(t);
  const clock = new TestClock();
  let lifecycle!: ReturnType<typeof createLiveLifecycle>;
  let reentrantUnmute: Promise<LiveMutationResult> | undefined;
  let capturesStarted = 0;
  let activeCaptures = 0;
  const stoppedCaptures = new Set<number>();
  const connection: LiveConnection = {
    startCapture() {
      const captureNumber = ++capturesStarted;
      activeCaptures += 1;
      return settledStart({
        async stop() {
          if (stoppedCaptures.has(captureNumber)) return;
          stoppedCaptures.add(captureNumber);
          activeCaptures -= 1;
          if (captureNumber === 1) reentrantUnmute = lifecycle.setMuted(false);
        },
      });
    },
    sendSample: () => undefined,
    closeSession: async () => undefined,
    close: async () => undefined,
  };
  lifecycle = createLiveLifecycle({
    admission: { check: admitted },
    consent: { request: async () => true },
    home: certifiedHome(fixture.home),
    coordination: createIsolatedLiveCoordination(),
    clock,
    resources: {
      credentials: async () => undefined,
      attestation: async () => undefined,
      connect: () => settledStart(connection),
    },
  });

  assert.equal((await lifecycle.start()).kind, "started");
  assert.equal((await lifecycle.setMuted(true)).kind, "updated");
  assert.ok(reentrantUnmute);
  assert.equal((await reentrantUnmute).kind, "updated");
  assert.equal(lifecycle.snapshot().muted, false);
  assert.equal(capturesStarted, 2);
  assert.equal(activeCaptures, 1);

  assert.deepEqual(await lifecycle.stop(), { status: "off" });
  assert.equal(activeCaptures, 0);
  assert.equal(stoppedCaptures.size, 2);
});

test("a fenced ownership recheck cannot create capture after cleanup snapshots work", async (t) => {
  const fixture = await fixtureHome(t);
  const baseFileSystem = createNodeOwnershipFileSystem();
  const validationEntered = deferred<void>();
  const allowValidation = deferred<void>();
  let lockEntries = 0;
  let capturesStarted = 0;
  const connection: LiveConnection = {
    startCapture() {
      capturesStarted += 1;
      return settledStart({ stop: async () => undefined });
    },
    sendSample: () => undefined,
    closeSession: async () => undefined,
    close: async () => undefined,
  };
  const lifecycle = createLiveLifecycle({
    admission: { check: admitted },
    consent: { request: async () => true },
    home: certifiedHome(fixture.home),
    coordination: createIsolatedLiveCoordination(),
    ownershipFileSystem: {
      ...baseFileSystem,
      async entries(target) {
        lockEntries += 1;
        const entries = await baseFileSystem.entries(target);
        if (lockEntries === 3) {
          validationEntered.resolve();
          await allowValidation.promise;
        }
        return entries;
      },
    },
    resources: {
      credentials: async () => undefined,
      attestation: async () => undefined,
      connect: () => settledStart(connection),
    },
  });

  assert.equal((await lifecycle.start()).kind, "started");
  assert.equal(capturesStarted, 1);
  assert.equal((await lifecycle.setMuted(true)).kind, "updated");
  const unmuting = lifecycle.setMuted(false);
  await validationEntered.promise;
  const stopping = lifecycle.stop();
  allowValidation.resolve();
  await unmuting;
  assert.deepEqual(await stopping, { status: "off" });
  assert.equal(capturesStarted, 1);
  await assert.rejects(stat(fixture.lock), { code: "ENOENT" });
});

test("data and resource phases use their five and ten second budgets", async (t) => {
  await t.test("credential phase", async (t) => {
    const fixture = await fixtureHome(t);
    const clock = new TestClock();
    const entered = deferred<void>();
    const never = deferred<void>();
    const capture: LiveCapture = { stop: async () => undefined };
    const connection: LiveConnection = {
      startCapture: () => settledStart(capture),
      sendSample: () => undefined,
      closeSession: async () => undefined,
      close: async () => undefined,
    };
    const lifecycle = createLiveLifecycle({
      admission: { check: admitted },
      consent: { request: async () => true },
      home: certifiedHome(fixture.home),
      coordination: createIsolatedLiveCoordination(),
      clock,
      resources: {
        credentials() {
          entered.resolve();
          return never.promise;
        },
        attestation: async () => undefined,
        connect: () => settledStart(connection),
      },
    });
    const starting = lifecycle.start();
    await entered.promise;
    clock.advance(4_999);
    assert.equal(lifecycle.snapshot().state, "acquiring");
    clock.advance(1);
    assert.equal((await starting).kind, "cancelled");
    await eventually(() => lifecycle.snapshot().state === "off");
    assert.equal(lifecycle.snapshot().lastFailure, "connect-timeout");
  });

  await t.test("resource setup phase", async (t) => {
    const fixture = await fixtureHome(t);
    const clock = new TestClock();
    const entered = deferred<void>();
    const never = deferred<LiveConnection>();
    const lifecycle = createLiveLifecycle({
      admission: { check: admitted },
      consent: { request: async () => true },
      home: certifiedHome(fixture.home),
      coordination: createIsolatedLiveCoordination(),
      clock,
      resources: {
        credentials: async () => undefined,
        attestation: async () => undefined,
        connect() {
          entered.resolve();
          return {
            result: never.promise,
            terminate: async () => undefined,
          };
        },
      },
    });
    const starting = lifecycle.start();
    await entered.promise;
    clock.advance(9_999);
    assert.equal(lifecycle.snapshot().state, "connecting");
    clock.advance(1);
    assert.equal((await starting).kind, "cancelled");
    await eventually(() => lifecycle.snapshot().state === "off");
    assert.equal(lifecycle.snapshot().lastFailure, "connect-timeout");
  });
});

test("CORE: absolute lifecycle deadlines hold when timer delivery is delayed or early", async (t) => {
  await t.test(
    "data phase settlement after five seconds is not adopted",
    async (t) => {
      const fixture = await fixtureHome(t);
      const clock = new TestClock();
      const credentials = deferred<void>();
      const entered = deferred<void>();
      let attestationCalls = 0;
      const lifecycle = createLiveLifecycle({
        admission: { check: admitted },
        consent: { request: async () => true },
        home: certifiedHome(fixture.home),
        coordination: createIsolatedLiveCoordination(),
        clock,
        resources: {
          credentials() {
            entered.resolve();
            return credentials.promise;
          },
          async attestation() {
            attestationCalls += 1;
          },
          connect: () =>
            settledStart({
              startCapture: () => settledStart({ stop: async () => undefined }),
              sendSample: () => undefined,
              closeSession: async () => undefined,
              close: async () => undefined,
            }),
        },
      });

      const starting = lifecycle.start();
      await entered.promise;
      clock.elapseWithoutTimers(5_000);
      credentials.resolve();
      assert.equal((await starting).kind, "cancelled");
      await eventually(() => lifecycle.snapshot().state === "off");
      assert.equal(attestationCalls, 0);
      assert.equal(lifecycle.snapshot().lastFailure, "connect-timeout");
    },
  );

  await t.test(
    "resource settlement after ten seconds is disposed, not adopted",
    async (t) => {
      const fixture = await fixtureHome(t);
      const clock = new TestClock();
      const pendingConnection = deferred<LiveConnection>();
      const entered = deferred<void>();
      let closeCalls = 0;
      let captureCalls = 0;
      const connection: LiveConnection = {
        startCapture() {
          captureCalls += 1;
          return settledStart({ stop: async () => undefined });
        },
        sendSample: () => undefined,
        closeSession: async () => undefined,
        async close() {
          closeCalls += 1;
        },
      };
      const lifecycle = createLiveLifecycle({
        admission: { check: admitted },
        consent: { request: async () => true },
        home: certifiedHome(fixture.home),
        coordination: createIsolatedLiveCoordination(),
        clock,
        resources: {
          credentials: async () => undefined,
          attestation: async () => undefined,
          connect() {
            entered.resolve();
            return {
              result: pendingConnection.promise,
              async terminate(dispose) {
                await dispose(await pendingConnection.promise);
              },
            };
          },
        },
      });

      const starting = lifecycle.start();
      await entered.promise;
      clock.elapseWithoutTimers(10_000);
      pendingConnection.resolve(connection);
      assert.equal((await starting).kind, "cancelled");
      await eventually(() => lifecycle.snapshot().state === "off");
      assert.equal(captureCalls, 0);
      assert.equal(closeCalls, 1);
    },
  );

  await t.test(
    "total connect deadline is checked after a parked home effect",
    async (t) => {
      const fixture = await fixtureHome(t);
      const clock = new TestClock();
      const certificationEntered = deferred<void>();
      const allowCertification = deferred<void>();
      let connectCalls = 0;
      const lifecycle = createLiveLifecycle({
        admission: { check: admitted },
        consent: { request: async () => true },
        home: {
          ...certifiedHome(fixture.home),
          async certify(observation) {
            certificationEntered.resolve();
            await allowCertification.promise;
            return { certified: true as const, ...observation };
          },
        },
        coordination: createIsolatedLiveCoordination(),
        clock,
        resources: {
          credentials: async () => undefined,
          attestation: async () => undefined,
          connect() {
            connectCalls += 1;
            return settledStart({
              startCapture: () => settledStart({ stop: async () => undefined }),
              sendSample: () => undefined,
              closeSession: async () => undefined,
              close: async () => undefined,
            });
          },
        },
      });

      const starting = lifecycle.start();
      await certificationEntered.promise;
      clock.elapseWithoutTimers(30_000);
      allowCertification.resolve();
      assert.equal((await starting).kind, "cancelled");
      await eventually(() => lifecycle.snapshot().state === "off");
      assert.equal(connectCalls, 0);
      assert.equal(lifecycle.snapshot().lastFailure, "connect-timeout");
      await assert.rejects(stat(fixture.lock), { code: "ENOENT" });
    },
  );

  await t.test(
    "capture settlement after the startup cutoff is disposed",
    async (t) => {
      const fixture = await fixtureHome(t);
      const clock = new TestClock();
      const captureResult = deferred<LiveCapture>();
      const captureEntered = deferred<void>();
      let captureStops = 0;
      const lifecycle = createLiveLifecycle({
        admission: { check: admitted },
        consent: { request: async () => true },
        home: certifiedHome(fixture.home),
        coordination: createIsolatedLiveCoordination(),
        clock,
        resources: {
          credentials: async () => undefined,
          attestation: async () => undefined,
          connect: () =>
            settledStart({
              startCapture() {
                captureEntered.resolve();
                return {
                  result: captureResult.promise,
                  async terminate(dispose) {
                    await dispose(await captureResult.promise);
                  },
                };
              },
              sendSample: () => undefined,
              closeSession: async () => undefined,
              close: async () => undefined,
            }),
        },
      });

      const starting = lifecycle.start();
      await captureEntered.promise;
      clock.elapseWithoutTimers(30_001);
      captureResult.resolve({
        async stop() {
          captureStops += 1;
        },
      });
      assert.equal((await starting).kind, "cancelled");
      await eventually(() => lifecycle.snapshot().state === "off");
      assert.equal(captureStops, 1);
    },
  );

  await t.test(
    "total call checks monotonic time and ignores an early timer callback",
    async (t) => {
      const fixture = await fixtureHome(t);
      const clock = new TestClock();
      const lifecycle = createLiveLifecycle({
        admission: { check: admitted },
        consent: { request: async () => true },
        home: certifiedHome(fixture.home),
        coordination: createIsolatedLiveCoordination(),
        clock,
        resources: {
          credentials: async () => undefined,
          attestation: async () => undefined,
          connect: () =>
            settledStart({
              startCapture: () => settledStart({ stop: async () => undefined }),
              sendSample: () => undefined,
              closeSession: async () => undefined,
              close: async () => undefined,
            }),
        },
      });

      assert.equal((await lifecycle.start()).kind, "started");
      clock.fireNextWithoutAdvancing();
      assert.equal(lifecycle.snapshot().state, "active");
      clock.elapseWithoutTimers(60 * 60_000);
      // Status remains read-only even when a timer notification is delayed.
      assert.equal(lifecycle.snapshot().state, "active");
      const expiredControl = lifecycle.setMuted(false);
      assert.equal(lifecycle.snapshot().state, "stopping");
      assert.equal((await expiredControl).kind, "refused");
      assert.deepEqual(await lifecycle.stop(), { status: "off" });
    },
  );

  await t.test(
    "late unmute capture is disposed within its own resource budget",
    async (t) => {
      const fixture = await fixtureHome(t);
      const clock = new TestClock();
      const secondCapture = deferred<LiveCapture>();
      const secondEntered = deferred<void>();
      let capturesStarted = 0;
      let captureStops = 0;
      const lifecycle = createLiveLifecycle({
        admission: { check: admitted },
        consent: { request: async () => true },
        home: certifiedHome(fixture.home),
        coordination: createIsolatedLiveCoordination(),
        clock,
        resources: {
          credentials: async () => undefined,
          attestation: async () => undefined,
          connect: () =>
            settledStart({
              startCapture() {
                capturesStarted += 1;
                if (capturesStarted === 1)
                  return settledStart({
                    async stop() {
                      captureStops += 1;
                    },
                  });
                secondEntered.resolve();
                return {
                  result: secondCapture.promise,
                  async terminate(dispose) {
                    await dispose(await secondCapture.promise);
                  },
                };
              },
              sendSample: () => undefined,
              closeSession: async () => undefined,
              close: async () => undefined,
            }),
        },
      });

      assert.equal((await lifecycle.start()).kind, "started");
      assert.equal((await lifecycle.setMuted(true)).kind, "updated");
      const unmuting = lifecycle.setMuted(false);
      await secondEntered.promise;
      clock.elapseWithoutTimers(10_000);
      secondCapture.resolve({
        async stop() {
          captureStops += 1;
        },
      });
      assert.equal((await unmuting).kind, "refused");
      await eventually(() => lifecycle.snapshot().state === "off");
      assert.equal(capturesStarted, 2);
      assert.equal(captureStops, 2);
    },
  );
});

test("connect and call budgets anchor at acquiring after consent, and delegated work anchors at admission", async (t) => {
  const fixture = await fixtureHome(t);
  const clock = new TestClock();
  const consent = deferred<boolean>();
  const mkdirEntered = deferred<void>();
  const allowMkdir = deferred<void>();
  const baseFileSystem = createNodeOwnershipFileSystem();
  const fileSystem = {
    ...baseFileSystem,
    async mkdirExclusive(target: string, mode: number) {
      mkdirEntered.resolve();
      await allowMkdir.promise;
      await baseFileSystem.mkdirExclusive(target, mode);
    },
  };
  const capture: LiveCapture = { stop: async () => undefined };
  const connection: LiveConnection = {
    startCapture: () => settledStart(capture),
    sendSample: () => undefined,
    closeSession: async () => undefined,
    close: async () => undefined,
  };
  const connecting = createLiveLifecycle({
    admission: { check: admitted },
    consent: { request: () => consent.promise },
    home: certifiedHome(fixture.home),
    ownershipFileSystem: fileSystem,
    resources: {
      credentials: async () => undefined,
      attestation: async () => undefined,
      connect: () => settledStart(connection),
    },
    coordination: createIsolatedLiveCoordination(),
    clock,
  });
  const connectingStart = connecting.start();
  clock.advance(777);
  consent.resolve(true);
  await mkdirEntered.promise;
  assert.equal(connecting.snapshot().state, "acquiring");
  clock.advance(29_999);
  assert.equal(connecting.snapshot().state, "acquiring");
  clock.advance(1);
  assert.equal(connecting.snapshot().state, "stopping");
  allowMkdir.resolve();
  assert.equal((await connectingStart).kind, "cancelled");
  await eventually(() => connecting.snapshot().state === "off");
  assert.equal(connecting.snapshot().lastFailure, "connect-timeout");
  await assert.rejects(stat(fixture.lock), { code: "ENOENT" });

  const activeClock = new TestClock();
  const active = createLiveLifecycle({
    admission: { check: admitted },
    consent: { request: async () => true },
    home: certifiedHome(fixture.home),
    resources: {
      credentials: async () => undefined,
      attestation: async () => undefined,
      connect: () => settledStart(connection),
    },
    coordination: createIsolatedLiveCoordination(),
    clock: activeClock,
  });
  assert.equal((await active.start()).kind, "started");
  activeClock.advance(60 * 60_000 - 1);
  assert.equal(active.snapshot().state, "active");
  activeClock.advance(1);
  await eventually(() => active.snapshot().state === "off");

  assert.equal((await active.start()).kind, "started");
  const admittedWork = active.delegationAdmitted();
  assert.equal(admittedWork.kind, "updated");
  if (admittedWork.kind !== "updated") assert.fail("delegation was refused");
  assert.equal(admittedWork.state, "active");
  assert.equal(typeof admittedWork.settle, "function");
  activeClock.advance(30 * 60_000 - 1);
  assert.equal(active.snapshot().state, "active");
  activeClock.advance(1);
  await eventually(() => active.snapshot().state === "off");
});

test("CORE: delegation settlement capability is owned by its admitted call generation", async (t) => {
  const fixture = await fixtureHome(t);
  const clock = new TestClock();
  const lifecycle = createLiveLifecycle({
    admission: { check: admitted },
    consent: { request: async () => true },
    home: certifiedHome(fixture.home),
    coordination: createIsolatedLiveCoordination(),
    clock,
    resources: {
      credentials: async () => undefined,
      attestation: async () => undefined,
      connect: () =>
        settledStart({
          startCapture: () => settledStart({ stop: async () => undefined }),
          sendSample: () => undefined,
          closeSession: async () => undefined,
          close: async () => undefined,
        }),
    },
  });

  assert.equal((await lifecycle.start()).kind, "started");
  const oldAdmission = lifecycle.delegationAdmitted();
  assert.equal(oldAdmission.kind, "updated");
  if (oldAdmission.kind !== "updated") assert.fail("delegation was refused");
  assert.equal(typeof oldAdmission.settle, "function");
  assert.equal(lifecycle.delegationAdmitted().kind, "refused");
  assert.deepEqual(await lifecycle.stop(), { status: "off" });

  assert.equal((await lifecycle.start()).kind, "started");
  const currentAdmission = lifecycle.delegationAdmitted();
  assert.equal(currentAdmission.kind, "updated");
  if (currentAdmission.kind !== "updated")
    assert.fail("delegation was refused");
  oldAdmission.settle();
  clock.advance(30 * 60_000 - 1);
  assert.equal(lifecycle.snapshot().state, "active");
  clock.advance(1);
  await eventually(() => lifecycle.snapshot().state === "off");
  currentAdmission.settle();
});

test("a synchronous startup termination failure is shared without retrying shutdown", async (t) => {
  const fixture = await fixtureHome(t);
  let terminationCalls = 0;
  const lifecycle = createLiveLifecycle({
    admission: { check: admitted },
    consent: { request: async () => true },
    home: certifiedHome(fixture.home),
    coordination: createIsolatedLiveCoordination(),
    clock: new TestClock(),
    resources: {
      credentials: async () => undefined,
      attestation: async () => undefined,
      connect: () => ({
        result: Promise.reject(new Error("connection failed")),
        terminate() {
          terminationCalls += 1;
          throw new Error("termination uncertain");
        },
      }),
    },
  });
  await lifecycle.start();
  assert.deepEqual(await lifecycle.stop(), { status: "blocked" });
  assert.equal(terminationCalls, 1);
  assert.equal((await stat(fixture.lock)).isDirectory(), true);
});

test("delegation settlement cannot erase an expired deadline while timer delivery is delayed", async (t) => {
  for (const elapsed of [30 * 60_000 - 1, 30 * 60_000, 30 * 60_000 + 1]) {
    await t.test(`${elapsed} milliseconds`, async (t) => {
      const fixture = await fixtureHome(t);
      const clock = new TestClock();
      const lifecycle = createLiveLifecycle({
        admission: { check: admitted },
        consent: { request: async () => true },
        home: certifiedHome(fixture.home),
        coordination: createIsolatedLiveCoordination(),
        clock,
        resources: {
          credentials: async () => undefined,
          attestation: async () => undefined,
          connect: () =>
            settledStart({
              startCapture: () => settledStart({ stop: async () => undefined }),
              sendSample: () => undefined,
              closeSession: async () => undefined,
              close: async () => undefined,
            }),
        },
      });
      assert.equal((await lifecycle.start()).kind, "started");
      const admission = lifecycle.delegationAdmitted();
      if (admission.kind !== "updated") assert.fail("delegation was refused");
      clock.elapseWithoutTimers(elapsed);
      admission.settle();
      assert.equal(
        lifecycle.snapshot().state,
        elapsed < 30 * 60_000 ? "active" : "stopping",
      );
      assert.deepEqual(await lifecycle.stop(), { status: "off" });
    });
  }
});
