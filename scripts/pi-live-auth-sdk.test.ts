import assert from "node:assert/strict";
import { setImmediate as nextTurn } from "node:timers/promises";
import test from "node:test";

import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";

const PROVIDER = "openai-codex";
const ACCOUNT_ID = "acct_fixture";
const HOUR_MS = 60 * 60 * 1000;

type ModelRuntimeOptions = NonNullable<
  Parameters<typeof ModelRuntime.create>[0]
>;
type CredentialStore = NonNullable<ModelRuntimeOptions["credentials"]>;
type Credential = NonNullable<Awaited<ReturnType<CredentialStore["read"]>>>;
type ProviderConfig = Parameters<ModelRegistry["registerProvider"]>[1];
type OAuthConfig = NonNullable<ProviderConfig["oauth"]>;
type OAuthCredentials = Parameters<OAuthConfig["refreshToken"]>[0];

function syntheticJwt(
  marker: string,
  accountId: string,
  expiresAt: number,
): string {
  const encode = (value: unknown): string =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none", typ: "JWT" })}.${encode({
    exp: Math.floor(expiresAt / 1000),
    "https://api.openai.com/auth": {
      chatgpt_account_id: accountId,
    },
    fixture: marker,
  })}.synthetic`;
}

function oauthCredential(access: string, expires: number): Credential {
  return {
    type: "oauth",
    access,
    refresh: "synthetic-refresh",
    expires,
  };
}

class InMemoryCredentialStore implements CredentialStore {
  private readonly credentials = new Map<string, Credential>();
  private readonly tails = new Map<string, Promise<void>>();
  readCalls = 0;
  modifyRequests = 0;
  modifyExecutions = 0;
  activeModifiers = 0;
  maxActiveModifiers = 0;
  readonly modifyInputs: Array<Credential | undefined> = [];
  readonly writes: Credential[] = [];

  constructor(initial?: Credential) {
    if (initial) this.credentials.set(PROVIDER, structuredClone(initial));
  }

  async read(
    providerId: string,
    options?: Parameters<CredentialStore["read"]>[1],
  ): Promise<Credential | undefined> {
    options?.signal?.throwIfAborted();
    this.readCalls += 1;
    const credential = this.credentials.get(providerId);
    return credential ? structuredClone(credential) : undefined;
  }

  async list(
    options?: Parameters<CredentialStore["list"]>[0],
  ): Promise<Awaited<ReturnType<CredentialStore["list"]>>> {
    options?.signal?.throwIfAborted();
    return [...this.credentials].map(([providerId, credential]) => ({
      providerId,
      type: credential.type,
    }));
  }

  async modify(
    providerId: string,
    mutation: Parameters<CredentialStore["modify"]>[1],
    options?: Parameters<CredentialStore["modify"]>[2],
  ): Promise<Credential | undefined> {
    this.modifyRequests += 1;
    const predecessor = this.tails.get(providerId) ?? Promise.resolve();
    let release!: () => void;
    const turn = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = predecessor.then(
      () => turn,
      () => turn,
    );
    this.tails.set(providerId, tail);

    await predecessor.catch(() => undefined);
    options?.signal?.throwIfAborted();
    this.modifyExecutions += 1;
    this.activeModifiers += 1;
    this.maxActiveModifiers = Math.max(
      this.maxActiveModifiers,
      this.activeModifiers,
    );
    try {
      const current = this.credentials.get(providerId);
      this.modifyInputs.push(current ? structuredClone(current) : undefined);
      const next = await mutation(
        current ? structuredClone(current) : undefined,
      );
      options?.signal?.throwIfAborted();
      if (next !== undefined) {
        const persisted = structuredClone(next);
        this.credentials.set(providerId, persisted);
        this.writes.push(structuredClone(persisted));
      }
      const persisted = this.credentials.get(providerId);
      return persisted ? structuredClone(persisted) : undefined;
    } finally {
      this.activeModifiers -= 1;
      release();
      if (this.tails.get(providerId) === tail) this.tails.delete(providerId);
    }
  }

  async delete(
    providerId: string,
    options?: Parameters<CredentialStore["delete"]>[1],
  ): Promise<void> {
    options?.signal?.throwIfAborted();
    this.credentials.delete(providerId);
  }

  peek(providerId = PROVIDER): Credential | undefined {
    const credential = this.credentials.get(providerId);
    return credential ? structuredClone(credential) : undefined;
  }

  resetObservations(): void {
    this.readCalls = 0;
    this.modifyRequests = 0;
    this.modifyExecutions = 0;
    this.activeModifiers = 0;
    this.maxActiveModifiers = 0;
    this.modifyInputs.length = 0;
    this.writes.length = 0;
  }
}

interface RegistryFixtureOptions {
  credential?: Credential;
  refreshToken?: OAuthConfig["refreshToken"];
  apiKeyFallback?: string;
}

async function createRegistryFixture(options: RegistryFixtureOptions = {}) {
  const store = new InMemoryCredentialStore(options.credential);
  const runtime = await ModelRuntime.create({
    credentials: store,
    modelsPath: null,
    refreshOnCreate: false,
    allowModelNetwork: false,
  });
  const registry = new ModelRegistry(runtime);
  let refreshCalls = 0;
  const oauth: OAuthConfig = {
    name: "Synthetic OpenAI Codex OAuth",
    async login() {
      throw new Error("Synthetic login must not run");
    },
    async refreshToken(credentials, signal) {
      refreshCalls += 1;
      signal.throwIfAborted();
      if (!options.refreshToken)
        throw new Error("Unexpected synthetic refresh");
      return options.refreshToken(credentials, signal);
    },
    getApiKey(credentials) {
      return credentials.access;
    },
  };
  const provider: ProviderConfig = {
    oauth,
    ...(options.apiKeyFallback === undefined
      ? {}
      : { apiKey: options.apiKeyFallback }),
  };
  registry.registerProvider(PROVIDER, provider);

  // Registration schedules a non-network catalog refresh. Join an explicit
  // isolated refresh, then let the scheduled refresh finish before observing.
  await registry.refresh({ allowNetwork: false, providers: [PROVIDER] });
  await nextTurn();
  store.resetObservations();

  return {
    registry,
    runtime,
    store,
    refreshCalls: () => refreshCalls,
  };
}

function oauthAccess(credential: Credential | undefined): string | undefined {
  return credential?.type === "oauth" ? credential.access : undefined;
}

async function waitFor(
  predicate: () => boolean,
  description: string,
): Promise<void> {
  for (let turn = 0; turn < 100; turn += 1) {
    if (predicate()) return;
    await nextTurn();
  }
  assert.fail(`Timed out waiting for ${description}`);
}

test("valid Codex credentials are returned without refresh", async () => {
  const expires = Date.now() + HOUR_MS;
  const access = syntheticJwt("valid", ACCOUNT_ID, expires);
  const fixture = await createRegistryFixture({
    credential: oauthCredential(access, expires),
  });

  assert.equal(await fixture.registry.getApiKeyForProvider(PROVIDER), access);
  assert.equal(fixture.refreshCalls(), 0);
  assert.equal(fixture.store.modifyRequests, 0);
  assert.deepEqual(fixture.store.writes, []);
});

test("expiring Codex credentials are refreshed, persisted, and returned", async () => {
  const initialExpires = Date.now() + 60_000;
  const refreshedExpires = Date.now() + HOUR_MS;
  const initialAccess = syntheticJwt("expiring", ACCOUNT_ID, initialExpires);
  const refreshedAccess = syntheticJwt(
    "refreshed",
    ACCOUNT_ID,
    refreshedExpires,
  );
  const refreshed: OAuthCredentials = {
    access: refreshedAccess,
    refresh: "synthetic-refresh-rotated",
    expires: refreshedExpires,
  };
  const fixture = await createRegistryFixture({
    credential: oauthCredential(initialAccess, initialExpires),
    refreshToken: async (current) => {
      assert.equal(current.access, initialAccess);
      return refreshed;
    },
  });

  assert.equal(
    await fixture.registry.getApiKeyForProvider(PROVIDER),
    refreshedAccess,
  );
  assert.equal(fixture.refreshCalls(), 1);
  assert.equal(fixture.store.modifyRequests, 1);
  assert.equal(fixture.store.modifyExecutions, 1);
  assert.deepEqual(fixture.store.writes, [{ type: "oauth", ...refreshed }]);
  assert.deepEqual(fixture.store.peek(), { type: "oauth", ...refreshed });
});

test("concurrent refresh is serialized and rechecks expiry under the store lock", async () => {
  const initialExpires = Date.now() + 60_000;
  const refreshedExpires = Date.now() + HOUR_MS;
  const initialAccess = syntheticJwt(
    "concurrent-old",
    ACCOUNT_ID,
    initialExpires,
  );
  const refreshedAccess = syntheticJwt(
    "concurrent-new",
    ACCOUNT_ID,
    refreshedExpires,
  );
  let releaseRefresh!: () => void;
  const refreshGate = new Promise<void>((resolve) => {
    releaseRefresh = resolve;
  });
  let markRefreshStarted!: () => void;
  const refreshStarted = new Promise<void>((resolve) => {
    markRefreshStarted = resolve;
  });
  const fixture = await createRegistryFixture({
    credential: oauthCredential(initialAccess, initialExpires),
    refreshToken: async () => {
      markRefreshStarted();
      await refreshGate;
      return {
        access: refreshedAccess,
        refresh: "synthetic-refresh-rotated",
        expires: refreshedExpires,
      };
    },
  });

  const first = fixture.registry.getApiKeyForProvider(PROVIDER);
  const second = fixture.registry.getApiKeyForProvider(PROVIDER);
  await refreshStarted;
  await waitFor(
    () => fixture.store.modifyRequests === 2,
    "both refresh candidates to request the credential lock",
  );
  releaseRefresh();

  assert.deepEqual(await Promise.all([first, second]), [
    refreshedAccess,
    refreshedAccess,
  ]);
  assert.equal(fixture.refreshCalls(), 1);
  assert.equal(fixture.store.modifyExecutions, 2);
  assert.equal(fixture.store.maxActiveModifiers, 1);
  assert.equal(fixture.store.writes.length, 1);
  assert.deepEqual(fixture.store.modifyInputs.map(oauthAccess), [
    initialAccess,
    refreshedAccess,
  ]);
});

test("failed Codex refresh is hidden as an undefined registry result", async () => {
  const expires = Date.now() + 60_000;
  const access = syntheticJwt("failed-refresh", ACCOUNT_ID, expires);
  const original = oauthCredential(access, expires);
  const fixture = await createRegistryFixture({
    credential: original,
    refreshToken: async () => {
      throw new Error("synthetic refresh failure");
    },
  });

  assert.equal(
    await fixture.registry.getApiKeyForProvider(PROVIDER),
    undefined,
  );
  assert.equal(fixture.refreshCalls(), 1);
  assert.equal(fixture.store.modifyRequests, 1);
  assert.deepEqual(fixture.store.writes, []);
  assert.deepEqual(fixture.store.peek(), original);
});

test("missing Codex credentials return undefined without refresh", async () => {
  const fixture = await createRegistryFixture();

  assert.equal(
    await fixture.registry.getApiKeyForProvider(PROVIDER),
    undefined,
  );
  assert.equal(fixture.refreshCalls(), 0);
  assert.equal(fixture.store.modifyRequests, 0);
  assert.deepEqual(fixture.store.writes, []);
});

test("runtime API-key override bypasses the persistent credential store", async () => {
  const storedExpires = Date.now() + HOUR_MS;
  const overrideExpires = Date.now() + 2 * HOUR_MS;
  const storedAccess = syntheticJwt("stored", ACCOUNT_ID, storedExpires);
  const overrideAccess = syntheticJwt(
    "runtime-override",
    ACCOUNT_ID,
    overrideExpires,
  );
  const stored = oauthCredential(storedAccess, storedExpires);
  // The built-in is OAuth-only, so expose an API-key method in this overlay for
  // ModelRuntime's generic runtime override to resolve.
  const fixture = await createRegistryFixture({
    credential: stored,
    apiKeyFallback: "synthetic-unused-fallback",
  });
  await fixture.runtime.setRuntimeApiKey(PROVIDER, overrideAccess);
  fixture.store.resetObservations();

  assert.equal(
    await fixture.registry.getApiKeyForProvider(PROVIDER),
    overrideAccess,
  );
  assert.equal(fixture.store.readCalls, 0);
  assert.equal(fixture.store.modifyRequests, 0);
  assert.equal(fixture.refreshCalls(), 0);
  assert.deepEqual(fixture.store.peek(), stored);
});
