import assert from "node:assert/strict";
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { userInfo } from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  createIsolatedLiveCoordination,
  createLiveLifecycle,
  createNodeOwnershipFileSystem,
  type HomeCertificationObservation,
  type OwnershipFileSystem,
} from "../src/live.ts";
import {
  admitted as admittedFacts,
  approvingConsent,
  certifiedHome,
  createFakeCapture,
  createFakeConnection,
  createFakeResources as inertResources,
  deferred,
  ManualClock as TestClock,
  settledStart,
} from "./test-support/live-fixture.ts";
import {
  activeChildWatchdogCount,
  assertChildBusy,
  assertCompleteOwner,
  assertEmptyLock,
  type ChildMode,
  createOwnershipFixture as fixtureHome,
  eventually,
  exitChildAtBarrier,
  lockInventory,
  parkedReleaseFileSystem,
  publicationFaultFileSystem,
  spawnContender,
  startAndStopChild,
  withChildWatchdog,
} from "./test-support/live-ownership.ts";

const admitted = { check: admittedFacts };
const consented = approvingConsent;

test("a certified fixture home publishes a private owner and releases it only after resources close", async (t) => {
  const fixture = await fixtureHome(t);
  const effects: string[] = [];
  const capture = createFakeCapture({
    async stop() {
      effects.push("capture-stopped");
    },
  });
  const connection = createFakeConnection(
    {
      async closeSession() {
        effects.push("session-close");
      },
      async close() {
        effects.push("connection-closed");
      },
    },
    capture,
  );
  const resources = inertResources(connection);
  const lifecycle = fixture.createLifecycle({ resources });

  assert.deepEqual(await lifecycle.start(), {
    kind: "started",
    state: "active",
  });
  assert.equal(lifecycle.snapshot().state, "active");
  assert.equal((await stat(fixture.lock)).mode & 0o777, 0o700);
  const ownerPath = path.join(fixture.lock, "owner.json");
  assert.equal((await stat(ownerPath)).mode & 0o777, 0o600);
  const owner: unknown = JSON.parse(await readFile(ownerPath, "utf8"));
  assert.ok(owner && typeof owner === "object" && "generation" in owner);
  assert.ok("ownerToken" in owner);

  assert.deepEqual(await lifecycle.stop(), { status: "off" });
  assert.deepEqual(effects, [
    "session-close",
    "capture-stopped",
    "connection-closed",
  ]);
  await assert.rejects(stat(fixture.lock), { code: "ENOENT" });
});

test("real child contenders using different Pi agent directories produce exactly one owner", async (t) => {
  const fixture = await fixtureHome(t);
  const first = spawnContender(fixture, fixture.agentA);
  const firstStarted = await first.next();
  assert.deepEqual(firstStarted, {
    event: "started",
    result: { kind: "started", state: "active" },
    snapshot: { state: "active", muted: false, voice: "marin" },
  });
  assert.equal((await stat(fixture.lock)).isDirectory(), true);

  const second = spawnContender(fixture, fixture.agentB);
  assert.deepEqual(await second.next(), {
    event: "started",
    result: { kind: "refused", state: "off", diagnostic: "busy" },
    snapshot: {
      state: "off",
      muted: false,
      voice: "marin",
      lastFailure: "busy",
    },
  });
  const secondExit = await second.waitExited();
  assert.deepEqual(secondExit, { code: 0, signal: null }, second.stderr());
  assert.equal((await stat(fixture.lock)).isDirectory(), true);

  const stoppedLine = first.next();
  first.process.stdin.write("stop\n");
  assert.deepEqual(await stoppedLine, {
    event: "stopped",
    result: { status: "off" },
    snapshot: { state: "off", muted: false, voice: "marin" },
  });
  first.process.stdin.end();
  const firstExit = await first.waitExited();
  assert.deepEqual(firstExit, { code: 0, signal: null }, first.stderr());
  await assert.rejects(stat(fixture.lock), { code: "ENOENT" });
  assert.deepEqual(await readdir(path.join(fixture.root, "agent-a")), []);
  assert.deepEqual(await readdir(path.join(fixture.root, "agent-b")), []);
});

test("simultaneous ready-barrier children produce exactly one real owner", async (t) => {
  const fixture = await fixtureHome(t);
  const contenders = [
    spawnContender(fixture, fixture.agentA, "start-barrier"),
    spawnContender(fixture, fixture.agentB, "start-barrier"),
  ];

  assert.deepEqual(await Promise.all(contenders.map((child) => child.next())), [
    { event: "ready", barrier: "start" },
    { event: "ready", barrier: "start" },
  ]);
  const reports = contenders.map((child) => child.next());
  for (const contender of contenders) contender.process.stdin.write("start\n");
  const results = await Promise.all(reports);
  const winnerIndexes = results.flatMap((result, index) =>
    result &&
    typeof result === "object" &&
    (result as { result?: { kind?: unknown } }).result?.kind === "started"
      ? [index]
      : [],
  );
  const refusedIndexes = results.flatMap((result, index) =>
    result &&
    typeof result === "object" &&
    (result as { result?: { kind?: unknown } }).result?.kind === "refused"
      ? [index]
      : [],
  );
  assert.deepEqual(winnerIndexes.length, 1, JSON.stringify(results));
  assert.deepEqual(refusedIndexes.length, 1, JSON.stringify(results));

  const winner = contenders[winnerIndexes[0]!]!;
  const refused = contenders[refusedIndexes[0]!]!;
  assert.deepEqual(results[winnerIndexes[0]!], {
    event: "started",
    result: { kind: "started", state: "active" },
    snapshot: { state: "active", muted: false, voice: "marin" },
  });
  assert.deepEqual(results[refusedIndexes[0]!], {
    event: "started",
    result: { kind: "refused", state: "off", diagnostic: "busy" },
    snapshot: {
      state: "off",
      muted: false,
      voice: "marin",
      lastFailure: "busy",
    },
  });
  assert.deepEqual(await refused.waitExited(), { code: 0, signal: null });
  assert.equal((await stat(fixture.lock)).isDirectory(), true);

  const stopped = winner.next();
  winner.process.stdin.write("stop\n");
  assert.deepEqual(await stopped, {
    event: "stopped",
    result: { status: "off" },
    snapshot: { state: "off", muted: false, voice: "marin" },
  });
  winner.process.stdin.end();
  assert.deepEqual(await winner.waitExited(), { code: 0, signal: null });
  await assert.rejects(stat(fixture.lock), { code: "ENOENT" });
});

