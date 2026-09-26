import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { test } from "node:test";
import {
  browserControllerUrl,
  browserDevToolsUrl,
  createBrowserController,
  createBrowserRouter,
  type BrowserSocketEvents,
} from "../src/browser.ts";

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

const settled = () => new Promise((resolve) => setImmediate(resolve));

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
  assert.equal(fake.closed(), 1);
});

test("refusals and failures are handed off; questions are relayed", async () => {
  const cases: Array<[string, unknown, { text: string; handOff: boolean }]> = [
    [
      "decision",
      decision({ decision: "ignore", summary: "not a browser command" }),
      {
        text: "the browser controller did not recognize a browser command (not a browser command)",
        handOff: true,
      },
    ],
    [
      "action",
      {
        action: { type: "select_option", label: "colour" },
        ok: false,
        detail: "no matching option",
      },
      {
        text: "the browser controller tried to colour and failed: no matching option",
        handOff: true,
      },
    ],
    [
      "log",
      { level: "error", msg: "Jev error: 401 Unauthorized" },
      {
        text: "the browser controller reported an error: Jev error: 401 Unauthorized",
        handOff: true,
      },
    ],
    [
      "decision",
      decision({
        decision: "confirm",
        summary: 'say "confirm" to click Buy',
      }),
      {
        text: 'Not done yet: it needs confirmation first (say "confirm" to click Buy). The user can say "confirm" or "cancel".',
        handOff: false,
      },
    ],
    [
      "decision",
      decision({ decision: "cancel", summary: "cancelled pending action" }),
      { text: "Cancelled the pending browser action.", handOff: false },
    ],
    [
      "candidates",
      [
        { n: 1, id: "a", label: "Alan Turing" },
        { n: 2, id: "b", label: "Turing machine" },
      ],
      {
        text: "Not done yet: more than one match. Ask which one: 1. Alan Turing; 2. Turing machine. The user can answer with the number.",
        handOff: false,
      },
    ],
  ];
  for (const [type, payload, expected] of cases) {
    const fake = fakeController();
    const run = createBrowserController("ws://127.0.0.1:1", {
      socket: fake.socket,
    }).run("d1", "request", new AbortController().signal);
    await settled();
    fake.registered();
    fake.emit(type, payload);
    assert.deepEqual(await run, expected, type);
  }
});

test("an incomplete command is handed off and stops controller retries", async () => {
  const fake = fakeController();
  const run = createBrowserController("ws://127.0.0.1:1", {
    socket: fake.socket,
  }).run("d1", "search something interesting", new AbortController().signal);
  await settled();
  fake.registered();
  fake.emit(
    "decision",
    decision({ decision: "wait", summary: "search for what?" }),
  );
  fake.emit(
    "decision",
    decision({ decision: "wait", summary: "search for what?" }, "silence"),
  );
  assert.deepEqual(await run, {
    text: "the browser controller could not complete the command (search for what?)",
    handOff: true,
  });
  assert.deepEqual(fake.sent[1], {
    type: "transcript",
    text: "",
    final: true,
    utteranceId: "pi-live-d1-end",
  });
});

test("an unreachable controller, a stop or a timeout gives no false completion", async () => {
  const run = createBrowserController("ws://127.0.0.1:1", {
    socket: (_url, events) => {
      queueMicrotask(() => events.onClose());
      return { send: () => undefined, close: () => undefined };
    },
  }).run("d1", "go back", new AbortController().signal);
  assert.deepEqual(await run, {
    text: "The browser controller is not reachable at ws://127.0.0.1:1. Start voice-browser first.",
    handOff: false,
  });

  const stopped = fakeController();
  const stop = new AbortController();
  const aborted = createBrowserController("ws://127.0.0.1:1", {
    socket: stopped.socket,
  }).run("d2", "go back", stop.signal);
  await settled();
  stop.abort();
  assert.equal(await aborted, undefined);
  assert.equal(stopped.closed(), 1);

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
  const signal = new AbortController().signal;
  const page = { url: "https://www.rolex.com/", title: "Rolex" };

  assert.equal(
    await router.route(
      "look into Rolex all models and search for Submariner",
      page,
      signal,
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
  assert.equal(await router.route("run the tests", undefined, signal), "pi");
  answer = { route: { type: "choice", choice: "browser_step" } };
  assert.equal(await router.route("scroll down", undefined, signal), "browser");
  answer = { route: { type: "choice", choice: "something_else" } };
  assert.equal(await router.route("scroll down", undefined, signal), undefined);
  status = 401;
  assert.equal(await router.route("scroll down", undefined, signal), undefined);

  const hung = createBrowserRouter("ts-test-key", {
    timeoutMs: 5,
    fetch: (_url, init) =>
      new Promise((_resolve, reject) =>
        init?.signal?.addEventListener("abort", () =>
          reject(new Error("aborted")),
        ),
      ),
  });
  assert.equal(await hung.route("scroll down", undefined, signal), undefined);
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
      send("action", { action: { label: "scroll down" }, ok: true });
      send("snapshot", { url: "https://example.com/", title: "Example" });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const outcome = await createBrowserController(
    `ws://127.0.0.1:${address.port}`,
  ).run("d1", "scroll down", new AbortController().signal);
  assert.deepEqual(outcome, {
    text: 'Done: scroll down. The page is now "Example" (https://example.com/).',
    handOff: false,
  });
});
