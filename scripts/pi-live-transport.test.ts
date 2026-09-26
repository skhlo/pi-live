import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";

import {
  createDefaultLiveNetworkAdapter,
  createLiveRuntimeResources,
  type LiveCredentials,
  type LiveDefaultNetworkDependencies,
  type LiveHttpResponse,
  type LiveNativeAdapter,
  type LiveNativePeer,
  type LiveNetworkAdapter,
  type LiveRuntimeDiagnostic,
  type LiveSidebandSocket,
  type LiveSidebandStartInput,
  createDefaultLiveNativeAdapter,
  type DefaultNativeBindings,
} from "../src/live.ts";
import {
  approvingConsent,
  createFakeCapture,
  createLiveFixture,
  deferred,
  ManualClock,
  settledStart,
} from "./test-support/live-fixture.ts";
import { waitForCondition } from "./test-support/live-wait.ts";

const credentials: LiveCredentials = { apiKey: "sk-fixture-key" };

function sessionAnswer(sdp: string, sessionId = "live_fixture"): string {
  return JSON.stringify({
    session: { id: sessionId },
    transport: { type: "webrtc", sdp },
  });
}

/** A created session answering with `sdp`, or a raw body when given. */
function response(
  sdp: string,
  options: { status?: number; statusText?: string; raw?: string } = {},
): LiveHttpResponse {
  return {
    status: options.status ?? 201,
    statusText: options.statusText ?? "Created",
    body: (async function* () {
      yield Buffer.from(options.raw ?? sessionAnswer(sdp));
    })(),
    cancel: () => undefined,
  };
}

function fakeSocket(sent: string[] = []): LiveSidebandSocket {
  return {
    bufferedAmount: () => 0,
    async sendText(payload) {
      sent.push(payload);
    },
    async sendPong() {},
    async close() {
      return true;
    },
  };
}

function fakeNative(
  overrides: Partial<LiveNativePeer> = {},
): LiveNativeAdapter {
  const peer: LiveNativePeer = {
    createOffer: async () => "fixture-offer",
    acceptAnswer: async () => undefined,
    waitForOpen: async () => undefined,
    pushAudio: () => undefined,
    setMuted: () => undefined,
    close: async () => true,
    ...overrides,
  };
  return {
    createPeer: () => settledStart(peer),
    startCapture: () => settledStart(createFakeCapture()),
  };
}

async function connectWith(
  native: LiveNativeAdapter,
  network: LiveNetworkAdapter,
  options: {
    clock?: ManualClock;
    randomId?: () => string;
    proxyForUrl?: (
      url: string,
    ) => string | undefined | Promise<string | undefined>;
  } = {},
) {
  const resources = createLiveRuntimeResources({
    registry: { getApiKeyForProvider: async () => undefined },
    instructions: "fixture instructions",
    native,
    network,
    clock: options.clock,
    randomId: options.randomId ?? (() => "realtime-session"),
    proxyForUrl: options.proxyForUrl,
  });
  const controller = new AbortController();
  const started = resources.connect({
    signal: controller.signal,
    deadline:
      options.clock?.nowValue === undefined
        ? performance.now() + 30_000
        : options.clock.nowValue + 30_000,
    credentials,
    voice: "marin",
  });
  return { resources, controller, started };
}

test("signaling creates a GPT-Live session and the sideband attaches to it with the API key", async (t) => {
  const signaling: Array<Parameters<LiveNetworkAdapter["signal"]>[0]> = [];
  const sideband: LiveSidebandStartInput[] = [];
  const proxyUrls: string[] = [];
  const socket = fakeSocket();
  const network: LiveNetworkAdapter = {
    signal(input) {
      signaling.push(input);
      return settledStart(
        response("", { raw: sessionAnswer("fixture-answer", "live_abc-123") }),
      );
    },
    openSideband(input) {
      sideband.push(input);
      return settledStart(socket);
    },
  };
  let acceptedAnswer: string | undefined;
  const { started } = await connectWith(
    fakeNative({
      async acceptAnswer(answer) {
        acceptedAnswer = answer;
      },
    }),
    network,
    {
      proxyForUrl(url) {
        proxyUrls.push(url);
        return url.startsWith("wss:")
          ? "http://sideband-proxy.invalid"
          : "http://signaling-proxy.invalid";
      },
    },
  );
  const connection = await started.result;
  t.after(async () => {
    await connection.close();
  });

  assert.equal(signaling.length, 1);
  const request = signaling[0]!;
  assert.equal(request.url, "https://api.openai.com/v1/live/sessions");
  assert.equal(request.redirect, "manual");
  assert.equal(request.proxyUrl, "http://signaling-proxy.invalid");
  assert.deepEqual(request.headers, {
    Authorization: "Bearer sk-fixture-key",
    Accept: "application/json",
    "Content-Type": "application/json",
  });
  assert.deepEqual(JSON.parse(request.body), {
    session: {
      model: "gpt-live-1",
      instructions: "fixture instructions",
      audio: { output: { voice: "marin" } },
      delegation: { type: "client" },
    },
    transport: { type: "webrtc", sdp: "fixture-offer" },
  });
  assert.equal(acceptedAnswer, "fixture-answer");

  assert.equal(sideband.length, 1);
  assert.equal(
    sideband[0]?.url,
    "wss://api.openai.com/v1/live/sessions/live_abc-123/attach",
  );
  assert.deepEqual(sideband[0]?.headers, {
    Authorization: "Bearer sk-fixture-key",
  });
  assert.equal(sideband[0]?.followRedirects, false);
  assert.equal(sideband[0]?.maxPayloadBytes, 256 * 1_024);
  assert.equal(sideband[0]?.autoPong, false);
  assert.equal(sideband[0]?.proxyUrl, "http://sideband-proxy.invalid");
  assert.deepEqual(proxyUrls, [request.url, sideband[0]!.url]);
});

