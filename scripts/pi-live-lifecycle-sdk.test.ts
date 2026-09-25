import assert from "node:assert/strict";
import { access, chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";

import {
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  createAgentSession,
  createAgentSessionRuntime,
  type AgentSession,
  type AgentSessionRuntime,
  type ExtensionUIContext,
  type InlineExtension,
  type ResourceLoader,
  type SourceInfo,
} from "@earendil-works/pi-coding-agent";

import piLiveExtension from "../index.ts";
import {
  PINNED_BETTER_OPENAI_PACKAGE_SOURCES,
  bindPiLiveLifecycle,
  createIsolatedLiveCoordination,
  createNodeOwnershipFileSystem,
  type LiveCapture,
  type LiveClock,
  type LiveConnection,
  type LiveLifecycleBinding,
  type LiveResourceStart,
  type LiveTimer,
} from "../src/live.ts";

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolvePromise!: (value: T) => void;
  return {
    promise: new Promise<T>((resolve) => {
      resolvePromise = resolve;
    }),
    resolve: (value) => resolvePromise(value),
  };
}

class ManualClock implements LiveClock {
  nowValue = 0;
  private sequence = 0;
  private readonly timers = new Map<
    LiveTimer,
    { at: number; sequence: number; callback: () => void }
  >();

  now(): number {
    return this.nowValue;
  }

  setTimer(callback: () => void, delayMs: number): LiveTimer {
    const timer = {};
    this.timers.set(timer, {
      at: this.nowValue + Math.max(0, delayMs),
      sequence: this.sequence++,
      callback,
    });
    return timer;
  }

  clearTimer(timer: LiveTimer): void {
    this.timers.delete(timer);
  }

  advance(milliseconds: number): void {
    this.nowValue += milliseconds;
    for (;;) {
      const due = [...this.timers.entries()]
        .filter(([, timer]) => timer.at <= this.nowValue)
        .sort(
          (left, right) =>
            left[1].at - right[1].at || left[1].sequence - right[1].sequence,
        )[0];
      if (!due) return;
      this.timers.delete(due[0]);
      due[1].callback();
    }
  }
}

function resourceStart<T>(value: T): LiveResourceStart<T> {
  const result = Promise.resolve(value);
  return {
    result,
    async terminate(dispose): Promise<void> {
      await dispose(await result);
    },
  };
}

