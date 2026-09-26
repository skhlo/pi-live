import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";

import {
  createLiveRuntimeResources,
  type LiveConnection,
  type LiveCredentials,
  type LiveNativeAdapter,
  type LiveNativePeer,
  type LiveNetworkAdapter,
  type LiveRuntimeDiagnostic,
  type LiveSidebandSocket,
  type LiveSidebandStartInput,
} from "../src/live.ts";
import {
  approvingConsent,
  createFakeCapture,
  createFakeConnection,
  createFakeResources,
  createLiveFixture,
  ManualClock,
  settledStart,
} from "./test-support/live-fixture.ts";
import { waitForCondition } from "./test-support/live-wait.ts";

const credentials: LiveCredentials = { apiKey: "sk-privacy" };

interface RuntimeHarness {
  connection: LiveConnection;
  sideband: LiveSidebandStartInput;
  /** The WebRTC data channel, which owns transcripts and delegations. */
  native(event: unknown): void;
  /** User speech followed by a client delegation. */
  handoff(id: string, text: string): void;
  sent: string[];
  diagnostics: LiveRuntimeDiagnostic[];
  serviceErrors: string[];
  requests: Array<{ id: string; text: string }>;
  transcripts: Array<{ role: "user" | "assistant"; text: string }>;
}

async function runtimeHarness(
  t: TestContext,
  options: {
    clock?: ManualClock;
    bufferedAmount?: () => number;
    sendText?: (payload: string) => Promise<void>;
    sendPong?: (payload: Uint8Array) => Promise<void>;
    onSocketClose?: () => void;
    onRequest?: (request: { id: string; text: string }) => void;
    onNativeCallbacks?: (
      callbacks: Parameters<LiveNativeAdapter["createPeer"]>[0],
    ) => void;
    onNativeCaptureCallbacks?: (
      callbacks: Parameters<LiveNativeAdapter["startCapture"]>[0],
    ) => void;
  } = {},
): Promise<RuntimeHarness> {
  let sideband!: LiveSidebandStartInput;
  let nativeEvent!: (payload: string) => void;
  const serviceErrors: string[] = [];
  const sent: string[] = [];
  const diagnostics: LiveRuntimeDiagnostic[] = [];
  const requests: Array<{ id: string; text: string }> = [];
  const transcripts: Array<{
    role: "user" | "assistant";
    text: string;
  }> = [];
  const socket: LiveSidebandSocket = {
    bufferedAmount: options.bufferedAmount ?? (() => 0),
    async sendText(payload) {
      sent.push(payload);
      await options.sendText?.(payload);
    },
    async sendPong(payload) {
      await options.sendPong?.(payload);
    },
    async close() {
      options.onSocketClose?.();
      return true;
    },
  };
  const peer: LiveNativePeer = {
    createOffer: async () => "offer",
    acceptAnswer: async () => undefined,
    waitForOpen: async () => undefined,
    pushAudio: () => undefined,
    setMuted: () => undefined,
    close: async () => true,
  };
  const native: LiveNativeAdapter = {
    createPeer(callbacks) {
      nativeEvent = callbacks.onEvent;
      options.onNativeCallbacks?.(callbacks);
      return settledStart(peer);
    },
    startCapture(callbacks) {
      options.onNativeCaptureCallbacks?.(callbacks);
      return settledStart(createFakeCapture());
    },
  };
  const network: LiveNetworkAdapter = {
    signal: () =>
      settledStart({
        status: 201,
        statusText: "Created",
        body: (async function* () {
          yield Buffer.from(
            JSON.stringify({
              session: { id: "live_privacy" },
              transport: { type: "webrtc", sdp: "answer" },
            }),
          );
        })(),
        cancel: () => undefined,
      }),
    openSideband(input) {
      sideband = input;
      return settledStart(socket);
    },
  };
  const resources = createLiveRuntimeResources({
    registry: { getApiKeyForProvider: async () => undefined },
    instructions: "privacy instructions",
    native,
    network,
    clock: options.clock,
    randomId: () => "privacy-event",
    proxyForUrl: () => undefined,
    callbacks: {
      onRequest(request) {
        requests.push(request);
        options.onRequest?.(request);
      },
      onTranscript: (transcript) => transcripts.push(transcript),
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
      onServiceError: (code) => serviceErrors.push(code),
    },
  });
  const started = resources.connect({
    signal: new AbortController().signal,
    deadline: (options.clock?.nowValue ?? performance.now()) + 30_000,
    credentials,
    voice: "marin",
  });
  const connection = await started.result;
  t.after(async () => {
    await connection.close().catch(() => undefined);
  });
  const emitNative = (event: unknown) => nativeEvent(JSON.stringify(event));
  return {
    connection,
    sideband,
    native: emitNative,
    handoff(id, text) {
      emitNative(speech("user", text));
      emitNative(delegation(id));
    },
    sent,
    diagnostics,
    serviceErrors,
    requests,
    transcripts,
  };
}