test("a second real child stays busy while the first fake resource close is pending", async (t) => {
  const fixture = await fixtureHome(t);
  const closeEntered = deferred<void>();
  const allowClose = deferred<void>();
  const connection = createFakeConnection({
    async close() {
      closeEntered.resolve();
      await allowClose.promise;
    },
  });
  const lifecycle = fixture.createLifecycle({
    resources: inertResources(connection),
    coordination: createIsolatedLiveCoordination(),
  });
  fixture.beforeRemoval(async () => {
    allowClose.resolve();
    await withChildWatchdog(
      lifecycle.stop(),
      () => "fixture lifecycle cleanup timed out",
    );
  });

  assert.equal((await lifecycle.start()).kind, "started");
  const stopping = lifecycle.stop();
  await withChildWatchdog(
    closeEntered.promise,
    () => "fake connection close was not entered",
  );

  const duringClose = spawnContender(fixture, fixture.agentB);
  const duringCloseResult = await duringClose.next();
  const unexpectedlyStarted =
    duringCloseResult !== null &&
    typeof duringCloseResult === "object" &&
    (duringCloseResult as { result?: { kind?: unknown } }).result?.kind ===
      "started";
  if (unexpectedlyStarted) {
    const stopped = duringClose.next();
    duringClose.process.stdin.write("stop\n");
    await stopped;
    duringClose.process.stdin.end();
  }
  assert.deepEqual(await duringClose.waitExited(), {
    code: 0,
    signal: null,
  });

  allowClose.resolve();
  const stoppedFirst = await withChildWatchdog(
    stopping,
    () => "first lifecycle stop did not settle after releasing close gate",
  );
  assert.deepEqual(
    (duringCloseResult as { result?: unknown }).result,
    { kind: "refused", state: "off", diagnostic: "busy" },
    duringClose.stderr(),
  );
  assert.deepEqual(stoppedFirst, { status: "off" });
  await assert.rejects(stat(fixture.lock), { code: "ENOENT" });

  const afterClose = spawnContender(fixture, fixture.agentB);
  assert.deepEqual(await afterClose.next(), {
    event: "started",
    result: { kind: "started", state: "active" },
    snapshot: { state: "active", muted: false, voice: "marin" },
  });
  const stopped = afterClose.next();
  afterClose.process.stdin.write("stop\n");
  assert.deepEqual(((await stopped) as { result?: unknown }).result, {
    status: "off",
  });
  afterClose.process.stdin.end();
  assert.deepEqual(await afterClose.waitExited(), { code: 0, signal: null });
  await assert.rejects(stat(fixture.lock), { code: "ENOENT" });
});

test("the default cell rejects malformed state without contaminating an isolated cell", async (t) => {
  const fixture = await fixtureHome(t);
  const child = spawnContender(fixture, fixture.agentA, "coordination-probe");

  assert.deepEqual(await child.next(), {
    event: "coordination-probe",
    defaultSnapshot: {
      state: "blocked",
      muted: false,
      voice: "marin",
      lastFailure: "cleanup-blocked",
    },
    isolatedSnapshot: { state: "off", muted: false, voice: "marin" },
    globalVersion: 2,
  });
  assert.deepEqual(await child.waitExited(), { code: 0, signal: null });
});

test("child failures are joined and clear their bounded watchdog", async (t) => {
  const fixture = await fixtureHome(t);
  const child = spawnContender(fixture, fixture.agentA, "silent-exit");

  await assert.rejects(child.next(), /exited before output/);
  assert.deepEqual(await child.waitExited(), { code: 0, signal: null });
  assert.equal(activeChildWatchdogCount(), 0);
});

