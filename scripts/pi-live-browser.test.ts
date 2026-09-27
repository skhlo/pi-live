import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import {
  browserControllerUrl,
  browserDevToolsUrl,
  browserEnvironment,
  createBrowserController,
  createBrowserRouter,
  type BrowserSocketEvents,
} from "../src/browser.ts";
import { probeBrowserController } from "../src/browser-sidecar.ts";

// A deterministic stand-in for voice-browser's WebSocket broadcast protocol.
function fakeController() {
  const sent: Array<Record<string, unknown>> = [];
  let events: BrowserSocketEvents | undefined;
  let closed = 0;
  return {
    sent,
    closed: () => closed,
    socket(_url: string, next: BrowserSocketEvents) {
      events = next;
      queueMicrotask(() => next.onOpen());
      return {
        send: (text: string) =>
          sent.push(JSON.parse(text) as Record<string, unknown>),
        close: () => {
          closed++;
        },
      };
    },
    emit(type: string, payload: unknown) {
      events?.onText(JSON.stringify({ type, payload }));
    },
    /** Echoes the request the way the controller registers an utterance. */
    registered() {
      const request = sent[0]!;
      this.emit("transcript", {
        text: request.text,
        final: true,
        utteranceId: request.utteranceId,
      });
    },
  };
}

const decision = (policy: Record<string, unknown>, trigger = "debounce") => ({
  transcript: "go to wikipedia",
  trigger,
  policy,
});

const release = (id: string) => ({
  type: "transcript",
  text: "",
  final: true,
  utteranceId: `pi-live-${id}-end`,
});

const settled = () => new Promise((resolve) => setImmediate(resolve));

test("browser settings fall back to the env file, variable by variable", async () => {
  const folder = await mkdtemp(path.join(tmpdir(), "pi-live-env-"));
  const envFile = path.join(folder, ".env");
  try {
    assert.deepEqual(browserEnvironment({}, envFile), { values: {} });
    await writeFile(
      envFile,
      [
        "# browser mode",
        'TYPESAFE_API_KEY="file-key"',
        "PI_LIVE_BROWSER_CDP=http://127.0.0.1:9333",
        "PI_LIVE_BROWSER_URL=ws://127.0.0.1:9000",
        "OPENAI_API_KEY=not-read",
        "VOICE_BROWSER_DIR='/tmp/voice browser'",
        "",
      ].join("\n"),
    );
    assert.deepEqual(
      browserEnvironment(
        {
          PI_LIVE_BROWSER_URL: "ws://127.0.0.1:8787",
          PI_LIVE_BROWSER_CDP: " ",
          JEV_API_KEY: "shell-jev",
        },
        envFile,
      ),
      {
        values: {
          PI_LIVE_BROWSER_URL: "ws://127.0.0.1:8787",
          PI_LIVE_BROWSER_CDP: "http://127.0.0.1:9333",
          TYPESAFE_API_KEY: "file-key",
          JEV_API_KEY: "shell-jev",
          VOICE_BROWSER_DIR: "/tmp/voice browser",
        },
      },
    );
    assert.equal(
      browserEnvironment({}, envFile).values.VOICE_BROWSER_DIR,
      "/tmp/voice browser",
    );
    assert.equal(
      browserEnvironment({ VOICE_BROWSER_DIR: "/shell/checkout" }, envFile)
        .values.VOICE_BROWSER_DIR,
      "/shell/checkout",
    );
    const unreadable = browserEnvironment(
      { TYPESAFE_API_KEY: "shell-key" },
      folder,
    );
    assert.deepEqual(unreadable.values, { TYPESAFE_API_KEY: "shell-key" });
    assert.match(
      unreadable.notice ?? "",
      /could not read .*so its settings are ignored/,
    );
  } finally {
    await rm(folder, { recursive: true });
  }
});

