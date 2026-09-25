import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createLiveRuntimeResources,
  resolveLiveRegistryCredentials,
  type LiveAttestation,
  type LiveCredentialRegistry,
  type LiveCredentials,
} from "../src/live.ts";
import {
  approvingConsent,
  createLiveFixture,
  settledStart,
} from "./test-support/live-fixture.ts";
import { waitForCondition } from "./test-support/live-wait.ts";

function registryReturning(
  value: string | undefined | Promise<string | undefined>,
  calls: string[] = [],
): LiveCredentialRegistry {
  return {
    async getApiKeyForProvider(provider) {
      calls.push(provider);
      return value;
    },
  };
}

function jwt(payload: Record<string, unknown>): string {
  return [
    Buffer.from('{"alg":"none"}').toString("base64url"),
    Buffer.from(JSON.stringify(payload)).toString("base64url"),
    "signature-not-verified",
  ].join(".");
}

function codexJwt(accountId: string, expirySeconds?: number): string {
  return jwt({
    ...(expirySeconds === undefined ? {} : { exp: expirySeconds }),
    "https://api.openai.com/auth": { chatgpt_account_id: accountId },
  });
}

test("registry credentials are resolved once from only openai-codex and pin the JWT identity", async () => {
  const calls: string[] = [];
  const accessToken = codexJwt("acct_fixture", 2_000);

  assert.deepEqual(
    await resolveLiveRegistryCredentials(
      registryReturning(accessToken, calls),
      {
        now: () => 1_000_000,
      },
    ),
    { accessToken, accountId: "acct_fixture" },
  );
  assert.deepEqual(calls, ["openai-codex"]);
});

test("registry JSON credentials honor usable expiry and exact UTF-8 token/account bounds", async (t) => {
  const exactToken = "t".repeat(16 * 1_024);
  const exactAccount = "é".repeat(128);
  assert.deepEqual(
    await resolveLiveRegistryCredentials(
      registryReturning(
        JSON.stringify({
          access: exactToken,
          accountId: exactAccount,
          expires: 1_001,
        }),
      ),
      { now: () => 1_000 },
    ),
    { accessToken: exactToken, accountId: exactAccount },
  );

  for (const [name, raw] of [
    [
      "token limit plus one",
      JSON.stringify({ access: `${exactToken}x`, accountId: "acct" }),
    ],
    [
      "multibyte account limit plus one",
      JSON.stringify({ access: "token", accountId: `${exactAccount}x` }),
    ],
    [
      "expired JSON credential",
      JSON.stringify({ access: "token", accountId: "acct", expires: 1_000 }),
    ],
    ["expired JWT credential", codexJwt("acct", 1_000)],
    [
      "header injection",
      JSON.stringify({ access: "token\r\nleak: yes", accountId: "acct" }),
    ],
  ] as const) {
    await t.test(name, async () => {
      assert.equal(
        await resolveLiveRegistryCredentials(registryReturning(raw), {
          now: () => 1_000_000,
        }),
        undefined,
      );
    });
  }
});

test("wrapped JWTs use embedded expiry and account evidence and malformed JWT bytes fail closed", async (t) => {
  const now = 1_000_000;
  const future = codexJwt("acct", 2_000);
  assert.deepEqual(
    await resolveLiveRegistryCredentials(
      registryReturning(JSON.stringify({ access: future, accountId: "acct" })),
      { now: () => now },
    ),
    { accessToken: future, accountId: "acct" },
  );

  for (const [name, raw] of [
    [
      "expired embedded token with future wrapper expiry",
      JSON.stringify({
        access: codexJwt("acct", 1_000),
        accountId: "acct",
        expires: now + 10_000,
      }),
    ],
    [
      "expired embedded token without wrapper expiry",
      JSON.stringify({
        access: codexJwt("acct", 1_000),
        accountId: "acct",
      }),
    ],
    [
      "embedded account mismatch",
      JSON.stringify({ access: future, accountId: "other" }),
    ],
    ["plain token missing expiry", codexJwt("acct")],
    [
      "opaque wrapper missing expiry",
      JSON.stringify({ access: "opaque-token", accountId: "acct" }),
    ],
    ["non-canonical base64url payload", ["header", "A", "signature"].join(".")],
    [
      "invalid UTF-8 payload",
      ["header", Buffer.from([0xff]).toString("base64url"), "signature"].join(
        ".",
      ),
    ],
    [
      "invalid account Unicode",
      JSON.stringify({
        access: "opaque-token",
        accountId: "acct\ud800",
        expires: now + 1,
      }),
    ],
  ] as const) {
    await t.test(name, async () => {
      assert.equal(
        await resolveLiveRegistryCredentials(registryReturning(raw), {
          now: () => now,
        }),
        undefined,
      );
    });
  }
});