test("the retained proxy environment selects both HTTP and WebSocket proxy paths without exposing it", async (t) => {
  const previous = {
    HTTPS_PROXY: process.env.HTTPS_PROXY,
    ALL_PROXY: process.env.ALL_PROXY,
    NO_PROXY: process.env.NO_PROXY,
  };
  process.env.HTTPS_PROXY = "http://fixture-user:fixture-secret@127.0.0.1:9";
  process.env.ALL_PROXY = "http://fixture-user:fixture-secret@127.0.0.1:9";
  delete process.env.NO_PROXY;
  t.after(() => {
    if (previous.HTTPS_PROXY === undefined) delete process.env.HTTPS_PROXY;
    else process.env.HTTPS_PROXY = previous.HTTPS_PROXY;
    if (previous.ALL_PROXY === undefined) delete process.env.ALL_PROXY;
    else process.env.ALL_PROXY = previous.ALL_PROXY;
    if (previous.NO_PROXY === undefined) delete process.env.NO_PROXY;
    else process.env.NO_PROXY = previous.NO_PROXY;
  });
  const selected: string[] = [];
  const network: LiveNetworkAdapter = {
    signal(input) {
      selected.push(input.proxyUrl ?? "");
      return settledStart(response("answer"));
    },
    openSideband(input) {
      selected.push(input.proxyUrl ?? "");
      return settledStart(fakeSocket());
    },
  };
  const { started } = await connectWith(fakeNative(), network);
  const connection = await started.result;
  t.after(async () => connection.close());
  assert.deepEqual(selected, [
    "http://fixture-user:fixture-secret@127.0.0.1:9",
    "http://fixture-user:fixture-secret@127.0.0.1:9",
  ]);
});

test("the default network adapter owns direct/proxy dispatchers and promptly joins WebSocket teardown", async (t) => {
  const dispatcherKinds: string[] = [];
  const fetchedWith: string[] = [];
  const destroyedDispatchers: string[] = [];
  const destroyedSocketAgents: string[] = [];
  const socketOptions: Record<string, unknown>[] = [];
  let socketTerminations = 0;

  const dispatcher = (kind: string) => ({
    async destroy() {
      destroyedDispatchers.push(kind);
    },
  });
  class FakeWebSocket extends EventEmitter {
    readyState = 1;
    bufferedAmount = 0;

    send(_payload: string, callback: (error?: Error) => void): void {
      callback();
    }

    pong(_payload: Uint8Array, callback: (error?: Error) => void): void {
      callback();
    }

    close(): void {
      assert.fail(
        "teardown must not enter the dependency's graceful close wait",
      );
    }

    terminate(): void {
      socketTerminations += 1;
      this.readyState = 3;
      this.emit("close", 1006);
    }
  }
  const dependencies: LiveDefaultNetworkDependencies = {
    createHttpAgent() {
      dispatcherKinds.push("direct");
      return dispatcher("direct");
    },
    createHttpProxyAgent(url) {
      assert.equal(url, "http://proxy.invalid");
      dispatcherKinds.push("proxy");
      return dispatcher("proxy");
    },
    async fetch(_url, input) {
      fetchedWith.push(
        input.dispatcher === undefined ? "missing" : dispatcherKinds.at(-1)!,
      );
      return {
        status: 200,
        statusText: "OK",
        headers: { get: () => null },
        body: {
          async *[Symbol.asyncIterator]() {
            yield Buffer.from("answer");
          },
          async cancel() {},
        },
      };
    },
    createWebSocket(_url, options) {
      socketOptions.push(options);
      const socket = new FakeWebSocket();
      queueMicrotask(() => socket.emit("open"));
      return socket;
    },
    createWebSocketProxyAgent(url) {
      assert.equal(url, "http://proxy.invalid");
      return {
        async destroy() {
          destroyedSocketAgents.push("proxy");
        },
      };
    },
  };
  const adapter = createDefaultLiveNetworkAdapter(dependencies);
  for (const proxyUrl of [undefined, "http://proxy.invalid"] as const) {
    const started = adapter.signal({
      url: "https://example.invalid/signal",
      method: "POST",
      redirect: "manual",
      headers: {},
      body: "{}",
      ...(proxyUrl ? { proxyUrl } : {}),
      signal: new AbortController().signal,
    });
    await started.result;
    await started.terminate(async (owned) => owned.cancel());
  }
  assert.deepEqual(dispatcherKinds, ["direct", "proxy"]);
  assert.deepEqual(fetchedWith, ["direct", "proxy"]);
  assert.deepEqual(destroyedDispatchers, ["direct", "proxy"]);

  const sidebandInput = {
    url: "wss://api.openai.com/v1/live/sessions/live_low_level/attach",
    headers: {},
    followRedirects: false as const,
    maxPayloadBytes: 256 * 1_024,
    autoPong: false as const,
    signal: new AbortController().signal,
    onText: () => undefined,
    onBinary: () => undefined,
    onPing: () => undefined,
    onPong: () => undefined,
    onFailure: () => undefined,
    onClose: () => undefined,
  };
  const directSocket = adapter.openSideband(sidebandInput);
  await directSocket.result;
  await directSocket.terminate(async (owned) => {
    assert.equal(await owned.close(), true);
  });
  assert.equal(socketTerminations, 1);
  assert.equal(socketOptions[0]?.followRedirects, false);
  assert.equal(socketOptions[0]?.maxPayload, 256 * 1_024);
  assert.equal(socketOptions[0]?.autoPong, false);

  const proxiedSocket = adapter.openSideband({
    ...sidebandInput,
    proxyUrl: "http://proxy.invalid",
  });
  await proxiedSocket.result;
  await assert.rejects(
    proxiedSocket.terminate(async (owned) => {
      assert.equal(await owned.close(), false);
    }),
    { message: "Live transport cleanup is unconfirmed." },
  );
  assert.equal(socketTerminations, 2);
  assert.deepEqual(destroyedSocketAgents, ["proxy"]);

  const cleanupFailure = createDefaultLiveNetworkAdapter({
    ...dependencies,
    createHttpAgent() {
      return {
        async destroy() {
          throw new Error("synthetic dispatcher cleanup secret");
        },
      };
    },
  }).signal({
    url: "https://example.invalid/signal",
    method: "POST",
    redirect: "manual",
    headers: {},
    body: "{}",
    signal: new AbortController().signal,
  });
  await cleanupFailure.result;
  await assert.rejects(
    cleanupFailure.terminate(async (owned) => owned.cancel()),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.message, "Live transport cleanup is unconfirmed.");
      assert.equal(String(error).includes("secret"), false);
      return true;
    },
  );
});