async function waitUntil(
  predicate: () => boolean,
  description: string,
): Promise<void> {
  for (let turn = 0; turn < 200; turn += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.fail(`Timed out waiting for ${description}`);
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

function emptyUi(
  confirm: ExtensionUIContext["confirm"] = async () => true,
): ExtensionUIContext {
  return {
    select: async () => undefined,
    confirm,
    input: async () => undefined,
    notify: () => undefined,
    onTerminalInput: () => () => undefined,
    setStatus: () => undefined,
    setWorkingMessage: () => undefined,
    setWorkingVisible: () => undefined,
    setWorkingIndicator: () => undefined,
    setHiddenThinkingLabel: () => undefined,
    setWidget: () => undefined,
    setFooter: () => undefined,
    setHeader: () => undefined,
    setTitle: () => undefined,
    custom: async () => undefined as never,
    pasteToEditor: () => undefined,
    setEditorText: () => undefined,
    getEditorText: () => "",
    editor: async () => undefined,
    addAutocompleteProvider: () => undefined,
    setEditorComponent: () => undefined,
    getEditorComponent: () => undefined,
    theme: {} as ExtensionUIContext["theme"],
    getAllThemes: () => [],
    getTheme: () => undefined,
    setTheme: () => ({ success: false, error: "fixture" }),
    getToolsExpanded: () => false,
    setToolsExpanded: () => undefined,
  };
}

interface FixtureOptions {
  before?: InlineExtension[];
  after?: InlineExtension[];
  closeGate?: Deferred<void>;
  delayRmdirCallback?: Deferred<void>;
  onRmdirRemoved?: () => void;
  ui?: ExtensionUIContext;
  consent?: Parameters<typeof bindPiLiveLifecycle>[1]["consent"];
  configuredPackageSources?: readonly string[];
  getCommandsOverride?: () => unknown;
  sourceInfoByInlineName?: ReadonlyMap<string, SourceInfo>;
}

interface SdkFixture {
  root: string;
  home: string;
  cwd: string;
  agentDir: string;
  lockPath: string;
  clock: ManualClock;
  coordination: ReturnType<typeof createIsolatedLiveCoordination>;
  runtime: AgentSessionRuntime;
  bindings: LiveLifecycleBinding[];
  abortCalls: number;
  captureStops: number;
  closeCalls: number;
  closeSessionCalls: number;
  sentSamples: number;
  acquisitionCalls: number;
  emitSample(samples?: readonly number[]): void;
  current(): LiveLifecycleBinding;
  disposeRuntime(): Promise<void>;
}

async function sdkFixture(
  t: TestContext,
  options: FixtureOptions = {},
): Promise<SdkFixture> {
  const root = await mkdtemp(path.join(tmpdir(), "pi-live-sdk-test-"));
  const home = path.join(root, "account-home");
  const cwd = path.join(root, "work");
  const agentDir = path.join(root, "empty-agent");
  const stateParent = path.join(home, ".local/state/pi-live");
  const sessions = path.join(root, "sessions");
  for (const directory of [home, cwd, agentDir, stateParent, sessions])
    await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(stateParent, 0o700);

  const previousHome = process.env.HOME;
  process.env.HOME = home;

  const clock = new ManualClock();
  const coordination = createIsolatedLiveCoordination();
  const bindings: LiveLifecycleBinding[] = [];
  const nodeOwnership = createNodeOwnershipFileSystem();
  let abortCalls = 0;
  let captureStops = 0;
  let closeCalls = 0;
  let closeSessionCalls = 0;
  let sentSamples = 0;
  let acquisitionCalls = 0;
  let sampleHandler: ((samples: readonly number[]) => void) | undefined;
  let randomSequence = 0;
  let disposed = false;

  const capture: LiveCapture = {
    async stop(): Promise<void> {
      captureStops += 1;
    },
  };
  const connection: LiveConnection = {
    startCapture(onSample) {
      sampleHandler = onSample;
      return resourceStart(capture);
    },
    sendSample() {
      sentSamples += 1;
    },
    async closeSession(): Promise<void> {
      closeSessionCalls += 1;
    },
    async close(): Promise<void> {
      closeCalls += 1;
      await options.closeGate?.promise;
    },
  };

  const bindingFactory: InlineExtension = {
    name: "pi-live-lifecycle-test",
    factory(pi) {
      const bindingApi = options.getCommandsOverride
        ? (new Proxy(pi, {
            get(target, property, receiver) {
              if (property === "getCommands")
                return options.getCommandsOverride;
              return Reflect.get(target, property, receiver);
            },
          }) as typeof pi)
        : pi;
      bindings.push(
        bindPiLiveLifecycle(bindingApi, {
          facts: {
            check: () => ({
              compatible: true,
              configuredPackageSources: options.configuredPackageSources,
            }),
          },
          consent:
            options.consent ??
            ({
              request: ({ openConfirm }) =>
                openConfirm("Pi Live consent", "Start the fixture call?"),
            } satisfies NonNullable<FixtureOptions["consent"]>),
          lifecycle: {
            clock,
            coordination,
            randomId: () => `fixture-${++randomSequence}`,
            home: {
              accountHome: () => home,
              environmentHome: () => process.env.HOME,
              certify: (observation) => ({
                certified: true,
                ...observation,
              }),
            },
            ownershipFileSystem: {
              ...nodeOwnership,
              async mkdirExclusive(target, mode): Promise<void> {
                acquisitionCalls += 1;
                await nodeOwnership.mkdirExclusive(target, mode);
              },
              async rmdir(target): Promise<void> {
                await nodeOwnership.rmdir(target);
                options.onRmdirRemoved?.();
                await options.delayRmdirCallback?.promise;
              },
            },
            resources: {
              credentials: async () => undefined,
              attestation: async () => undefined,
              connect: () => resourceStart(connection),
            },
          },
        }),
      );
    },
  };

  const extensionFactories = [
    ...(options.before ?? []),
    bindingFactory,
    ...(options.after ?? []),
  ];
  const settingsManager = SettingsManager.inMemory({
    cacheWarming: "off",
    compaction: { enabled: false },
  });
  const modelRuntime = await ModelRuntime.create({
    credentials: {
      read: async () => undefined,
      list: async () => [],
      modify: async () => undefined,
      delete: async () => undefined,
    },
    modelsPath: null,
    refreshOnCreate: false,
    allowModelNetwork: false,
  });
  const baseLoader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    extensionFactories,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPrompt: "Offline Pi Live lifecycle SDK fixture.",
  });
  const resourceLoader: ResourceLoader = {
    getExtensions() {
      const result = baseLoader.getExtensions();
      for (const extension of result.extensions) {
        const name = extension.path.match(/^<inline:(.+)>$/)?.[1];
        const sourceInfo = name
          ? options.sourceInfoByInlineName?.get(name)
          : undefined;
        if (!sourceInfo) continue;
        extension.sourceInfo = sourceInfo;
        for (const command of extension.commands.values())
          command.sourceInfo = sourceInfo;
      }
      return result;
    },
    getSkills: () => baseLoader.getSkills(),
    getPrompts: () => baseLoader.getPrompts(),
    getThemes: () => baseLoader.getThemes(),
    getAgentsFiles: () => baseLoader.getAgentsFiles(),
    getSystemPrompt: () => baseLoader.getSystemPrompt(),
    getSystemPromptSource: () => baseLoader.getSystemPromptSource(),
    getAppendSystemPrompt: () => baseLoader.getAppendSystemPrompt(),
    getAppendSystemPromptSources: () =>
      baseLoader.getAppendSystemPromptSources(),
    extendResources: (paths) => baseLoader.extendResources(paths),
    reload: (reloadOptions) => baseLoader.reload(reloadOptions),
  };

  const createRuntime = async ({
    cwd: targetCwd,
    sessionManager,
    sessionStartEvent,
  }: Parameters<typeof createAgentSessionRuntime>[0] extends (
    input: infer Input,
  ) => unknown
    ? Input
    : never) => {
    await resourceLoader.reload();
    const result = await createAgentSession({
      cwd: targetCwd,
      agentDir,
      modelRuntime,
      settingsManager,
      resourceLoader,
      sessionManager,
      sessionStartEvent,
      noTools: "all",
    });
    return {
      ...result,
      services: {
        cwd: targetCwd,
        agentDir,
        modelRuntime,
        settingsManager,
        resourceLoader,
        diagnostics: [],
      },
      diagnostics: [],
    };
  };

  let runtime!: AgentSessionRuntime;
  const extensionErrors: unknown[] = [];
  const bind = async (session: AgentSession): Promise<void> => {
    await session.bindExtensions({
      mode: "tui",
      uiContext: options.ui ?? emptyUi(),
      abortHandler: () => {
        abortCalls += 1;
      },
      onError: (error) => {
        extensionErrors.push(error);
      },
      commandContextActions: {
        waitForIdle: () => session.waitForIdle(),
        newSession: (replacementOptions) =>
          runtime.newSession(replacementOptions),
        fork: (entryId, forkOptions) => runtime.fork(entryId, forkOptions),
        navigateTree: (entryId, navigationOptions) =>
          session.navigateTree(entryId, navigationOptions),
        switchSession: (sessionPath, switchOptions) =>
          runtime.switchSession(sessionPath, switchOptions),
        reload: () => session.reload(),
      },
    });
  };

  runtime = await createAgentSessionRuntime(createRuntime, {
    cwd,
    agentDir,
    sessionManager: SessionManager.inMemory(cwd),
  });
  runtime.setRebindSession(bind);
  await bind(runtime.session);
  assert.deepEqual(extensionErrors, []);
  assert.ok(bindings.length >= 1);

  const fixture: SdkFixture = {
    root,
    home,
    cwd,
    agentDir,
    lockPath: path.join(stateParent, "active.lock"),
    clock,
    coordination,
    runtime,
    bindings,
    get abortCalls() {
      return abortCalls;
    },
    get captureStops() {
      return captureStops;
    },
    get closeCalls() {
      return closeCalls;
    },
    get closeSessionCalls() {
      return closeSessionCalls;
    },
    get sentSamples() {
      return sentSamples;
    },
    get acquisitionCalls() {
      return acquisitionCalls;
    },
    emitSample(samples = [0.25]) {
      sampleHandler?.(samples);
    },
    current() {
      const binding = bindings.at(-1);
      assert.ok(binding);
      return binding;
    },
    async disposeRuntime(): Promise<void> {
      if (disposed) return;
      disposed = true;
      await runtime.dispose();
    },
  };

  t.after(async () => {
    options.closeGate?.resolve();
    options.delayRmdirCallback?.resolve();
    clock.advance(5_000);
    await fixture.disposeRuntime();
    await new Promise<void>((resolve) => setImmediate(resolve));
    await rm(root, { recursive: true });
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  });

  return fixture;
}

