import assert from "node:assert/strict";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  MessageRenderer,
} from "@earendil-works/pi-coding-agent";
import { discoverAndLoadExtensions } from "@earendil-works/pi-coding-agent";

import {
  registerPiLive,
  createIsolatedLiveCoordination,
  type LiveSetupResult,
} from "../src/live.ts";
import { PreferenceError } from "../src/preferences.ts";

type CommandRegistration = {
  description?: string;
  handler(args: string, ctx: ExtensionCommandContext): Promise<void>;
};

type ShortcutRegistration = {
  description?: string;
  handler(ctx: ExtensionContext): Promise<void> | void;
};

type WidgetCall = [key: string, content: string[] | undefined];

const noClip = (value: string): string => value;

function registrationHarness() {
  const commands = new Map<string, CommandRegistration>();
  const shortcuts = new Map<string, ShortcutRegistration>();
  const renderers = new Map<string, MessageRenderer>();
  const events = new Map<
    string,
    Array<(event: unknown, ctx: ExtensionContext) => unknown>
  >();
  const otherRegistrations: string[] = [];
  const pi = {
    events: { on: () => () => undefined },
    getCommands: () => [],
    registerCommand(name: string, registration: CommandRegistration) {
      commands.set(name, registration);
    },
    registerShortcut(name: string, registration: ShortcutRegistration) {
      shortcuts.set(name, registration);
    },
    registerMessageRenderer(name: string, renderer: MessageRenderer) {
      renderers.set(name, renderer);
    },
    on(
      name: string,
      handler: (event: unknown, ctx: ExtensionContext) => unknown,
    ) {
      const handlers = events.get(name) ?? [];
      handlers.push(handler);
      events.set(name, handlers);
      return () => undefined;
    },
    registerTool() {
      otherRegistrations.push("tool");
    },
    registerProvider() {
      otherRegistrations.push("provider");
    },
    registerEntryRenderer() {
      otherRegistrations.push("entry-renderer");
    },
    registerFlag() {
      otherRegistrations.push("flag");
    },
  } as unknown as ExtensionAPI;
  return {
    pi,
    commands,
    shortcuts,
    renderers,
    events,
    otherRegistrations,
  };
}

async function isMissing(target: string): Promise<boolean> {
  try {
    await access(target);
    return false;
  } catch {
    return true;
  }
}

function commandFrom(harness: ReturnType<typeof registrationHarness>) {
  const command = harness.commands.get("live");
  assert.ok(command);
  return command;
}

function context(
  mode: ExtensionContext["mode"],
  notifications: Array<[string, string | undefined]>,
  widgetCalls: WidgetCall[],
): ExtensionCommandContext {
  return {
    mode,
    isIdle: () => true,
    hasPendingMessages: () => false,
    sessionManager: { getSessionId: () => "fixture", getLeafId: () => null },
    ui: {
      confirm: async () => false,
      notify(message: string, level?: "info" | "warning" | "error") {
        notifications.push([message, level]);
      },
      setWidget(key: string, content: string[] | undefined) {
        widgetCalls.push([key, content]);
      },
    },
  } as unknown as ExtensionCommandContext;
}

test("the default factory registers only live controls and required listeners without creating agent state", async (t) => {
  const agentDir = path.join(
    await mkdtemp(path.join(tmpdir(), "pi-live-discovery-test-")),
    "missing-agent",
  );
  t.after(async () => rm(path.dirname(agentDir), { recursive: true }));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  t.after(() => {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  });

  assert.equal(await isMissing(agentDir), true);
  const loaded = await discoverAndLoadExtensions(
    [path.join(import.meta.dirname, "../index.ts")],
    process.cwd(),
    agentDir,
  );

  assert.deepEqual(loaded.errors, []);
  assert.equal(loaded.extensions.length, 1);
  const extension = loaded.extensions[0]!;
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
  assert.equal(await isMissing(agentDir), true);
});