test("actual process exit records exact acquisition and publication remnants without SDK disposal", async (t) => {
  const cases = [
    ["exit-before-mkdir", "absent"],
    ["exit-mkdir-submitted", "submitted"],
    ["exit-mkdir-completed", "empty"],
    ["exit-owner-open", "empty-owner"],
    ["exit-owner-write", "complete-owner"],
    ["exit-owner-sync", "complete-owner"],
    ["exit-owner-close", "complete-owner"],
    ["exit-owner-verification", "complete-owner"],
    ["exit-verified-ownership", "complete-owner"],
  ] as const satisfies ReadonlyArray<readonly [ChildMode, string]>;

  for (const [mode, expected] of cases) {
    await t.test(mode, async (t) => {
      const fixture = await fixtureHome(t);
      const child = spawnContender(fixture, fixture.agentA, mode);
      const report = await child.next();
      assert.ok(report && typeof report === "object");
      assert.deepEqual(
        {
          event: (report as { event?: unknown }).event,
          boundary: (report as { boundary?: unknown }).boundary,
          exitKind: (report as { exitKind?: unknown }).exitKind,
          snapshot: (report as { snapshot?: unknown }).snapshot,
          coordination: (report as { coordination?: unknown }).coordination,
        },
        {
          event: "exit-boundary",
          boundary: mode,
          exitKind: "process-without-sdk-dispose",
          snapshot: {
            state: mode === "exit-verified-ownership" ? "active" : "acquiring",
            muted: false,
            voice: "marin",
          },
          coordination: { kind: "none" },
        },
      );

      const whileAlive = await lockInventory(fixture.lock);
      if (expected === "absent")
        assert.deepEqual(whileAlive, { kind: "absent" });
      else if (expected === "empty") assertEmptyLock(whileAlive);
      else if (expected === "empty-owner")
        assert.deepEqual(whileAlive, {
          kind: "directory",
          mode: 0o700,
          entries: [
            { name: "owner.json", kind: "file", mode: 0o600, bytes: "" },
          ],
        });
      else if (expected === "complete-owner") assertCompleteOwner(whileAlive);
      else
        assert.ok(
          whileAlive.kind === "absent" ||
            (whileAlive.kind === "directory" &&
              whileAlive.mode === 0o700 &&
              whileAlive.entries.length === 0),
          JSON.stringify(whileAlive),
        );

      await exitChildAtBarrier(child);
      const afterJoinedExit = await lockInventory(fixture.lock);
      if (expected === "absent")
        assert.deepEqual(afterJoinedExit, { kind: "absent" });
      else if (expected === "empty") assertEmptyLock(afterJoinedExit);
      else if (expected === "empty-owner")
        assert.deepEqual(afterJoinedExit, {
          kind: "directory",
          mode: 0o700,
          entries: [
            { name: "owner.json", kind: "file", mode: 0o600, bytes: "" },
          ],
        });
      else if (expected === "complete-owner")
        assertCompleteOwner(afterJoinedExit);
      else
        assert.ok(
          afterJoinedExit.kind === "absent" ||
            (afterJoinedExit.kind === "directory" &&
              afterJoinedExit.mode === 0o700 &&
              afterJoinedExit.entries.length === 0),
          JSON.stringify(afterJoinedExit),
        );

      if (afterJoinedExit.kind === "absent") await startAndStopChild(fixture);
      else await assertChildBusy(fixture);
    });
  }
});

test("actual process exit records release remnants and never treats an unacknowledged callback as filesystem truth", async (t) => {
  for (const mode of [
    "exit-unlink-complete",
    "exit-rmdir-pending",
    "exit-rmdir-complete-callback-parked",
  ] as const) {
    await t.test(mode, async (t) => {
      const fixture = await fixtureHome(t);
      const original = spawnContender(fixture, fixture.agentA, mode);
      assert.deepEqual(await original.next(), {
        event: "started",
        result: { kind: "started", state: "active" },
        snapshot: { state: "active", muted: false, voice: "marin" },
      });
      const boundary = original.next();
      original.process.stdin.write("stop\n");
      const report = await boundary;
      assert.ok(report && typeof report === "object");
      const coordination = (report as { coordination?: unknown }).coordination;
      assert.ok(coordination && typeof coordination === "object");
      assert.equal(
        typeof (coordination as { attemptId?: unknown }).attemptId,
        "string",
      );
      assert.deepEqual(
        {
          event: (report as { event?: unknown }).event,
          boundary: (report as { boundary?: unknown }).boundary,
          exitKind: (report as { exitKind?: unknown }).exitKind,
          snapshot: (report as { snapshot?: unknown }).snapshot,
          coordinationKind: (coordination as { kind?: unknown }).kind,
        },
        {
          event: "exit-boundary",
          boundary: mode,
          exitKind: "process-without-sdk-dispose",
          snapshot: { state: "releasing", muted: false, voice: "marin" },
          coordinationKind: "pending",
        },
      );

      const whileAlive = await lockInventory(fixture.lock);
      if (mode === "exit-unlink-complete") assertEmptyLock(whileAlive);
      else if (mode === "exit-rmdir-complete-callback-parked")
        assert.deepEqual(whileAlive, { kind: "absent" });
      else
        assert.ok(
          whileAlive.kind === "absent" ||
            (whileAlive.kind === "directory" &&
              whileAlive.entries.length === 0),
          JSON.stringify(whileAlive),
        );

      if (mode === "exit-rmdir-complete-callback-parked") {
        const replacement = spawnContender(fixture, fixture.agentB);
        assert.deepEqual(await replacement.next(), {
          event: "started",
          result: { kind: "started", state: "active" },
          snapshot: { state: "active", muted: false, voice: "marin" },
        });
        assertCompleteOwner(await lockInventory(fixture.lock));
        await exitChildAtBarrier(original);
        assertCompleteOwner(await lockInventory(fixture.lock));
        const stopped = replacement.next();
        replacement.process.stdin.write("stop\n");
        assert.deepEqual(await stopped, {
          event: "stopped",
          result: { status: "off" },
          snapshot: { state: "off", muted: false, voice: "marin" },
        });
        replacement.process.stdin.end();
        assert.deepEqual(
          await replacement.waitExited(),
          { code: 0, signal: null },
          replacement.stderr(),
        );
        return;
      }

      await exitChildAtBarrier(original);
      const afterJoinedExit = await lockInventory(fixture.lock);
      if (mode === "exit-unlink-complete") {
        assertEmptyLock(afterJoinedExit);
        await assertChildBusy(fixture);
      } else if (afterJoinedExit.kind === "absent") {
        await startAndStopChild(fixture);
      } else {
        assertEmptyLock(afterJoinedExit);
        await assertChildBusy(fixture);
      }
    });
  }
});