test("default HTTP cancellation owns the real response stream iterator", async (t) => {
  await t.test("overflow cancels through the locked iterator", async () => {
    let streamCancellations = 0;
    let dispatcherDestructions = 0;
    const dependencies: LiveDefaultNetworkDependencies = {
      createHttpAgent: () => ({
        async destroy() {
          dispatcherDestructions += 1;
        },
      }),
      createHttpProxyAgent() {
        throw new Error("proxy must stay unused");
      },
      async fetch() {
        return {
          status: 200,
          statusText: "OK",
          headers: { get: () => null },
          body: new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(Buffer.alloc(2 * 1_024 * 1_024));
              controller.enqueue(Buffer.from("x"));
            },
            cancel() {
              streamCancellations += 1;
            },
          }),
        };
      },
      createWebSocket() {
        throw new Error("overflow must not open sideband");
      },
      createWebSocketProxyAgent() {
        throw new Error("proxy must stay unused");
      },
    };
    const { started } = await connectWith(
      fakeNative(),
      createDefaultLiveNetworkAdapter(dependencies),
    );

    await assert.rejects(started.result, {
      message: "Live transport protocol failed.",
    });
    await started.terminate(async (connection) => connection.close());
    assert.equal(streamCancellations, 1);
    assert.equal(dispatcherDestructions, 1);
  });

  await t.test(
    "termination cancels before joining a pending read",
    async () => {
      const clock = new ManualClock();
      const readPending = deferred<void>();
      let responseBody: ReadableStream<Uint8Array> | undefined;
      let signalAborts = 0;
      let dispatcherDestructions = 0;
      const dependencies: LiveDefaultNetworkDependencies = {
        createHttpAgent: () => ({
          async destroy() {
            dispatcherDestructions += 1;
          },
        }),
        createHttpProxyAgent() {
          throw new Error("proxy must stay unused");
        },
        async fetch(_url, input) {
          return {
            status: 200,
            statusText: "OK",
            headers: { get: () => null },
            body: (responseBody = new ReadableStream<Uint8Array>({
              start(controller) {
                input.signal.addEventListener(
                  "abort",
                  () => {
                    signalAborts += 1;
                    controller.error(new Error("synthetic fetch abort"));
                  },
                  { once: true },
                );
              },
              pull() {
                if (responseBody?.locked) readPending.resolve();
              },
            })),
          };
        },
        createWebSocket() {
          throw new Error("pending body must not open sideband");
        },
        createWebSocketProxyAgent() {
          throw new Error("proxy must stay unused");
        },
      };
      const { started } = await connectWith(
        fakeNative(),
        createDefaultLiveNetworkAdapter(dependencies),
        { clock },
      );
      await readPending.promise;
      assert.equal(responseBody?.locked, true);
      clock.advance(10_000);

      await assert.rejects(started.result, {
        message: "Live transport connection timed out.",
      });
      await started.terminate(async (connection) => connection.close());
      assert.equal(signalAborts, 1);
      assert.equal(dispatcherDestructions, 1);
    },
  );
});

test(
  "termination during the lazy HTTP load constructs no dispatcher and performs no fetch",
  { timeout: 1_000 },
  async () => {
    const loaded =
      deferred<
        Pick<
          LiveDefaultNetworkDependencies,
          "createHttpAgent" | "createHttpProxyAgent" | "fetch"
        >
      >();
    let dispatcherConstructions = 0;
    let fetches = 0;
    const http = {
      createHttpAgent() {
        dispatcherConstructions += 1;
        return { destroy: async () => undefined };
      },
      createHttpProxyAgent() {
        dispatcherConstructions += 1;
        return { destroy: async () => undefined };
      },
      async fetch() {
        fetches += 1;
        return {
          status: 200,
          statusText: "OK",
          headers: { get: () => null },
          body: null,
        };
      },
    };
    const dependencies: LiveDefaultNetworkDependencies = {
      ...http,
      loadHttp: () => loaded.promise,
      createWebSocket() {
        throw new Error("socket must stay unused");
      },
      createWebSocketProxyAgent() {
        throw new Error("proxy must stay unused");
      },
    };
    const adapter = createDefaultLiveNetworkAdapter(dependencies);
    const started = adapter.signal({
      url: "https://example.invalid/signal",
      method: "POST",
      redirect: "manual",
      headers: {},
      body: "{}",
      signal: new AbortController().signal,
    });
    await Promise.resolve();
    const terminating = started.terminate(async (owned) => owned.cancel());
    await Promise.resolve();
    assert.equal(dispatcherConstructions, 0);
    assert.equal(fetches, 0);

    loaded.resolve(http);
    await terminating;
    await assert.rejects(started.result, {
      message: "Live transport was cancelled.",
    });
    assert.equal(dispatcherConstructions, 0);
    assert.equal(fetches, 0);
  },
);