test("call-scoped credentials and attestation are passed to only their connection generation", async (t) => {
  const fixture = await createLiveFixture(t);
  const credentials: LiveCredentials = {
    accessToken: "generation-token",
    accountId: "generation-account",
  };
  const attestation: LiveAttestation = {
    header: "generation-attestation",
    supported: true,
  };
  const observed: Array<{
    credentials: LiveCredentials | undefined;
    attestation: LiveAttestation | undefined;
    voice: string;
    deadline: number;
  }> = [];
  fixture.resources.credentials = async () => credentials;
  fixture.resources.attestation = async () => attestation;
  fixture.resources.connect = (input) => {
    observed.push({
      credentials: input.credentials,
      attestation: input.attestation,
      voice: input.voice,
      deadline: input.deadline,
    });
    return settledStart(fixture.connection);
  };
  const lifecycle = fixture.createLifecycle(approvingConsent, {
    clock: fixture.clock,
  });

  assert.equal((await lifecycle.start()).kind, "started");
  assert.deepEqual(observed, [
    { credentials, attestation, voice: "sol", deadline: 30_000 },
  ]);
  assert.deepEqual(await lifecycle.stop(), { status: "off" });
});

test("missing registry auth stops before DeviceCheck or transport construction", async (t) => {
  const fixture = await createLiveFixture(t);
  let deviceChecks = 0;
  let peerConstructions = 0;
  const resources = createLiveRuntimeResources({
    registry: { getApiKeyForProvider: async () => undefined },
    sessionId: "missing-auth-session",
    instructions: "fixture",
    native: {
      deviceCheck: {
        async generateToken() {
          deviceChecks += 1;
          return { supported: false, latencyMs: 0 };
        },
      },
      createPeer() {
        peerConstructions += 1;
        throw new Error("missing auth must not construct a peer");
      },
      startCapture() {
        throw new Error("missing auth must not capture");
      },
    },
    network: {
      signal() {
        throw new Error("missing auth must not signal");
      },
      openSideband() {
        throw new Error("missing auth must not open sideband");
      },
    },
  });
  const lifecycle = fixture.createLifecycle(approvingConsent, { resources });

  assert.equal((await lifecycle.start()).kind, "cancelled");
  await waitForCondition(
    () => lifecycle.snapshot().state === "off",
    "missing-auth cleanup did not release fixture ownership",
  );
  assert.equal(lifecycle.snapshot().lastFailure, "missing-auth");
  assert.equal(deviceChecks, 0);
  assert.equal(peerConstructions, 0);
});

test("registry failure and cancellation stay closed and discard late credential data", async () => {
  const secret = "synthetic-registry-secret";
  const failing: LiveCredentialRegistry = {
    async getApiKeyForProvider() {
      throw new Error(secret);
    },
  };
  assert.equal(await resolveLiveRegistryCredentials(failing), undefined);

  let resolveLate!: (value: string) => void;
  const late = new Promise<string>((resolve) => {
    resolveLate = resolve;
  });
  const controller = new AbortController();
  const resolving = resolveLiveRegistryCredentials(registryReturning(late), {
    signal: controller.signal,
  });
  controller.abort();
  assert.equal(await resolving, undefined);
  resolveLate(codexJwt("late-account", 4_000_000_000));
  await late;
});

test("aborted credential resolution emits neither missing-auth nor a late diagnostic", async () => {
  const pending = new Promise<string>(() => undefined);
  const diagnostics: unknown[] = [];
  const resources = createLiveRuntimeResources({
    registry: registryReturning(pending),
    sessionId: "aborted-auth",
    instructions: "fixture",
    native: {
      deviceCheck: {
        generateToken: async () => ({ supported: false, latencyMs: 0 }),
      },
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
  const controller = new AbortController();
  const resolving = resources.credentials({ signal: controller.signal });
  controller.abort();
  await assert.rejects(resolving, {
    message: "Live authentication resolution was cancelled.",
  });
  await Promise.resolve();
  assert.deepEqual(diagnostics, []);
});
