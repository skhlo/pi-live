import assert from "node:assert/strict";
import { stat } from "node:fs/promises";
import { test } from "node:test";

import {
  createIsolatedLiveCoordination,
  createLiveLifecycle,
  createNodeOwnershipFileSystem,
  type LiveCapture,
  type LiveConnection,
  type LiveMutationResult,
} from "../src/live.ts";
import {
  admitted,
  approvingConsent,
  certifiedHome,
  createFakeCapture,
  createFakeConnection,
  createFakeResources,
  createLiveFixture,
  deferred,
  fixtureCredentials,
  ManualClock as TestClock,
  settledStart,
} from "./test-support/live-fixture.ts";
import { waitForCondition } from "./test-support/live-wait.ts";

function eventually(check: () => boolean): Promise<void> {
  return waitForCondition(check, "condition did not settle within 10 seconds");
}

test("the lifecycle is lazy and refuses unsupported admission before consent or resources", async () => {
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
        return Promise.resolve(fixtureCredentials);
      },
      connect() {
        throw new Error("resource construction must stay lazy");
      },
    },
  });

  assert.deepEqual(lifecycle.snapshot(), {
    state: "off",
    muted: false,
    voice: "marin",
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

  assert.deepEqual(await lifecycle.selectVoice("cedar"), {
    kind: "updated",
    state: "off",
    voice: "cedar",
  });
  const firstStart = lifecycle.start();
  await consentEntered[0]!.promise;
  assert.equal(lifecycle.snapshot().state, "consent");
  assert.deepEqual(await lifecycle.start(), {
    kind: "existing",
    state: "consent",
  });
  assert.deepEqual(await lifecycle.selectVoice("marin"), {
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
    const fixture = await createLiveFixture(t);
    const mkdirEntered = deferred<void>();
    const allowMkdir = deferred<void>();
    const baseFileSystem = createNodeOwnershipFileSystem();
    const lifecycle = fixture.createLifecycle(approvingConsent, {
      clock: fixture.clock,
      ownershipFileSystem: {
        ...baseFileSystem,
        async mkdirExclusive(target, mode) {
          mkdirEntered.resolve();
          await allowMkdir.promise;
          await baseFileSystem.mkdirExclusive(target, mode);
        },
      },
    });
    fixture.beforeRemoval(() => allowMkdir.resolve());
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
    assert.deepEqual(await lifecycle.selectVoice("cedar"), {
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
    const fixture = await createLiveFixture(t);
    const connectEntered = deferred<void>();
    const connectionResult = deferred<LiveConnection>();
    let terminateCalls = 0;
    fixture.resources.connect = () => {
      connectEntered.resolve();
      return {
        result: connectionResult.promise,
        async terminate() {
          terminateCalls += 1;
        },
      };
    };
    const lifecycle = fixture.createLifecycle(approvingConsent, {
      clock: fixture.clock,
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
    assert.deepEqual(await lifecycle.selectVoice("cedar"), {
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
      const fixture = await createLiveFixture(t);
      const baseFileSystem = createNodeOwnershipFileSystem();
      const rmdirCompleted = deferred<void>();
      const allowRmdirCallback = deferred<void>();
      const approval = deferred<boolean>();
      const consentEntered = deferred<void>();
      let contenderHomeCalls = 0;
      const owner = fixture.createLifecycle(approvingConsent, {
        clock: fixture.clock,
        ownershipFileSystem: {
          ...baseFileSystem,
          async rmdir(target) {
            await baseFileSystem.rmdir(target);
            rmdirCompleted.resolve();
            await allowRmdirCallback.promise;
          },
        },
      });
      const contender = fixture.createLifecycle(
        {
          request() {
            consentEntered.resolve();
            return approval.promise;
          },
        },
        {
          clock: fixture.clock,
          home: {
            ...certifiedHome(fixture.home),
            accountHome() {
              contenderHomeCalls += 1;
              return fixture.home;
            },
          },
        },
      );
      fixture.beforeRemoval(() => {
        approval.resolve(false);
        allowRmdirCallback.resolve();
      });

      assert.equal((await owner.start()).kind, "started");
      const contenderStart = contender.start();
      await consentEntered.promise;
      const ownerStop = owner.stop();
      await rmdirCompleted.promise;
      assert.equal(fixture.coordination.ownership.kind, "pending");

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
        const fixture = await createLiveFixture(t);
        const approval = deferred<boolean>();
        const consentEntered = deferred<void>();
        let homeCalls = 0;
        const contender = fixture.createLifecycle(
          {
            request() {
              consentEntered.resolve();
              return approval.promise;
            },
          },
          {
            clock: fixture.clock,
            home: {
              ...certifiedHome(fixture.home),
              accountHome() {
                homeCalls += 1;
                return fixture.home;
              },
            },
          },
        );
        fixture.beforeRemoval(() => approval.resolve(false));

        const starting = contender.start();
        await consentEntered.promise;
        if (sharedChange === "blocked") {
          fixture.coordination.ownership = { kind: "blocked" };
        } else {
          const observer = createLiveLifecycle({
            coordination: fixture.coordination,
            clock: fixture.clock,
          });
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
  const fixture = await createLiveFixture(t);
  const lifecycle = fixture.createLifecycle(approvingConsent);
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
  assert.deepEqual(await lifecycle.selectVoice("cedar"), {
    kind: "refused",
    state: "active",
    diagnostic: "busy",
  });
  assert.deepEqual(await lifecycle.interrupt("pooling"), { status: "off" });
  assert.equal(lifecycle.snapshot().state, "off");
  assert.equal(fixture.coordination.poolingRefused, true);
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
      voice: "marin",
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
    const fixture = await createLiveFixture(t);
    const certificationEntered = deferred<void>();
    const allowCertification = deferred<void>();
    const lifecycle = fixture.createLifecycle(approvingConsent, {
      home: {
        ...certifiedHome(fixture.home),
        async certify(observation) {
          certificationEntered.resolve();
          await allowCertification.promise;
          return { certified: true as const, ...observation };
        },
      },
    });
    fixture.beforeRemoval(() => allowCertification.resolve());
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
    const fixture = await createLiveFixture(t);
    const connectEntered = deferred<void>();
    let terminateCalls = 0;
    fixture.resources.connect = () => {
      connectEntered.resolve();
      return {
        result: new Promise<LiveConnection>(() => undefined),
        async terminate() {
          terminateCalls += 1;
        },
      };
    };
    const lifecycle = fixture.createLifecycle(approvingConsent);
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
    const fixture = await createLiveFixture(t);
    const closeEntered = deferred<void>();
    const allowClose = deferred<void>();
    fixture.connection.close = async () => {
      closeEntered.resolve();
      await allowClose.promise;
    };
    const lifecycle = fixture.createLifecycle(approvingConsent);
    fixture.beforeRemoval(() => allowClose.resolve());
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
  const fixture = await createLiveFixture(t);
  const credentialEntered = deferred<void>();
  const neverData = deferred<typeof fixtureCredentials>();
  const dataOnly = fixture.createLifecycle(approvingConsent, {
    clock: fixture.clock,
    resources: createFakeResources(fixture.connection, {
      credentials() {
        credentialEntered.resolve();
        return neverData.promise;
      },
    }),
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
  const resourceBearing = fixture.createLifecycle(approvingConsent, {
    clock: fixture.clock,
    coordination: createIsolatedLiveCoordination(),
    resources: createFakeResources(fixture.connection, {
      connect() {
        connectEntered.resolve();
        return {
          result: neverConnection.promise,
          async terminate() {
            await allowTermination.promise;
          },
        };
      },
    }),
  });
  fixture.beforeRemoval(() => allowTermination.resolve());
  const resourceStarting = resourceBearing.start();
  await connectEntered.promise;
  assert.equal(resourceBearing.snapshot().state, "connecting");
  const resourceStopping = resourceBearing.stop();
  fixture.clock.advance(5_000);
  assert.deepEqual(await resourceStopping, { status: "blocked" });
  assert.deepEqual(resourceBearing.snapshot(), {
    state: "blocked",
    muted: false,
    voice: "marin",
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
      const fixture = await createLiveFixture(t);
      const effects: string[] = [];
      const clock = fixture.clock;
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
      fixture.resources.credentials = async () => {
        effects.push("credentials");
        return fixtureCredentials;
      };
      fixture.resources.connect = () => {
        effects.push("connect");
        return settledStart(fixture.connection);
      };
      lifecycle = fixture.createLifecycle(approvingConsent, {
        clock: fixture.clock,
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
  const fixture = await createLiveFixture(t);
  const effects: string[] = [];
  let lifecycle!: ReturnType<typeof createLiveLifecycle>;
  const connection = createFakeConnection({
    startCapture() {
      effects.push("capture-started");
      return settledStart(fixture.capture);
    },
    closeSession: async () => {
      effects.push("semantic-close");
    },
    close: async () => {
      effects.push("connection-close");
    },
  });
  fixture.resources.connect = () => {
    effects.push("connection-constructor");
    void lifecycle.stop();
    return settledStart(connection);
  };
  lifecycle = fixture.createLifecycle(approvingConsent);

  assert.equal((await lifecycle.start()).kind, "cancelled");
  await eventually(() => lifecycle.snapshot().state === "off");
  assert.deepEqual(effects, ["connection-constructor", "connection-close"]);
  await assert.rejects(stat(fixture.lock), { code: "ENOENT" });
});

test("CORE: synchronous abort-listener stop reentrancy shares one published cleanup", async (t) => {
  const fixture = await createLiveFixture(t);
  let lifecycle!: ReturnType<typeof createLiveLifecycle>;
  let nestedStop:
    Promise<{ status: "off" | "blocked" | "release-pending" }> | undefined;
  let semanticCloseCalls = 0;
  let captureStopCalls = 0;
  let connectionCloseCalls = 0;
  fixture.resources.connect = ({ signal }) => {
    signal.addEventListener(
      "abort",
      () => {
        nestedStop = lifecycle.stop();
      },
      { once: true },
    );
    return settledStart(
      createFakeConnection(
        {
          async closeSession() {
            semanticCloseCalls += 1;
          },
          async close() {
            connectionCloseCalls += 1;
          },
        },
        createFakeCapture({
          async stop() {
            captureStopCalls += 1;
          },
        }),
      ),
    );
  };
  lifecycle = fixture.createLifecycle(approvingConsent, {
    clock: fixture.clock,
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
  const fixture = await createLiveFixture(t);
  const effects: string[] = [];
  let lifecycle!: ReturnType<typeof createLiveLifecycle>;
  const capture = createFakeCapture({
    async stop() {
      effects.push("capture-stopped");
    },
  });
  const connection = createFakeConnection({
    startCapture(callback) {
      callback(new Float32Array([1]));
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
  });
  fixture.resources.connect = () => settledStart(connection);
  lifecycle = fixture.createLifecycle(approvingConsent);

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
  const fixture = await createLiveFixture(t);
  const effects: string[] = [];
  fixture.connection.startCapture = () => {
    effects.push("capture-constructor");
    throw new Error("opaque capture constructor failed");
  };
  fixture.connection.closeSession = async () => {
    effects.push("semantic-close");
  };
  fixture.connection.close = async () => {
    effects.push("connection-close");
  };
  const lifecycle = fixture.createLifecycle(approvingConsent);

  assert.equal((await lifecycle.start()).kind, "cancelled");
  await eventually(() =>
    ["off", "blocked"].includes(lifecycle.snapshot().state),
  );
  assert.deepEqual(lifecycle.snapshot(), {
    state: "blocked",
    muted: false,
    voice: "marin",
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
  assert.deepEqual(await lifecycle.selectVoice("cedar"), {
    kind: "refused",
    state: "blocked",
    diagnostic: "busy",
  });
  assert.deepEqual(await lifecycle.interrupt("pooling"), {
    status: "blocked",
  });
  assert.equal(fixture.coordination.poolingRefused, true);
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
  const fixture = await createLiveFixture(t);
  const effects: string[] = [];
  fixture.capture.stop = () => {
    effects.push("capture-stop");
    throw new Error("synchronous capture stop failure");
  };
  fixture.connection.closeSession = async () => {
    effects.push("semantic-close");
  };
  fixture.connection.close = async () => {
    effects.push("connection-close");
  };
  const lifecycle = fixture.createLifecycle(approvingConsent);

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
  const fixture = await createLiveFixture(t);
  const captureStartEntered = deferred<void>();
  const terminateEntered = deferred<void>();
  const allowTerminate = deferred<void>();
  const closeEntered = deferred<void>();
  const effects: string[] = [];
  fixture.connection.startCapture = () => {
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
  };
  fixture.connection.closeSession = async () => {
    effects.push("semantic-close");
  };
  fixture.connection.close = async () => {
    effects.push("connection-close");
    closeEntered.resolve();
  };
  const lifecycle = fixture.createLifecycle(approvingConsent, {
    clock: fixture.clock,
  });
  fixture.beforeRemoval(() => allowTerminate.resolve());

  const starting = lifecycle.start();
  await captureStartEntered.promise;
  const stopping = lifecycle.stop();
  await Promise.all([terminateEntered.promise, closeEntered.promise]);
  assert.equal(effects[0], "semantic-close");
  assert.deepEqual(
    new Set(effects.slice(1)),
    new Set(["capture-terminate", "connection-close"]),
  );
  fixture.clock.advance(5_000);
  assert.deepEqual(await stopping, { status: "blocked" });
  allowTerminate.resolve();
  assert.equal((await starting).kind, "cancelled");
  await eventually(() => lifecycle.snapshot().state === "blocked");
  assert.equal((await stat(fixture.lock)).isDirectory(), true);
});

test("the one semantic close receives the shared remaining deadline and cancellation", async (t) => {
  const fixture = await createLiveFixture(t);
  const clock = fixture.clock;
  const allowConnectionClose = deferred<void>();
  const closeRequests: Array<{
    deadline: number;
    remainingMs: number;
    signal: AbortSignal;
  }> = [];
  fixture.connection.closeSession = (request) => {
    closeRequests.push(request);
    return new Promise<void>(() => undefined);
  };
  fixture.connection.close = async () => {
    await allowConnectionClose.promise;
  };
  const lifecycle = fixture.createLifecycle(approvingConsent, {
    clock: fixture.clock,
  });
  fixture.beforeRemoval(() => allowConnectionClose.resolve());

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
  const fixture = await createLiveFixture(t);
  const closeEntered = deferred<void>();
  const allowClose = deferred<void>();
  const baseFileSystem = createNodeOwnershipFileSystem();
  let unlinkCalls = 0;
  fixture.connection.close = async () => {
    closeEntered.resolve();
    await allowClose.promise;
  };
  const lifecycle = fixture.createLifecycle(approvingConsent, {
    clock: fixture.clock,
    ownershipFileSystem: {
      ...baseFileSystem,
      async unlink(target) {
        unlinkCalls += 1;
        await baseFileSystem.unlink(target);
      },
    },
  });
  fixture.beforeRemoval(() => allowClose.resolve());

  assert.equal((await lifecycle.start()).kind, "started");
  const stopping = lifecycle.stop();
  await closeEntered.promise;
  fixture.clock.advance(4_999);
  allowClose.resolve();
  assert.deepEqual(await stopping, { status: "off" });
  assert.equal(unlinkCalls, 1);
  await assert.rejects(stat(fixture.lock), { code: "ENOENT" });
});

test("quiescence at the exact stop deadline blocks and prohibits every release operation", async (t) => {
  const fixture = await createLiveFixture(t);
  const closeEntered = deferred<void>();
  const allowClose = deferred<void>();
  const baseFileSystem = createNodeOwnershipFileSystem();
  let unlinkCalls = 0;
  fixture.connection.close = async () => {
    closeEntered.resolve();
    await allowClose.promise;
  };
  const lifecycle = fixture.createLifecycle(approvingConsent, {
    clock: fixture.clock,
    ownershipFileSystem: {
      ...baseFileSystem,
      async unlink(target) {
        unlinkCalls += 1;
        await baseFileSystem.unlink(target);
      },
    },
  });
  fixture.beforeRemoval(() => allowClose.resolve());
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
  assert.deepEqual(await lifecycle.selectVoice("cedar"), {
    kind: "refused",
    state: "stopping",
    diagnostic: "busy",
  });
  const joined = lifecycle.stop();
  fixture.clock.advance(5_000);
  assert.deepEqual(await stopping, { status: "blocked" });
  assert.deepEqual(await joined, { status: "blocked" });
  assert.equal(unlinkCalls, 0);
  allowClose.resolve();
  await eventually(() => lifecycle.snapshot().state === "blocked");
  assert.equal(unlinkCalls, 0);
  assert.equal((await stat(fixture.lock)).isDirectory(), true);
});

test("old-generation sample and data callbacks cannot send or affect a later call", async (t) => {
  const fixture = await createLiveFixture(t);
  const callbacks: Array<(samples: Float32Array) => void> = [];
  const sends: string[] = [];
  const dataSends: string[] = [];
  const closes: string[] = [];
  const oldDataResult = deferred<void>();
  let connectionNumber = 0;
  fixture.resources.connect = () => {
    const number = ++connectionNumber;
    const capture = createFakeCapture({
      async stop() {
        closes.push(`capture-${number}`);
      },
    });
    return settledStart(
      createFakeConnection({
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
      }),
    );
  };
  const lifecycle = fixture.createLifecycle(approvingConsent);
  fixture.beforeRemoval(() => oldDataResult.resolve());

  assert.equal((await lifecycle.start()).kind, "started");
  const firstDataSender = lifecycle.createOutgoingSender();
  assert.ok(firstDataSender);
  callbacks[0]?.(new Float32Array([1]));
  assert.equal(firstDataSender({ kind: "application", text: "first" }), true);
  assert.deepEqual(sends, ["sample-1"]);
  assert.deepEqual(dataSends, ["application-1:first"]);
  const firstStop = lifecycle.stop();
  const joinedStop = lifecycle.stop();
  callbacks[0]?.(new Float32Array([2]));
  assert.equal(firstDataSender({ kind: "final", text: "late" }), false);
  assert.deepEqual(await firstStop, { status: "off" });
  assert.deepEqual(await joinedStop, { status: "off" });
  assert.deepEqual(closes, ["semantic-1", "capture-1", "connection-1"]);
  assert.deepEqual(sends, ["sample-1"]);

  assert.equal((await lifecycle.start()).kind, "started");
  assert.equal(firstDataSender({ kind: "application", text: "stale" }), false);
  callbacks[0]?.(new Float32Array([3]));
  callbacks[1]?.(new Float32Array([4]));
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
  const fixture = await createLiveFixture(t);
  const allowFirstStop = deferred<void>();
  const callbacks: Array<(samples: Float32Array) => void> = [];
  const sent: number[] = [];
  let capturesStarted = 0;
  let activeCaptures = 0;
  fixture.connection.startCapture = (callback) => {
    callbacks.push(callback);
    capturesStarted += 1;
    assert.equal(activeCaptures, 0);
    activeCaptures += 1;
    const captureNumber = capturesStarted;
    return settledStart(
      createFakeCapture({
        async stop() {
          if (captureNumber === 1) await allowFirstStop.promise;
          activeCaptures -= 1;
        },
      }),
    );
  };
  fixture.connection.sendSample = (samples) => {
    sent.push(samples[0] ?? -1);
  };
  fixture.connection.close = async () => {
    assert.equal(activeCaptures, 0);
  };
  const lifecycle = fixture.createLifecycle(approvingConsent);
  fixture.beforeRemoval(() => allowFirstStop.resolve());
  assert.equal((await lifecycle.start()).kind, "started");
  assert.equal(activeCaptures, 1);

  const muting = lifecycle.setMuted(true);
  assert.equal(lifecycle.snapshot().muted, true);
  callbacks[0]?.(new Float32Array([1]));
  assert.deepEqual(sent, []);
  const unmuting = lifecycle.setMuted(false);
  assert.equal(lifecycle.snapshot().muted, false);
  allowFirstStop.resolve();
  await Promise.all([muting, unmuting]);
  assert.equal(capturesStarted, 2);
  assert.equal(activeCaptures, 1);
  callbacks[0]?.(new Float32Array([2]));
  callbacks[1]?.(new Float32Array([3]));
  assert.deepEqual(sent, [3]);

  assert.deepEqual(await lifecycle.toggle(), { status: "off" });
  assert.deepEqual(await lifecycle.stop(), { status: "off" });
  assert.equal(activeCaptures, 0);
});

test("CORE: synchronous mute reentrancy preserves final intent without overlapping capture", async (t) => {
  const fixture = await createLiveFixture(t);
  let lifecycle!: ReturnType<typeof createLiveLifecycle>;
  let reentrantUnmute: Promise<LiveMutationResult> | undefined;
  let capturesStarted = 0;
  let activeCaptures = 0;
  const stoppedCaptures = new Set<number>();
  fixture.connection.startCapture = () => {
    const captureNumber = ++capturesStarted;
    activeCaptures += 1;
    return settledStart(
      createFakeCapture({
        async stop() {
          if (stoppedCaptures.has(captureNumber)) return;
          stoppedCaptures.add(captureNumber);
          activeCaptures -= 1;
          if (captureNumber === 1) reentrantUnmute = lifecycle.setMuted(false);
        },
      }),
    );
  };
  lifecycle = fixture.createLifecycle(approvingConsent, {
    clock: fixture.clock,
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
  const fixture = await createLiveFixture(t);
  const baseFileSystem = createNodeOwnershipFileSystem();
  const validationEntered = deferred<void>();
  const allowValidation = deferred<void>();
  let lockEntries = 0;
  let capturesStarted = 0;
  fixture.connection.startCapture = () => {
    capturesStarted += 1;
    return settledStart(fixture.capture);
  };
  const lifecycle = fixture.createLifecycle(approvingConsent, {
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
  });
  fixture.beforeRemoval(() => allowValidation.resolve());

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

test("data phases use five seconds and lifecycle connection uses the common total budget", async (t) => {
  await t.test("credential phase", async (t) => {
    const fixture = await createLiveFixture(t);
    const clock = fixture.clock;
    const entered = deferred<void>();
    const never = deferred<typeof fixtureCredentials>();
    fixture.resources.credentials = () => {
      entered.resolve();
      return never.promise;
    };
    const lifecycle = fixture.createLifecycle(approvingConsent, {
      clock: fixture.clock,
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

  await t.test("total connection phase", async (t) => {
    const fixture = await createLiveFixture(t);
    const clock = fixture.clock;
    const entered = deferred<void>();
    const never = deferred<LiveConnection>();
    fixture.resources.connect = () => {
      entered.resolve();
      return {
        result: never.promise,
        terminate: async () => undefined,
      };
    };
    const lifecycle = fixture.createLifecycle(approvingConsent, {
      clock: fixture.clock,
    });
    const starting = lifecycle.start();
    await entered.promise;
    clock.advance(29_999);
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
      const fixture = await createLiveFixture(t);
      const clock = fixture.clock;
      const credentials = deferred<typeof fixtureCredentials>();
      const entered = deferred<void>();
      let connectCalls = 0;
      fixture.resources.credentials = () => {
        entered.resolve();
        return credentials.promise;
      };
      fixture.resources.connect = () => {
        connectCalls += 1;
        return settledStart(fixture.connection);
      };
      const lifecycle = fixture.createLifecycle(approvingConsent, {
        clock: fixture.clock,
      });

      const starting = lifecycle.start();
      await entered.promise;
      clock.elapseWithoutTimers(5_000);
      credentials.resolve(fixtureCredentials);
      assert.equal((await starting).kind, "cancelled");
      await eventually(() => lifecycle.snapshot().state === "off");
      assert.equal(connectCalls, 0);
      assert.equal(lifecycle.snapshot().lastFailure, "connect-timeout");
    },
  );

  await t.test(
    "connection settlement after the total deadline is disposed, not adopted",
    async (t) => {
      const fixture = await createLiveFixture(t);
      const clock = fixture.clock;
      const pendingConnection = deferred<LiveConnection>();
      const entered = deferred<void>();
      let closeCalls = 0;
      let captureCalls = 0;
      const connection = createFakeConnection({
        startCapture() {
          captureCalls += 1;
          return settledStart(createFakeCapture());
        },
        async close() {
          closeCalls += 1;
        },
      });
      fixture.resources.connect = () => {
        entered.resolve();
        return {
          result: pendingConnection.promise,
          async terminate(dispose) {
            await dispose(await pendingConnection.promise);
          },
        };
      };
      const lifecycle = fixture.createLifecycle(approvingConsent, {
        clock: fixture.clock,
      });
      fixture.beforeRemoval(() => pendingConnection.resolve(connection));

      const starting = lifecycle.start();
      await entered.promise;
      clock.elapseWithoutTimers(30_000);
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
      const fixture = await createLiveFixture(t);
      const clock = fixture.clock;
      const certificationEntered = deferred<void>();
      const allowCertification = deferred<void>();
      let connectCalls = 0;
      fixture.resources.connect = () => {
        connectCalls += 1;
        return settledStart(fixture.connection);
      };
      const lifecycle = fixture.createLifecycle(approvingConsent, {
        clock: fixture.clock,
        home: {
          ...certifiedHome(fixture.home),
          async certify(observation) {
            certificationEntered.resolve();
            await allowCertification.promise;
            return { certified: true as const, ...observation };
          },
        },
      });
      fixture.beforeRemoval(() => allowCertification.resolve());

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
      const fixture = await createLiveFixture(t);
      const clock = fixture.clock;
      const captureResult = deferred<LiveCapture>();
      const captureEntered = deferred<void>();
      let captureStops = 0;
      fixture.connection.startCapture = () => {
        captureEntered.resolve();
        return {
          result: captureResult.promise,
          async terminate(dispose) {
            await dispose(await captureResult.promise);
          },
        };
      };
      const lifecycle = fixture.createLifecycle(approvingConsent, {
        clock: fixture.clock,
      });
      fixture.beforeRemoval(() => captureResult.resolve(createFakeCapture()));

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
      const fixture = await createLiveFixture(t);
      const clock = fixture.clock;
      const lifecycle = fixture.createLifecycle(approvingConsent, {
        clock: fixture.clock,
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
      const fixture = await createLiveFixture(t);
      const clock = fixture.clock;
      const secondCapture = deferred<LiveCapture>();
      const secondEntered = deferred<void>();
      let capturesStarted = 0;
      let captureStops = 0;
      fixture.connection.startCapture = () => {
        capturesStarted += 1;
        if (capturesStarted === 1)
          return settledStart(
            createFakeCapture({
              async stop() {
                captureStops += 1;
              },
            }),
          );
        secondEntered.resolve();
        return {
          result: secondCapture.promise,
          async terminate(dispose) {
            await dispose(await secondCapture.promise);
          },
        };
      };
      const lifecycle = fixture.createLifecycle(approvingConsent, {
        clock: fixture.clock,
      });
      fixture.beforeRemoval(() => secondCapture.resolve(createFakeCapture()));

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

test("connect and call budgets anchor at acquiring after consent", async (t) => {
  const fixture = await createLiveFixture(t);
  const clock = fixture.clock;
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
  const connecting = fixture.createLifecycle(
    { request: () => consent.promise },
    { clock: fixture.clock, ownershipFileSystem: fileSystem },
  );
  fixture.beforeRemoval(() => allowMkdir.resolve());
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
  const active = fixture.createLifecycle(approvingConsent, {
    coordination: createIsolatedLiveCoordination(),
    clock: activeClock,
  });
  assert.equal((await active.start()).kind, "started");
  activeClock.advance(60 * 60_000 - 1);
  assert.equal(active.snapshot().state, "active");
  activeClock.advance(1);
  await eventually(() => active.snapshot().state === "off");
});

test("a synchronous startup termination failure is shared without retrying shutdown", async (t) => {
  const fixture = await createLiveFixture(t);
  let terminationCalls = 0;
  fixture.resources.connect = () => ({
    result: Promise.reject(new Error("connection failed")),
    terminate() {
      terminationCalls += 1;
      throw new Error("termination uncertain");
    },
  });
  const lifecycle = fixture.createLifecycle(approvingConsent, {
    clock: fixture.clock,
  });
  await lifecycle.start();
  assert.deepEqual(await lifecycle.stop(), { status: "blocked" });
  assert.equal(terminationCalls, 1);
  assert.equal((await stat(fixture.lock)).isDirectory(), true);
});