test("empty, partial, corrupt, unreadable, redirected, and dead-PID locks remain busy and are never stolen", async (t) => {
  for (const kind of [
    "empty",
    "partial",
    "dead-pid",
    "unreadable",
    "symlink",
    "regular-file",
  ] as const) {
    await t.test(kind, async (t) => {
      const fixture = await fixtureHome(t);
      if (kind === "symlink") {
        const outside = path.join(fixture.root, "outside-lock");
        await mkdir(outside, { mode: 0o700 });
        await symlink(outside, fixture.lock);
      } else if (kind === "regular-file") {
        await writeFile(fixture.lock, "not a directory\n", { mode: 0o600 });
      } else {
        await mkdir(fixture.lock, { mode: 0o700 });
        if (kind === "partial")
          await writeFile(
            path.join(fixture.lock, "owner.json"),
            '{"version":',
            {
              mode: 0o600,
            },
          );
        if (kind === "dead-pid")
          await writeFile(
            path.join(fixture.lock, "owner.json"),
            '{"version":1,"generation":"old","ownerToken":"old","pid":999999999}\n',
            { mode: 0o600 },
          );
        if (kind === "unreadable") await chmod(fixture.lock, 0o000);
      }
      const before = await lstat(fixture.lock);
      let resourceCalls = 0;
      const lifecycle = fixture.createLifecycle({
        resources: {
          ...inertResources(),
          connect(options) {
            resourceCalls += 1;
            return inertResources().connect(options);
          },
        },
        coordination: createIsolatedLiveCoordination(),
      });
      assert.deepEqual(await lifecycle.start(), {
        kind: "refused",
        state: "off",
        diagnostic: "busy",
      });
      const after = await lstat(fixture.lock);
      assert.equal(after.dev, before.dev);
      assert.equal(after.ino, before.ino);
      assert.equal(after.mode, before.mode);
      assert.equal(resourceCalls, 0);
    });
  }
});

test("every post-mkdir publication fault is sticky and leaves child contenders busy", async (t) => {
  for (const point of [
    "mkdir-return",
    "lock-inspect",
    "owner-open",
    "owner-write",
    "owner-sync",
    "owner-handle-inspect",
    "owner-close",
    "owner-path-inspect",
    "owner-read",
    "owner-reinspect",
    "lock-reinspect",
    "directory-entries",
  ] as const) {
    await t.test(point, async (t) => {
      const fixture = await fixtureHome(t);
      const lifecycle = fixture.createLifecycle({
        ownershipFileSystem: publicationFaultFileSystem(point, fixture.lock),
        coordination: createIsolatedLiveCoordination(),
      });
      assert.deepEqual(await lifecycle.start(), {
        kind: "cancelled",
        state: "blocked",
      });
      assert.deepEqual(lifecycle.snapshot(), {
        state: "blocked",
        muted: false,
        voice: "marin",
        lastFailure: "cleanup-blocked",
      });
      assert.equal((await stat(fixture.lock)).isDirectory(), true);

      const contender = spawnContender(fixture, fixture.agentA);
      const result = await contender.next();
      assert.ok(result && typeof result === "object");
      assert.deepEqual(
        (result as { result?: unknown }).result,
        { kind: "refused", state: "off", diagnostic: "busy" },
        contender.stderr(),
      );
      assert.deepEqual(await contender.waitExited(), {
        code: 0,
        signal: null,
      });
    });
  }
});

test("every serial release filesystem phase stays pending past its observer deadline and settles authoritatively", async (t) => {
  const points = [
    "validation-realpath",
    "validation-inspect",
    "validation-read",
    "validation-entries",
    "unlink",
    "deletion-inspect",
    "deletion-entries",
    "rmdir",
  ] as const;
  for (const point of points) {
    for (const settlement of ["success", "failure"] as const) {
      await t.test(`${point} then ${settlement}`, async (t) => {
        const fixture = await fixtureHome(t);
        const parked = parkedReleaseFileSystem(fixture, point);
        const clock = new TestClock();
        const coordination = createIsolatedLiveCoordination();
        const lifecycle = fixture.createLifecycle({
          ownershipFileSystem: parked.fileSystem,
          clock,
          coordination,
        });
        fixture.beforeRemoval(async () => {
          parked.settle("failure");
          clock.advance(5_000);
          await withChildWatchdog(
            lifecycle.stop(),
            () => `parked ${point} lifecycle cleanup timed out`,
          );
        });
        assert.equal((await lifecycle.start()).kind, "started");
        parked.arm();

        const stopping = lifecycle.stop();
        const entered = await withChildWatchdog(
          parked.entered,
          () => `release did not enter ${point}`,
        );
        assert.equal(entered.operation, point.split("-").at(-1));
        const pendingInventory = await lockInventory(fixture.lock);
        if (
          point === "deletion-inspect" ||
          point === "deletion-entries" ||
          point === "rmdir"
        )
          assertEmptyLock(pendingInventory);
        else assertCompleteOwner(pendingInventory);

        clock.advance(5_000);
        assert.deepEqual(await stopping, { status: "release-pending" });
        assert.equal(lifecycle.snapshot().state, "releasing");
        assert.equal(coordination.ownership.kind, "pending");
        assert.deepEqual(await lifecycle.start(), {
          kind: "refused",
          state: "releasing",
          diagnostic: "busy",
        });
        assert.equal(lifecycle.snapshot().state, "releasing");
        assert.equal(parked.maximumActive(), 1);

        const operationNames = parked
          .records()
          .map((record) => record.operation);
        if (point === "validation-entries" || point === "unlink") {
          const firstRealpath = operationNames.indexOf("realpath");
          const firstInspect = operationNames.indexOf("inspect");
          const read = operationNames.indexOf("read");
          const entries = operationNames.indexOf("entries");
          assert.ok(firstRealpath >= 0);
          assert.ok(firstInspect > firstRealpath);
          assert.ok(read > firstInspect);
          assert.ok(entries > read);
          if (point === "unlink")
            assert.ok(operationNames.indexOf("unlink") > entries);
        }
        if (
          point === "deletion-inspect" ||
          point === "deletion-entries" ||
          point === "rmdir"
        ) {
          assert.ok(operationNames.indexOf("unlink") >= 0);
          assert.ok(
            operationNames.lastIndexOf(entered.operation) >
              operationNames.indexOf("unlink"),
          );
        }

        parked.settle(settlement);
        await parked.selectedSettled;
        if (settlement === "success") {
          await eventually(() => lifecycle.snapshot().state === "off", "task");
          assert.deepEqual(await lifecycle.stop(), { status: "off" });
          assert.deepEqual(await lockInventory(fixture.lock), {
            kind: "absent",
          });
          assert.deepEqual(coordination.ownership, { kind: "none" });
        } else {
          await eventually(
            () => lifecycle.snapshot().state === "blocked",
            "task",
          );
          assert.deepEqual(await lifecycle.stop(), { status: "blocked" });
          assert.deepEqual(coordination.ownership, { kind: "blocked" });
          const retained = await lockInventory(fixture.lock);
          if (
            point === "deletion-inspect" ||
            point === "deletion-entries" ||
            point === "rmdir"
          )
            assertEmptyLock(retained);
          else assertCompleteOwner(retained);

          const independentContender = fixture.createLifecycle({
            coordination: createIsolatedLiveCoordination(),
          });
          assert.deepEqual(await independentContender.start(), {
            kind: "refused",
            state: "off",
            diagnostic: "busy",
          });
        }
        assert.equal(parked.maximumActive(), 1);
      });
    }
  }
});

