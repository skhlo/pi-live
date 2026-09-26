import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  DefaultResourceLoader,
  SettingsManager,
  type ExtensionUIContext,
  type InlineExtension,
  type SourceInfo,
} from "@earendil-works/pi-coding-agent";

import piLiveExtension from "../index.ts";
import { PINNED_BETTER_OPENAI_PACKAGE_SOURCES } from "../src/live.ts";
import { deferred, type Deferred } from "./test-support/live-fixture.ts";
import {
  betterOpenAIFactory,
  createSdkFixture,
  emptyUi,
  lifecycleEventRecorder,
  packageSourceInfo,
  pathExists,
  prepareMovement,
  startActive,
  waitUntil,
} from "./test-support/live-sdk.ts";

test("AgentSessionRuntime.dispose fences voice on quit without calling ctx.abort", async (t) => {
  const events = { starts: [] as string[], shutdowns: [] as string[] };
  const fixture = await createSdkFixture(t, {
    after: [lifecycleEventRecorder(events)],
  });
  const binding = fixture.current();
  await startActive(binding);
  fixture.emitSample();
  assert.equal(fixture.sentSamples, 1);

  const disposal = fixture.disposeRuntime();

  assert.notEqual(binding.lifecycle.snapshot().state, "active");
  fixture.emitSample();
  assert.equal(fixture.sentSamples, 1);
  await disposal;
  assert.equal(binding.lifecycle.snapshot().state, "off");
  assert.equal(await pathExists(fixture.lockPath), false);
  assert.equal(fixture.captureStops, 1);
  assert.equal(fixture.closeCalls, 1);
  assert.equal(fixture.closeSessionCalls, 1);
  assert.equal(fixture.abortCalls, 0);
  assert.deepEqual(events.shutdowns, ["quit"]);
});

test("real reload projects asynchronous release until a completed rmdir callback arrives", async (t) => {
  const callbackGate = deferred<void>();
  const rmdirRemoved = deferred<void>();
  const events = { starts: [] as string[], shutdowns: [] as string[] };
  const fixture = await createSdkFixture(t, {
    after: [lifecycleEventRecorder(events)],
    delayRmdirCallback: callbackGate,
    onRmdirRemoved: () => rmdirRemoved.resolve(),
  });
  const oldBinding = fixture.current();
  await startActive(oldBinding);

  const reload = fixture.runtime.session.reload();

  assert.notEqual(oldBinding.lifecycle.snapshot().state, "active");
  await rmdirRemoved.promise;
  assert.equal(oldBinding.lifecycle.snapshot().state, "releasing");
  assert.equal(await pathExists(fixture.lockPath), false);
  assert.deepEqual(events.shutdowns, []);
  assert.equal(fixture.bindings.length, 1);
  fixture.clock.advance(5_000);
  await reload;

  const replacement = fixture.current();
  assert.notEqual(replacement, oldBinding);
  assert.equal(replacement.lifecycle.snapshot().state, "releasing");
  assert.deepEqual(await replacement.lifecycle.start(), {
    kind: "refused",
    state: "releasing",
    diagnostic: "busy",
  });

  callbackGate.resolve();
  await waitUntil(
    () => replacement.lifecycle.snapshot().state === "off",
    "replacement to observe release settlement",
  );
  await startActive(replacement);
  assert.deepEqual(await replacement.lifecycle.stop(), { status: "off" });
  assert.equal(fixture.abortCalls, 0);
  assert.deepEqual(events.shutdowns, ["reload"]);
  assert.deepEqual(events.starts, ["startup", "reload"]);
});

test("shutdown retires held bindings after actual reload and replacement", async (t) => {
  for (const operation of ["reload", "replacement"] as const) {
    await t.test(operation, async (t) => {
      const fixture = await createSdkFixture(t);
      const oldBinding = fixture.current();

      if (operation === "reload") await fixture.runtime.session.reload();
      else
        assert.deepEqual(await fixture.runtime.newSession(), {
          cancelled: false,
        });

      const replacement = fixture.current();
      assert.notEqual(replacement, oldBinding);
      const acquisitionsBefore = fixture.acquisitionCalls;
      assert.deepEqual(await oldBinding.lifecycle.start(), {
        kind: "refused",
        state: "off",
        diagnostic: "denied",
      });
      assert.equal(fixture.acquisitionCalls, acquisitionsBefore);
      assert.equal(await pathExists(fixture.lockPath), false);

      await startActive(replacement);
      assert.deepEqual(await replacement.lifecycle.stop(), { status: "off" });
    });
  }
});