function speech(role: "user" | "assistant", delta: string) {
  return {
    type:
      role === "user"
        ? "session.input_transcript.delta"
        : "session.output_transcript.delta",
    delta,
    start_ms: 0,
    end_ms: 1,
  };
}

function delegation(id: string) {
  return {
    type: "session.delegation.created",
    offset_ms: 1,
    delegation: { id, type: "delegation", target: "client" },
  };
}

function appended(wire: string): {
  type: string;
  event_id: string;
  delegation_id: string | null;
  content: string;
} {
  return JSON.parse(wire) as ReturnType<typeof appended>;
}

test("microphone ingress requires bounded finite Float32 samples and shares the per-call bucket", async (t) => {
  const fixture = await createLiveFixture(t);
  let onSample: ((samples: Float32Array) => void) | undefined;
  let sentSamples = 0;
  const connection = createFakeConnection({
    startCapture(callback) {
      onSample = callback;
      return settledStart(createFakeCapture());
    },
    sendSample(samples) {
      sentSamples += samples.length;
    },
  });
  const lifecycle = fixture.createLifecycle(approvingConsent, {
    clock: fixture.clock,
    resources: createFakeResources(connection),
  });
  assert.equal((await lifecycle.start()).kind, "started");
  assert.ok(onSample);

  onSample(new Float32Array(16_000));
  onSample(new Float32Array(16_000));
  assert.equal(sentSamples, 32_000);
  fixture.clock.advance(1_000);
  onSample(new Float32Array(16_000));
  assert.equal(sentSamples, 48_000);
  onSample(new Float32Array([0]));
  await waitForCondition(
    () => lifecycle.snapshot().state !== "active",
    "audio bucket overflow did not stop the call",
  );
  assert.equal(lifecycle.snapshot().lastFailure, "audio-error");

  await t.test(
    "limit plus one and non-finite samples fail closed",
    async (t) => {
      for (const samples of [
        new Float32Array(16_001),
        new Float32Array([Number.NaN]),
        new Float32Array([Number.POSITIVE_INFINITY]),
      ]) {
        const nested = await createLiveFixture(t);
        let callback: ((value: Float32Array) => void) | undefined;
        let sends = 0;
        const nestedConnection = createFakeConnection({
          startCapture(onAudio) {
            callback = onAudio;
            return settledStart(createFakeCapture());
          },
          sendSample() {
            sends += 1;
          },
        });
        const nestedLifecycle = nested.createLifecycle(approvingConsent, {
          resources: createFakeResources(nestedConnection),
        });
        assert.equal((await nestedLifecycle.start()).kind, "started");
        assert.ok(callback);
        callback(samples);
        await waitForCondition(
          () => nestedLifecycle.snapshot().state !== "active",
          "invalid audio did not stop the call",
        );
        assert.equal(sends, 0);
        assert.equal(nestedLifecycle.snapshot().lastFailure, "audio-error");
      }
    },
  );
});