test("the in-process Pi 0.87.1 loader API accepts one default factory and side-effect-free registrations", async (t) => {
  const entry = path.join(import.meta.dirname, "../index.ts");
  const agentDir = await mkdtemp(path.join(tmpdir(), "pi-live-loader-test-"));
  t.after(async () => rm(agentDir, { recursive: true }));
  const loaded = await discoverAndLoadExtensions(
    [entry],
    process.cwd(),
    agentDir,
  );

  assert.deepEqual(loaded.errors, []);
  assert.equal(loaded.extensions.length, 1);
  const extension = loaded.extensions[0]!;
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
});

test("status stays off and lazily reports the selected voice and compatibility", async () => {
  const harness = registrationHarness();
  let preferenceReads = 0;
  let compatibilityChecks = 0;
  registerPiLive(harness.pi, {
    preferences: {
      async load() {
        preferenceReads += 1;
        return { voice: "verse", fields: { voice: "verse" } };
      },
      async setVoice() {
        throw new Error("unexpected preference write");
      },
    },
    compatibility: {
      async check() {
        compatibilityChecks += 1;
        return { supported: true, issues: [] };
      },
    },
    truncateToWidth: noClip,
    runtime: { lifecycle: { coordination: createIsolatedLiveCoordination() } },
  });
  const notifications: Array<[string, string | undefined]> = [];
  const widgetCalls: WidgetCall[] = [];

  await commandFrom(harness).handler(
    "status",
    context("tui", notifications, widgetCalls),
  );

  assert.deepEqual(notifications, [
    ["Pi Live: off; unmuted; voice verse; compatibility supported.", "info"],
  ]);
  assert.equal(preferenceReads, 1);
  assert.equal(compatibilityChecks, 1);
  assert.deepEqual(widgetCalls, []);
});

test("start and shortcut share cancelled consent without claiming active state", async () => {
  const harness = registrationHarness();
  let preferenceCalls = 0;
  let compatibilityCalls = 0;
  registerPiLive(harness.pi, {
    preferences: {
      async load() {
        preferenceCalls += 1;
        return { voice: "marin", fields: {} };
      },
      async setVoice() {
        preferenceCalls += 1;
      },
    },
    compatibility: {
      async check() {
        compatibilityCalls += 1;
        return { supported: true, issues: [] };
      },
    },
    truncateToWidth: noClip,
    runtime: { lifecycle: { coordination: createIsolatedLiveCoordination() } },
  });
  const notifications: Array<[string, string | undefined]> = [];
  const widgetCalls: WidgetCall[] = [];
  const ctx = context("tui", notifications, widgetCalls);

  await commandFrom(harness).handler("", ctx);
  await commandFrom(harness).handler("start", ctx);
  await harness.shortcuts.get("ctrl+shift+l")?.handler(ctx);
  await commandFrom(harness).handler("stop", ctx);
  await commandFrom(harness).handler("stop", ctx);
  await commandFrom(harness).handler("mute", ctx);
  await commandFrom(harness).handler("unmute", ctx);

  assert.equal(preferenceCalls, 3);
  assert.equal(compatibilityCalls, 6);
  assert.equal(
    widgetCalls.filter(([, content]) => typeof content === "function").length,
    3,
  );
  assert.equal(
    widgetCalls.filter(([, content]) => content === undefined).length,
    3,
  );
  assert.equal(
    notifications.some(([text]) => /listening|active/i.test(text)),
    false,
  );
  assert.deepEqual(notifications.slice(-2), [
    ["Pi Live: off; mute unavailable.", "warning"],
    ["Pi Live: off; unmute unavailable.", "warning"],
  ]);
});

