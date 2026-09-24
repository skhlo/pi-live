import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { LiveNativeBindings, LiveWebRtcPeerInstance } from "/tmp/pi-better-openai.qnz8hk/src/live/native.ts";
import { fakeUndici } from "./fake-undici.ts";
import { fakeSockets } from "./fake-ws.ts";

const { generateCodexAttestation } = await import(
  "/tmp/pi-better-openai.qnz8hk/src/live/attestation.ts"
);
const { CONTEXT_CHUNK_BYTES, chunkLiveContext, parseLiveServerEvent } = await import(
  "/tmp/pi-better-openai.qnz8hk/src/live/protocol.ts"
);
const { LiveSessionController } = await import(
  "/tmp/pi-better-openai.qnz8hk/src/live/controller.ts"
);
const { CodexLiveTransport } = await import(
  "/tmp/pi-better-openai.qnz8hk/src/live/transport.ts"
);
const { extractAccountIdFromJwt, getCodexCredentials, parseCodexRegistryCredentials } =
  await import("/tmp/pi-better-openai.qnz8hk/src/codex-auth.ts");
const { setActiveMultiproviderService } = await import(
  "/tmp/pi-better-openai.qnz8hk/src/multiprovider.ts"
);
const { redactDiagnosticValue, sanitizeDiagnosticError } = await import(
  "/tmp/pi-better-openai.qnz8hk/src/format.ts"
);

type PeerEvent = {
  type: "delegation.created";
  item: {
    type: "delegation";
    target: "client";
    id: string;
    content: Array<{ type: "input_text"; text: string }>;
  };
};

function encodeJwt(accountId: string): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none" })}.${encode({ "https://api.openai.com/auth": { chatgpt_account_id: accountId } })}.synthetic`;
}

function timeout(ms: number): Promise<"timed-out"> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve("timed-out"), ms);
    timer.unref?.();
  });
}

async function settledWithin(
  promise: Promise<unknown>,
  ms = 40,
): Promise<"fulfilled" | "rejected" | "pending"> {
  return Promise.race([
    promise.then(
      () => "fulfilled" as const,
      () => "rejected" as const,
    ),
    timeout(ms).then(() => "pending" as const),
  ]);
}

async function waitUntil(predicate: () => boolean, maxTicks = 50): Promise<void> {
  for (let index = 0; index < maxTicks; index += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error("probe condition did not become true");
}

function nativeFor(
  peer: LiveWebRtcPeerInstance,
  deviceCheckGenerateToken: LiveNativeBindings["deviceCheckGenerateToken"] = async () => ({
    supported: false,
    latencyMs: 0,
  }),
): LiveNativeBindings {
  class Peer {
    constructor(_onEvent: unknown, _onLevel: unknown, _onFailure: unknown) {}
    createOffer(): Promise<string> {
      return peer.createOffer();
    }
    acceptAnswer(sdp: string): Promise<void> {
      return peer.acceptAnswer(sdp);
    }
    waitForOpen(timeoutMs?: number): Promise<void> {
      return peer.waitForOpen(timeoutMs);
    }
    pushAudio(samples: Float32Array): void {
      peer.pushAudio(samples);
    }
    setMuted(muted: boolean): void {
      peer.setMuted(muted);
    }
    close(): Promise<void> {
      return peer.close();
    }
  }
  return {
    AudioCapture: class {
      stop(): void {}
    },
    LiveWebRtcPeer: Peer,
    deviceCheckGenerateToken,
    __ompInstallTokioRuntime(): void {},
  };
}

function signalingResponse() {
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    text: async () => "synthetic-answer",
    headers: {
      get(name: string): string | null {
        return name.toLowerCase() === "location"
          ? "https://chatgpt.com/backend-api/codex/realtime/calls/rtc_probe"
          : null;
      },
    },
  };
}

beforeEach(() => {
  fakeUndici.calls.length = 0;
  fakeUndici.response = undefined;
  fakeSockets.length = 0;
  setActiveMultiproviderService(undefined);
});

afterEach(() => {
  setActiveMultiproviderService(undefined);
});