test("the data channel and sideband each have a bounded event bucket", async (t) => {
  const harness = await runtimeHarness(t);
  for (let count = 0; count < 200; count += 1)
    harness.native({ type: "future.event" });
  const unknown = Buffer.from('{"type":"future.event"}');
  for (let count = 0; count < 200; count += 1) harness.sideband.onText(unknown);
  assert.deepEqual(harness.diagnostics, []);
  harness.sideband.onPing(new Uint8Array());
  assert.deepEqual(harness.diagnostics.at(-1), {
    code: "protocol-error",
    phase: "protocol",
    text: "Pi Live protocol failed.",
  });

  const nativeHarness = await runtimeHarness(t);
  for (let count = 0; count < 200; count += 1)
    nativeHarness.native({ type: "future.event" });
  assert.equal(nativeHarness.diagnostics.length, 0);
  nativeHarness.native({ type: "future.event" });
  assert.equal(nativeHarness.diagnostics.at(-1)?.code, "protocol-error");
});

test("inbound frame, request, ID and content-entry maxima are inclusive", async (t) => {
  let nativeEvent: ((payload: string) => void) | undefined;
  const nativeHarness = await runtimeHarness(t, {
    onNativeCallbacks(callbacks) {
      nativeEvent = callbacks.onEvent;
    },
  });
  assert.ok(nativeEvent);
  const nativePrefix = '{"type":"future.native","pad":"';
  const nativeSuffix = '"}';
  nativeEvent(
    `${nativePrefix}${"a".repeat(
      256 * 1_024 - nativePrefix.length - nativeSuffix.length,
    )}${nativeSuffix}`,
  );
  assert.equal(nativeHarness.diagnostics.length, 0);
  nativeEvent(
    `${nativePrefix}${"a".repeat(
      256 * 1_024 + 1 - nativePrefix.length - nativeSuffix.length,
    )}${nativeSuffix}`,
  );
  assert.equal(nativeHarness.diagnostics.at(-1)?.code, "protocol-error");

  const frameHarness = await runtimeHarness(t);
  const prefix = '{"type":"future.event","pad":"';
  const suffix = '"}';
  const exactFrame = Buffer.from(
    `${prefix}${"a".repeat(256 * 1_024 - prefix.length - suffix.length)}${suffix}`,
  );
  assert.equal(exactFrame.byteLength, 256 * 1_024);
  frameHarness.sideband.onText(exactFrame);
  assert.equal(frameHarness.diagnostics.length, 0);
  frameHarness.sideband.onText(
    Buffer.from(
      `${prefix}${"a".repeat(
        256 * 1_024 + 1 - prefix.length - suffix.length,
      )}${suffix}`,
    ),
  );
  assert.equal(frameHarness.diagnostics.at(-1)?.code, "protocol-error");

  const exactDelta = await runtimeHarness(t);
  exactDelta.handoff("request", "é".repeat((64 * 1_024) / 2));
  assert.equal(
    exactDelta.requests[0]!.text,
    `User: ${"é".repeat((64 * 1_024) / 2)}`,
  );
  const largeDelta = await runtimeHarness(t);
  largeDelta.native(speech("user", `${"é".repeat((64 * 1_024) / 2)}x`));
  assert.deepEqual(largeDelta.transcripts, []);
  assert.equal(largeDelta.diagnostics.at(-1)?.code, "protocol-error");

  const exactId = await runtimeHarness(t);
  exactId.handoff("i".repeat(256), "task");
  assert.equal(exactId.requests[0]?.id.length, 256);
  const largeId = await runtimeHarness(t);
  largeId.handoff("i".repeat(257), "task");
  assert.deepEqual(largeId.requests, []);
  assert.equal(largeId.diagnostics.at(-1)?.code, "protocol-error");
});

test("malformed UTF-8, malformed transcripts and non-client delegations fail before callbacks", async (t) => {
  const malformedWire = await runtimeHarness(t);
  malformedWire.sideband.onText(Uint8Array.from([0xff]));
  assert.deepEqual(malformedWire.requests, []);
  assert.equal(malformedWire.diagnostics.at(-1)?.code, "protocol-error");

  const malformedText = await runtimeHarness(t);
  malformedText.handoff("bad-unicode", "\ud800");
  assert.deepEqual(malformedText.requests, []);
  assert.equal(malformedText.diagnostics.at(-1)?.code, "protocol-error");

  const responses = await runtimeHarness(t);
  responses.native({
    type: "session.delegation.created",
    delegation: { id: "responses", type: "delegation", target: "responses" },
  });
  assert.deepEqual(responses.requests, []);
  assert.equal(responses.diagnostics.at(-1)?.code, "protocol-error");
});

