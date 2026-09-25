import assert from "node:assert/strict";
import { access, mkdir } from "node:fs/promises";
import path from "node:path";
import type { TestContext } from "node:test";

import {
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  createAgentSession,
  createAgentSessionRuntime,
  type AgentSession,
  type AgentSessionRuntime,
  type CreateAgentSessionRuntimeFactory,
  type ExtensionUIContext,
  type InlineExtension,
  type SourceInfo,
} from "@earendil-works/pi-coding-agent";

import {
  bindPiLiveLifecycle,
  registerPiLive,
  createLiveDependencies,
  createIsolatedLiveCoordination,
  createNodeOwnershipFileSystem,
  type LiveLifecycleBinding,
  type LiveLifecycleBindingOptions,
  type LiveDependencies,
} from "../../src/live.ts";
import {
  ManualClock,
  certifiedHome,
  createFakeCapture,
  createFakeConnection,
  createFakeResources,
  fixtureHome as createFixtureHome,
  settledStart,
  withFixtureWatchdog,
  type Deferred,
} from "./live-fixture.ts";
import { waitForCondition } from "./live-wait.ts";

export function waitUntil(
  predicate: () => boolean,
  description: string,
): Promise<void> {
  return waitForCondition(predicate, `Timed out waiting for ${description}`);
}

export async function pathExists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