test("browser endpoints are plain loopback addresses", () => {
  assert.equal(browserControllerUrl(undefined), "ws://127.0.0.1:8787");
  assert.equal(browserControllerUrl(" "), "ws://127.0.0.1:8787");
  assert.equal(
    browserControllerUrl("ws://localhost:9000"),
    "ws://localhost:9000",
  );
  assert.equal(browserControllerUrl("ws://[::1]:9000"), "ws://[::1]:9000");
  for (const refused of [
    "wss://127.0.0.1:8787",
    "http://127.0.0.1:8787",
    "ws://example.com:8787",
    "ws://192.168.1.2:8787",
    "ws://user:secret@127.0.0.1:8787",
    "not a url",
  ])
    assert.equal(browserControllerUrl(refused), undefined, refused);

  assert.equal(browserDevToolsUrl(undefined), undefined);
  assert.equal(browserDevToolsUrl(" "), undefined);
  assert.equal(
    browserDevToolsUrl("http://127.0.0.1:9333"),
    "http://127.0.0.1:9333",
  );
  for (const refused of ["ws://127.0.0.1:9333", "http://example.com:9333"])
    assert.equal(browserDevToolsUrl(refused), undefined, refused);
});

test("a completed action reports the observed page", async () => {
  const fake = fakeController();
  const controller = createBrowserController("ws://127.0.0.1:1", {
    socket: fake.socket,
  });
  const run = controller.run(
    "d1",
    "go to wikipedia",
    new AbortController().signal,
  );
  await settled();
  assert.deepEqual(fake.sent[0], {
    type: "transcript",
    text: "go to wikipedia",
    final: true,
    utteranceId: "pi-live-d1",
  });
  fake.emit("hello", {
    snapshot: { url: "https://example.com/", title: "Example" },
  });
  assert.deepEqual(controller.page(), {
    url: "https://example.com/",
    title: "Example",
  });
  // Events from before the controller registers this request belong to others.
  fake.emit("decision", decision({ decision: "ignore", summary: "stale" }));
  fake.registered();
  fake.emit(
    "decision",
    decision({ decision: "act", summary: "open wikipedia" }),
  );
  fake.emit("action", {
    action: { type: "navigate_url", label: "wikipedia" },
    ok: true,
    detail: "https://www.wikipedia.org/",
  });
  fake.emit("snapshot", {
    url: "https://www.wikipedia.org/",
    title: "Wikipedia",
  });
  assert.deepEqual(await run, {
    text: 'Done: wikipedia. The page is now "Wikipedia" (https://www.wikipedia.org/).',
    handOff: false,
  });
  assert.deepEqual(controller.page(), {
    url: "https://www.wikipedia.org/",
    title: "Wikipedia",
  });
  // It acted, so there is nothing to release.
  assert.equal(fake.sent.length, 1);
  assert.equal(fake.closed(), 1);
});

test("an earlier request's action is not reported as this one", async () => {
  const fake = fakeController();
  const run = createBrowserController("ws://127.0.0.1:1", {
    socket: fake.socket,
    settleMs: 5,
  }).run("b", "scroll down", new AbortController().signal);
  await settled();
  fake.registered();
  // Request A was still executing when B registered.
  fake.emit("action", { action: { label: "open youtube" }, ok: true });
  fake.emit("snapshot", { url: "https://youtube.com/", title: "YouTube" });
  fake.emit("decision", decision({ decision: "act", summary: "scroll" }));
  fake.emit("action", { action: { label: "scroll down" }, ok: true });
  assert.deepEqual(await run, {
    text: "Done: scroll down. The page may still be loading.",
    handOff: false,
  });
});

test("a spoken number that picks a listed choice acts without a decision", async () => {
  const fake = fakeController();
  const run = createBrowserController("ws://127.0.0.1:1", {
    socket: fake.socket,
  }).run("pick", "two", new AbortController().signal);
  await settled();
  fake.registered();
  fake.emit("action", {
    action: { label: "Turing machine" },
    ok: true,
    via: "candidate-pick",
  });
  fake.emit("snapshot", { url: "https://w.org/tm", title: "Turing machine" });
  assert.equal(
    (await run)?.text,
    'Done: Turing machine. The page is now "Turing machine" (https://w.org/tm).',
  );
});