test("voice requests pass through while earlier Pi work is pending", async (t) => {
  const harness = await runtimeHarness(t);
  harness.handoff("first", "first task");
  harness.handoff("second", "second task");
  assert.deepEqual(harness.requests, [
    { id: "first", text: "User: first task" },
    { id: "second", text: "User: second task" },
  ]);
  assert.deepEqual(harness.diagnostics, []);
});

test("a handoff carries both speakers since the previous handoff, in order", async (t) => {
  const harness = await runtimeHarness(t);
  harness.native(speech("assistant", "Should I "));
  harness.native(speech("assistant", "run the tests?"));
  harness.native(speech("user", "Yes"));
  harness.native(speech("user", ", please."));
  harness.native(delegation("one"));
  harness.native(delegation("empty"));
  assert.deepEqual(harness.requests, [
    {
      id: "one",
      text: "Voice assistant: Should I run the tests?\nUser: Yes, please.",
    },
    {
      id: "empty",
      text: "(The voice assistant handed off without a transcript. Ask the user what they need.)",
    },
  ]);
});

test("the sideband does not duplicate data-channel transcripts or delegations", async (t) => {
  const harness = await runtimeHarness(t);
  harness.sideband.onText(Buffer.from(JSON.stringify(speech("user", "dup"))));
  harness.sideband.onText(Buffer.from(JSON.stringify(delegation("dup"))));
  assert.deepEqual(harness.transcripts, []);
  assert.deepEqual(harness.requests, []);
  assert.deepEqual(harness.diagnostics, []);
});

test("a nested voice request becomes the current wire reply destination", async (t) => {
  let harness!: RuntimeHarness;
  harness = await runtimeHarness(t, {
    onRequest(request) {
      if (request.id === "outer") harness.handoff("nested", "nested task");
    },
  });
  harness.handoff("outer", "outer task");
  await harness.connection.sendData?.({ kind: "final", text: "Pi reply" });
  assert.equal(harness.requests.length, 2);
  assert.ok(harness.sent[0]?.includes('"delegation_id":"nested"'));
  assert.deepEqual(harness.diagnostics, []);
});

test("a request callback that reentrantly closes transport cannot adopt its result", async (t) => {
  let harness!: RuntimeHarness;
  harness = await runtimeHarness(t, {
    onRequest() {
      void harness.connection.close();
      return true;
    },
  });
  harness.handoff("reentrant-stop", "task");
  await assert.rejects(
    harness.connection.sendData?.({ kind: "final", text: "must not send" }) ??
      Promise.resolve(),
    { message: "Live transport was cancelled." },
  );
  assert.deepEqual(harness.sent, []);
});

test("each voice request is input, without replay history or a call-wide request quota", async (t) => {
  const clock = new ManualClock();
  const harness = await runtimeHarness(t, { clock });
  for (let index = 0; index < 300; index++) {
    harness.handoff("reused-wire-id", `request ${index}`);
    clock.advance(10);
  }
  assert.equal(harness.requests.length, 300);
  assert.deepEqual(harness.diagnostics, []);
});

test("transcripts retain only the latest UTF-8 tail of the conversation", async (t) => {
  const harness = await runtimeHarness(t);
  harness.native(speech("user", "a".repeat(64 * 1_024)));
  harness.native(speech("user", "é"));
  const retained = harness.transcripts.at(-1)!.text;
  assert.equal(Buffer.byteLength(retained), 64 * 1_024);
  assert.equal(retained.endsWith("é"), true);
  harness.native(delegation("tail"));
  assert.equal(
    harness.requests[0]!.text,
    `User: ${"a".repeat(64 * 1_024 - 2)}é`,
  );
});