export function emptyUi(
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

interface SdkFixtureOptions {
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
  cleanupTimeoutMs?: number;
  provider?: Parameters<ModelRuntime["registerProvider"]>[1];
  tools?: NonNullable<Parameters<typeof createAgentSession>[0]>["customTools"];
  controls?: boolean;
  resources?: NonNullable<LiveDependencies["runtime"]>["resources"];
  retry?: boolean;
  configuredSourcesFromSettings?: boolean;
}

export async function createSdkFixture(
  t: TestContext,
  options: SdkFixtureOptions = {},
) {
  const fixtureHome = await createFixtureHome(t);
  const { root, home, lock: lockPath } = fixtureHome;
  const cwd = path.join(root, "work");
  const agentDir = path.join(root, "empty-agent");
  for (const directory of [cwd, agentDir])
    await mkdir(directory, { recursive: true, mode: 0o700 });

  const previousHome = process.env.HOME;
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.HOME = home;
  process.env.PI_CODING_AGENT_DIR = agentDir;

  const clock = new ManualClock();
  const coordination = createIsolatedLiveCoordination();
  let runtime: AgentSessionRuntime | undefined;
  let disposal: Promise<void> | undefined;
  const disposeRuntime = async (): Promise<void> => {
    if (!runtime) return;
    disposal ??= runtime.dispose();
    await withFixtureWatchdog(
      disposal,
      "SDK runtime disposal",
      options.cleanupTimeoutMs,
    );
  };

  fixtureHome.beforeRemoval(async () => {
    const errors: unknown[] = [];
    try {
      options.closeGate?.resolve();
      options.delayRmdirCallback?.resolve();
      clock.advance(5_000);
    } catch (error) {
      errors.push(error);
    }
    try {
      await disposeRuntime();
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(
        clock.timers.size,
        0,
        "SDK fixture cleanup left manual timers armed",
      );
    } catch (error) {
      errors.push(error);
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousAgentDir === undefined)
        delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    }
    if (errors.length > 0)
      throw new AggregateError(errors, "SDK fixture cleanup failed");
  });

  const bindings: LiveLifecycleBinding[] = [];
  const nodeOwnership = createNodeOwnershipFileSystem();
  const counts = {
    abortCalls: 0,
    captureStops: 0,
    closeCalls: 0,
    closeSessionCalls: 0,
    sentSamples: 0,
    acquisitionCalls: 0,
  };
  let sampleHandler: ((samples: Float32Array) => void) | undefined;
  let randomSequence = 0;

  const capture = createFakeCapture({
    async stop(): Promise<void> {
      counts.captureStops += 1;
    },
  });
  const connection = createFakeConnection(
    {
      startCapture(onSample) {
        sampleHandler = onSample;
        return settledStart(capture);
      },
      sendSample() {
        counts.sentSamples += 1;
      },
      async closeSession(): Promise<void> {
        counts.closeSessionCalls += 1;
      },
      async close(): Promise<void> {
        counts.closeCalls += 1;
        await options.closeGate?.promise;
      },
    },
    capture,
  );

  const bindingFactory: InlineExtension = {
    name: "pi-live-lifecycle-test",
    factory(pi) {
      const bindingApi = options.getCommandsOverride
        ? (new Proxy(pi, {
            get(target, property, receiver) {
              if (property === "getCommands" && options.getCommandsOverride)
                return options.getCommandsOverride;
              return Reflect.get(target, property, receiver);
            },
          }) as typeof pi)
        : pi;
      const bindingOptions: LiveLifecycleBindingOptions = {
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
          } satisfies NonNullable<SdkFixtureOptions["consent"]>),
        lifecycle: {
          clock,
          coordination,
          randomId: () => `fixture-${++randomSequence}`,
          home: certifiedHome(home),
          ownershipFileSystem: {
            ...nodeOwnership,
            async mkdirExclusive(target, mode): Promise<void> {
              counts.acquisitionCalls += 1;
              await nodeOwnership.mkdirExclusive(target, mode);
            },
            async rmdir(target): Promise<void> {
              await nodeOwnership.rmdir(target);
              options.onRmdirRemoved?.();
              await options.delayRmdirCallback?.promise;
            },
          },
          resources: createFakeResources(connection),
        },
      };
      if (options.controls) {
        let voice: "sol" | "vale" = "sol";
        bindings.push(
          registerPiLive(bindingApi, {
            preferences: {
              load: async () => ({ voice, fields: {} }),
              setVoice: async (next) => {
                assert.ok(next === "sol" || next === "vale");
                voice = next;
              },
            },
            compatibility: {
              check: async () => ({ supported: true, issues: [] }),
            },
            truncateToWidth: (text, width) => text.slice(0, width),
            ...(options.configuredSourcesFromSettings
              ? {
                  packageSources: createLiveDependencies((text) => text)
                    .packageSources,
                }
              : {}),
            runtime: {
              lifecycle: bindingOptions.lifecycle,
              executionHost: () => "fixture-host",
              resources:
                options.resources ?? (() => createFakeResources(connection)),
            },
          }),
        );
      } else bindings.push(bindPiLiveLifecycle(bindingApi, bindingOptions));
    },
  };

  const settingsManager = SettingsManager.inMemory({
    cacheWarming: "off",
    compaction: { enabled: false },
    retry: {
      enabled: options.retry ?? false,
      maxRetries: 1,
      baseDelayMs: 1,
      maxAgentDelayMs: 1,
    },
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
  if (options.provider)
    modelRuntime.registerProvider("live-fixture", options.provider);
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    extensionFactories: [
      ...(options.before ?? []),
      bindingFactory,
      ...(options.after ?? []),
    ],
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPrompt: "Offline Pi Live lifecycle SDK fixture.",
  });
  if (options.sourceInfoByInlineName) {
    const getExtensions = resourceLoader.getExtensions.bind(resourceLoader);
    resourceLoader.getExtensions = () => {
      const result = getExtensions();
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
    };
  }

  const createRuntime: CreateAgentSessionRuntimeFactory = async ({
    cwd: targetCwd,
    sessionManager,
    sessionStartEvent,
  }) => {
    await resourceLoader.reload();
    const result = await createAgentSession({
      cwd: targetCwd,
      agentDir,
      modelRuntime,
      settingsManager,
      resourceLoader,
      sessionManager,
      sessionStartEvent,
      noTools: options.tools ? "builtin" : "all",
      ...(options.provider
        ? { model: modelRuntime.getModel("live-fixture", "fixture") }
        : {}),
      customTools: options.tools,
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

  const extensionErrors: unknown[] = [];
  const bind = async (session: AgentSession): Promise<void> => {
    await session.bindExtensions({
      mode: "tui",
      uiContext: options.ui ?? emptyUi(),
      abortHandler: () => {
        counts.abortCalls += 1;
      },
      onError: (error) => {
        extensionErrors.push(error);
      },
      commandContextActions: {
        waitForIdle: () => session.waitForIdle(),
        newSession: (replacementOptions) =>
          runtime!.newSession(replacementOptions),
        fork: (entryId, forkOptions) => runtime!.fork(entryId, forkOptions),
        navigateTree: (entryId, navigationOptions) =>
          session.navigateTree(entryId, navigationOptions),
        switchSession: (sessionPath, switchOptions) =>
          runtime!.switchSession(sessionPath, switchOptions),
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

  return Object.assign(counts, {
    root,
    cwd,
    agentDir,
    lockPath,
    clock,
    runtime,
    bindings,
    emitSample(samples: Float32Array = new Float32Array([0.25])) {
      sampleHandler?.(samples);
    },
    current() {
      const binding = bindings.at(-1);
      assert.ok(binding);
      return binding;
    },
    disposeRuntime,
  });
}

export type SdkFixture = Awaited<ReturnType<typeof createSdkFixture>>;

export async function startActive(
  binding: LiveLifecycleBinding,
): Promise<void> {
  assert.deepEqual(await binding.lifecycle.start(), {
    kind: "started",
    state: "active",
  });
  assert.equal(binding.lifecycle.snapshot().state, "active");
}

export function lifecycleEventRecorder(record: {
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

export async function prepareMovement(
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

export function betterOpenAIFactory(
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

export function packageSourceInfo(source: string): SourceInfo {
  return {
    path: "/fixture/pi-better-openai/index.ts",
    source,
    scope: "user",
    origin: "package",
    baseDir: "/fixture/pi-better-openai",
  };
}