test("refusals and failures are handed off; questions are relayed", async () => {
  const cases: Array<
    [Array<[string, unknown]>, { text: string; handOff: boolean }]
  > = [
    [
      [
        [
          "decision",
          decision({ decision: "ignore", summary: "not a browser command" }),
        ],
      ],
      {
        text: "the browser controller did not recognize a browser command (not a browser command)",
        handOff: true,
      },
    ],
    [
      [
        ["decision", decision({ decision: "act", summary: "select" })],
        [
          "action",
          {
            action: { type: "select_option", label: "colour" },
            ok: false,
            detail: "no matching option",
          },
        ],
      ],
      {
        text: "the browser controller tried to colour and failed: no matching option",
        handOff: true,
      },
    ],
    [
      [["log", { level: "error", msg: "Jev error: 401 Unauthorized" }]],
      {
        text: "the browser controller reported an error: Jev error: 401 Unauthorized",
        handOff: true,
      },
    ],
    [
      [
        [
          "decision",
          decision({
            decision: "confirm",
            summary: 'say "confirm" to click Buy',
          }),
        ],
      ],
      {
        text: 'Not done yet: it needs confirmation first (say "confirm" to click Buy). The user can say "confirm" or "cancel".',
        handOff: false,
      },
    ],
    [
      [
        [
          "decision",
          decision({ decision: "cancel", summary: "cancelled pending action" }),
        ],
      ],
      { text: "Cancelled the pending browser action.", handOff: false },
    ],
    [
      [
        [
          "candidates",
          [
            { n: 1, id: "a", label: "Alan Turing" },
            { n: 2, id: "b", label: "Turing machine" },
          ],
        ],
      ],
      {
        text: "Not done yet: more than one match. Ask which one: 1. Alan Turing; 2. Turing machine. The user can answer with the number.",
        handOff: false,
      },
    ],
  ];
  for (const [events, expected] of cases) {
    const fake = fakeController();
    const run = createBrowserController("ws://127.0.0.1:1", {
      socket: fake.socket,
    }).run("d1", "request", new AbortController().signal);
    await settled();
    fake.registered();
    for (const [type, payload] of events) fake.emit(type, payload);
    assert.deepEqual(await run, expected, events[0]![0]);
  }
});

test("an unfinished request releases the controller so it stops asking Jev", async () => {
  const incomplete = fakeController();
  const run = createBrowserController("ws://127.0.0.1:1", {
    socket: incomplete.socket,
  }).run("d1", "search something interesting", new AbortController().signal);
  await settled();
  incomplete.registered();
  incomplete.emit(
    "decision",
    decision({ decision: "wait", summary: "search for what?" }),
  );
  incomplete.emit(
    "decision",
    decision({ decision: "wait", summary: "search for what?" }, "silence"),
  );
  assert.deepEqual(await run, {
    text: "the browser controller could not complete the command (search for what?)",
    handOff: true,
  });
  assert.deepEqual(incomplete.sent[1], release("d1"));

  // Numbered choices would otherwise be re-asked every few hundred ms.
  const choices = fakeController();
  const listed = createBrowserController("ws://127.0.0.1:1", {
    socket: choices.socket,
  }).run("d2", "open turing", new AbortController().signal);
  await settled();
  choices.registered();
  choices.emit("candidates", [{ label: "Alan Turing" }]);
  await listed;
  assert.deepEqual(choices.sent[1], release("d2"));

  // A stop releases too, before the socket closes.
  const stopped = fakeController();
  const stop = new AbortController();
  const aborted = createBrowserController("ws://127.0.0.1:1", {
    socket: stopped.socket,
  }).run("d3", "go back", stop.signal);
  await settled();
  stop.abort();
  assert.equal(await aborted, undefined);
  assert.deepEqual(stopped.sent[1], release("d3"));
  assert.equal(stopped.closed(), 1);
});

test("an unreachable controller or a timeout gives no false completion", async () => {
  const run = createBrowserController("ws://127.0.0.1:1", {
    socket: (_url, events) => {
      queueMicrotask(() => events.onClose());
      return { send: () => undefined, close: () => undefined };
    },
  }).run("d1", "go back", new AbortController().signal);
  assert.deepEqual(await run, {
    text: "The browser controller is not reachable at ws://127.0.0.1:1. Start voice-browser first.",
    handOff: true,
    unreachable: true,
  });

  const quiet = fakeController();
  const timedOut = createBrowserController("ws://127.0.0.1:1", {
    socket: quiet.socket,
    timeoutMs: 5,
  }).run("d3", "go back", new AbortController().signal);
  assert.deepEqual(await timedOut, {
    text: "No browser outcome within 0 seconds; the browser may still act.",
    handOff: false,
  });
});

