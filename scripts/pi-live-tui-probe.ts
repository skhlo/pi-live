/** Explicitly invoked offline terminal fixture. Never loads real credentials/media. */
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync } from "node:fs";
import { connect } from "node:net";
import path from "node:path";
import {
  DefaultResourceLoader,
  InteractiveMode,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  createAgentSession,
  createAgentSessionRuntime,
  type CreateAgentSessionRuntimeFactory,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import {
  registerPiLive,
  createIsolatedLiveCoordination,
  type LiveLifecycleBinding,
  type LiveClock,
} from "../src/live.ts";
import { certifiedHome } from "./test-support/live-fixture.ts";
import { fakeMedia } from "./test-support/live-media.ts";
import { fakeProvider } from "./test-support/live-provider.ts";

const root = process.env.PI_LIVE_FIXTURE_ROOT;
assert.ok(root && path.isAbsolute(root));
assert.equal(process.env.HOME, path.join(root, "home"));
assert.equal(process.env.PI_CODING_AGENT_DIR, path.join(root, "agent"));
assert.ok(process.execArgv.includes("--no-addons"));
for (const directory of ["home", "agent", "work", "tmp"])
  mkdirSync(path.join(root, directory), { recursive: true, mode: 0o700 });
mkdirSync(path.join(root, "home/.local/state/pi-live"), {
  recursive: true,
  mode: 0o700,
});
const record = (type: string, fields: Record<string, unknown> = {}) =>
  appendFileSync(
    path.join(root, "events.jsonl"),
    JSON.stringify({ type, ...fields }) + "\n",
  );
await new Promise<void>((resolve, reject) => {
  const socket = connect({ host: "127.0.0.1", port: 9 });
  socket.once("connect", () => {
    socket.destroy();
    reject(new Error("fixture network was permitted"));
  });
  socket.once("error", (error: NodeJS.ErrnoException) => {
    socket.destroy();
    if (error.code !== "EPERM") reject(error);
    else {
      record("network-denied", { code: error.code });
      resolve();
    }
  });
});
globalThis.fetch = async () => {
  throw new Error("fixture forbids network");
};
const timers = new Set<object>();
const clock: LiveClock = {
  now: () => performance.now(),
  setTimer(callback, delay) {
    const timer = setTimeout(() => {
      timers.delete(timer);
      callback();
    }, delay);
    timers.add(timer);
    return timer;
  },
  clearTimer(timer) {
    clearTimeout(timer as ReturnType<typeof setTimeout>);
    timers.delete(timer);
  },
};
const media = fakeMedia();
const provider = fakeProvider({ tool: true });
let binding: LiveLifecycleBinding;
let currentContext: ExtensionContext | undefined;
let voice: "sol" | "vale" = "sol";
let stopAtConsentResult = false;
const snapshot = () => ({
  ...binding.lifecycle.snapshot(),
  timers: timers.size,
  ...media.counts(),
  frames: media.frames.length,
});
const settingsManager = SettingsManager.inMemory({
  cacheWarming: "off",
  compaction: { enabled: false },
  retry: { enabled: false },
  quietStartup: true,
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
modelRuntime.registerProvider("live-fixture", provider.provider);
const cwd = path.join(root, "work");
const agentDir = path.join(root, "agent");
const resourceLoader = new DefaultResourceLoader({
  cwd,
  agentDir,
  settingsManager,
  noExtensions: true,
  noSkills: true,
  noPromptTemplates: true,
  noThemes: true,
  noContextFiles: true,
  systemPrompt: "Offline Pi Live terminal fixture.",
  extensionFactories: [
    {
      name: "pi-live-tui-fixture",
      factory(pi) {
        binding = registerPiLive(pi, {
          preferences: {
            load: async () => ({ voice, fields: {} }),
            setVoice: async (value) => {
              assert.ok(value === "sol" || value === "vale");
              voice = value;
            },
          },
          compatibility: {
            check: async () => ({ supported: true, issues: [] }),
          },
          truncateToWidth,
          runtime: {
            lifecycle: {
              home: certifiedHome(path.join(root, "home")),
              coordination: createIsolatedLiveCoordination(),
              clock,
            },
            executionHost: () => "offline-fixture-host",
            resources: media.resources,
          },
        });
        pi.on("session_start", (_event, ctx) => {
          currentContext = ctx;
          record("ready", snapshot());
        });
        pi.on("ui_prompt_start", (event) => {
          const before = media.counts().captured;
          media.sample();
          record("prompt-start", {
            kind: event.kind,
            title: event.title,
            before,
            ...snapshot(),
          });
        });
        pi.on("ui_prompt_end", (event) => {
          if (stopAtConsentResult && event.kind === "confirm") {
            stopAtConsentResult = false;
            void binding.lifecycle.stop();
            record("consent-stopped", snapshot());
          }
          record("prompt-end", { kind: event.kind, ...snapshot() });
        });
        pi.on("agent_settled", () =>
          record("agent-settled", {
            ...snapshot(),
            framesContent: media.frames,
            inputs: provider.contexts,
          }),
        );
        pi.registerCommand("fixture", {
          description: "Offline terminal probe controls",
          async handler(args, ctx) {
            const kind = args.trim();
            if (kind === "state") {
              record("state", { ...snapshot(), draft: ctx.ui.getEditorText() });
              ctx.ui.notify(`Fixture: ${JSON.stringify(snapshot())}`, "info");
              return;
            }
            if (kind === "speech") {
              media.sample();
              media.emit({
                type: "turn.done",
                turn: { role: "user", transcript: "Unicode é 你好 🙂" },
              });
              media.emit({
                type: "turn.done",
                turn: { role: "assistant", transcript: "Ready to help" },
              });
              record("speech", snapshot());
              return;
            }
            if (kind === "task" || kind === "followup") {
              media.request(
                kind === "task" ? "terminal-one" : "terminal-two",
                kind === "task"
                  ? "Run the harmless fixture tool and report the result"
                  : "Voice follow-up while Pi is working",
              );
              return;
            }
            if (kind === "late") {
              stopAtConsentResult = true;
              record("late-armed");
              return;
            }
            let result: unknown;
            if (kind === "confirm")
              result = await ctx.ui.confirm(
                "Fixture approval",
                "Choose normally; voice stops on reported prompts.",
              );
            else if (kind === "select")
              result = await ctx.ui.select("Fixture choice", ["Alpha", "Beta"]);
            else if (kind === "input")
              result = await ctx.ui.input("Fixture input", "Type here");
            else if (kind === "editor")
              result = await ctx.ui.editor("Fixture editor", "initial");
            else if (kind === "custom")
              result = await ctx.ui.custom<string | undefined>(
                (_tui, _theme, _keys, done) => ({
                  render: () => ["Fixture custom: x confirms, Escape cancels"],
                  invalidate() {},
                  handleInput(data: string) {
                    if (data === "x") done("x");
                    else if (data === "\u001b") done(undefined);
                  },
                }),
              );
            else return;
            record("dialog-result", {
              kind,
              result: result ?? null,
              ...snapshot(),
            });
          },
        });
        pi.registerShortcut("ctrl+shift+k", {
          description: "Offline unreported shortcut dialog",
          async handler(ctx) {
            record("shortcut-invoked", snapshot());
            setTimeout(() => {
              media.sample();
              record("shortcut-pending", snapshot());
            }, 100);
            const result = await ctx.ui.confirm(
              "Shortcut approval",
              "This unreported dialog intentionally leaves voice active.",
            );
            record("shortcut-result", { result, ...snapshot() });
          },
        });
        pi.registerShortcut("ctrl+shift+j", {
          description: "Record editor text",
          handler(ctx) {
            record("editor-draft", {
              text: ctx.ui.getEditorText(),
              ...snapshot(),
            });
          },
        });
      },
    },
  ],
});
const createRuntime: CreateAgentSessionRuntimeFactory = async ({
  cwd: directory,
  sessionManager,
  sessionStartEvent,
}) => {
  await resourceLoader.reload();
  const result = await createAgentSession({
    cwd: directory,
    agentDir,
    modelRuntime,
    model: modelRuntime.getModel("live-fixture", "fixture"),
    settingsManager,
    resourceLoader,
    sessionManager,
    sessionStartEvent,
    noTools: "builtin",
    customTools: [
      {
        name: "fixture_tool",
        label: "Offline check",
        description: "Harmless fixture computation",
        parameters: { type: "object", properties: {} },
        async execute() {
          record("tool-start");
          await new Promise((resolve) => setTimeout(resolve, 1500));
          record("tool-end");
          return {
            content: [
              { type: "text", text: "private raw tool output: 19 + 23 = 42" },
            ],
            details: {},
          };
        },
      },
    ],
  });
  return {
    ...result,
    services: {
      cwd: directory,
      agentDir,
      modelRuntime,
      settingsManager,
      resourceLoader,
      diagnostics: [],
    },
    diagnostics: [],
  };
};
const runtime = await createAgentSessionRuntime(createRuntime, {
  cwd,
  agentDir,
  sessionManager: SessionManager.inMemory(cwd),
});
const mode = new InteractiveMode(runtime, {
  verbose: false,
  tuiMode: "inline",
});
await mode.run();
await runtime.dispose();
record("disposed", { ...snapshot(), contextAvailable: !!currentContext });