test("final replies are spoken commentary, truncated with a marker and chunked at 500 UTF-8 bytes", async (t) => {
  const exact = await runtimeHarness(t);
  exact.handoff("exact-final-id", "task");
  await exact.connection.sendData?.({
    kind: "final",
    text: "é".repeat(750),
  });
  const exactFrames = exact.sent.map(appended);
  assert.deepEqual(
    exactFrames.map((frame) => [frame.type, frame.delegation_id]),
    Array.from({ length: 3 }, () => [
      "session.commentary.append",
      "exact-final-id",
    ]),
  );
  assert.equal(
    exactFrames.map((frame) => frame.content).join(""),
    "é".repeat(750),
  );

  const harness = await runtimeHarness(t);
  harness.handoff("final-id", "task");
  await harness.connection.sendData?.({
    kind: "final",
    text: `${"\u0001".repeat(64 * 1_024)}x`,
  });
  const chunks = harness.sent.map(appended).map((frame) => {
    assert.equal(frame.type, "session.commentary.append");
    assert.equal(frame.event_id, "privacy-event");
    assert.equal(frame.delegation_id, "final-id");
    assert.ok(Buffer.byteLength(frame.content) <= 500);
    return frame.content;
  });
  const reconstructed = chunks.join("");
  assert.ok(Buffer.byteLength(reconstructed) <= 1_500);
  assert.ok(
    reconstructed.endsWith(" [The rest of Pi's reply is in the terminal.]"),
  );
});

test("progress is quiet thinking context and the writer permits over 256 KiB lifetime", async (t) => {
  const harness = await runtimeHarness(t);
  harness.handoff("progress-id", "task");
  for (let index = 0; index < 5; index++)
    await harness.connection.sendData?.({
      kind: "application",
      text: "\u0001".repeat(64 * 1_024),
    });
  for (const frame of harness.sent.map(appended)) {
    assert.equal(frame.type, "session.thinking.append");
    assert.equal(frame.delegation_id, "progress-id");
  }
  assert.ok(
    harness.sent.reduce((total, wire) => total + Buffer.byteLength(wire), 0) >
      256 * 1_024,
  );

  const unrelated = await runtimeHarness(t);
  await unrelated.connection.sendData?.({ kind: "application", text: "x" });
  await unrelated.connection.sendData?.({ kind: "final", text: "typed work" });
  assert.deepEqual(unrelated.sent.map(appended), [
    {
      type: "session.thinking.append",
      event_id: "privacy-event",
      delegation_id: null,
      content: "x",
    },
  ]);
});

test("context chunking uses an inclusive 500-byte UTF-8 limit", async (t) => {
  const exact = await runtimeHarness(t);
  exact.handoff("chunk-exact", "task");
  await exact.connection.sendData?.({
    kind: "application",
    text: "é".repeat(250),
  });
  assert.equal(exact.sent.length, 1);
  assert.equal(Buffer.byteLength(appended(exact.sent[0]!).content), 500);

  const over = await runtimeHarness(t);
  over.handoff("chunk-over", "task");
  await over.connection.sendData?.({
    kind: "application",
    text: `${"é".repeat(250)}x`,
  });
  assert.equal(over.sent.length, 2);
  assert.deepEqual(
    over.sent.map((wire) => Buffer.byteLength(appended(wire).content)),
    [500, 1],
  );
});

test("materialized envelope admission is bounded and stop promptly discards queued producers", async (t) => {
  let releaseSend!: () => void;
  const sendGate = new Promise<void>((resolve) => {
    releaseSend = resolve;
  });
  let socketCloses = 0;
  let sendCalls = 0;
  const harness = await runtimeHarness(t, {
    async sendText() {
      sendCalls += 1;
      if (sendCalls === 1) await sendGate;
    },
    onSocketClose: () => {
      socketCloses += 1;
    },
  });
  harness.handoff("queued", "task");
  const accepted = Array.from({ length: 256 }, () =>
    harness.connection.sendData?.({ kind: "application", text: "x" }),
  );
  const overflow = harness.connection.sendData?.({
    kind: "application",
    text: "overflow",
  });
  assert.ok(overflow);
  await assert.rejects(overflow, {
    message: "Live transport protocol failed.",
  });
  await waitForCondition(() => sendCalls === 1, "first send did not start");
  const closing = harness.connection.close();
  await waitForCondition(
    () => socketCloses === 1,
    "socket cleanup did not start independently",
  );
  assert.equal(sendCalls, 1);

  try {
    const queuedBeforeRelease = await Promise.race([
      Promise.allSettled(accepted.slice(1)),
      new Promise<"pending">((resolve) =>
        setTimeout(() => resolve("pending"), 50),
      ),
    ]);
    assert.notEqual(queuedBeforeRelease, "pending");
    assert.equal(
      queuedBeforeRelease instanceof Array &&
        queuedBeforeRelease.every((result) => result.status === "rejected"),
      true,
    );
    assert.equal(sendCalls, 1);
  } finally {
    releaseSend();
    await closing;
  }
  const settled = await Promise.allSettled(accepted);
  assert.equal(
    settled.filter((result) => result.status === "rejected").length,
    256,
  );
  assert.equal(sendCalls, 1);
  assert.equal(harness.sent.length, 1);
});