test("unsafe dependency debug settings are refused before credentials or network", async (t) => {
  const previousDebug = process.env.DEBUG;
  const previousNodeDebug = process.env.NODE_DEBUG;
  process.env.DEBUG = "https*,-https:quiet,*proxy*";
  process.env.NODE_DEBUG = "http,net,tls,https,fetch,websocket";
  t.after(() => {
    if (previousDebug === undefined) delete process.env.DEBUG;
    else process.env.DEBUG = previousDebug;
    if (previousNodeDebug === undefined) delete process.env.NODE_DEBUG;
    else process.env.NODE_DEBUG = previousNodeDebug;
  });
  let registryCalls = 0;
  let networkCalls = 0;
  const diagnostics: LiveRuntimeDiagnostic[] = [];
  const network: LiveNetworkAdapter = {
    signal() {
      networkCalls += 1;
      throw new Error("network must stay lazy");
    },
    openSideband() {
      networkCalls += 1;
      throw new Error("network must stay lazy");
    },
  };
  const resources = createLiveRuntimeResources({
    registry: {
      async getApiKeyForProvider() {
        registryCalls += 1;
        return undefined;
      },
    },
    instructions: "fixture instructions",
    native: fakeNative(),
    network,
    callbacks: { onDiagnostic: (value) => diagnostics.push(value) },
  });
  await assert.rejects(
    resources.credentials({ signal: new AbortController().signal }),
    { message: "Live transport protocol failed." },
  );
  const started = resources.connect({
    signal: new AbortController().signal,
    deadline: performance.now() + 30_000,
    credentials,
    voice: "marin",
  });
  await assert.rejects(started.result, {
    message: "Live transport protocol failed.",
  });
  await started.terminate(async (connection) => connection.close());
  assert.equal(registryCalls, 0);
  assert.equal(networkCalls, 0);
  assert.deepEqual(diagnostics, [
    {
      code: "denied",
      phase: "protocol",
      text: "Pi Live permission was denied.",
    },
  ]);
});

test("signaling is attempted once and rejects redirects, non-OK responses and malformed session answers", async (t) => {
  const answer = (value: unknown) =>
    response("", { raw: JSON.stringify(value) });
  for (const [name, result] of [
    [
      "redirect",
      response("", {
        status: 302,
        statusText: "Found",
        raw: "redirect body secret",
      }),
    ],
    ["not JSON", response("", { raw: "fixture-answer" })],
    ["missing session", answer({ transport: { type: "webrtc", sdp: "a" } })],
    [
      "path-unsafe session id",
      answer({
        session: { id: "live/../other" },
        transport: { type: "webrtc", sdp: "a" },
      }),
    ],
    [
      "oversized session id",
      answer({
        session: { id: "i".repeat(257) },
        transport: { type: "webrtc", sdp: "a" },
      }),
    ],
    [
      "other transport",
      answer({
        session: { id: "live_x" },
        transport: { type: "sip", sdp: "a" },
      }),
    ],
    [
      "empty answer",
      answer({
        session: { id: "live_x" },
        transport: { type: "webrtc", sdp: "" },
      }),
    ],
  ] as const) {
    await t.test(name, async () => {
      let attempts = 0;
      const network: LiveNetworkAdapter = {
        signal() {
          attempts += 1;
          return settledStart(result);
        },
        openSideband() {
          throw new Error("invalid signaling must not open sideband");
        },
      };
      const { started } = await connectWith(fakeNative(), network);
      await assert.rejects(started.result, {
        message: "Live transport protocol failed.",
      });
      await started.terminate(async (connection) => connection.close());
      assert.equal(attempts, 1);
    });
  }
});

test("non-OK signaling discards at most 8 KiB and never consumes or emits the body tail", async () => {
  const secret = "synthetic-non-ok-body-secret";
  let chunksConsumed = 0;
  let cancelCalls = 0;
  const diagnostics: LiveRuntimeDiagnostic[] = [];
  const native = fakeNative();
  const network: LiveNetworkAdapter = {
    signal: () =>
      settledStart({
        status: 503,
        statusText: secret,
        body: (async function* () {
          chunksConsumed += 1;
          yield Buffer.alloc(8 * 1_024, 0x61);
          chunksConsumed += 1;
          yield Buffer.from("x");
          chunksConsumed += 1;
          yield Buffer.from(secret);
        })(),
        cancel() {
          cancelCalls += 1;
        },
      }),
    openSideband() {
      throw new Error("non-OK signaling must not open sideband");
    },
  };
  const resources = createLiveRuntimeResources({
    registry: { getApiKeyForProvider: async () => undefined },
    instructions: "fixture instructions",
    native,
    network,
    randomId: () => "realtime-session",
    proxyForUrl: () => undefined,
    callbacks: {
      onDiagnostic(value) {
        diagnostics.push(value);
      },
    },
  });
  const started = resources.connect({
    signal: new AbortController().signal,
    deadline: performance.now() + 30_000,
    credentials,
    voice: "marin",
  });
  await assert.rejects(started.result, {
    message: "Live transport protocol failed.",
  });
  await started.terminate(async (connection) => connection.close());
  assert.equal(chunksConsumed, 2);
  assert.ok(cancelCalls >= 1);
  assert.deepEqual(diagnostics, [
    {
      code: "protocol-error",
      phase: "signaling",
      text: "Pi Live protocol failed.",
      httpStatus: 503,
    },
  ]);
  assert.equal(JSON.stringify(diagnostics).includes(secret), false);
});