test("an asynchronous release reports pending across reload and only its original finalizer settles it", async (t) => {
  const fixture = await fixtureHome(t);
  const baseFileSystem = createNodeOwnershipFileSystem();
  const enteredRmdir = deferred<void>();
  const allowRmdir = deferred<void>();
  const rmdirCompleted = deferred<void>();
  const clock = new TestClock();
  const coordination = createIsolatedLiveCoordination();
  const fileSystem = {
    ...baseFileSystem,
    async rmdir(target: string) {
      enteredRmdir.resolve();
      await allowRmdir.promise;
      await baseFileSystem.rmdir(target);
      rmdirCompleted.resolve();
    },
  };
  const options = {
    admission: admitted,
    consent: consented,
    home: certifiedHome(fixture.home),
    resources: inertResources(),
    ownershipFileSystem: fileSystem,
    clock,
    coordination,
  };
  const original = createLiveLifecycle(options);
  fixture.beforeRemoval(async () => {
    allowRmdir.resolve();
    await withChildWatchdog(
      original.stop(),
      () => "asynchronous release cleanup timed out",
    );
    await eventually(() => original.snapshot().state !== "releasing", "task");
  });
  assert.equal((await original.start()).kind, "started");

  const stopping = original.stop();
  await enteredRmdir.promise;
  assert.equal(original.snapshot().state, "releasing");
  assert.deepEqual(await original.start(), {
    kind: "refused",
    state: "releasing",
    diagnostic: "busy",
  });
  assert.deepEqual(await original.toggle(), {
    kind: "refused",
    state: "releasing",
    diagnostic: "busy",
  });
  assert.deepEqual(await original.setMuted(true), {
    kind: "refused",
    state: "releasing",
    diagnostic: "busy",
  });
  assert.deepEqual(await original.selectVoice("cedar"), {
    kind: "refused",
    state: "releasing",
    diagnostic: "busy",
  });
  assert.equal(coordination.ownership.kind, "pending");
  if (coordination.ownership.kind === "pending")
    assert.equal(typeof coordination.ownership.attemptId, "string");
  clock.advance(5_000);
  assert.deepEqual(await stopping, { status: "release-pending" });
  assert.equal(original.snapshot().state, "releasing");

  const replacement = createLiveLifecycle(options);
  assert.equal(replacement.snapshot().state, "releasing");
  assert.deepEqual(await replacement.stop(), { status: "release-pending" });
  assert.deepEqual(await replacement.interrupt("pooling"), {
    status: "release-pending",
  });
  assert.equal(replacement.snapshot().state, "releasing");
  assert.equal((await stat(fixture.lock)).isDirectory(), true);

  allowRmdir.resolve();
  await rmdirCompleted.promise;
  await eventually(() => original.snapshot().state === "off");
  assert.equal(replacement.snapshot().state, "off");
  assert.deepEqual(coordination.ownership, { kind: "none" });
  assert.deepEqual(await replacement.start(), {
    kind: "refused",
    state: "off",
    diagnostic: "denied",
  });
});