test("help discloses calling limits and voice changes only the off-state preference", async () => {
  const harness = registrationHarness();
  let voice: "marin" | "cedar" = "marin";
  let writes = 0;
  let compatibilityCalls = 0;
  registerPiLive(harness.pi, {
    preferences: {
      async load() {
        return { voice, fields: { retained: true, voice } };
      },
      async setVoice(nextVoice) {
        writes += 1;
        voice = nextVoice as typeof voice;
      },
    },
    compatibility: {
      async check() {
        compatibilityCalls += 1;
        return { supported: true, issues: [] };
      },
    },
    truncateToWidth: noClip,
    runtime: { lifecycle: { coordination: createIsolatedLiveCoordination() } },
  });
  const notifications: Array<[string, string | undefined]> = [];
  const ctx = context("tui", notifications, []);

  await commandFrom(harness).handler("help", ctx);
  await commandFrom(harness).handler("voice", ctx);
  await commandFrom(harness).handler("voice cedar", ctx);
  await commandFrom(harness).handler("voice sol", ctx);

  const help = notifications[0]?.[0] ?? "";
  for (const phrase of [
    "host microphone and speakers",
    "OpenAI GPT-Live",
    "API key",
    "progress note",
    "shortcut-opened dialogs",
    "stop voice first",
    "Browser mode",
    "TypeSafe",
  ]) {
    assert.match(help, new RegExp(phrase, "i"));
  }
  assert.deepEqual(notifications[1], [
    "Usage: /live [start|browser|stop|end|off|mute|unmute|voice <name>|status|setup|help]",
    "error",
  ]);
  assert.deepEqual(notifications[2], [
    "Pi Live voice set to cedar for the next call.",
    "info",
  ]);
  assert.match(notifications[3]?.[0] ?? "", /alloy.*cedar/);
  assert.equal(notifications[3]?.[1], "error");
  assert.equal(voice, "cedar");
  assert.equal(writes, 1);
  assert.equal(compatibilityCalls, 0);
});

test("the renderer uses Pi terminal width semantics and removes controls", async (t) => {
  const agentDir = await mkdtemp(path.join(tmpdir(), "pi-live-width-test-"));
  t.after(async () => rm(agentDir, { recursive: true }));
  const loaded = await discoverAndLoadExtensions(
    [path.join(import.meta.dirname, "../index.ts")],
    process.cwd(),
    agentDir,
  );
  assert.deepEqual(loaded.errors, []);
  const renderer = loaded.extensions[0]?.messageRenderers.get(
    "better-openai-live-delegation",
  );
  assert.ok(renderer);
  const component = renderer(
    {
      role: "custom",
      customType: "better-openai-live-delegation",
      content: [
        {
          type: "text",
          text: "e\u0301clair\n界a\n🙂x\nA\u0007B\n👨‍👩‍👧‍👦x",
        },
      ],
      display: true,
      timestamp: 0,
    },
    { expanded: false, outputPad: 1 },
    {} as never,
  );
  assert.ok(component);
  const plain = component
    .render(2)
    .map((line: string) => line.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, ""));
  assert.deepEqual(plain, ["Li", "e\u0301c", "界", "🙂", "A ", "👨‍👩‍👧‍👦"]);
  assert.equal(plain.join("").includes("\u0007"), false);
});

test("start reports invalid preferences without a widget or compatibility read", async () => {
  const harness = registrationHarness();
  let compatibilityCalls = 0;
  registerPiLive(harness.pi, {
    preferences: {
      async load() {
        throw new PreferenceError("malformed");
      },
      async setVoice() {
        throw new PreferenceError("malformed");
      },
    },
    compatibility: {
      async check() {
        compatibilityCalls += 1;
        return { supported: true, issues: [] };
      },
    },
    truncateToWidth: noClip,
    runtime: { lifecycle: { coordination: createIsolatedLiveCoordination() } },
  });
  const notifications: Array<[string, string | undefined]> = [];
  const widgetCalls: WidgetCall[] = [];

  await commandFrom(harness).handler(
    "start",
    context("tui", notifications, widgetCalls),
  );

  assert.deepEqual(notifications, [
    ["Pi Live preference is malformed.", "error"],
  ]);
  assert.deepEqual(widgetCalls, []);
  assert.equal(compatibilityCalls, 0);
});