test("sideband retries only transient pre-open failures, three attempts under one deadline", async (t) => {
  await t.test("transient then success", async (t) => {
    let attempts = 0;
    const sidebandIds: string[] = [];
    const network: LiveNetworkAdapter = {
      signal: () => settledStart(response("answer")),
      openSideband(input) {
        attempts += 1;
        sidebandIds.push(input.url);
        if (attempts < 3)
          return {
            result: Promise.reject(
              attempts === 1
                ? { kind: "http" as const, status: 500 }
                : { kind: "transient" as const },
            ),
            terminate: async () => undefined,
          };
        return settledStart(fakeSocket());
      },
    };
    const clock = new ManualClock();
    const connecting = await connectWith(fakeNative(), network, { clock });
    await waitForCondition(
      () => attempts === 1,
      "first sideband attempt did not start",
    );
    clock.advance(200);
    await waitForCondition(
      () => attempts === 2,
      "second sideband attempt did not start",
    );
    clock.advance(400);
    const connection = await connecting.started.result;
    t.after(async () => connection.close());
    assert.equal(attempts, 3);
    assert.deepEqual(
      sidebandIds,
      Array.from(
        { length: 3 },
        () => "wss://api.openai.com/v1/live/sessions/live_fixture/attach",
      ),
    );
  });

  for (const [name, failure] of [
    ["auth", { kind: "http" as const, status: 401 }],
    ["permission", { kind: "http" as const, status: 403 }],
    ["non-transient status", { kind: "http" as const, status: 400 }],
    ["malformed", { kind: "malformed" as const }],
  ] as const) {
    await t.test(name, async () => {
      let attempts = 0;
      const network: LiveNetworkAdapter = {
        signal: () => settledStart(response("answer")),
        openSideband() {
          attempts += 1;
          return {
            result: Promise.reject(failure),
            terminate: async () => undefined,
          };
        },
      };
      const { started } = await connectWith(fakeNative(), network);
      await assert.rejects(started.result, {
        message: "Live transport protocol failed.",
      });
      await started.terminate(async (connection) => connection.close());
      assert.equal(attempts, 1);
    });
  }
});

test("SDP and serialized signaling limits are inclusive and reject the next byte before network I/O", async (t) => {
  const session = {
    model: "gpt-live-1",
    instructions: "fixture instructions",
    audio: { output: { voice: "marin" } },
    delegation: { type: "client" },
  };
  const serialized = (sdp: string) =>
    JSON.stringify({ session, transport: { type: "webrtc", sdp } });
  const overhead = Buffer.byteLength(serialized(""));
  const targetEscapedOfferBytes = 2 * 1_024 * 1_024 - overhead;
  const controlCount = Math.ceil((targetEscapedOfferBytes - 1_024 * 1_024) / 5);
  const plainCount = targetEscapedOfferBytes - controlCount * 6;
  const exactSerializedOffer = `${"\u0001".repeat(controlCount)}${"a".repeat(plainCount)}`;
  assert.ok(Buffer.byteLength(exactSerializedOffer) <= 1_024 * 1_024);
  assert.equal(
    Buffer.byteLength(serialized(exactSerializedOffer)),
    2 * 1_024 * 1_024,
  );

  for (const [name, offer, expectedSignals] of [
    ["one MiB SDP", "a".repeat(1_024 * 1_024), 1],
    ["one MiB SDP plus one", "a".repeat(1_024 * 1_024 + 1), 0],
    ["exact two MiB serialized request", exactSerializedOffer, 1],
    ["serialized request plus one", `${exactSerializedOffer}a`, 0],
  ] as const) {
    await t.test(name, async (t) => {
      let signalCalls = 0;
      const network: LiveNetworkAdapter = {
        signal(input) {
          signalCalls += 1;
          assert.ok(Buffer.byteLength(input.body) <= 2 * 1_024 * 1_024);
          return settledStart(response("answer"));
        },
        openSideband: () => settledStart(fakeSocket()),
      };
      const { started } = await connectWith(
        fakeNative({ createOffer: async () => offer }),
        network,
      );
      if (expectedSignals === 1) {
        const connection = await started.result;
        t.after(async () => connection.close());
      } else {
        await assert.rejects(started.result, {
          message: "Live transport protocol failed.",
        });
        await started.terminate(async (connection) => connection.close());
      }
      assert.equal(signalCalls, expectedSignals);
    });
  }
});