test("successive Pi replies share the bounded writer and drain in order", async (t) => {
  let releaseSend!: () => void;
  const sendGate = new Promise<void>((resolve) => {
    releaseSend = resolve;
  });
  let sendCalls = 0;
  const harness = await runtimeHarness(t, {
    async sendText() {
      if (++sendCalls === 1) await sendGate;
    },
  });
  t.after(() => releaseSend());
  harness.handoff("first", "first task");
  const first = harness.connection.sendData?.({
    kind: "final",
    text: "\u0001".repeat(64 * 1_024),
  });
  await waitForCondition(() => sendCalls === 1, "first reply did not start");
  harness.handoff("second", "second task");
  const second = harness.connection.sendData?.({
    kind: "final",
    text: "Second reply",
  });
  assert.equal(harness.sent.length, 1);
  releaseSend();
  await Promise.all([first, second]);
  assert.ok(harness.sent.length >= 4);
  assert.ok(
    harness.sent
      .slice(0, -1)
      .every((frame) => frame.includes('"delegation_id":"first"')),
  );
  assert.ok(harness.sent.at(-1)?.includes('"delegation_id":"second"'));
  assert.ok(harness.sent.at(-1)?.includes("Second reply"));
});

test("a reused wire ID receives its reply after an earlier send drains", async (t) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  t.after(() => release());
  const harness = await runtimeHarness(t, { sendText: () => gate });
  harness.handoff("same-id", "first input");
  const first = harness.connection.sendData?.({
    kind: "final",
    text: "First reply",
  });
  harness.handoff("same-id", "next input");
  release();
  await first;
  await harness.connection.sendData?.({ kind: "final", text: "Next reply" });
  assert.equal(harness.sent.length, 2);
  assert.ok(harness.sent[1]?.includes("Next reply"));
});

test("writer bounds queued retained bytes and captures only admitted bounded data", async (t) => {
  let releaseSend!: () => void;
  const sendGate = new Promise<void>((resolve) => {
    releaseSend = resolve;
  });
  let sendCalls = 0;
  const harness = await runtimeHarness(t, {
    async sendText() {
      sendCalls += 1;
      if (sendCalls === 1) await sendGate;
    },
  });
  const first = harness.connection.sendData?.({
    kind: "application",
    text: "hold",
  });
  assert.ok(first);
  await waitForCondition(
    () => sendCalls === 1,
    "first retained send did not start",
  );

  const full = "x".repeat(64 * 1_024);
  const admitted = Array.from({ length: 4 }, () =>
    harness.connection.sendData?.({ kind: "application", text: full }),
  );
  const overflow = harness.connection.sendData?.({
    kind: "application",
    text: "x",
  });
  assert.ok(overflow);
  await assert.rejects(overflow, {
    message: "Live transport protocol failed.",
  });

  releaseSend();
  await first;
  await Promise.all(admitted);

  const mutable: { kind: "application" | "final"; text: string } = {
    kind: "application",
    text: "captured text",
  };
  const captured = harness.connection.sendData?.(mutable);
  assert.ok(captured);
  mutable.kind = "final";
  mutable.text = "changed after admission";
  await captured;
  const delivered = harness.sent.map((wire) => appended(wire).content);
  assert.equal(delivered.includes("captured text"), true);
  assert.equal(delivered.includes("changed after admission"), false);
});