test("real reload projects blocked while an old connection close remains pending", async (t) => {
  const closeGate = deferred<void>();
  const events = { starts: [] as string[], shutdowns: [] as string[] };
  const fixture = await createSdkFixture(t, {
    after: [lifecycleEventRecorder(events)],
    closeGate,
  });
  const oldBinding = fixture.current();
  await startActive(oldBinding);

  const reload = fixture.runtime.session.reload();

  assert.notEqual(oldBinding.lifecycle.snapshot().state, "active");
  await waitUntil(() => fixture.closeCalls === 1, "connection close to begin");
  assert.equal(oldBinding.lifecycle.snapshot().state, "stopping");
  fixture.clock.advance(5_000);
  await reload;

  const replacement = fixture.current();
  assert.equal(replacement.lifecycle.snapshot().state, "blocked");
  assert.equal(await pathExists(fixture.lockPath), true);
  assert.deepEqual(await replacement.lifecycle.start(), {
    kind: "refused",
    state: "blocked",
    diagnostic: "cleanup-blocked",
  });
  closeGate.resolve();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(replacement.lifecycle.snapshot().state, "blocked");
  assert.equal(await pathExists(fixture.lockPath), true);
  assert.equal(fixture.abortCalls, 0);
  assert.deepEqual(events.shutdowns, ["reload"]);
  assert.deepEqual(events.starts, ["startup", "reload"]);
});

test("an earlier shutdown handler can delay delivery, but binding entry fences synchronously", async (t) => {
  const earlierHandler = deferred<void>();
  let shutdownDeliveries = 0;
  const delayFactory: InlineExtension = {
    name: "prior-shutdown-handler",
    factory(pi) {
      pi.on("session_shutdown", async () => {
        shutdownDeliveries += 1;
        if (shutdownDeliveries === 1) await earlierHandler.promise;
      });
    },
  };
  const fixture = await createSdkFixture(t, { before: [delayFactory] });
  const oldBinding = fixture.current();
  await startActive(oldBinding);

  const reload = fixture.runtime.session.reload();
  fixture.emitSample();

  assert.equal(oldBinding.lifecycle.snapshot().state, "active");
  assert.equal(fixture.sentSamples, 1);
  earlierHandler.resolve();
  await waitUntil(
    () => oldBinding.lifecycle.snapshot().state !== "active",
    "Pi Live shutdown handler entry",
  );
  fixture.emitSample();
  assert.equal(fixture.sentSamples, 1);
  await reload;
  assert.equal(fixture.abortCalls, 0);
});

test("an external dialog nested during own consent leaves the outer report open and refuses before acquisition", async (t) => {
  const confirmations: Array<{
    title: string;
    result: Deferred<boolean>;
  }> = [];
  const promptEvents = { starts: 0, ends: 0 };
  let externalResult: boolean | undefined;
  const dialogFactory: InlineExtension = {
    name: "nested-external-dialog",
    factory(pi) {
      pi.registerCommand("nested-external-dialog", {
        description: "Open a nested external fixture dialog",
        handler: async (_args, ctx) => {
          externalResult = await ctx.ui.confirm(
            "External nested dialog",
            "Keep this open after consent returns.",
          );
        },
      });
    },
  };
  const promptRecorder: InlineExtension = {
    name: "prompt-event-recorder",
    factory(pi) {
      pi.on("ui_prompt_start", () => {
        promptEvents.starts += 1;
      });
      pi.on("ui_prompt_end", () => {
        promptEvents.ends += 1;
      });
    },
  };
  const fixture = await createSdkFixture(t, {
    after: [dialogFactory, promptRecorder],
    ui: emptyUi((title) => {
      const result = deferred<boolean>();
      confirmations.push({ title, result });
      return result.promise;
    }),
    consent: {
      request: ({ openConfirm }) =>
        openConfirm("Pi Live consent", "Own fixture consent"),
    },
  });
  const binding = fixture.current();

  const start = binding.lifecycle.start();
  await waitUntil(() => confirmations.length === 1, "own consent dialog");
  await waitUntil(() => promptEvents.starts === 1, "outer prompt start");
  const externalPrompt = fixture.runtime.session.prompt(
    "/nested-external-dialog",
  );
  await waitUntil(() => confirmations.length === 2, "nested external dialog");

  confirmations[0]?.result.resolve(true);
  assert.deepEqual(await start, {
    kind: "refused",
    state: "off",
    diagnostic: "busy",
  });
  assert.deepEqual(
    confirmations.map(({ title }) => title),
    ["Pi Live consent", "External nested dialog"],
  );
  assert.deepEqual(promptEvents, { starts: 1, ends: 0 });
  assert.equal(fixture.acquisitionCalls, 0);
  assert.equal(await pathExists(fixture.lockPath), false);

  confirmations[1]?.result.resolve(false);
  await externalPrompt;
  await waitUntil(() => promptEvents.ends === 1, "outer prompt end");
  assert.equal(externalResult, false);
  assert.equal(binding.lifecycle.snapshot().state, "off");
  assert.equal(fixture.abortCalls, 0);
});