test("voice write failure reports uncertainty after the writer runs", async () => {
  const harness = registrationHarness();
  const written: string[] = [];
  registerPiLive(harness.pi, {
    preferences: {
      async load() {
        return { voice: "marin", fields: {} };
      },
      async setVoice(voice) {
        written.push(voice);
        throw new PreferenceError("unsafe-path");
      },
    },
    compatibility: {
      async check() {
        return { supported: true, issues: [] };
      },
    },
    truncateToWidth: noClip,
    runtime: { lifecycle: { coordination: createIsolatedLiveCoordination() } },
  });
  const notifications: Array<[string, string | undefined]> = [];
  await commandFrom(harness).handler(
    "voice alloy",
    context("tui", notifications, []),
  );
  assert.deepEqual(written, ["alloy"]);
  assert.deepEqual(notifications, [
    ["Pi Live preference could not be accessed or written.", "error"],
  ]);
});

test("unsupported compatibility refuses before consent or widget", async () => {
  const harness = registrationHarness();
  let preferenceReads = 0;
  let compatibilityChecks = 0;
  registerPiLive(harness.pi, {
    preferences: {
      async load() {
        preferenceReads += 1;
        return { voice: "verse", fields: { voice: "verse" } };
      },
      async setVoice() {
        throw new Error("unexpected preference write");
      },
    },
    compatibility: {
      async check() {
        compatibilityChecks += 1;
        return {
          supported: false,
          issues: ["platform", "native-metadata"],
        };
      },
    },
    truncateToWidth: noClip,
    runtime: { lifecycle: { coordination: createIsolatedLiveCoordination() } },
  });
  const notifications: Array<[string, string | undefined]> = [];
  const widgetCalls: WidgetCall[] = [];

  await commandFrom(harness).handler(
    "start",
    context("tui", notifications, widgetCalls),
  );

  assert.deepEqual(widgetCalls, []);
  assert.deepEqual(notifications, [
    ["Pi Live: unsupported (platform, native-metadata).", "warning"],
  ]);
  assert.equal(preferenceReads, 1);
  assert.equal(compatibilityChecks, 1);
});

test("the renderer labels visible delegation text and shutdown clears only pi-live", async () => {
  const harness = registrationHarness();
  registerPiLive(harness.pi, {
    preferences: {
      async load() {
        return { voice: "marin", fields: {} };
      },
      async setVoice() {},
    },
    compatibility: {
      async check() {
        return { supported: true, issues: [] };
      },
    },
    truncateToWidth: noClip,
    runtime: { lifecycle: { coordination: createIsolatedLiveCoordination() } },
  });
  const renderer = harness.renderers.get("better-openai-live-delegation");
  assert.ok(renderer);
  const component = renderer(
    {
      role: "custom",
      customType: "better-openai-live-delegation",
      content: [{ type: "text", text: "Inspect the failing check" }],
      display: true,
      timestamp: 0,
    },
    { expanded: false, outputPad: 1 },
    {} as never,
  );
  assert.ok(component);
  assert.match(component.render(80).join("\n"), /Live request/);
  assert.match(component.render(80).join("\n"), /Inspect the failing check/);

  const widgetCalls: WidgetCall[] = [];
  const notifications: Array<[string, string | undefined]> = [];
  const shutdown = harness.events.get("session_shutdown")?.at(-1);
  assert.ok(shutdown);
  await shutdown(
    { type: "session_shutdown", reason: "quit" },
    context("tui", notifications, widgetCalls),
  );
  assert.deepEqual(widgetCalls, [["pi-live", undefined]]);
  assert.deepEqual(notifications, []);
});