async function startActive(binding: LiveLifecycleBinding): Promise<void> {
  assert.deepEqual(await binding.lifecycle.start(), {
    kind: "started",
    state: "active",
  });
  assert.equal(binding.lifecycle.snapshot().state, "active");
}

function lifecycleEventRecorder(record: {
  starts: string[];
  shutdowns: string[];
}): InlineExtension {
  return {
    name: "lifecycle-event-recorder",
    factory(pi) {
      pi.on("session_start", (event) => {
        record.starts.push(event.reason);
      });
      pi.on("session_shutdown", (event) => {
        record.shutdowns.push(event.reason);
      });
    },
  };
}

type MovementKind = "tree" | "new" | "resume" | "fork";

interface PreparedMovement {
  oldSession: AgentSession;
  oldLeaf: string | null;
  targetLeaf?: string;
  invoke(): Promise<{ cancelled: boolean }>;
}

async function prepareMovement(
  fixture: SdkFixture,
  kind: MovementKind,
): Promise<PreparedMovement> {
  const oldSession = fixture.runtime.session;
  const manager = oldSession.sessionManager;
  if (kind === "tree") {
    const targetLeaf = manager.appendCustomEntry("tree-target", { fixture: 1 });
    manager.appendCustomEntry("tree-tail", { fixture: 2 });
    oldSession.refreshContext();
    return {
      oldSession,
      oldLeaf: manager.getLeafId(),
      targetLeaf,
      invoke: () => oldSession.navigateTree(targetLeaf),
    };
  }
  if (kind === "fork") {
    const targetLeaf = manager.appendCustomEntry("fork-target", { fixture: 1 });
    manager.appendCustomEntry("fork-tail", { fixture: 2 });
    oldSession.refreshContext();
    return {
      oldSession,
      oldLeaf: manager.getLeafId(),
      invoke: () => fixture.runtime.fork(targetLeaf, { position: "at" }),
    };
  }
  if (kind === "resume") {
    const target = SessionManager.create(
      fixture.cwd,
      path.join(fixture.root, "resume-sessions"),
    );
    target.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "isolated session fixture" }],
      provider: "fixture",
      model: "fixture",
      api: "openai-responses",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          total: 0,
        },
      },
      stopReason: "stop",
      timestamp: Date.now(),
    });
    const targetPath = target.getSessionFile();
    assert.ok(targetPath);
    return {
      oldSession,
      oldLeaf: manager.getLeafId(),
      invoke: () => fixture.runtime.switchSession(targetPath),
    };
  }
  return {
    oldSession,
    oldLeaf: manager.getLeafId(),
    invoke: () => fixture.runtime.newSession(),
  };
}

