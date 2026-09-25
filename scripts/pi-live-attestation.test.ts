import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createLiveRuntimeResources,
  prepareLiveAttestation,
  type LiveDeviceCheck,
} from "../src/live.ts";
import {
  approvingConsent,
  createLiveFixture,
  deferred,
} from "./test-support/live-fixture.ts";
import { waitForCondition } from "./test-support/live-wait.ts";

function deviceCheck(
  result: Awaited<ReturnType<LiveDeviceCheck["generateToken"]>>,
): LiveDeviceCheck {
  return { generateToken: async () => result };
}

function decodedClientAttestation(header: string): Buffer {
  const envelope = JSON.parse(header) as { v: number; s: number; t: string };
  assert.deepEqual({ v: envelope.v, s: envelope.s }, { v: 1, s: 0 });
  assert.match(envelope.t, /^v1\./);
  return Buffer.from(envelope.t.slice(3), "base64url");
}

test("attestation preserves the Codex bundle, app, locale, timezone and token CBOR", async () => {
  const token = Buffer.from("device-token").toString("base64");
  const result = await prepareLiveAttestation(
    deviceCheck({ supported: true, tokenBase64: token, latencyMs: 12.5 }),
    {
      locale: "en-GB",
      timeZone: "Europe/London",
      appSessionId: "fixture-app-session",
    },
  );

  assert.equal(result.supported, true);
  const cbor = decodedClientAttestation(result.header);
  for (const retainedValue of [
    "token",
    token,
    "bundle_id",
    "com.openai.codex",
    "en-GB",
    "Europe/London",
    "fixture-app-session",
  ]) {
    assert.equal(
      cbor.includes(Buffer.from(retainedValue)),
      true,
      retainedValue,
    );
  }
});

test("explicit DeviceCheck unsupported is encoded and is not treated as an omitted header", async () => {
  const result = await prepareLiveAttestation(
    deviceCheck({ supported: false, latencyMs: 1 }),
    { locale: "en", timeZone: "UTC", appSessionId: "fixture" },
  );
  assert.equal(result.supported, false);
  assert.ok(result.header.length > 0);
  const cbor = decodedClientAttestation(result.header);
  assert.equal(cbor.includes(Buffer.from("error_code")), true);
  assert.equal(cbor.includes(Buffer.from("com.openai.codex")), true);
});

test("DeviceCheck token and complete-header maxima are inclusive", async () => {
  const exactToken = Buffer.alloc(8 * 1_024, 0x61).toString("base64");
  const exact = await prepareLiveAttestation(
    deviceCheck({ supported: true, tokenBase64: exactToken, latencyMs: 0 }),
    { locale: "en", timeZone: "UTC", appSessionId: "fixture" },
  );
  assert.ok(Buffer.byteLength(exact.header) <= 16 * 1_024);

  const tooLargeToken = Buffer.alloc(8 * 1_024 + 1, 0x61).toString("base64");
  await assert.rejects(
    prepareLiveAttestation(
      deviceCheck({
        supported: true,
        tokenBase64: tooLargeToken,
        latencyMs: 0,
      }),
      { locale: "en", timeZone: "UTC", appSessionId: "fixture" },
    ),
    { message: "Live attestation data is invalid." },
  );
});

test("DeviceCheck errors, conflicts, invalid latency and non-canonical tokens fail closed", async (t) => {
  const validToken = Buffer.from("token").toString("base64");
  for (const [name, result] of [
    [
      "native timeout field",
      { supported: false, error: "native timeout secret", latencyMs: 1 },
    ],
    ["supported without token", { supported: true, latencyMs: 1 }],
    [
      "unsupported with token",
      { supported: false, tokenBase64: validToken, latencyMs: 1 },
    ],
    [
      "token and error conflict",
      {
        supported: true,
        tokenBase64: validToken,
        error: "conflict secret",
        latencyMs: 1,
      },
    ],
    ["negative latency", { supported: false, latencyMs: -1 }],
    [
      "infinite latency",
      { supported: false, latencyMs: Number.POSITIVE_INFINITY },
    ],
    [
      "non-canonical token",
      { supported: true, tokenBase64: "YR==", latencyMs: 1 },
    ],
    [
      "oversized encoded token",
      { supported: true, tokenBase64: "A".repeat(1_000_000), latencyMs: 1 },
    ],
  ] as const) {
    await t.test(name, async () => {
      await assert.rejects(
        prepareLiveAttestation(deviceCheck(result)),
        (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.equal(error.message, "Live attestation data is invalid.");
          assert.equal(String(error).includes("secret"), false);
          return true;
        },
      );
    });
  }
});

