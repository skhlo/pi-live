import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const sourceRoot = process.env.LIVE_SOURCE ?? "/tmp/pi-better-openai.qnz8hk";
const expectedHead = "39171682343754366439b2c0890f5b0f4c3ed891";
const sourceHead = execFileSync("git", ["-C", sourceRoot, "rev-parse", "HEAD"], {
  encoding: "utf8",
}).trim();
assert.equal(sourceHead, expectedHead);

const live = await import(pathToFileURL(join(sourceRoot, "src/live/index.ts")).href);
const controllerModule = await import(pathToFileURL(join(sourceRoot, "src/live/controller.ts")).href);
const { LIVE_COMMAND, registerOpenAILive } = live;
const { LiveSessionController } = controllerModule;

const theme = {
  fg: (_color, text) => text,
  bold: (text) => text,
};

function waitTurn() {
  return new Promise((resolve) => setImmediate(resolve));
}

async function waitFor(label, predicate, timeoutMs = 500) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${label}`);
    await waitTurn();
  }
}

async function observe(promise, timeoutMs) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve("timeout"), timeoutMs);
  });
  const result = promise.then(
    () => "resolved",
    () => "rejected",
  );
  const settlement = await Promise.race([result, timeout]);
  clearTimeout(timer);
  return settlement;
}

async function flushMicrotasks() {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
}

function fakeNative() {
  return {
    AudioCapture: class {
      stop() {}
    },
    LiveWebRtcPeer: class {
      async createOffer() {
        return "offline-offer";
      }
      async acceptAnswer() {}
      async waitForOpen() {}
      pushAudio() {}
      setMuted() {}
      async close() {}
    },
    async deviceCheckGenerateToken() {
      return { supported: false, latencyMs: 0 };
    },
    __ompInstallTokioRuntime() {},
  };
}

function makePi() {
  const commands = new Map();
  const events = new Map();
  const sentMessages = [];
  const pi = {
    registerCommand(name, options) {
      commands.set(name, options);
    },
    registerShortcut() {},
    registerMessageRenderer() {},
    on(event, handler) {
      events.set(event, handler);
      return () => undefined;
    },
    sendMessage(message, options) {
      sentMessages.push({ message, options });
    },
  };
  return { pi, commands, events, sentMessages };
}

function makeCustom(captured) {
  return (factory) => {
    let resolveDone;
    const result = new Promise((resolve) => {
      resolveDone = resolve;
    });
    captured.done = resolveDone;
    captured.component = factory(captured.tui, theme, {}, resolveDone);
    return result.then((value) => {
      captured.component?.dispose?.();
      return value;
    });
  };
}

function makeContext(custom, idle, notifications, idleChecks) {
  return {
    mode: "tui",
    hasUI: true,
    cwd: "/probe/project",
    ui: {
      custom,
      notify(message, type) {
        notifications.push({ message, type });
      },
    },
    sessionManager: { getSessionId: () => "probe-session" },
    modelRegistry: {},
    model: undefined,
    scopedModels: [],
    isIdle() {
      idleChecks.count += 1;
      return idle;
    },
    isProjectTrusted: () => true,
    signal: undefined,
    abort: () => undefined,
    hasPendingMessages: () => false,
    shutdown: () => undefined,
    getContextUsage: () => undefined,
    compact: () => undefined,
    getSystemPrompt: () => "",
    getSystemPromptOptions: () => ({}),
    waitForIdle: async () => undefined,
    newSession: async () => ({ cancelled: false }),
    fork: async () => ({ cancelled: false }),
    navigateTree: async () => ({ cancelled: false }),
    switchSession: async () => ({ cancelled: false }),
    reload: async () => undefined,
  };
}

function makeArbiter(events) {
  const control = {
    callbacks: undefined,
    arbiter: undefined,
    createArbiter(options, callbacks) {
      control.callbacks = callbacks;
      control.arbiter = {
        id: "probe-arbiter",
        label: "project · probe",
        policy: options.policy,
        hasFloor: false,
        join: () => events.push("arbiter.join"),
        leave: () => events.push("arbiter.leave"),
        tick: () => events.push("arbiter.tick"),
        setFocused: (focused) => events.push(`arbiter.focus:${focused}`),
      };
      return control.arbiter;
    },
  };
  return control;
}

function makeRegistration(createSession, { idle = true, events = [] } = {}) {
  const pi = makePi();
  const arbiter = makeArbiter(events);
  const captured = {
    component: undefined,
    done: () => undefined,
    tui: {
      requestRender: () => events.push("tui.requestRender"),
      terminal: { write: (data) => events.push(`terminal.write:${data}`) },
      addInputListener: () => () => undefined,
    },
  };
  const notifications = [];
  const idleChecks = { count: 0 };
  const registration = registerOpenAILive(
    pi.pi,
    () => ({ live: { enabled: true, voice: "sol" } }),
    {
      createSession,
      createArbiter: arbiter.createArbiter,
      probeFocusReporting: async () => false,
      attachFocusReporting: () => () => undefined,
      notifyActivatedUnfocused: () => undefined,
      tickMs: 60_000,
    },
  );
  const context = makeContext(makeCustom(captured), idle, notifications, idleChecks);
  const command = pi.commands.get(LIVE_COMMAND);
  assert.ok(command);
  return { pi, arbiter, captured, notifications, idleChecks, registration, context, command };
}

function makeFakeSessionFactory(events, sessions) {
  let nextId = 1;
  return (options) => {
    const session = {
      id: `session-${nextId++}`,
      options,
      muted: false,
      startCalls: 0,
      stopCalls: 0,
      toggleMuteCalls: 0,
      async start() {
        session.startCalls += 1;
        events.push(`session.start:${session.id}`);
        options.callbacks.onPhase("listening");
      },
      async stop() {
        session.stopCalls += 1;
        events.push(`session.stop:${session.id}`);
      },
      toggleMute() {
        session.toggleMuteCalls += 1;
        session.muted = !session.muted;
        events.push(`session.mute:${session.id}:${session.muted}`);
        options.callbacks.onPhase(session.muted ? "muted" : "listening");
      },
      handleAgentMessage() {},
      handleAgentSettled() {},
    };
    sessions.push(session);
    events.push(`session.create:${session.id}`);
    return session;
  };
}

function delegation(id, request) {
  return {
    type: "delegation.created",
    item: {
      type: "delegation",
      target: "client",
      id,
      content: [{ type: "input_text", text: request }],
    },
  };
}

async function parkedCallbacksProbe() {
  const events = [];
  const sessions = [];
  const probe = makeRegistration(makeFakeSessionFactory(events, sessions), { events });
  const commandRun = probe.command.handler("", probe.context);
  await waitFor("arbiter enrollment", () => probe.arbiter.callbacks !== undefined);
  const callbacks = probe.arbiter.callbacks;
  callbacks.onActivated("fifo");
  await waitFor("first session start", () => sessions[0]?.startCalls === 1);
  callbacks.onDeactivated();
  callbacks.onActivated("fifo");
  await waitFor("second session start", () => sessions[1]?.startCalls === 1);
  const parked = sessions[0];
  parked.options.callbacks.onPhase("speaking");
  parked.options.callbacks.onTranscript({
    role: "assistant",
    text: "parked callback transcript",
    turn: 1,
    final: false,
  });
  const staleRender = probe.captured.component.render(80).join("\n");
  assert.match(staleRender, /speaking/);
  assert.match(staleRender, /parked callback transcript/);
  parked.options.callbacks.onTerminal(new Error("late parked terminal"));
  assert.equal(await observe(commandRun, 200), "resolved");
  assert.deepEqual(probe.notifications.at(-1), {
    message: "late parked terminal",
    type: "error",
  });
  return {
    callOrder: events,
    staleRenderObserved: true,
    commandResult: "resolved",
    notification: probe.notifications.at(-1),
  };
}

async function unresolvedDisposalProbe() {
  const events = [];
  const sessions = [];
  let releaseStop;
  const createSession = (options) => {
    const factory = makeFakeSessionFactory(events, sessions);
    const session = factory(options);
    session.stop = async () => {
      session.stopCalls += 1;
      events.push(`session.stop:${session.id}:pending`);
      await new Promise((resolve) => {
        releaseStop = resolve;
      });
      events.push(`session.stop:${session.id}:released`);
    };
    return session;
  };
  const probe = makeRegistration(createSession, { events });
  const commandRun = probe.command.handler("", probe.context);
  await waitFor("arbiter enrollment", () => probe.arbiter.callbacks !== undefined);
  probe.arbiter.callbacks.onActivated("focus");
  await waitFor("session start", () => sessions[0]?.startCalls === 1);
  probe.captured.done({});
  await waitFor("pending session stop", () => releaseStop !== undefined);
  assert.ok(events.indexOf("arbiter.leave") < events.indexOf("session.stop:session-1:pending"));
  assert.equal(await observe(commandRun, 60), "timeout");
  assert.equal(probe.registration.isActive(), true);
  releaseStop();
  assert.equal(await observe(commandRun, 200), "resolved");
  assert.equal(probe.registration.isActive(), false);
  return {
    callOrder: events,
    beforeRelease: "timeout",
    activeBeforeRelease: true,
    afterRelease: "resolved",
  };
}

async function delegationReplacementProbe() {
  let transportOptions;
  const delegated = [];
  const sent = [];
  const controller = new LiveSessionController({
    sessionId: "probe-controller",
    native: fakeNative(),
    getCredentials: async () => undefined,
    delegate: (request) => delegated.push(request),
    createTransport: (options) => {
      transportOptions = options;
      return {
        connect: async () => undefined,
        send: async (message) => {
          sent.push(message);
        },
        pushAudio: () => undefined,
        setMuted: () => undefined,
        close: async () => undefined,
      };
    },
    createAudioCapture: () => ({ stop: () => undefined }),
    callbacks: {
      onPhase: () => undefined,
      onLevels: () => undefined,
      onTranscript: () => undefined,
      onTerminal: () => undefined,
    },
  });
  await controller.start();
  transportOptions.callbacks.onEvent(delegation("delegation-a", "first request"));
  transportOptions.callbacks.onEvent(delegation("delegation-b", "second request"));
  controller.handleAgentMessage({
    role: "assistant",
    content: [{ type: "text", text: "result after the second delegation" }],
    stopReason: "stop",
  });
  controller.handleAgentSettled();
  await flushMicrotasks();
  const contextMessages = sent.filter((message) => message.type === "delegation.context.append");
  assert.deepEqual(delegated, ["first request", "second request"]);
  assert.equal(contextMessages.length, 1);
  assert.equal(contextMessages[0].delegation_item_id, "delegation-b");
  assert.equal(
    contextMessages[0].content[0].text,
    '"Agent Final Message":\n\nresult after the second delegation',
  );
  assert.equal(controller.activeDelegationId, undefined);
  await controller.stop();
  return { delegated, contextMessages, activeDelegationId: null };
}

async function pendingConnectProbe() {
  const events = [];
  let releaseConnect;
  const connect = new Promise((resolve) => {
    releaseConnect = resolve;
  });
  const controller = new LiveSessionController({
    sessionId: "probe-pending-connect",
    native: fakeNative(),
    getCredentials: async () => undefined,
    delegate: () => undefined,
    createTransport: () => ({
      connect: async () => {
        events.push("transport.connect");
        await connect;
      },
      send: async (message) => events.push(`transport.send:${message.type}`),
      pushAudio: () => undefined,
      setMuted: () => undefined,
      close: async () => events.push("transport.close"),
    }),
    createAudioCapture: () => ({ stop: () => events.push("recorder.stop") }),
    callbacks: {
      onPhase: (phase) => events.push(`phase:${phase}`),
      onLevels: () => undefined,
      onTranscript: (transcript) =>
        events.push(`transcript:${transcript === undefined ? "clear" : transcript.text}`),
      onTerminal: (error) => events.push(`terminal:${error?.message ?? "none"}`),
    },
  });
  const startPromise = controller.start();
  await waitFor("pending connect", () => events.includes("transport.connect"));
  const startResult = startPromise
    .then(() => "resolved")
    .catch((error) => `rejected:${error instanceof Error ? error.message : String(error)}`);
  const stopPromise = controller.stop();
  assert.equal(await observe(stopPromise, 200), "resolved");
  assert.equal(await observe(startResult, 30), "timeout");
  assert.ok(events.includes("transport.send:session.close"));
  assert.ok(events.includes("transport.close"));
  releaseConnect();
  const finalStartResult = await startResult;
  assert.equal(finalStartResult, "rejected:The live session stopped while connecting.");
  return {
    callOrder: events,
    stopResult: "resolved",
    startBeforeConnectRelease: "timeout",
    startAfterConnectRelease: finalStartResult,
  };
}

async function busyCommandProbe() {
  const events = [];
  const sessions = [];
  const probe = makeRegistration(makeFakeSessionFactory(events, sessions), {
    idle: false,
    events,
  });
  const commandRun = probe.command.handler("", probe.context);
  await waitFor("arbiter enrollment", () => probe.arbiter.callbacks !== undefined);
  probe.arbiter.callbacks.onActivated("focus");
  await waitFor("session start", () => sessions[0]?.startCalls === 1);
  sessions[0].options.delegate("busy-agent request");
  assert.equal(probe.idleChecks.count, 0);
  assert.deepEqual(probe.pi.sentMessages, [
    {
      message: {
        customType: "better-openai-live-delegation",
        content: "busy-agent request",
        display: true,
        details: { source: "live" },
      },
      options: { triggerTurn: true, deliverAs: "steer" },
    },
  ]);
  probe.captured.done({});
  assert.equal(await observe(commandRun, 200), "resolved");
  return {
    idleChecks: probe.idleChecks.count,
    sessionStarted: sessions[0].startCalls,
    sentMessages: probe.pi.sentMessages,
    commandResult: "resolved",
  };
}

async function muteReactivationProbe() {
  const events = [];
  const sessions = [];
  const probe = makeRegistration(makeFakeSessionFactory(events, sessions), { events });
  const commandRun = probe.command.handler("", probe.context);
  await waitFor("arbiter enrollment", () => probe.arbiter.callbacks !== undefined);
  const callbacks = probe.arbiter.callbacks;
  callbacks.onActivated("focus");
  await waitFor("first session start", () => sessions[0]?.startCalls === 1);
  probe.captured.component.handleInput(" ");
  assert.equal(sessions[0].toggleMuteCalls, 1);
  assert.equal(sessions[0].muted, true);
  assert.match(probe.captured.component.render(80).join("\n"), /muted/);
  callbacks.onDeactivated();
  assert.match(probe.captured.component.render(80).join("\n"), /standby/);
  callbacks.onActivated("focus");
  await waitFor("second session start", () => sessions[1]?.startCalls === 1);
  assert.equal(sessions[1].muted, false);
  assert.equal(sessions[1].toggleMuteCalls, 0);
  assert.match(probe.captured.component.render(80).join("\n"), /listening/);
  probe.captured.done({});
  assert.equal(await observe(commandRun, 200), "resolved");
  return {
    callOrder: events,
    firstSession: { muted: sessions[0].muted, toggleMuteCalls: sessions[0].toggleMuteCalls },
    secondSession: { muted: sessions[1].muted, toggleMuteCalls: sessions[1].toggleMuteCalls },
    commandResult: "resolved",
  };
}

const results = {
  parkedCallbacks: await parkedCallbacksProbe(),
  unresolvedDisposal: await unresolvedDisposalProbe(),
  delegationReplacement: await delegationReplacementProbe(),
  pendingConnect: await pendingConnectProbe(),
  busyCommand: await busyCommandProbe(),
  muteReactivation: await muteReactivationProbe(),
};

console.log(JSON.stringify({ sourceHead, fakesOnly: true, results }, null, 2));