test("the router asks Jev one choice and reads its answer", async () => {
  const bodies: Array<Record<string, unknown>> = [];
  const headers: Array<Record<string, string>> = [];
  let answer: unknown = { route: { type: "choice", choice: "browser_task" } };
  let status = 200;
  const fetchStub: typeof fetch = async (_url, init) => {
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    headers.push(init?.headers as Record<string, string>);
    return new Response(JSON.stringify({ answers: answer }), { status });
  };
  const router = createBrowserRouter("ts-test-key", { fetch: fetchStub });
  const page = { url: "https://www.rolex.com/", title: "Rolex" };

  assert.equal(
    await router.route(
      "look into Rolex all models and search for Submariner",
      page,
    ),
    "browser_task",
  );
  assert.equal(headers[0]!.authorization, "Bearer ts-test-key");
  assert.deepEqual(bodies[0]!.state, {
    request: "look into Rolex all models and search for Submariner",
    current_page: page,
  });
  const questions = bodies[0]!.questions as Record<
    string,
    Record<string, unknown>
  >;
  assert.equal(questions.route!.type, "choice");
  assert.deepEqual(Object.keys(questions.route!.criteria as object), [
    "browser_step",
    "browser_task",
    "other",
  ]);

  answer = { route: { type: "choice", choice: "other" } };
  assert.equal(await router.route("run the tests", undefined), "other");
  answer = { route: { type: "choice", choice: "browser_step" } };
  assert.equal(await router.route("scroll down", undefined), "browser_step");
  answer = { route: { type: "choice", choice: "something_else" } };
  assert.equal(await router.route("scroll down", undefined), undefined);
  status = 401;
  assert.equal(await router.route("scroll down", undefined), undefined);
});

test("the router's timeout fires even when nothing else keeps Node running", async () => {
  // A child process with nothing else pending: a timeout that does not hold
  // the event loop lets the process exit before the router answers.
  const script = `
    import { createBrowserRouter } from ${JSON.stringify(path.join(import.meta.dirname, "../src/browser.ts"))};
    const router = createBrowserRouter("ts-test-key", {
      timeoutMs: 50,
      fetch: (_url, init) => new Promise((_resolve, reject) =>
        init.signal.addEventListener("abort", () => reject(new Error("aborted")))),
    });
    console.log(String(await router.route("scroll down", undefined)));
  `;
  const { stdout } = await promisify(execFile)(
    process.execPath,
    ["--input-type=module", "-e", script],
    { timeout: 10_000 },
  );
  assert.equal(stdout.trim(), "undefined");
});

test("the default socket speaks to a real WebSocket server", async (t) => {
  // ws is already a runtime dependency; load it the way Pi Live does.
  const { WebSocketServer } = createRequire(import.meta.url)("ws") as {
    WebSocketServer: new (options: { server: unknown }) => {
      on(
        event: "connection",
        listener: (socket: {
          on(event: "message", listener: (data: Buffer) => void): void;
          send(text: string): void;
        }) => void,
      ): void;
      close(): void;
    };
  };
  const server = createServer();
  const wss = new WebSocketServer({ server });
  t.after(() => {
    wss.close();
    server.close();
  });
  wss.on("connection", (socket) => {
    socket.on("message", (data) => {
      const request = JSON.parse(data.toString()) as { utteranceId: string };
      const send = (type: string, payload: unknown) =>
        socket.send(JSON.stringify({ type, payload }));
      send("transcript", { utteranceId: request.utteranceId });
      send("decision", { policy: { decision: "act" } });
      send("action", { action: { label: "scroll down" }, ok: true });
      send("snapshot", { url: "https://example.com/", title: "Example" });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  assert.equal(
    await probeBrowserController(`ws://127.0.0.1:${address.port}`),
    true,
  );
  const outcome = await createBrowserController(
    `ws://127.0.0.1:${address.port}`,
  ).run("d1", "scroll down", new AbortController().signal);
  assert.deepEqual(outcome, {
    text: 'Done: scroll down. The page is now "Example" (https://example.com/).',
    handOff: false,
  });
});

test("controller probes time out without a WebSocket handshake and handle refusal", async (t) => {
  const server = createServer();
  const sockets = new Set<import("node:net").Socket>();
  server.on("connection", (socket) => sockets.add(socket));
  t.after(() => {
    for (const socket of sockets) socket.destroy();
    server.close();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const url = `ws://127.0.0.1:${address.port}`;
  assert.equal(await probeBrowserController(url, 10), false);
  for (const socket of sockets) socket.destroy();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  assert.equal(await probeBrowserController(url), false);
});
