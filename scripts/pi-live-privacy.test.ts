import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";

import {
  createLiveRuntimeResources,
  type LiveAttestation,
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

const credentials: LiveCredentials = {
  accessToken: "privacy-access-token",
  accountId: "privacy-account",
};
const attestation: LiveAttestation = {
  header: "privacy-attestation",
  supported: true,
};

interface RuntimeHarness {
  connection: LiveConnection;
  sideband: LiveSidebandStartInput;
  sent: string[];
  diagnostics: LiveRuntimeDiagnostic[];
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
    admitRequests?: boolean;
    onRequest?: (request: { id: string; text: string }) => boolean;
    onNativeCallbacks?: (
      callbacks: Parameters<LiveNativeAdapter["createPeer"]>[0],
    ) => void;
    onNativeCaptureCallbacks?: (
      callbacks: Parameters<LiveNativeAdapter["startCapture"]>[0],
    ) => void;
  } = {},
): Promise<RuntimeHarness> {
  let sideband!: LiveSidebandStartInput;
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
    deviceCheck: {
      generateToken: async () => ({ supported: false, latencyMs: 0 }),
    },
    createPeer(callbacks) {
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
        status: 200,
        statusText: "OK",
        location: "/v1/live/rtc_privacy",
        body: (async function* () {
          yield Buffer.from("answer");
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
    sessionId: "privacy-session",
    instructions: "privacy instructions",
    native,
    network,
    clock: options.clock,
    randomId: () => "privacy-realtime-session",
    proxyForUrl: () => undefined,
    callbacks: {
      onRequest(request) {
        requests.push(request);
        return options.onRequest?.(request) ?? options.admitRequests === true;
      },
      onTranscript: (transcript) => transcripts.push(transcript),
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    },
  });
  const started = resources.connect({
    signal: new AbortController().signal,
    deadline: (options.clock?.nowValue ?? performance.now()) + 30_000,
    credentials,
    attestation,
    voice: "sol",
  });
  const connection = await started.result;
  t.after(async () => {
    await connection.close().catch(() => undefined);
  });
  return {
    connection,
    sideband,
    sent,
    diagnostics,
    requests,
    transcripts,
  };
}

function delegation(id: string, text: string): Uint8Array {
  return Buffer.from(
    JSON.stringify({
      type: "delegation.created",
      item: {
        type: "delegation",
        target: "client",
        id,
        content: [{ type: "input_text", text }],
      },
    }),
  );
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

test("native and sideband ingress share a bounded event bucket before dispatch", async (t) => {
  const harness = await runtimeHarness(t);
  const unknown = Buffer.from('{"type":"future.event"}');
  for (let count = 0; count < 200; count += 1) harness.sideband.onText(unknown);
  assert.deepEqual(harness.diagnostics, []);
  harness.sideband.onPing(new Uint8Array());
  assert.deepEqual(harness.diagnostics.at(-1), {
    code: "protocol-error",
    phase: "protocol",
    text: "Pi Live protocol failed.",
  });
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

  const exactRequest = await runtimeHarness(t);
  exactRequest.sideband.onText(
    delegation("request", "é".repeat((64 * 1_024) / 2)),
  );
  assert.equal(Buffer.byteLength(exactRequest.requests[0]!.text), 64 * 1_024);
  const largeRequest = await runtimeHarness(t);
  largeRequest.sideband.onText(
    delegation("request", `${"é".repeat((64 * 1_024) / 2)}x`),
  );
  assert.deepEqual(largeRequest.requests, []);
  assert.equal(largeRequest.diagnostics.at(-1)?.code, "protocol-error");

  const exactId = await runtimeHarness(t);
  exactId.sideband.onText(delegation("i".repeat(256), "task"));
  assert.equal(exactId.requests[0]?.id.length, 256);
  const largeId = await runtimeHarness(t);
  largeId.sideband.onText(delegation("i".repeat(257), "task"));
  assert.deepEqual(largeId.requests, []);
  assert.equal(largeId.diagnostics.at(-1)?.code, "protocol-error");

  const exactContent = await runtimeHarness(t);
  const contentEvent = (count: number) =>
    Buffer.from(
      JSON.stringify({
        type: "delegation.created",
        item: {
          type: "delegation",
          target: "client",
          id: `content-${count}`,
          content: Array.from({ length: count }, () => ({
            type: "input_text",
            text: "x",
          })),
        },
      }),
    );
  exactContent.sideband.onText(contentEvent(64));
  assert.equal(exactContent.requests.length, 1);
  const largeContent = await runtimeHarness(t);
  largeContent.sideband.onText(contentEvent(65));
  assert.deepEqual(largeContent.requests, []);
  assert.equal(largeContent.diagnostics.at(-1)?.code, "protocol-error");
});

test("malformed UTF-8 and oversized raw delegation text fail before callbacks", async (t) => {
  const malformedWire = await runtimeHarness(t);
  malformedWire.sideband.onText(Uint8Array.from([0xff]));
  assert.deepEqual(malformedWire.requests, []);
  assert.equal(malformedWire.diagnostics.at(-1)?.code, "protocol-error");

  const malformedText = await runtimeHarness(t);
  malformedText.sideband.onText(delegation("bad-unicode", "\ud800"));
  assert.deepEqual(malformedText.requests, []);
  assert.equal(malformedText.diagnostics.at(-1)?.code, "protocol-error");

  const padded = await runtimeHarness(t);
  padded.sideband.onText(
    delegation("raw-request", `${" ".repeat(64 * 1_024)}x`),
  );
  assert.deepEqual(padded.requests, []);
  assert.equal(padded.diagnostics.at(-1)?.code, "protocol-error");
});

test("an active delegation is refused before a second request callback executes", async (t) => {
  const harness = await runtimeHarness(t, { admitRequests: true });
  harness.sideband.onText(delegation("first", "first task"));
  harness.sideband.onText(delegation("second", "second task"));
  assert.deepEqual(harness.requests, [{ id: "first", text: "first task" }]);
  assert.equal(harness.diagnostics.at(-1)?.code, "protocol-error");
});

test("a reentrant request callback cannot execute a second admission", async (t) => {
  let harness!: RuntimeHarness;
  harness = await runtimeHarness(t, {
    onRequest() {
      harness.sideband.onText(delegation("nested", "nested task"));
      return true;
    },
  });
  harness.sideband.onText(delegation("outer", "outer task"));
  assert.deepEqual(harness.requests, [{ id: "outer", text: "outer task" }]);
  assert.equal(harness.diagnostics.at(-1)?.code, "protocol-error");
});

test("a request callback that reentrantly closes transport cannot adopt its result", async (t) => {
  let harness!: RuntimeHarness;
  harness = await runtimeHarness(t, {
    onRequest() {
      void harness.connection.close();
      return true;
    },
  });
  harness.sideband.onText(delegation("reentrant-stop", "task"));
  await assert.rejects(
    harness.connection.sendData?.({ kind: "final", text: "must not send" }) ??
      Promise.resolve(),
    { message: "Live transport was cancelled." },
  );
  assert.deepEqual(harness.sent, []);
});

test("delegation IDs are replay-safe, byte-bounded and never evicted", async (t) => {
  const harness = await runtimeHarness(t);
  harness.sideband.onText(delegation("rtc-request", "do the task"));
  harness.sideband.onText(delegation("rtc-request", "do the task"));
  assert.deepEqual(harness.requests, [
    { id: "rtc-request", text: "do the task" },
  ]);
  harness.sideband.onText(delegation("rtc-request", "changed task"));
  assert.equal(harness.diagnostics.at(-1)?.code, "protocol-error");

  const clock = new ManualClock();
  const exhausted = await runtimeHarness(t, { clock });
  for (let index = 0; index < 256; index += 1) {
    exhausted.sideband.onText(delegation(`request-${index}`, "task"));
    clock.advance(5);
  }
  assert.equal(exhausted.requests.length, 256);
  exhausted.sideband.onText(delegation("request-256", "task"));
  assert.equal(exhausted.requests.length, 256);
  assert.equal(exhausted.diagnostics.at(-1)?.code, "protocol-error");
});

test("transcripts retain only the latest UTF-8 tail per role", async (t) => {
  const harness = await runtimeHarness(t);
  const text = `${"a".repeat(64 * 1_024)}é`;
  harness.sideband.onText(
    Buffer.from(
      JSON.stringify({
        type: "turn.done",
        turn: { role: "user", transcript: text },
      }),
    ),
  );
  assert.equal(harness.transcripts.length, 1);
  const retained = harness.transcripts[0]!.text;
  assert.equal(Buffer.byteLength(retained), 64 * 1_024);
  assert.equal(retained.endsWith("é"), true);
});

test("final writer truncates with a marker, chunks lazily at 500 UTF-8 bytes and permits over 256 KiB lifetime", async (t) => {
  const exact = await runtimeHarness(t, { admitRequests: true });
  exact.sideband.onText(delegation("exact-final-id", "task"));
  await exact.connection.sendData?.({
    kind: "final",
    text: "é".repeat((64 * 1_024) / 2),
  });
  const exactText = exact.sent
    .map((wire) => {
      const message = JSON.parse(wire) as {
        content: Array<{ text: string }>;
      };
      return message.content[0]!.text;
    })
    .join("");
  assert.equal(exactText.endsWith("[truncated]"), false);
  assert.equal(
    Buffer.byteLength(exactText.slice('"Agent Final Message":\n\n'.length)),
    64 * 1_024,
  );

  const harness = await runtimeHarness(t, { admitRequests: true });
  harness.sideband.onText(delegation("final-id", "task"));
  await harness.connection.sendData?.({
    kind: "final",
    text: `${"\u0001".repeat(64 * 1_024)}x`,
  });
  assert.ok(harness.sent.length > 100);
  const chunks = harness.sent.map((wire) => {
    const message = JSON.parse(wire) as {
      type: string;
      delegation_item_id: string;
      content: Array<{ type: string; text: string }>;
    };
    assert.equal(message.type, "delegation.context.append");
    assert.equal(message.delegation_item_id, "final-id");
    assert.equal(message.content.length, 1);
    assert.ok(Buffer.byteLength(message.content[0]!.text) <= 500);
    return message.content[0]!.text;
  });
  const reconstructed = chunks.join("");
  assert.equal(reconstructed.startsWith('"Agent Final Message":\n\n'), true);
  assert.equal(reconstructed.endsWith("[truncated]"), true);
  assert.ok(
    harness.sent.reduce((total, wire) => total + Buffer.byteLength(wire), 0) >
      256 * 1_024,
  );
});

test("context chunking uses an inclusive 500-byte UTF-8 limit", async (t) => {
  const exact = await runtimeHarness(t, { admitRequests: true });
  exact.sideband.onText(delegation("chunk-exact", "task"));
  await exact.connection.sendData?.({
    kind: "application",
    text: "é".repeat(250),
  });
  assert.equal(exact.sent.length, 1);
  const exactMessage = JSON.parse(exact.sent[0]!) as {
    content: Array<{ text: string }>;
  };
  assert.equal(Buffer.byteLength(exactMessage.content[0]!.text), 500);

  const over = await runtimeHarness(t, { admitRequests: true });
  over.sideband.onText(delegation("chunk-over", "task"));
  await over.connection.sendData?.({
    kind: "application",
    text: `${"é".repeat(250)}x`,
  });
  assert.equal(over.sent.length, 2);
  assert.deepEqual(
    over.sent.map((wire) => {
      const message = JSON.parse(wire) as {
        content: Array<{ text: string }>;
      };
      return Buffer.byteLength(message.content[0]!.text);
    }),
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
    admitRequests: true,
    async sendText() {
      sendCalls += 1;
      if (sendCalls === 1) await sendGate;
    },
    onSocketClose: () => {
      socketCloses += 1;
    },
  });
  harness.sideband.onText(delegation("queued", "task"));
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

test("only one lazy final producer is retained while its future envelopes remain unmaterialized", async (t) => {
  let releaseSend!: () => void;
  const sendGate = new Promise<void>((resolve) => {
    releaseSend = resolve;
  });
  let sendCalls = 0;
  const harness = await runtimeHarness(t, {
    admitRequests: true,
    async sendText() {
      sendCalls += 1;
      if (sendCalls === 1) await sendGate;
    },
  });
  harness.sideband.onText(delegation("lazy-final", "task"));
  const sending = harness.connection.sendData?.({
    kind: "final",
    text: "\u0001".repeat(64 * 1_024),
  });
  assert.ok(sending);
  await waitForCondition(() => sendCalls === 1, "final send did not start");
  assert.equal(harness.sent.length, 1);

  const duplicate = harness.connection.sendData?.({
    kind: "final",
    text: "duplicate",
  });
  assert.ok(duplicate);
  try {
    const duplicateOutcome = await Promise.race([
      duplicate.then(
        () => "fulfilled" as const,
        (error: unknown) => error,
      ),
      new Promise<"pending">((resolve) =>
        setTimeout(() => resolve("pending"), 50),
      ),
    ]);
    assert.notEqual(duplicateOutcome, "pending");
    assert.ok(duplicateOutcome instanceof Error);
    assert.equal(duplicateOutcome.message, "Live transport protocol failed.");
  } finally {
    releaseSend();
  }

  await sending;
  assert.ok(harness.sent.length > 100);
  assert.ok(
    harness.sent.reduce((total, wire) => total + Buffer.byteLength(wire), 0) >
      256 * 1_024,
  );
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
  const delivered = harness.sent.map((wire) => {
    const message = JSON.parse(wire) as { content: Array<{ text: string }> };
    return message.content[0]!.text;
  });
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
    admitRequests: true,
    async sendText() {
      throw new Error(secret);
    },
  });
  failureHarness.sideband.onText(delegation("send-failure", "task"));
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
    admitRequests: true,
    bufferedAmount: () => buffered,
  });
  harness.sideband.onText(delegation("draining-id", "task"));
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
    type: "session.context.append",
    channel: "commentary",
    content: [{ type: "input_text", text: "x" }],
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
    type: "session.context.append",
    channel: "commentary",
    content: [{ type: "input_text", text: "x" }],
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
    admitRequests: true,
    bufferedAmount: () => 256 * 1_024,
  });
  harness.sideband.onText(delegation("stalled-id", "task"));
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

test("diagnostics never expose provider payloads or synthetic dependency errors", async (t) => {
  const harness = await runtimeHarness(t);
  const secret = "synthetic-provider-secret";
  harness.sideband.onText(
    Buffer.from(JSON.stringify({ type: "error", message: secret })),
  );
  assert.deepEqual(harness.diagnostics.at(-1), {
    code: "protocol-error",
    phase: "protocol",
    text: "Pi Live protocol failed.",
  });
  assert.equal(JSON.stringify(harness.diagnostics).includes(secret), false);
});