describe("Luna transport bounded probes", () => {
  test("accepts megabyte delegation and transcript text; only outgoing context is chunked", () => {
    const size = 1_048_576;
    const delegationText = "D".repeat(size);
    const transcriptText = "T".repeat(size);
    const delegation = parseLiveServerEvent(
      JSON.stringify({
        type: "delegation.created",
        item: {
          type: "delegation",
          target: "client",
          id: "synthetic-delegation",
          content: [{ type: "input_text", text: delegationText }],
        },
      }),
    );
    const transcript = parseLiveServerEvent(
      JSON.stringify({
        type: "turn.done",
        turn: { role: "assistant", transcript: transcriptText },
      }),
    );
    const chunks = chunkLiveContext(delegationText);
    const maxBytes = Math.max(...chunks.map((chunk) => Buffer.byteLength(chunk, "utf8")));

    expect(delegation?.type).toBe("delegation.created");
    expect(
      delegation?.type === "delegation.created" ? delegation.item.content[0]?.text.length : 0,
    ).toBe(size);
    expect(transcript?.type).toBe("turn.done");
    expect(transcript?.type === "turn.done" ? transcript.turn.transcript.length : 0).toBe(size);
    expect(chunks.join("")).toBe(delegationText);
    expect(maxBytes).toBeLessThanOrEqual(CONTEXT_CHUNK_BYTES);
    console.log(
      JSON.stringify({ probe: "oversized-text", inputBytes: size, chunks: chunks.length, maxChunkBytes: maxBytes }),
    );
  });

  test("delivers the same delegation id twice instead of deduplicating it", async () => {
    let transportOptions: { callbacks: { onEvent: (event: PeerEvent) => void } } | undefined;
    const delegate = vi.fn();
    const send = vi.fn(async () => undefined);
    const controller = new LiveSessionController({
      sessionId: "synthetic-session",
      native: nativeFor({
        createOffer: async () => "unused",
        acceptAnswer: async () => undefined,
        waitForOpen: async () => undefined,
        pushAudio: () => undefined,
        setMuted: () => undefined,
        close: async () => undefined,
      }),
      getCredentials: vi.fn(async () => ({ accessToken: "synthetic-token", accountId: "synthetic-account" })),
      delegate,
      createTransport: (options) => {
        transportOptions = options as typeof transportOptions;
        return {
          connect: vi.fn(async () => undefined),
          send,
          pushAudio: vi.fn(),
          setMuted: vi.fn(),
          close: vi.fn(async () => undefined),
        };
      },
      createAudioCapture: () => ({ stop: vi.fn() }),
      callbacks: {
        onPhase: vi.fn(),
        onLevels: vi.fn(),
        onTranscript: vi.fn(),
        onTerminal: vi.fn(),
      },
    });
    await controller.start();
    const event: PeerEvent = {
      type: "delegation.created",
      item: {
        type: "delegation",
        target: "client",
        id: "duplicate-id",
        content: [{ type: "input_text", text: "same request" }],
      },
    };
    transportOptions?.callbacks.onEvent(event);
    transportOptions?.callbacks.onEvent(event);

    expect(delegate).toHaveBeenCalledTimes(2);
    expect(controller.activeDelegationId).toBe("duplicate-id");
    console.log(
      JSON.stringify({ probe: "duplicate-delegation", delegateCalls: delegate.mock.calls.length }),
    );
    await controller.stop();
  });

  test("shows sanitizer coverage and synthetic credential parsing boundaries", async () => {
    const accountId = "acct_probe_123456";
    const uuid = "123e4567-e89b-12d3-a456-426614174000";
    const jwt = encodeJwt(accountId);
    const rawJwt = sanitizeDiagnosticError(`jwt=${jwt}`);
    const bearerJwt = sanitizeDiagnosticError(`Authorization: Bearer ${jwt}`);
    const accountError = sanitizeDiagnosticError(`request failed for ${accountId}`);
    const uuidError = sanitizeDiagnosticError(`request ${uuid} failed`);
    const proxyError = sanitizeDiagnosticError(
      `proxy failed at https://proxy-user:proxy-secret@example.test:8443`,
    );
    const redactedObject = redactDiagnosticValue({
      accessToken: jwt,
      accountId: uuid,
      proxyUrl: "https://proxy-user:proxy-secret@example.test:8443",
    });
    const registry = vi.fn(async () => JSON.stringify({ access: "synthetic-access", accountId }));
    const ctx = {
      modelRegistry: { getApiKeyForProvider: registry },
      model: undefined,
      sessionManager: { getSessionId: () => "synthetic-session" },
    } as never;
    const parsed = parseCodexRegistryCredentials(JSON.stringify({ access: jwt, accountId }));
    const service = {
      getActiveAccount: vi.fn(async () => undefined),
      resolveActiveAccountAuth: vi.fn(async () => ({ accessToken: jwt, label: "synthetic" })),
      onActiveAccountChanged: vi.fn(() => () => undefined),
    };
    setActiveMultiproviderService(service);
    const selected = await getCodexCredentials(ctx);

    expect(extractAccountIdFromJwt(jwt)).toBe(accountId);
    expect(parsed).toEqual({ accessToken: jwt, accountId });
    expect(selected?.source).toBe("multiprovider");
    expect(registry).not.toHaveBeenCalled();
    expect(bearerJwt).toBe("Authorization: [REDACTED] [REDACTED]");
    expect(rawJwt).toContain(jwt);
    expect(accountError).toContain("acct_[REDACTED]");
    expect(uuidError).toContain(uuid);
    expect(proxyError).toContain("proxy-secret");
    expect(redactedObject).toEqual({
      accessToken: "[REDACTED]",
      accountId: "[REDACTED]",
      proxyUrl: "https://proxy-user:proxy-secret@example.test:8443",
    });
    console.log(
      JSON.stringify({
        probe: "sanitizer-auth",
        rawJwtLeaks: rawJwt.includes(jwt),
        bearerJwtRedacted: bearerJwt === "Authorization: [REDACTED] [REDACTED]",
        accountMasked: accountError.includes("acct_[REDACTED]"),
        uuidLeaks: uuidError.includes(uuid),
        proxyPasswordLeaks: proxyError.includes("proxy-secret"),
        selectedSource: selected?.source,
      }),
    );
  });

  test("abort does not settle a native createOffer that never resolves", async () => {
    let releaseOffer!: (offer: string) => void;
    const createOffer = new Promise<string>((resolve) => {
      releaseOffer = resolve;
    });
    const peerClose = vi.fn(async () => undefined);
    const peer: LiveWebRtcPeerInstance = {
      createOffer: () => createOffer,
      acceptAnswer: async () => undefined,
      waitForOpen: async () => undefined,
      pushAudio: () => undefined,
      setMuted: () => undefined,
      close: peerClose,
    };
    const signal = new AbortController();
    const transport = new CodexLiveTransport({
      sessionId: "synthetic-session",
      instructions: "synthetic",
      voice: "synthetic",
      getCredentials: vi.fn(async () => ({ accessToken: "synthetic-token", accountId: "synthetic-account" })),
      callbacks: { onEvent: vi.fn(), onOutputLevel: vi.fn() },
      signal: signal.signal,
      native: nativeFor(peer),
    });
    const connect = transport.connect();
    await Promise.resolve();
    signal.abort();
    await transport.close();

    expect(await settledWithin(connect)).toBe("pending");
    expect(peerClose).toHaveBeenCalledOnce();
    console.log(
      JSON.stringify({ probe: "abort-createOffer", connectAfterAbort: "pending", peerCloseCalls: peerClose.mock.calls.length }),
    );
    releaseOffer("synthetic-offer");
    await expect(connect).rejects.toMatchObject({ name: "AbortError" });
  });

  test("abort does not settle a native waitForOpen that never resolves", async () => {
    fakeUndici.response = signalingResponse();
    let releaseOpen!: () => void;
    let waitForOpenCalls = 0;
    const peerClose = vi.fn(async () => undefined);
    const peer: LiveWebRtcPeerInstance = {
      createOffer: async () => "synthetic-offer",
      acceptAnswer: async () => undefined,
      waitForOpen: () => {
        waitForOpenCalls += 1;
        return new Promise<void>((resolve) => {
          releaseOpen = resolve;
        });
      },
      pushAudio: () => undefined,
      setMuted: () => undefined,
      close: peerClose,
    };
    const signal = new AbortController();
    const transport = new CodexLiveTransport({
      sessionId: "synthetic-session",
      instructions: "synthetic",
      voice: "synthetic",
      getCredentials: vi.fn(async () => ({ accessToken: "synthetic-token", accountId: "synthetic-account" })),
      callbacks: { onEvent: vi.fn(), onOutputLevel: vi.fn() },
      signal: signal.signal,
      native: nativeFor(peer),
    });
    const connect = transport.connect();
    await waitUntil(() => waitForOpenCalls === 1);
    signal.abort();
    await transport.close();

    expect(await settledWithin(connect)).toBe("pending");
    expect(peerClose).toHaveBeenCalledOnce();
    console.log(
      JSON.stringify({ probe: "abort-waitForOpen", connectAfterAbort: "pending", peerCloseCalls: peerClose.mock.calls.length }),
    );
    releaseOpen();
    await expect(connect).rejects.toMatchObject({ name: "AbortError" });
  });

  test("a DeviceCheck promise has no abort or time bound", async () => {
    if (process.platform !== "darwin" || process.arch !== "arm64") return;
    let releaseToken!: (result: { supported: boolean; latencyMs: number }) => void;
    const deviceCheckGenerateToken = vi.fn(
      () =>
        new Promise<{ supported: boolean; latencyMs: number }>((resolve) => {
          releaseToken = resolve;
        }),
    );
    const attestation = generateCodexAttestation({ deviceCheckGenerateToken });

    expect(await settledWithin(attestation)).toBe("pending");
    expect(deviceCheckGenerateToken).toHaveBeenCalledOnce();
    console.log(
      JSON.stringify({ probe: "abort-deviceCheck", resultAfterTimeout: "pending", acceptsAbortSignal: false }),
    );
    releaseToken({ supported: false, latencyMs: 0 });
    await expect(attestation).resolves.toMatch(/^\{"v":1,"s":0,"t":"v1\./);
  });

  test("sends while fake WebSocket bufferedAmount is high because no backpressure gate exists", async () => {
    fakeUndici.response = signalingResponse();
    const peer: LiveWebRtcPeerInstance = {
      createOffer: async () => "synthetic-offer",
      acceptAnswer: async () => undefined,
      waitForOpen: async () => undefined,
      pushAudio: () => undefined,
      setMuted: () => undefined,
      close: async () => undefined,
    };
    const transport = new CodexLiveTransport({
      sessionId: "synthetic-session",
      instructions: "synthetic",
      voice: "synthetic",
      getCredentials: vi.fn(async () => ({ accessToken: "synthetic-token", accountId: "synthetic-account" })),
      callbacks: { onEvent: vi.fn(), onOutputLevel: vi.fn() },
      native: nativeFor(peer),
    });
    const connect = transport.connect();
    await waitUntil(() => fakeSockets.length === 1);
    const socket = fakeSockets[0] as {
      readyState: number;
      bufferedAmount: number;
      emit: (event: string, ...args: unknown[]) => void;
      sent: string[];
    };
    socket.readyState = 1;
    socket.bufferedAmount = 16 * 1024 * 1024;
    socket.emit("open");
    await connect;
    await Promise.all(
      Array.from({ length: 32 }, (_, index) =>
        transport.send({
          type: "session.context.append",
          content: [{ type: "input_text", text: `synthetic-${index}` }],
        }),
      ),
    );
    expect(socket.sent).toHaveLength(32);
    expect(socket.bufferedAmount).toBe(16 * 1024 * 1024);
    console.log(
      JSON.stringify({ probe: "websocket-backpressure", bufferedAmount: socket.bufferedAmount, sends: socket.sent.length }),
    );
    await transport.close();
  });
});