test("ping replies use the bounded writer and checked failures expose no raw error", async (t) => {
  const pongPayloads: Uint8Array[] = [];
  const pingHarness = await runtimeHarness(t, {
    async sendPong(payload) {
      pongPayloads.push(payload);
    },
  });
  pingHarness.sideband.onPing(new Uint8Array(125));
  await waitForCondition(() => pongPayloads.length === 1, "pong was not sent");
  assert.equal(pongPayloads[0]!.byteLength, 125);

  const oversizedPing = await runtimeHarness(t, {
    async sendPong() {
      assert.fail("oversized ping must not be answered");
    },
  });
  oversizedPing.sideband.onPing(new Uint8Array(126));
  assert.equal(oversizedPing.diagnostics.at(-1)?.code, "protocol-error");

  const secret = "synthetic-send-secret";
  const failureHarness = await runtimeHarness(t, {
    async sendText() {
      throw new Error(secret);
    },
  });
  failureHarness.handoff("send-failure", "task");
  const sending = failureHarness.connection.sendData?.({
    kind: "application",
    text: "context",
  });
  assert.ok(sending);
  await assert.rejects(sending, (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal(error.message, "Live transport protocol failed.");
    assert.equal(String(error).includes(secret), false);
    return true;
  });
});

test("the fixed session close uses the checked writer at most once", async (t) => {
  const harness = await runtimeHarness(t);
  const controller = new AbortController();
  const request = {
    signal: controller.signal,
    deadline: performance.now() + 5_000,
    remainingMs: 5_000,
  };
  await harness.connection.closeSession(request);
  await harness.connection.closeSession(request);
  assert.deepEqual(
    harness.sent.filter((wire) => wire === '{"type":"session.close"}'),
    ['{"type":"session.close"}'],
  );
});

test("writer resumes after buffered bytes drain without eager chunk generation", async (t) => {
  const clock = new ManualClock();
  let buffered = 256 * 1_024;
  const harness = await runtimeHarness(t, {
    clock,
    bufferedAmount: () => buffered,
  });
  harness.handoff("draining-id", "task");
  const sending = harness.connection.sendData?.({
    kind: "application",
    text: "é".repeat(251),
  });
  assert.ok(sending);
  await Promise.resolve();
  assert.equal(harness.sent.length, 0);
  buffered = 0;
  clock.advance(10);
  await sending;
  assert.equal(harness.sent.length, 2);
});

test("socket headroom is checked for the next frame, not all queued envelopes", async (t) => {
  const clock = new ManualClock();
  let buffered = 256 * 1_024;
  const payload = JSON.stringify({
    type: "session.thinking.append",
    event_id: "privacy-event",
    delegation_id: null,
    content: "x",
  });
  const harness = await runtimeHarness(t, {
    clock,
    bufferedAmount: () => buffered,
    async sendText() {
      buffered = 0;
    },
  });
  const first = harness.connection.sendData?.({
    kind: "application",
    text: "x",
  });
  const second = harness.connection.sendData?.({
    kind: "application",
    text: "y",
  });
  assert.ok(first);
  assert.ok(second);
  const settled = Promise.allSettled([first, second]);
  t.after(async () => {
    await settled;
  });
  buffered -= Buffer.byteLength(payload) + 14;
  clock.advance(10);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(harness.sent.length, 2);
  assert.deepEqual(
    (await settled).map((result) => result.status),
    ["fulfilled", "fulfilled"],
  );
});

test("capacity accounting conservatively includes WebSocket framing", async (t) => {
  const clock = new ManualClock();
  const payload = JSON.stringify({
    type: "session.thinking.append",
    event_id: "privacy-event",
    delegation_id: null,
    content: "x",
  });
  let buffered = 256 * 1_024 - Buffer.byteLength(payload);
  const harness = await runtimeHarness(t, {
    clock,
    bufferedAmount: () => buffered,
  });
  const sending = harness.connection.sendData?.({
    kind: "application",
    text: "x",
  });
  assert.ok(sending);
  await Promise.resolve();
  assert.deepEqual(harness.sent, []);
  buffered -= 14;
  clock.advance(10);
  await sending;
  assert.equal(harness.sent.length, 1);
});