test("a stale release failure cannot relabel another pending coordination owner", async (t) => {
  const fixture = await fixtureHome(t);
  const baseFileSystem = createNodeOwnershipFileSystem();
  const rmdirEntered = deferred<void>();
  const rejectRmdir = deferred<void>();
  const rmdirFailureSettled = deferred<void>();
  const clock = new TestClock();
  const coordination = createIsolatedLiveCoordination();
  const cleanupCalls = {
    capture: 0,
    session: 0,
    connection: 0,
  };
  const capture = createFakeCapture({
    async stop() {
      cleanupCalls.capture += 1;
    },
  });
  const connection = createFakeConnection(
    {
      async closeSession() {
        cleanupCalls.session += 1;
      },
      async close() {
        cleanupCalls.connection += 1;
      },
    },
    capture,
  );
  const lifecycle = createLiveLifecycle({
    admission: admitted,
    consent: consented,
    home: certifiedHome(fixture.home),
    resources: inertResources(connection),
    ownershipFileSystem: {
      ...baseFileSystem,
      rmdir() {
        rmdirEntered.resolve();
        const failure = rejectRmdir.promise.then(() => {
          throw new Error("old release failed late");
        });
        void failure.then(undefined, () => {
          rmdirFailureSettled.resolve();
        });
        return failure;
      },
    },
    clock,
    coordination,
  });
  fixture.beforeRemoval(async () => {
    rejectRmdir.resolve();
    await withChildWatchdog(
      rmdirFailureSettled.promise,
      () => "stale release filesystem continuation did not settle",
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(cleanupCalls, {
      capture: 1,
      session: 1,
      connection: 1,
    });
    assertEmptyLock(await lockInventory(fixture.lock));
    assert.equal(clock.timers.size, 0);
    assert.equal(activeChildWatchdogCount(), 0);
    assert.equal(lifecycle.snapshot().state, "releasing");
    assert.deepEqual(coordination.ownership, {
      kind: "pending",
      attemptId: "new-release",
    });
  });
  assert.equal((await lifecycle.start()).kind, "started");
  const stopping = lifecycle.stop();
  await rmdirEntered.promise;
  assert.equal(coordination.ownership.kind, "pending");
  coordination.ownership = { kind: "pending", attemptId: "new-release" };
  rejectRmdir.resolve();
  await rmdirFailureSettled.promise;
  await new Promise<void>((resolve) => setImmediate(resolve));
  await eventually(
    () =>
      coordination.ownership.kind === "pending" &&
      coordination.ownership.attemptId === "new-release",
  );
  assert.equal(lifecycle.snapshot().state, "releasing");
  assert.deepEqual(coordination.ownership, {
    kind: "pending",
    attemptId: "new-release",
  });
  clock.advance(5_000);
  assert.deepEqual(await stopping, { status: "release-pending" });

  const replacement = createLiveLifecycle({
    coordination,
  });
  assert.equal(replacement.snapshot().state, "releasing");
  assert.deepEqual(await replacement.stop(), { status: "release-pending" });
});

test("a completed rmdir with a parked callback cannot touch a replacement child owner", async (t) => {
  const fixture = await fixtureHome(t);
  const baseFileSystem = createNodeOwnershipFileSystem();
  const removalCompleted = deferred<void>();
  const allowCallback = deferred<void>();
  const clock = new TestClock();
  const fileSystem = {
    ...baseFileSystem,
    async rmdir(target: string) {
      await baseFileSystem.rmdir(target);
      removalCompleted.resolve();
      await allowCallback.promise;
    },
  };
  const lifecycle = fixture.createLifecycle({
    ownershipFileSystem: fileSystem,
    coordination: createIsolatedLiveCoordination(),
    clock,
  });
  fixture.beforeRemoval(async () => {
    allowCallback.resolve();
    await eventually(() => lifecycle.snapshot().state !== "releasing", "task");
    await lifecycle.stop();
  });
  assert.equal((await lifecycle.start()).kind, "started");
  const stopping = lifecycle.stop();
  await removalCompleted.promise;
  await assert.rejects(stat(fixture.lock), { code: "ENOENT" });
  clock.advance(5_000);
  assert.deepEqual(await stopping, { status: "release-pending" });

  const replacement = spawnContender(fixture, fixture.agentB);
  assert.deepEqual(await replacement.next(), {
    event: "started",
    result: { kind: "started", state: "active" },
    snapshot: { state: "active", muted: false, voice: "marin" },
  });
  assert.equal((await stat(fixture.lock)).isDirectory(), true);
  assert.deepEqual(await lifecycle.start(), {
    kind: "refused",
    state: "releasing",
    diagnostic: "busy",
  });

  allowCallback.resolve();
  await eventually(() => lifecycle.snapshot().state === "off");
  assert.equal((await stat(fixture.lock)).isDirectory(), true);
  const stopped = replacement.next();
  replacement.process.stdin.write("stop\n");
  assert.deepEqual(((await stopped) as { result?: unknown }).result, {
    status: "off",
  });
  replacement.process.stdin.end();
  assert.deepEqual(await replacement.waitExited(), {
    code: 0,
    signal: null,
  });
});

test("release-time identity and content drift never removes a foreign owner", async (t) => {
  for (const drift of [
    "owner-token",
    "owner-bytes",
    "owner-file-identity",
    "state-parent-identity",
    "lock-directory-identity",
    "unexpected-entry",
  ] as const) {
    await t.test(drift, async (t) => {
      const fixture = await fixtureHome(t);
      const baseFileSystem = createNodeOwnershipFileSystem();
      let unlinkCalls = 0;
      let rmdirCalls = 0;
      const lifecycle = fixture.createLifecycle({
        ownershipFileSystem: {
          ...baseFileSystem,
          async unlink(target) {
            unlinkCalls += 1;
            await baseFileSystem.unlink(target);
          },
          async rmdir(target) {
            rmdirCalls += 1;
            await baseFileSystem.rmdir(target);
          },
        },
        coordination: createIsolatedLiveCoordination(),
      });
      assert.equal((await lifecycle.start()).kind, "started");
      const ownerPath = path.join(fixture.lock, "owner.json");
      const originalBytes = await readFile(ownerPath, "utf8");
      let retainedOriginal: string | undefined;

      if (drift === "owner-token") {
        const record = JSON.parse(originalBytes) as Record<string, unknown>;
        record.ownerToken = "foreign-owner-token";
        await writeFile(ownerPath, `${JSON.stringify(record)}\n`);
      } else if (drift === "owner-bytes") {
        await writeFile(ownerPath, `${originalBytes} `);
      } else if (drift === "owner-file-identity") {
        retainedOriginal = path.join(fixture.root, "original-owner.json");
        await rename(ownerPath, retainedOriginal);
        await writeFile(ownerPath, originalBytes, { mode: 0o600 });
      } else if (drift === "state-parent-identity") {
        retainedOriginal = path.join(fixture.root, "original-state-parent");
        await rename(fixture.stateParent, retainedOriginal);
        await mkdir(fixture.stateParent, { mode: 0o700 });
        await mkdir(fixture.lock, { mode: 0o700 });
        await writeFile(path.join(fixture.lock, "foreign"), "keep\n", {
          mode: 0o600,
        });
      } else if (drift === "lock-directory-identity") {
        retainedOriginal = path.join(fixture.root, "original-lock");
        await rename(fixture.lock, retainedOriginal);
        await mkdir(fixture.lock, { mode: 0o700 });
        await writeFile(ownerPath, originalBytes, { mode: 0o600 });
      } else {
        await writeFile(path.join(fixture.lock, "unexpected"), "keep\n", {
          mode: 0o600,
        });
      }

      const foreignInventory = await lockInventory(fixture.lock);
      const retainedInventory = retainedOriginal
        ? await lockInventory(
            drift === "state-parent-identity"
              ? path.join(retainedOriginal, "active.lock")
              : retainedOriginal,
          )
        : undefined;
      assert.deepEqual(await lifecycle.stop(), { status: "blocked" });
      assert.equal(lifecycle.snapshot().state, "blocked");
      assert.equal(unlinkCalls, 0);
      assert.equal(rmdirCalls, 0);
      assert.deepEqual(await lockInventory(fixture.lock), foreignInventory);
      if (retainedOriginal)
        assert.deepEqual(
          await lockInventory(
            drift === "state-parent-identity"
              ? path.join(retainedOriginal, "active.lock")
              : retainedOriginal,
          ),
          retainedInventory,
        );
      await assertChildBusy(fixture);
    });
  }
});

test("settled release validation and partial-removal faults block without another delete", async (t) => {
  await t.test("unexpected directory entry", async (t) => {
    const fixture = await fixtureHome(t);
    const lifecycle = fixture.createLifecycle({
      coordination: createIsolatedLiveCoordination(),
    });
    assert.equal((await lifecycle.start()).kind, "started");
    await writeFile(path.join(fixture.lock, "unexpected"), "keep\n", {
      mode: 0o600,
    });
    assert.deepEqual(await lifecycle.stop(), { status: "blocked" });
    assert.deepEqual((await readdir(fixture.lock)).sort(), [
      "owner.json",
      "unexpected",
    ]);
  });

  await t.test("rmdir refusal after owner unlink", async (t) => {
    const fixture = await fixtureHome(t);
    const baseFileSystem = createNodeOwnershipFileSystem();
    let rmdirCalls = 0;
    const lifecycle = fixture.createLifecycle({
      ownershipFileSystem: {
        ...baseFileSystem,
        async rmdir() {
          rmdirCalls += 1;
          throw new Error("injected rmdir refusal");
        },
      },
      coordination: createIsolatedLiveCoordination(),
    });
    assert.equal((await lifecycle.start()).kind, "started");
    assert.deepEqual(await lifecycle.stop(), { status: "blocked" });
    assert.equal(rmdirCalls, 1);
    assert.deepEqual(await readdir(fixture.lock), []);
    assert.deepEqual(await lifecycle.stop(), { status: "blocked" });
    assert.equal(rmdirCalls, 1);

    const contender = spawnContender(fixture, fixture.agentA);
    const line = await contender.next();
    assert.ok(line && typeof line === "object");
    assert.deepEqual((line as { result?: unknown }).result, {
      kind: "refused",
      state: "off",
      diagnostic: "busy",
    });
    assert.deepEqual(await contender.waitExited(), {
      code: 0,
      signal: null,
    });
  });
});

test("the default authority asks the OS account home first and never follows a divergent HOME in this test", async (t) => {
  const fixture = await fixtureHome(t);
  const accountHome = userInfo().homedir;
  assert.notEqual(fixture.home, accountHome);
  const accesses: Array<{ operation: string; target: string }> = [];
  const refuse = (operation: string, target: string): never => {
    accesses.push({ operation, target });
    throw new Error("read-only authority probe refuses filesystem access");
  };
  const fileSystem: OwnershipFileSystem = {
    async realpath(target) {
      return refuse("realpath", target);
    },
    async inspect(target) {
      return refuse("inspect", target);
    },
    async mkdirExclusive(target) {
      refuse("mkdirExclusive", target);
    },
    async openOwner(target) {
      return refuse("openOwner", target);
    },
    async read(target) {
      return refuse("read", target);
    },
    async entries(target) {
      return refuse("entries", target);
    },
    async unlink(target) {
      refuse("unlink", target);
    },
    async rmdir(target) {
      refuse("rmdir", target);
    },
  };
  const originalHome = process.env.HOME;
  process.env.HOME = fixture.home;
  try {
    const lifecycle = createLiveLifecycle({
      admission: admitted,
      consent: consented,
      resources: inertResources(),
      ownershipFileSystem: fileSystem,
      coordination: createIsolatedLiveCoordination(),
    });
    assert.deepEqual(await lifecycle.start(), {
      kind: "refused",
      state: "off",
      diagnostic: "denied",
    });
  } finally {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
  }
  assert.deepEqual(accesses, [{ operation: "realpath", target: accountHome }]);
  await assert.rejects(stat(fixture.lock), { code: "ENOENT" });
});

test("HOME absence and aliases use the injected account home, while divergence and bad certification refuse", async (t) => {
  const fixture = await fixtureHome(t);
  const alias = path.join(fixture.root, "home-alias");
  await symlink(fixture.home, alias);
  for (const environmentHome of [undefined, alias]) {
    const lifecycle = fixture.createLifecycle({
      home: {
        ...certifiedHome(fixture.home),
        environmentHome: () => environmentHome,
      },
      coordination: createIsolatedLiveCoordination(),
    });
    assert.equal((await lifecycle.start()).kind, "started");
    assert.deepEqual(await lifecycle.stop(), { status: "off" });
  }

  let resourceCalls = 0;
  for (const home of [
    {
      accountHome: () => fixture.home,
      environmentHome: () => fixture.root,
      certify: certifiedHome(fixture.home).certify,
    },
    {
      accountHome: () => fixture.home,
      environmentHome: () => path.join(fixture.root, "missing-home"),
      certify: certifiedHome(fixture.home).certify,
    },
    {
      accountHome: () => fixture.home,
      environmentHome: () => fixture.home,
      certify: async (_observation: HomeCertificationObservation) => ({
        certified: false as const,
      }),
    },
    {
      accountHome: () => fixture.home,
      environmentHome: () => fixture.home,
      certify: async (observation: HomeCertificationObservation) => ({
        certified: true as const,
        ...observation,
        canonicalHome: fixture.root,
      }),
    },
  ]) {
    const lifecycle = fixture.createLifecycle({
      home,
      resources: {
        ...inertResources(),
        connect(options) {
          resourceCalls += 1;
          return inertResources().connect(options);
        },
      },
      coordination: createIsolatedLiveCoordination(),
    });
    assert.deepEqual(await lifecycle.start(), {
      kind: "refused",
      state: "off",
      diagnostic: "denied",
    });
  }
  assert.equal(resourceCalls, 0);
  await assert.rejects(stat(fixture.lock), { code: "ENOENT" });
});

test("an unowned intermediate state directory refuses before lock creation", async (t) => {
  const fixture = await fixtureHome(t);
  const baseFileSystem = createNodeOwnershipFileSystem();
  const localDirectory = path.join(fixture.home, ".local");
  let mkdirCalls = 0;
  const lifecycle = fixture.createLifecycle({
    ownershipFileSystem: {
      ...baseFileSystem,
      async inspect(target) {
        const identity = await baseFileSystem.inspect(target);
        return target === localDirectory
          ? { ...identity, uid: identity.uid + 1 }
          : identity;
      },
      async mkdirExclusive(target, mode) {
        mkdirCalls += 1;
        await baseFileSystem.mkdirExclusive(target, mode);
      },
    },
    coordination: createIsolatedLiveCoordination(),
  });

  assert.deepEqual(await lifecycle.start(), {
    kind: "refused",
    state: "off",
    diagnostic: "denied",
  });
  assert.equal(mkdirCalls, 0);
  await assert.rejects(stat(fixture.lock), { code: "ENOENT" });
});

test("owner reads are no-follow and bounded before bytes can be trusted", async (t) => {
  const fixture = await fixtureHome(t);
  const fileSystem = createNodeOwnershipFileSystem();
  const outside = path.join(fixture.root, "outside-owner");
  const linked = path.join(fixture.root, "linked-owner");
  await writeFile(outside, "outside\n", { mode: 0o600 });
  await symlink(outside, linked);
  await assert.rejects(fileSystem.read(linked, 4_096));

  const oversized = path.join(fixture.root, "oversized-owner");
  await writeFile(oversized, Buffer.alloc(4_097, 1), { mode: 0o600 });
  await assert.rejects(fileSystem.read(oversized, 4_096));
});

test("special permission bits on a newly-created lock are rejected", async (t) => {
  const fixture = await fixtureHome(t);
  const baseFileSystem = createNodeOwnershipFileSystem();
  const lifecycle = fixture.createLifecycle({
    ownershipFileSystem: {
      ...baseFileSystem,
      async mkdirExclusive(target, mode) {
        await baseFileSystem.mkdirExclusive(target, mode);
        await chmod(target, 0o4700);
      },
    },
    coordination: createIsolatedLiveCoordination(),
  });

  assert.equal((await lifecycle.start()).kind, "cancelled");
  assert.deepEqual(lifecycle.snapshot(), {
    state: "blocked",
    muted: false,
    voice: "marin",
    lastFailure: "cleanup-blocked",
  });
  assert.equal((await lstat(fixture.lock)).mode & 0o7000, 0o4000);
});

test("home or state-parent identity drift after certification refuses before mkdir", async (t) => {
  for (const drift of ["home-mode", "mode", "redirect"] as const) {
    await t.test(drift, async (t) => {
      const fixture = await fixtureHome(t);
      let mkdirCalls = 0;
      const baseFileSystem = createNodeOwnershipFileSystem();
      const lifecycle = fixture.createLifecycle({
        home: {
          accountHome: () => fixture.home,
          environmentHome: () => fixture.home,
          async certify(observation) {
            if (drift === "home-mode") {
              await chmod(
                fixture.home,
                observation.homeIdentity.mode === 0o700 ? 0o755 : 0o700,
              );
            } else if (drift === "mode") {
              await chmod(fixture.stateParent, 0o755);
            } else {
              const moved = path.join(fixture.root, "moved-state-parent");
              await rename(fixture.stateParent, moved);
              await symlink(moved, fixture.stateParent);
            }
            return { certified: true, ...observation };
          },
        },
        ownershipFileSystem: {
          ...baseFileSystem,
          async mkdirExclusive(target, mode) {
            mkdirCalls += 1;
            await baseFileSystem.mkdirExclusive(target, mode);
          },
        },
        coordination: createIsolatedLiveCoordination(),
      });
      assert.deepEqual(await lifecycle.start(), {
        kind: "refused",
        state: "off",
        diagnostic: "denied",
      });
      assert.equal(mkdirCalls, 0);
    });
  }
});