test("a DeviceCheck error reports only the fixed attestation diagnostic", async () => {
  const diagnostics: unknown[] = [];
  const resources = createLiveRuntimeResources({
    registry: { getApiKeyForProvider: async () => undefined },
    sessionId: "attestation-diagnostic",
    instructions: "fixture",
    native: {
      deviceCheck: deviceCheck({
        supported: false,
        error: "native timeout secret",
        latencyMs: 1,
      }),
      createPeer() {
        throw new Error("must stay lazy");
      },
      startCapture() {
        throw new Error("must stay lazy");
      },
    },
    network: {
      signal() {
        throw new Error("must stay lazy");
      },
      openSideband() {
        throw new Error("must stay lazy");
      },
    },
    callbacks: { onDiagnostic: (diagnostic) => diagnostics.push(diagnostic) },
  });
  await assert.rejects(
    resources.attestation({
      signal: new AbortController().signal,
      credentials: { accessToken: "unused", accountId: "unused" },
    }),
    { message: "Live attestation failed." },
  );
  assert.deepEqual(diagnostics, [
    {
      code: "protocol-error",
      phase: "attestation",
      text: "Pi Live protocol failed.",
    },
  ]);
  assert.equal(JSON.stringify(diagnostics).includes("secret"), false);
});

test("never and late DeviceCheck results consume the five-second call phase and cannot resume setup", async (t) => {
  const fixture = await createLiveFixture(t);
  const entered = deferred<void>();
  const result = deferred<{
    supported: boolean;
    tokenBase64?: string;
    latencyMs: number;
  }>();
  let connectCalls = 0;
  const resources = createLiveRuntimeResources({
    registry: {
      getApiKeyForProvider: async () => {
        const payload = Buffer.from(
          JSON.stringify({
            exp: 4_000_000_000,
            "https://api.openai.com/auth": {
              chatgpt_account_id: "late-account",
            },
          }),
        ).toString("base64url");
        return `header.${payload}.signature`;
      },
    },
    sessionId: "attestation-session",
    instructions: "fixture",
    clock: fixture.clock,
    native: {
      deviceCheck: {
        generateToken() {
          entered.resolve();
          return result.promise;
        },
      },
      createPeer() {
        connectCalls += 1;
        throw new Error("late attestation must not construct native peer");
      },
      startCapture() {
        throw new Error("late attestation must not start capture");
      },
    },
    network: {
      signal() {
        connectCalls += 1;
        throw new Error("late attestation must not signal");
      },
      openSideband() {
        throw new Error("late attestation must not open sideband");
      },
    },
  });
  const lifecycle = fixture.createLifecycle(approvingConsent, {
    clock: fixture.clock,
    resources,
  });
  const starting = lifecycle.start();
  await entered.promise;
  fixture.clock.advance(4_999);
  assert.equal(lifecycle.snapshot().state, "acquiring");
  fixture.clock.advance(1);
  assert.equal((await starting).kind, "cancelled");
  await waitForCondition(
    () => lifecycle.snapshot().state === "off",
    "timed-out attestation did not release fixture ownership",
  );
  result.resolve({ supported: false, latencyMs: 1 });
  await result.promise;
  await Promise.resolve();
  assert.equal(connectCalls, 0);
  assert.equal(lifecycle.snapshot().lastFailure, "connect-timeout");
});

test("DeviceCheck failure is closed and never becomes silent no-attestation fallback", async () => {
  const secret = "synthetic-devicecheck-secret";
  const native: LiveDeviceCheck = {
    async generateToken() {
      throw new Error(secret);
    },
  };
  await assert.rejects(prepareLiveAttestation(native), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal(error.message, "Live attestation failed.");
    assert.equal(String(error).includes(secret), false);
    assert.equal("cause" in error, false);
    return true;
  });
});
