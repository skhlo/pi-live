import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const EXPECTED_SOURCE_HEAD = "39171682343754366439b2c0890f5b0f4c3ed891";
const sourceRoot = process.env.LIVE_SOURCE ?? "/tmp/pi-better-openai.qnz8hk";
const sourceHead = execFileSync("git", ["-C", sourceRoot, "rev-parse", "HEAD"], {
  encoding: "utf8",
}).trim();
if (sourceHead !== EXPECTED_SOURCE_HEAD) {
  throw new Error(`expected ${EXPECTED_SOURCE_HEAD}, found ${sourceHead}`);
}

const live = (await import(pathToFileURL(join(sourceRoot, "src/live/index.ts")).href)) as {
  LIVE_COMMAND: string;
  registerOpenAILive: (
    pi: unknown,
    getConfig: () => unknown,
    dependencies: Record<string, unknown>,
  ) => {
    isActive(): boolean;
    stop(): Promise<void>;
  };
};

type Session = {
  id: string;
  muted: boolean;
  started: boolean;
  stopCalled: boolean;
  stopResolved: boolean;
  resolveStop: () => void;
};

function waitTurn(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await waitTurn();
  }
  throw new Error("timed out waiting for the fake registration harness");
}

const events: string[] = [];
const commands = new Map<string, { handler(args: string, context: unknown): Promise<void> }>();
const sessions: Session[] = [];
let callbacks: { onActivated(cause: string): void; onDeactivated(): void } | undefined;
let floorHeld = false;
let finishUi: ((value: unknown) => void) | undefined;
let component: { handleInput(data: string): void; dispose?(): void } | undefined;

const fakePi = {
  registerCommand(
    name: string,
    options: { handler(args: string, context: unknown): Promise<void> },
  ) {
    commands.set(name, options);
  },
  registerShortcut() {},
  registerMessageRenderer() {},
  on() {},
  sendMessage() {},
};

function createSession(): Record<string, unknown> {
  const id = `session-${sessions.length + 1}`;
  let resolveStop!: () => void;
  const session: Session = {
    id,
    muted: false,
    started: false,
    stopCalled: false,
    stopResolved: false,
    resolveStop: () => resolveStop(),
  };
  const stopPromise = new Promise<void>((resolve) => {
    resolveStop = () => {
      session.stopResolved = true;
      events.push(`stop-resolved:${id}`);
      resolve();
    };
  });
  session.resolveStop = resolveStop;
  sessions.push(session);
  events.push(`create:${id}`);
  return {
    start: async () => {
      session.started = true;
      events.push(`start:${id}`);
    },
    stop: () => {
      session.stopCalled = true;
      events.push(`stop-called:${id}`);
      return stopPromise;
    },
    toggleMute: () => {
      session.muted = !session.muted;
      events.push(`mute:${id}:${session.muted}`);
    },
    handleAgentMessage: () => undefined,
    handleAgentSettled: () => undefined,
  };
}

const arbiter = {
  id: "fake-arbiter",
  label: "luna · fake",
  policy: "focus",
  hasFloor: false,
  join() {
    events.push("join");
  },
  leave() {
    events.push("leave-start");
    if (floorHeld) {
      floorHeld = false;
      callbacks?.onDeactivated();
    }
    events.push("leave-end");
  },
  tick() {},
  setFocused() {},
};

const registration = live.registerOpenAILive(
  fakePi,
  () => ({ live: { enabled: true, voice: "sol" } }),
  {
    createSession,
    createArbiter: (_options: unknown, nextCallbacks: typeof callbacks) => {
      callbacks = nextCallbacks;
      return arbiter;
    },
    probeFocusReporting: async () => true,
    attachFocusReporting: () => () => undefined,
    tickMs: 60_000,
  },
);

const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
};
const fakeTui = {
  requestRender: () => undefined,
  terminal: { write: () => undefined },
  addInputListener: () => () => undefined,
};
const context = {
  mode: "tui",
  cwd: "/worktrees/luna",
  ui: {
    notify: () => undefined,
    custom: async (factory: (...args: unknown[]) => unknown) =>
      new Promise<unknown>((resolve) => {
        finishUi = resolve;
        component = factory(fakeTui, theme, {}, resolve) as typeof component;
      }),
  },
  sessionManager: { getSessionId: () => "session-registration" },
};

const command = commands.get(live.LIVE_COMMAND);
if (!command) throw new Error("live command was not registered");
const commandRun = command.handler("", context);
await waitFor(() => callbacks !== undefined);

if (!callbacks) throw new Error("callbacks were not installed");
floorHeld = true;
callbacks.onActivated("focus");
await waitFor(() => sessions.length === 1 && sessions[0]!.started);
component?.handleInput(" ");

floorHeld = false;
callbacks.onDeactivated();
await waitFor(() => sessions[0]!.stopCalled);
const afterHandoffDeactivation = {
  firstSessionMuted: sessions[0]!.muted,
  firstStopCalled: sessions[0]!.stopCalled,
  firstStopResolved: sessions[0]!.stopResolved,
};

floorHeld = true;
callbacks.onActivated("focus");
await waitFor(() => sessions.length === 2 && sessions[1]!.started);
const whileSecondSessionRuns = {
  firstStopStillPending: !sessions[0]!.stopResolved,
  secondSessionMutedInitially: sessions[1]!.muted,
  sessionsCreated: sessions.length,
};

finishUi?.({});
await commandRun;
const afterCommandReturns = {
  secondStopCalled: sessions[1]!.stopCalled,
  secondStopResolved: sessions[1]!.stopResolved,
  events: [...events],
  registrationStillActive: registration.isActive(),
};

for (const session of sessions) session.resolveStop();
await waitTurn();
component?.dispose?.();

console.log(
  JSON.stringify(
    {
      source: { root: sourceRoot, head: sourceHead },
      fakesOnly: true,
      afterHandoffDeactivation,
      whileSecondSessionRuns,
      afterCommandReturns,
      finalSessionStates: sessions.map(({ id, muted, started, stopCalled, stopResolved }) => ({
        id,
        muted,
        started,
        stopCalled,
        stopResolved,
      })),
    },
    null,
    2,
  ),
);