test("session answers accept a one MiB SDP within a two MiB body and cancel at the next byte", async (t) => {
  const prefix =
    '{"session":{"id":"live_answer"},"transport":{"type":"webrtc","sdp":"';
  const suffix = '"}}';
  for (const [name, chunks, acceptedBytes] of [
    ["one MiB SDP", [prefix, "a".repeat(1_024 * 1_024), suffix], 1_024 * 1_024],
    [
      "one MiB SDP plus one",
      [prefix, "a".repeat(1_024 * 1_024 + 1), suffix],
      0,
    ],
    ["two MiB body plus one", [" ".repeat(2 * 1_024 * 1_024), "x"], 0],
  ] as const) {
    await t.test(name, async (t) => {
      let cancelled = 0;
      let acceptedAnswerBytes = 0;
      const native = fakeNative({
        async acceptAnswer(answer) {
          acceptedAnswerBytes = Buffer.byteLength(answer);
        },
      });
      const network: LiveNetworkAdapter = {
        signal: () =>
          settledStart({
            status: 201,
            statusText: "Created",
            body: (async function* () {
              for (const chunk of chunks) yield Buffer.from(chunk);
            })(),
            cancel() {
              cancelled += 1;
            },
          }),
        openSideband: () => settledStart(fakeSocket()),
      };
      const { started } = await connectWith(native, network);
      if (acceptedBytes > 0) {
        const connection = await started.result;
        t.after(async () => connection.close());
      } else {
        await assert.rejects(started.result, {
          message: "Live transport protocol failed.",
        });
        await started.terminate(async (connection) => connection.close());
      }
      assert.equal(acceptedAnswerBytes, acceptedBytes);
      assert.ok(cancelled >= 1);
    });
  }
});

test("unconfirmed native or socket disposal remains a sticky lifecycle cleanup obligation", async (t) => {
  for (const gap of ["native", "socket"] as const) {
    await t.test(gap, async (t) => {
      const fixture = await createLiveFixture(t);
      const socket = fakeSocket();
      if (gap === "socket") socket.close = async () => false;
      const native = fakeNative(
        gap === "native" ? { close: async () => false } : {},
      );
      const network: LiveNetworkAdapter = {
        signal: () => settledStart(response("answer")),
        openSideband: () => settledStart(socket),
      };
      const runtime = createLiveRuntimeResources({
        registry: { getApiKeyForProvider: async () => undefined },
        instructions: "fixture instructions",
        native,
        network,
        clock: fixture.clock,
        randomId: () => "realtime-session",
        proxyForUrl: () => undefined,
      });
      const lifecycle = fixture.createLifecycle(approvingConsent, {
        clock: fixture.clock,
        resources: {
          ...runtime,
          credentials: async () => credentials,
        },
      });
      assert.equal((await lifecycle.start()).kind, "started");
      assert.deepEqual(await lifecycle.stop(), { status: "blocked" });
      assert.equal(lifecycle.snapshot().state, "blocked");
      assert.equal(lifecycle.snapshot().lastFailure, "cleanup-blocked");
    });
  }
});

test("the signaling phase deadline includes a stalled streamed body and joins its cancellation", async () => {
  const clock = new ManualClock();
  const bodyEntered = deferred<void>();
  const cancelBody = deferred<void>();
  let cancelCalls = 0;
  const network: LiveNetworkAdapter = {
    signal: () =>
      settledStart({
        status: 200,
        statusText: "OK",
        body: (async function* () {
          bodyEntered.resolve();
          await cancelBody.promise;
          return;
        })(),
        cancel() {
          cancelCalls += 1;
          cancelBody.resolve();
        },
      }),
    openSideband() {
      throw new Error("stalled answer must not reach sideband");
    },
  };
  const { started } = await connectWith(fakeNative(), network, { clock });
  await bodyEntered.promise;
  clock.advance(9_999);
  let settled = false;
  void started.result.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  await Promise.resolve();
  assert.equal(settled, false);
  clock.advance(1);
  await assert.rejects(started.result, {
    message: "Live transport connection timed out.",
  });
  await started.terminate(async (connection) => connection.close());
  assert.ok(cancelCalls >= 1);
});

test("each native and network phase consumes its own ten seconds capped by the common deadline", async (t) => {
  await t.test("offer", async () => {
    const clock = new ManualClock();
    const offer = deferred<string>();
    const native = fakeNative({ createOffer: () => offer.promise });
    let signalCalls = 0;
    const network: LiveNetworkAdapter = {
      signal() {
        signalCalls += 1;
        return settledStart(response("answer"));
      },
      openSideband: () => settledStart(fakeSocket()),
    };
    const { started } = await connectWith(native, network, { clock });
    await Promise.resolve();
    clock.advance(9_999);
    assert.equal(signalCalls, 0);
    clock.advance(1);
    await assert.rejects(started.result, {
      message: "Live transport connection timed out.",
    });
    offer.resolve("late-offer");
    await started.terminate(async (connection) => connection.close());
    assert.equal(signalCalls, 0);
  });

  for (const phase of ["answer", "native-open"] as const) {
    await t.test(phase, async () => {
      const clock = new ManualClock();
      const entered = deferred<void>();
      const release = deferred<void>();
      const native = fakeNative({
        ...(phase === "answer"
          ? {
              acceptAnswer: () => {
                entered.resolve();
                return release.promise;
              },
            }
          : {
              waitForOpen: () => {
                entered.resolve();
                return release.promise;
              },
            }),
      });
      const network: LiveNetworkAdapter = {
        signal: () => settledStart(response("answer")),
        openSideband: () => settledStart(fakeSocket()),
      };
      const { started } = await connectWith(native, network, { clock });
      await entered.promise;
      clock.advance(9_999);
      let settled = false;
      void started.result.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      await Promise.resolve();
      assert.equal(settled, false);
      clock.advance(1);
      await assert.rejects(started.result, {
        message: "Live transport connection timed out.",
      });
      release.resolve();
      await started.terminate(async (connection) => connection.close());
    });
  }

  await t.test("sideband attempt", async () => {
    const clock = new ManualClock();
    const entered = deferred<void>();
    let terminations = 0;
    const network: LiveNetworkAdapter = {
      signal: () => settledStart(response("answer")),
      openSideband() {
        entered.resolve();
        return {
          result: new Promise<LiveSidebandSocket>(() => undefined),
          async terminate() {
            terminations += 1;
          },
        };
      },
    };
    const { started } = await connectWith(fakeNative(), network, { clock });
    await entered.promise;
    clock.advance(10_000);
    await assert.rejects(started.result, {
      message: "Live transport connection timed out.",
    });
    await started.terminate(async (connection) => connection.close());
    assert.equal(terminations, 1);
  });
});