test("an external dialog reported before own confirm invocation refuses without opening consent", async (t) => {
  const confirmations: Deferred<boolean>[] = [];
  let externalResult: boolean | undefined;
  const dialogFactory: InlineExtension = {
    name: "before-consent-dialog",
    factory(pi) {
      pi.registerCommand("before-consent-dialog", {
        description: "Open an external fixture dialog before consent",
        handler: async (_args, ctx) => {
          externalResult = await ctx.ui.confirm(
            "External before consent",
            "Keep this open.",
          );
        },
      });
    },
  };
  const fixture = await createSdkFixture(t, {
    after: [dialogFactory],
    ui: emptyUi(() => {
      const confirmation = deferred<boolean>();
      confirmations.push(confirmation);
      return confirmation.promise;
    }),
  });

  const externalPrompt = fixture.runtime.session.prompt(
    "/before-consent-dialog",
  );
  await waitUntil(() => confirmations.length === 1, "external dialog");
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.deepEqual(await fixture.current().lifecycle.start(), {
    kind: "refused",
    state: "off",
    diagnostic: "busy",
  });
  assert.equal(confirmations.length, 1);
  assert.equal(fixture.acquisitionCalls, 0);

  confirmations[0]?.resolve(true);
  await externalPrompt;
  assert.equal(externalResult, true);
});

