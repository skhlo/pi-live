import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createLiveRuntimeResources,
  resolveLiveRegistryCredentials,
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

test("the live credential is Pi's openai API key, resolved once", async () => {
  const calls: string[] = [];
  assert.deepEqual(
    await resolveLiveRegistryCredentials(
      registryReturning("sk-proj-fixture", calls),
    ),
    { apiKey: "sk-proj-fixture" },
  );
  assert.deepEqual(calls, ["openai"]);
});

test("API keys have an inclusive UTF-8 bound and cannot inject headers", async (t) => {
  const exact = "k".repeat(1_024);
  assert.deepEqual(
    await resolveLiveRegistryCredentials(registryReturning(exact)),
    { apiKey: exact },
  );
  for (const [name, raw] of [
    ["limit plus one", `${exact}k`],
    ["multibyte limit plus one", "é".repeat(513)],
    ["empty", ""],
    ["surrounding whitespace", " sk-fixture "],
    ["header injection", "sk-fixture\r\nleak: yes"],
    ["invalid Unicode", "sk-fixture\ud800"],
  ] as const) {
    await t.test(name, async () => {
      assert.equal(
        await resolveLiveRegistryCredentials(registryReturning(raw)),
        undefined,
      );
    });
  }
});

test("call-scoped credentials are passed to only their connection generation", async (t) => {
  const fixture = await createLiveFixture(t);
  const credentials: LiveCredentials = { apiKey: "sk-generation" };
  const observed: Array<{
    credentials: LiveCredentials | undefined;
    voice: string;
    deadline: number;
  }> = [];
  fixture.resources.credentials = async () => credentials;
  fixture.resources.connect = (input) => {
    observed.push({
      credentials: input.credentials,
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
    { credentials, voice: "marin", deadline: 30_000 },
  ]);
  assert.deepEqual(await lifecycle.stop(), { status: "off" });
});

test("missing registry auth stops before transport construction", async (t) => {
  const fixture = await createLiveFixture(t);
  let peerConstructions = 0;
  const resources = createLiveRuntimeResources({
    registry: { getApiKeyForProvider: async () => undefined },
    instructions: "fixture",
    native: {
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
  resolveLate("sk-late");
  await late;
});

test("aborted credential resolution emits neither missing-auth nor a late diagnostic", async () => {
  const pending = new Promise<string>(() => undefined);
  const diagnostics: unknown[] = [];
  const resources = createLiveRuntimeResources({
    registry: registryReturning(pending),
    instructions: "fixture",
    native: {
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