test("writer waits for socket capacity within one five-second send budget", async (t) => {
  const clock = new ManualClock();
  const harness = await runtimeHarness(t, {
    clock,
    bufferedAmount: () => 256 * 1_024,
  });
  harness.handoff("stalled-id", "task");
  const sending = harness.connection.sendData?.({
    kind: "final",
    text: "result",
  });
  assert.ok(sending);
  await Promise.resolve();
  assert.deepEqual(harness.sent, []);
  clock.advance(4_999);
  await Promise.resolve();
  assert.deepEqual(harness.sent, []);
  clock.advance(1);
  await assert.rejects(sending, {
    message: "Live transport connection timed out.",
  });
});

test("queued admission and send timers use the original deadline and ignore early delivery", async (t) => {
  const clock = new ManualClock();
  let releaseSend!: () => void;
  const gate = new Promise<void>((resolve) => {
    releaseSend = resolve;
  });
  let sendCalls = 0;
  const harness = await runtimeHarness(t, {
    clock,
    async sendText() {
      sendCalls += 1;
      await gate;
    },
  });
  const first = harness.connection.sendData?.({
    kind: "application",
    text: "first",
  });
  const queued = harness.connection.sendData?.({
    kind: "application",
    text: "queued",
  });
  assert.ok(first);
  assert.ok(queued);
  await waitForCondition(
    () => sendCalls === 1,
    "first deadline send did not start",
  );
  clock.fireNextWithoutAdvancing();
  let firstSettled = false;
  void first.then(
    () => {
      firstSettled = true;
    },
    () => {
      firstSettled = true;
    },
  );
  await Promise.resolve();
  assert.equal(firstSettled, false);
  clock.advance(5_000);
  await assert.rejects(first, {
    message: "Live transport connection timed out.",
  });
  await assert.rejects(queued, {
    message: "Live transport connection timed out.",
  });
  assert.equal(sendCalls, 1);
  releaseSend();
  await Promise.resolve();
});

test("native capture failure uses the generation-bound closed audio diagnostic", async (t) => {
  let nativeCapture:
    Parameters<LiveNativeAdapter["startCapture"]>[0] | undefined;
  const harness = await runtimeHarness(t, {
    onNativeCaptureCallbacks(callbacks) {
      nativeCapture = callbacks;
    },
  });
  const started = harness.connection.startCapture(() => undefined);
  await started.result;
  assert.ok(nativeCapture);
  nativeCapture.onFailure();
  assert.deepEqual(harness.diagnostics.at(-1), {
    code: "audio-error",
    phase: "audio",
    text: "Pi Live audio failed.",
  });
});

test("service errors are reported by code only and keep the call open", async (t) => {
  const harness = await runtimeHarness(t);
  const secret = "synthetic-provider-secret";
  harness.native({
    type: "error",
    error: { code: "rate_limit_exceeded", message: secret },
  });
  harness.native({ type: "error", error: { code: secret.repeat(9) } });
  harness.sideband.onText(
    Buffer.from(JSON.stringify({ type: "error", error: { message: secret } })),
  );
  harness.sideband.onText(
    Buffer.from(
      JSON.stringify({
        type: "error",
        error: { code: "invalid_value", client_event_id: "privacy-event" },
      }),
    ),
  );
  assert.deepEqual(harness.serviceErrors, [
    "rate_limit_exceeded",
    "unknown",
    "invalid_value",
  ]);
  assert.deepEqual(harness.diagnostics, []);
  await harness.connection.sendData?.({
    kind: "application",
    text: "still open",
  });
  assert.equal(harness.sent.length, 1);
});

test("a service-ended session stops the call; an acknowledged close does not", async (t) => {
  const harness = await runtimeHarness(t);
  harness.native({ type: "session.closed", reason: "expired" });
  assert.deepEqual(harness.diagnostics.at(-1), {
    code: "remote-ended",
    phase: "protocol",
    text: "The voice service ended the call.",
  });

  const closing = await runtimeHarness(t);
  await closing.connection.closeSession({
    signal: new AbortController().signal,
    deadline: performance.now() + 5_000,
    remainingMs: 5_000,
  });
  closing.sideband.onText(
    Buffer.from(
      JSON.stringify({ type: "session.closed", reason: "close_requested" }),
    ),
  );
  assert.deepEqual(closing.diagnostics, []);
});