test("every non-TUI command and the shortcut refuse before touching terminal presentation", async () => {
  const harness = registrationHarness();
  let dependencyCalls = 0;
  registerPiLive(harness.pi, {
    preferences: {
      async load() {
        dependencyCalls += 1;
        return { voice: "marin", fields: {} };
      },
      async setVoice() {
        dependencyCalls += 1;
      },
    },
    compatibility: {
      async check() {
        dependencyCalls += 1;
        return { supported: true, issues: [] };
      },
    },
    truncateToWidth: noClip,
    runtime: { lifecycle: { coordination: createIsolatedLiveCoordination() } },
  });
  const notifications: Array<[string, string | undefined]> = [];
  const widgetCalls: WidgetCall[] = [];
  const ctx = context("print", notifications, widgetCalls);

  for (const args of [
    "",
    "start",
    "browser",
    "stop",
    "end",
    "off",
    "mute",
    "unmute",
    "status",
    "setup",
    "help",
    "voice",
    "voice cedar",
    "unknown",
  ]) {
    await commandFrom(harness).handler(args, ctx);
  }
  await harness.shortcuts.get("ctrl+shift+l")?.handler(ctx);

  assert.equal(notifications.length, 15);
  for (const notification of notifications) {
    assert.deepEqual(notification, [
      "Pi Live requires interactive TUI mode.",
      "warning",
    ]);
  }
  assert.deepEqual(widgetCalls, []);
  assert.equal(dependencyCalls, 0);
});

test("browser sidecars are not probed or offered without a dialog-capable UI", async () => {
  const harness = registrationHarness();
  const notifications: Array<[string, string | undefined]> = [];
  const current = context("tui", notifications, []);
  current.hasUI = false;
  registerPiLive(harness.pi, {
    preferences: {
      load: async () => ({ voice: "marin", fields: {} }),
      setVoice: async () => {},
    },
    compatibility: { check: async () => ({ supported: true, issues: [] }) },
    truncateToWidth: noClip,
    browser: () => ({
      controller: { page: () => undefined, run: async () => undefined },
      sidecar: {
        url: "ws://127.0.0.1:8787",
        directory: "/fixture/checkout",
        probe: async () => {
          assert.fail("no sidecar probe without UI");
        },
        start: () => {
          assert.fail("no sidecar start without UI");
        },
      },
    }),
    runtime: { lifecycle: { coordination: createIsolatedLiveCoordination() } },
  });
  await commandFrom(harness).handler("browser", current);
  assert.ok(!notifications.some(([message]) => /protocol-error/.test(message)));
});

test("/live setup asks first, reports the result, and is unavailable without a setup dependency", async () => {
  const run = async (options: {
    setup?: () => Promise<LiveSetupResult>;
    confirm: boolean;
  }) => {
    const harness = registrationHarness();
    registerPiLive(harness.pi, {
      preferences: {
        load: async () => ({ voice: "marin", fields: {} }),
        async setVoice() {},
      },
      compatibility: {
        check: async () => ({ supported: true, issues: [] }),
      },
      truncateToWidth: noClip,
      ...(options.setup ? { setup: options.setup } : {}),
      runtime: {
        lifecycle: { coordination: createIsolatedLiveCoordination() },
      },
    });
    const notifications: Array<[string, string | undefined]> = [];
    const prompts: string[] = [];
    const ctx = context("tui", notifications, []);
    (ctx.ui as { confirm: unknown }).confirm = async (title: string) => {
      prompts.push(title);
      return options.confirm;
    };
    await commandFrom(harness).handler("setup", ctx);
    return { notifications, prompts };
  };

  let setupCalls = 0;
  const ready = async () => {
    setupCalls += 1;
    return { kind: "ready" as const, stateParent: "/fixture/state" };
  };
  assert.deepEqual(await run({ setup: ready, confirm: false }), {
    notifications: [["Pi Live setup cancelled.", "info"]],
    prompts: ["Set up Pi Live?"],
  });
  assert.equal(setupCalls, 0);
  assert.deepEqual((await run({ setup: ready, confirm: true })).notifications, [
    ["Pi Live is set up in /fixture/state. Run /live to start a call.", "info"],
  ]);
  assert.equal(setupCalls, 1);
  assert.deepEqual(
    (
      await run({
        setup: async () => ({ kind: "refused", reason: "Not local." }),
        confirm: true,
      })
    ).notifications,
    [["Pi Live setup refused: Not local.", "error"]],
  );
  assert.deepEqual(await run({ confirm: true }), {
    notifications: [["Pi Live setup is unavailable.", "error"]],
    prompts: [],
  });
});