test("AgentSessionRuntime.dispose fences voice on quit without calling ctx.abort", async (t) => {
  const events = { starts: [] as string[], shutdowns: [] as string[] };
  const fixture = await sdkFixture(t, {
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
  const fixture = await sdkFixture(t, {
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
      const fixture = await sdkFixture(t);
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
  const fixture = await sdkFixture(t, {
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
  const fixture = await sdkFixture(t, { before: [delayFactory] });
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
  const fixture = await sdkFixture(t, {
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
  const fixture = await sdkFixture(t, {
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
  const fixture = await sdkFixture(t, {
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
  const fixture = await sdkFixture(t, {
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
  const fixture = await sdkFixture(t, {
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
  const fixture = await sdkFixture(t, { before: [emitterFactory] });
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
  const fixture = await sdkFixture(t, {
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
  const fixture = await sdkFixture(t, {
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

function betterOpenAIFactory(
  description = "Start or stop Codex-backed realtime voice mode",
): InlineExtension {
  return {
    name: "better-openai",
    factory(pi) {
      pi.registerCommand("live", {
        description,
        handler: async () => undefined,
      });
    },
  };
}

function packageSourceInfo(source: string): SourceInfo {
  return {
    path: "/fixture/pi-better-openai/index.ts",
    source,
    scope: "user",
    origin: "package",
    baseDir: "/fixture/pi-better-openai",
  };
}

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
      const fixture = await sdkFixture(t, { getCommandsOverride });
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
      const fixture = await sdkFixture(t, {
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
        const fixture = await sdkFixture(t, {
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
        const fixture = await sdkFixture(t, {
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
      const fixture = await sdkFixture(t, {
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
        const fixture = await sdkFixture(t, {
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
      const fixture = await sdkFixture(t, {
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

test("the shipped factory remains setup-only after the dormant binding is added", async (t) => {
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
  assert.deepEqual([...extension.handlers.keys()], ["session_shutdown"]);
  assert.deepEqual([...extension.tools.keys()], []);
  assert.deepEqual([...extension.flags.keys()], []);
  assert.equal(await pathExists(agentDir), false);
});