test("sideband close before adoption is fatal without retry and retired callbacks cannot affect a later candidate", async (t) => {
  await t.test("open then same-turn close", async () => {
    let attempts = 0;
    const network: LiveNetworkAdapter = {
      signal: () => settledStart(response("answer")),
      openSideband(input) {
        attempts += 1;
        input.onClose();
        return settledStart(fakeSocket());
      },
    };
    const { started } = await connectWith(fakeNative(), network);
    await assert.rejects(started.result, {
      message: "Live transport protocol failed.",
    });
    await started.terminate(async (connection) => connection.close());
    assert.equal(attempts, 1);
  });

  await t.test("retired retry callbacks", async (t) => {
    const clock = new ManualClock();
    let attempts = 0;
    let retiredInput: LiveSidebandStartInput | undefined;
    const sent: string[] = [];
    const network: LiveNetworkAdapter = {
      signal: () => settledStart(response("answer")),
      openSideband(input) {
        attempts += 1;
        if (attempts === 1) {
          retiredInput = input;
          return {
            result: Promise.reject({ kind: "transient" as const }),
            terminate: async () => undefined,
          };
        }
        return settledStart(fakeSocket(sent));
      },
    };
    const { started } = await connectWith(fakeNative(), network, { clock });
    await waitForCondition(
      () => attempts === 1,
      "first candidate did not start",
    );
    clock.advance(200);
    const connection = await started.result;
    t.after(async () => connection.close());
    assert.ok(retiredInput);
    retiredInput.onClose();
    retiredInput.onFailure({ kind: "malformed" });
    await connection.sendData?.({ kind: "application", text: "still active" });
    assert.equal(sent.length, 1);
  });
});

test("stop fences late and synchronously invalidated peers before createOffer and disposes each once", async (t) => {
  for (const mode of ["late result", "synchronous failure"] as const) {
    await t.test(mode, async (t) => {
      const fixture = await createLiveFixture(t);
      const peerResult = deferred<LiveNativePeer>();
      const entered = deferred<void>();
      let offers = 0;
      let closes = 0;
      const peer = {
        createOffer: async () => {
          offers += 1;
          return "offer";
        },
        acceptAnswer: async () => undefined,
        waitForOpen: async () => undefined,
        pushAudio: () => undefined,
        setMuted: () => undefined,
        close: async () => {
          closes += 1;
          return true;
        },
      } satisfies LiveNativePeer;
      const native: LiveNativeAdapter = {
        createPeer(callbacks) {
          entered.resolve();
          if (mode === "synchronous failure") callbacks.onFailure();
          return mode === "late result"
            ? {
                result: peerResult.promise,
                async terminate(dispose) {
                  await dispose(await peerResult.promise);
                },
              }
            : settledStart(peer);
        },
        startCapture: () => settledStart(createFakeCapture()),
      };
      const network: LiveNetworkAdapter = {
        signal() {
          assert.fail("a fenced peer must not signal");
        },
        openSideband() {
          assert.fail("a fenced peer must not open sideband");
        },
      };
      const runtime = createLiveRuntimeResources({
        registry: { getApiKeyForProvider: async () => undefined },
        instructions: "fixture",
        native,
        network,
        clock: fixture.clock,
        proxyForUrl: () => undefined,
      });
      const lifecycle = fixture.createLifecycle(approvingConsent, {
        clock: fixture.clock,
        resources: {
          ...runtime,
          credentials: async () => credentials,
        },
      });
      const starting = lifecycle.start();
      await entered.promise;
      const stopping = lifecycle.stop();
      if (mode === "late result") peerResult.resolve(peer);
      assert.deepEqual(await stopping, { status: "off" });
      assert.equal((await starting).kind, "cancelled");
      assert.equal(offers, 0);
      assert.equal(closes, 1);
    });
  }
});

test("a peer close may reject a parked offer and still confirm lifecycle shutdown", async (t) => {
  const fixture = await createLiveFixture(t);
  const parkedOffer = deferred<string>();
  const offerEntered = deferred<void>();
  let closes = 0;
  const native = fakeNative({
    createOffer() {
      offerEntered.resolve();
      return parkedOffer.promise;
    },
    async close() {
      closes += 1;
      parkedOffer.reject(new Error("closed offer"));
      return true;
    },
  });
  const runtime = createLiveRuntimeResources({
    registry: { getApiKeyForProvider: async () => undefined },
    instructions: "fixture",
    native,
    network: {
      signal() {
        assert.fail("parked offer must not signal");
      },
      openSideband() {
        assert.fail("parked offer must not open sideband");
      },
    },
    clock: fixture.clock,
    proxyForUrl: () => undefined,
  });
  const lifecycle = fixture.createLifecycle(approvingConsent, {
    clock: fixture.clock,
    resources: {
      ...runtime,
      credentials: async () => credentials,
    },
  });
  const starting = lifecycle.start();
  await offerEntered.promise;
  assert.deepEqual(await lifecycle.stop(), { status: "off" });
  assert.equal((await starting).kind, "cancelled");
  assert.equal(closes, 1);
});