test("ordinary own confirm is admitted through the narrow openConfirm capability", async (t) => {
  const confirmation = deferred<boolean>();
  let ownResult: boolean | undefined;
  const fixture = await createSdkFixture(t, {
    ui: emptyUi(() => confirmation.promise),
    consent: {
      request: async ({ openConfirm }) => {
        ownResult = await openConfirm(
          "Pi Live consent",
          "Ordinary own consent",
        );
        return ownResult;
      },
    },
  });

  const start = fixture.current().lifecycle.start();
  await waitUntil(
    () => fixture.current().lifecycle.snapshot().state === "consent",
    "consent state",
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
  confirmation.resolve(true);

  assert.deepEqual(await start, { kind: "started", state: "active" });
  assert.equal(ownResult, true);
  assert.equal(fixture.acquisitionCalls, 1);
  assert.deepEqual(await fixture.current().lifecycle.stop(), { status: "off" });
});

test("a delayed own prompt marker is ambiguous and fails closed without changing the dialog result", async (t) => {
  const markerGate = deferred<void>();
  const markerEntered = deferred<void>();
  const confirmation = deferred<boolean>();
  let ownResult: boolean | undefined;
  const delayFactory: InlineExtension = {
    name: "delayed-prompt-marker",
    factory(pi) {
      pi.on("ui_prompt_start", async () => {
        markerEntered.resolve();
        await markerGate.promise;
      });
    },
  };
  const fixture = await createSdkFixture(t, {
    before: [delayFactory],
    ui: emptyUi(() => confirmation.promise),
    consent: {
      request: async ({ openConfirm }) => {
        ownResult = await openConfirm("Pi Live consent", "Delayed own marker");
        return ownResult;
      },
    },
  });

  const start = fixture.current().lifecycle.start();
  await markerEntered.promise;
  await new Promise<void>((resolve) => setImmediate(resolve));
  markerGate.resolve();
  await waitUntil(
    () => fixture.current().lifecycle.snapshot().state !== "consent",
    "ambiguous prompt fencing",
  );
  confirmation.resolve(true);

  assert.deepEqual(await start, { kind: "cancelled", state: "off" });
  assert.equal(ownResult, true);
  assert.equal(fixture.acquisitionCalls, 0);
  assert.equal(await pathExists(fixture.lockPath), false);
});

test("a same-title external dialog after activation fences voice and preserves its result", async (t) => {
  const confirmations: Deferred<boolean>[] = [];
  let externalResult: boolean | undefined;
  const dialogFactory: InlineExtension = {
    name: "same-title-dialog",
    factory(pi) {
      pi.registerCommand("same-title-dialog", {
        description: "Open a non-live fixture dialog",
        handler: async (_args, ctx) => {
          externalResult = await ctx.ui.confirm(
            "Pi Live consent",
            "External fixture dialog",
          );
        },
      });
    },
  };
  const fixture = await createSdkFixture(t, {
    after: [dialogFactory],
    ui: emptyUi(() => {
      const confirmation = deferred<boolean>();
      confirmations.push(confirmation);
      return confirmation.promise;
    }),
  });
  const binding = fixture.current();

  const start = binding.lifecycle.start();
  await waitUntil(() => confirmations.length === 1, "own consent prompt");
  confirmations[0]?.resolve(true);
  assert.deepEqual(await start, { kind: "started", state: "active" });

  const externalPrompt = fixture.runtime.session.prompt("/same-title-dialog");
  await waitUntil(
    () => confirmations.length === 2,
    "same-title external prompt",
  );
  await waitUntil(
    () => binding.lifecycle.snapshot().state !== "active",
    "same-title external prompt fencing",
  );
  confirmations[1]?.resolve(false);
  await externalPrompt;
  await waitUntil(
    () => binding.lifecycle.snapshot().state === "off",
    "same-title dialog-triggered stop",
  );
  assert.equal(externalResult, false);
  assert.equal(fixture.abortCalls, 0);
});

test("validated pooling shape is never invoked and latches across reload", async (t) => {
  let emit!: (channel: string, payload: unknown) => void;
  const emitterFactory: InlineExtension = {
    name: "pool-emitter",
    factory(pi) {
      emit = (channel, payload) => pi.events.emit(channel, payload);
    },
  };
  const fixture = await createSdkFixture(t, { before: [emitterFactory] });
  const binding = fixture.current();
  await startActive(binding);

  for (const malformed of [
    undefined,
    null,
    {},
    { getActiveAccount() {}, resolveActiveAccountAuth() {} },
    {
      getActiveAccount() {},
      resolveActiveAccountAuth() {},
      onActiveAccountChanged: "not-a-function",
    },
  ])
    emit("pi-multiprovider:service", malformed);
  assert.equal(binding.lifecycle.snapshot().state, "active");

  let methodCalls = 0;
  emit("pi-multiprovider:service", {
    getActiveAccount() {
      methodCalls += 1;
    },
    resolveActiveAccountAuth() {
      methodCalls += 1;
    },
    onActiveAccountChanged() {
      methodCalls += 1;
    },
  });

  assert.notEqual(binding.lifecycle.snapshot().state, "active");
  await waitUntil(
    () => binding.lifecycle.snapshot().state === "off",
    "pooling stop",
  );
  assert.equal(methodCalls, 0);
  await fixture.runtime.session.reload();
  const replacement = fixture.current();
  assert.deepEqual(await replacement.lifecycle.start(), {
    kind: "refused",
    state: "off",
    diagnostic: "denied",
  });
  assert.equal(methodCalls, 0);
  assert.equal(fixture.abortCalls, 0);
});

test("a synchronous pooling announcement inside consent fences startup", async (t) => {
  let emit!: (channel: string, payload: unknown) => void;
  const service = {
    getActiveAccount() {},
    resolveActiveAccountAuth() {},
    onActiveAccountChanged() {},
  };
  const emitterFactory: InlineExtension = {
    name: "startup-pool-emitter",
    factory(pi) {
      emit = (channel, payload) => pi.events.emit(channel, payload);
    },
  };
  const fixture = await createSdkFixture(t, {
    before: [emitterFactory],
    consent: {
      request: ({ openConfirm }) => {
        emit("pi-multiprovider:service", service);
        return openConfirm("Pi Live consent", "Fenced fixture consent");
      },
    },
  });

  assert.deepEqual(await fixture.current().lifecycle.start(), {
    kind: "cancelled",
    state: "off",
  });
  assert.equal(await pathExists(fixture.lockPath), false);
  assert.deepEqual(await fixture.current().lifecycle.start(), {
    kind: "refused",
    state: "off",
    diagnostic: "denied",
  });
});

test("pooling and a reported dialog cannot recast projected release across reload", async (t) => {
  const callbackGate = deferred<void>();
  const rmdirRemoved = deferred<void>();
  const confirmation = deferred<boolean>();
  let emit!: (channel: string, payload: unknown) => void;
  let confirmCalls = 0;
  let underlyingConfirmCalls = 0;
  let serviceCalls = 0;
  const service = {
    getActiveAccount() {
      serviceCalls += 1;
    },
    resolveActiveAccountAuth() {
      serviceCalls += 1;
    },
    onActiveAccountChanged() {
      serviceCalls += 1;
    },
  };
  const emitterFactory: InlineExtension = {
    name: "pending-pool-emitter",
    factory(pi) {
      emit = (channel, payload) => pi.events.emit(channel, payload);
    },
  };
  const dialogFactory: InlineExtension = {
    name: "pending-release-dialog",
    factory(pi) {
      pi.registerCommand("pending-release-dialog", {
        description: "Open a dialog while release is pending",
        handler: async (_args, ctx) => {
          await ctx.ui.confirm("External while releasing", "Fixture dialog");
        },
      });
    },
  };
  const fixture = await createSdkFixture(t, {
    before: [emitterFactory],
    after: [dialogFactory],
    ui: emptyUi(() => {
      underlyingConfirmCalls += 1;
      if (underlyingConfirmCalls === 1) return Promise.resolve(true);
      confirmCalls += 1;
      return confirmation.promise;
    }),
    delayRmdirCallback: callbackGate,
    onRmdirRemoved: () => rmdirRemoved.resolve(),
  });
  const oldBinding = fixture.current();
  await startActive(oldBinding);

  const reload = fixture.runtime.session.reload();
  await rmdirRemoved.promise;
  fixture.clock.advance(5_000);
  await reload;
  const replacement = fixture.current();
  assert.equal(replacement.lifecycle.snapshot().state, "releasing");

  const prompt = fixture.runtime.session.prompt("/pending-release-dialog");
  await waitUntil(() => confirmCalls === 1, "pending release dialog");
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(replacement.lifecycle.snapshot().state, "releasing");
  emit("pi-multiprovider:service", service);
  assert.equal(replacement.lifecycle.snapshot().state, "releasing");
  assert.equal(serviceCalls, 0);
  confirmation.resolve(false);
  await prompt;
  assert.equal(replacement.lifecycle.snapshot().state, "releasing");

  callbackGate.resolve();
  await waitUntil(
    () => replacement.lifecycle.snapshot().state === "off",
    "release after projected dialog and pooling",
  );
  assert.deepEqual(await replacement.lifecycle.start(), {
    kind: "refused",
    state: "off",
    diagnostic: "denied",
  });
  assert.equal(fixture.abortCalls, 0);
});

test("getCommands errors and malformed observations fail closed with the busy diagnostic", async (t) => {
  const cases: Array<[string, () => unknown]> = [
    [
      "throws",
      () => {
        throw new Error("fixture getCommands failure");
      },
    ],
    ["non-array", () => ({ source: "extension" })],
    ["malformed command", () => [null]],
  ];

  for (const [name, getCommandsOverride] of cases) {
    await t.test(name, async (t) => {
      const fixture = await createSdkFixture(t, { getCommandsOverride });
      assert.deepEqual(await fixture.current().lifecycle.start(), {
        kind: "refused",
        state: "off",
        diagnostic: "busy",
      });
      assert.equal(fixture.acquisitionCalls, 0);
      assert.equal(await pathExists(fixture.lockPath), false);
    });
  }
});

test("a configured pinned Better OpenAI source refuses without a live command", async (t) => {
  for (const source of PINNED_BETTER_OPENAI_PACKAGE_SOURCES) {
    await t.test(source, async (t) => {
      const fixture = await createSdkFixture(t, {
        configuredPackageSources: [source],
      });
      assert.deepEqual(await fixture.current().lifecycle.start(), {
        kind: "refused",
        state: "off",
        diagnostic: "busy",
      });
      assert.equal(fixture.acquisitionCalls, 0);
    });
  }
});

test("configured pinned source matching is independent of a wrong live description in both load orders", async (t) => {
  for (const source of PINNED_BETTER_OPENAI_PACKAGE_SOURCES) {
    for (const order of ["before", "after"] as const) {
      await t.test(`${source} ${order}`, async (t) => {
        const fixture = await createSdkFixture(t, {
          [order]: [betterOpenAIFactory("Wrong fixture description")],
          configuredPackageSources: [source],
          sourceInfoByInlineName: new Map([
            ["better-openai", packageSourceInfo(source)],
          ]),
        });
        assert.deepEqual(await fixture.current().lifecycle.start(), {
          kind: "refused",
          state: "off",
          diagnostic: "busy",
        });
        assert.equal(fixture.acquisitionCalls, 0);
      });
    }
  }
});

test("exact pinned Better OpenAI command provenance refuses both factory load orders", async (t) => {
  for (const source of PINNED_BETTER_OPENAI_PACKAGE_SOURCES) {
    for (const order of ["before", "after"] as const) {
      await t.test(`${source} ${order}`, async (t) => {
        const competitor = betterOpenAIFactory();
        const fixture = await createSdkFixture(t, {
          [order]: [competitor],
          sourceInfoByInlineName: new Map([
            ["better-openai", packageSourceInfo(source)],
          ]),
        });

        assert.deepEqual(await fixture.current().lifecycle.start(), {
          kind: "refused",
          state: "off",
          diagnostic: "busy",
        });
        assert.equal(await pathExists(fixture.lockPath), false);
      });
    }
  }
});

test("near-match and malformed Better OpenAI provenance is ignored", async (t) => {
  const cases: Array<[string, InlineExtension, SourceInfo]> = [
    [
      "unpinned npm source",
      betterOpenAIFactory(),
      packageSourceInfo("npm:@monotykamary/pi-better-openai@0.2.7"),
    ],
    [
      "wrong command description",
      betterOpenAIFactory("Similar but not pinned"),
      packageSourceInfo(PINNED_BETTER_OPENAI_PACKAGE_SOURCES[0]),
    ],
    [
      "top-level origin",
      betterOpenAIFactory(),
      {
        ...packageSourceInfo(PINNED_BETTER_OPENAI_PACKAGE_SOURCES[0]),
        origin: "top-level",
      },
    ],
    [
      "temporary scope",
      betterOpenAIFactory(),
      {
        ...packageSourceInfo(PINNED_BETTER_OPENAI_PACKAGE_SOURCES[0]),
        scope: "temporary",
      },
    ],
  ];

  for (const [name, competitor, sourceInfo] of cases) {
    await t.test(name, async (t) => {
      const fixture = await createSdkFixture(t, {
        before: [competitor],
        sourceInfoByInlineName: new Map([["better-openai", sourceInfo]]),
      });
      await startActive(fixture.current());
      assert.deepEqual(await fixture.current().lifecycle.stop(), {
        status: "off",
      });
    });
  }
});

test("real tree/new/resume/fork navigation cancels on release-pending and blocked", async (t) => {
  for (const kind of ["tree", "new", "resume", "fork"] as const) {
    for (const outcome of ["release-pending", "blocked"] as const) {
      await t.test(`${kind} ${outcome}`, async (t) => {
        const closeGate = outcome === "blocked" ? deferred<void>() : undefined;
        const rmdirGate =
          outcome === "release-pending" ? deferred<void>() : undefined;
        const events = { starts: [] as string[], shutdowns: [] as string[] };
        const fixture = await createSdkFixture(t, {
          before: [lifecycleEventRecorder(events)],
          closeGate,
          delayRmdirCallback: rmdirGate,
        });
        const movement = await prepareMovement(fixture, kind);
        const binding = fixture.current();
        await startActive(binding);

        const moving = movement.invoke();

        assert.notEqual(binding.lifecycle.snapshot().state, "active");
        if (outcome === "release-pending") {
          await waitUntil(
            () => binding.lifecycle.snapshot().state === "releasing",
            `${kind} to enter releasing`,
          );
        } else {
          await waitUntil(
            () => fixture.closeCalls === 1,
            `${kind} connection close to begin`,
          );
          assert.equal(binding.lifecycle.snapshot().state, "stopping");
        }
        fixture.clock.advance(5_000);
        assert.deepEqual(await moving, { cancelled: true });
        assert.equal(fixture.runtime.session, movement.oldSession);
        assert.equal(
          fixture.runtime.session.sessionManager.getLeafId(),
          movement.oldLeaf,
        );
        assert.equal(
          binding.lifecycle.snapshot().state,
          outcome === "release-pending" ? "releasing" : "blocked",
        );

        rmdirGate?.resolve();
        closeGate?.resolve();
        await new Promise<void>((resolve) => setImmediate(resolve));
        assert.equal(fixture.abortCalls, 0);
        assert.deepEqual(events.shutdowns, []);
        assert.deepEqual(events.starts, ["startup"]);
      });
    }
  }
});

test("real tree/new/resume/fork movement proceeds only after voice reaches off", async (t) => {
  for (const kind of ["tree", "new", "resume", "fork"] as const) {
    await t.test(kind, async (t) => {
      const events = { starts: [] as string[], shutdowns: [] as string[] };
      const fixture = await createSdkFixture(t, {
        before: [lifecycleEventRecorder(events)],
      });
      const movement = await prepareMovement(fixture, kind);
      const oldBinding = fixture.current();
      await startActive(oldBinding);

      const result = await movement.invoke();

      assert.equal(result.cancelled, false);
      assert.equal(oldBinding.lifecycle.snapshot().state, "off");
      if (kind === "tree") {
        assert.equal(fixture.runtime.session, movement.oldSession);
        assert.equal(
          fixture.runtime.session.sessionManager.getLeafId(),
          movement.targetLeaf,
        );
      } else {
        assert.notEqual(fixture.runtime.session, movement.oldSession);
        assert.notEqual(fixture.current(), oldBinding);
        assert.equal(fixture.current().lifecycle.snapshot().state, "off");
      }
      await startActive(fixture.current());
      assert.deepEqual(await fixture.current().lifecycle.stop(), {
        status: "off",
      });
      assert.equal(fixture.abortCalls, 0);
      const expectedReason = kind === "tree" ? undefined : kind;
      assert.deepEqual(
        events.shutdowns,
        expectedReason === undefined ? [] : [expectedReason],
      );
      assert.deepEqual(
        events.starts,
        expectedReason === undefined
          ? ["startup"]
          : ["startup", expectedReason],
      );
    });
  }
});

test("the shipped factory registers live bindings without starting a call", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "pi-live-sdk-shipped-"));
  const cwd = path.join(root, "work");
  const agentDir = path.join(root, "empty-agent");
  await mkdir(cwd, { recursive: true, mode: 0o700 });
  t.after(async () => rm(root, { recursive: true }));
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager: SettingsManager.inMemory(),
    extensionFactories: [{ name: "shipped-pi-live", factory: piLiveExtension }],
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });

  await loader.reload();

  const loaded = loader.getExtensions();
  assert.deepEqual(loaded.errors, []);
  assert.equal(loaded.extensions.length, 1);
  const extension = loaded.extensions[0];
  assert.ok(extension);
  assert.deepEqual([...extension.commands.keys()], ["live"]);
  assert.deepEqual([...extension.shortcuts.keys()], ["ctrl+shift+l"]);
  assert.deepEqual(
    [...extension.messageRenderers.keys()],
    ["better-openai-live-delegation"],
  );
  assert.deepEqual([...extension.handlers.keys()].sort(), [
    "agent_settled",
    "agent_start",
    "message_end",
    "session_before_fork",
    "session_before_switch",
    "session_before_tree",
    "session_shutdown",
    "session_start",
    "turn_end",
    "ui_prompt_end",
    "ui_prompt_start",
  ]);
  assert.deepEqual([...extension.tools.keys()], ["live_browser"]);
  assert.deepEqual([...extension.flags.keys()], []);
  assert.equal(await pathExists(agentDir), false);
});