test("lifecycle stop writes at most one immediately writable close frame and omits a saturated close", async (t) => {
  for (const [name, buffered, rejectClose, expectedFrames] of [
    ["writable", 0, false, 1],
    ["write rejected during teardown", 0, true, 1],
    ["saturated", 256 * 1_024, false, 0],
  ] as const) {
    await t.test(name, async (t) => {
      const fixture = await createLiveFixture(t);
      const sent: string[] = [];
      const socket = fakeSocket(sent);
      socket.bufferedAmount = () => buffered;
      if (rejectClose)
        socket.sendText = async (payload) => {
          sent.push(payload);
          throw new Error("socket terminated");
        };
      const runtime = createLiveRuntimeResources({
        registry: { getApiKeyForProvider: async () => undefined },
        instructions: "fixture",
        native: fakeNative(),
        network: {
          signal: () => settledStart(response("answer")),
          openSideband: () => settledStart(socket),
        },
        clock: fixture.clock,
        proxyForUrl: () => undefined,
      });
      const lifecycle = fixture.createLifecycle(approvingConsent, {
        clock: fixture.clock,
        resources: {
          ...runtime,
          credentials: async () => credentials,
        },
      });
      assert.equal((await lifecycle.start()).kind, "started");
      assert.deepEqual(await lifecycle.stop(), { status: "off" });
      assert.equal(lifecycle.snapshot().state, "off");
      assert.equal(
        sent.filter((payload) => payload === '{"type":"session.close"}').length,
        expectedFrames,
      );
    });
  }
});

test("runtime phase deadlines ignore early timer delivery and body reads enforce monotonic time", async (t) => {
  await t.test("early offer timer", async () => {
    const clock = new ManualClock();
    const offer = deferred<string>();
    const { started } = await connectWith(
      fakeNative({ createOffer: () => offer.promise }),
      {
        signal: () => settledStart(response("answer")),
        openSideband: () => settledStart(fakeSocket()),
      },
      { clock },
    );
    await Promise.resolve();
    clock.fireNextWithoutAdvancing();
    let settled = false;
    void started.result.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await Promise.resolve();
    assert.equal(settled, false);
    clock.advance(10_000);
    await assert.rejects(started.result, {
      message: "Live transport connection timed out.",
    });
    offer.resolve("late");
    await started.terminate(async (connection) => connection.close());
  });

  await t.test("zero-byte body chunks", async () => {
    const clock = new ManualClock();
    let cancelCalls = 0;
    const network: LiveNetworkAdapter = {
      signal: () =>
        settledStart({
          status: 200,
          statusText: "OK",
          body: (async function* () {
            for (let count = 0; count < 10; count += 1) {
              clock.elapseWithoutTimers(1_000);
              yield new Uint8Array();
            }
          })(),
          cancel() {
            cancelCalls += 1;
          },
        }),
      openSideband() {
        assert.fail("expired body read must not open sideband");
      },
    };
    const { started } = await connectWith(fakeNative(), network, { clock });
    await assert.rejects(started.result, {
      message: "Live transport connection timed out.",
    });
    await started.terminate(async (connection) => connection.close());
    assert.ok(cancelCalls >= 1);
  });
});

test("malformed UTF-8 SDP answers are rejected before native acceptance", async () => {
  let accepts = 0;
  const network: LiveNetworkAdapter = {
    signal: () =>
      settledStart({
        status: 200,
        statusText: "OK",
        body: (async function* () {
          yield Uint8Array.from([0xff]);
        })(),
        cancel: () => undefined,
      }),
    openSideband() {
      assert.fail("malformed SDP must not open sideband");
    },
  };
  const { started } = await connectWith(
    fakeNative({
      async acceptAnswer() {
        accepts += 1;
      },
    }),
    network,
  );
  await assert.rejects(started.result, {
    message: "Live transport protocol failed.",
  });
  await started.terminate(async (connection) => connection.close());
  assert.equal(accepts, 0);
});

test("the real native adapter confirms cleanup only when the native close resolves", async () => {
  const bindings = (close: () => Promise<void>): DefaultNativeBindings => ({
    AudioCapture: class {
      stop(): void {}
    } as unknown as DefaultNativeBindings["AudioCapture"],
    LiveWebRtcPeer: class {
      createOffer = async () => "offer";
      acceptAnswer = async () => undefined;
      waitForOpen = async () => undefined;
      pushAudio(): void {}
      setMuted(): void {}
      close = close;
    } as unknown as DefaultNativeBindings["LiveWebRtcPeer"],
    __ompInstallTokioRuntime(): void {},
  });
  const closed = async (close: () => Promise<void>) => {
    const peer = await createDefaultLiveNativeAdapter(() =>
      bindings(close),
    ).createPeer({
      onEvent() {},
      onOutputLevel() {},
      onFailure() {},
    }).result;
    return peer.close();
  };
  assert.equal(await closed(async () => undefined), true);
  assert.equal(
    await closed(async () => {
      throw new Error("native close failed");
    }),
    false,
  );
});
