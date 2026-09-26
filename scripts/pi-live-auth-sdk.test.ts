import assert from "node:assert/strict";
import test from "node:test";

import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";

import { resolveLiveRegistryCredentials } from "../src/live.ts";

type ModelRuntimeOptions = NonNullable<
  Parameters<typeof ModelRuntime.create>[0]
>;
type CredentialStore = NonNullable<ModelRuntimeOptions["credentials"]>;
type Credential = NonNullable<Awaited<ReturnType<CredentialStore["read"]>>>;

class InMemoryCredentialStore implements CredentialStore {
  private readonly credentials = new Map<string, Credential>();

  constructor(initial: Record<string, Credential> = {}) {
    for (const [provider, credential] of Object.entries(initial))
      this.credentials.set(provider, structuredClone(credential));
  }

  async read(providerId: string): Promise<Credential | undefined> {
    const credential = this.credentials.get(providerId);
    return credential ? structuredClone(credential) : undefined;
  }

  async list(): Promise<Awaited<ReturnType<CredentialStore["list"]>>> {
    return [...this.credentials].map(([providerId, credential]) => ({
      providerId,
      type: credential.type,
    }));
  }

  async modify(
    providerId: string,
    mutation: Parameters<CredentialStore["modify"]>[1],
  ): Promise<Credential | undefined> {
    const next = await mutation(this.credentials.get(providerId));
    if (next !== undefined) this.credentials.set(providerId, next);
    return this.credentials.get(providerId);
  }

  async delete(providerId: string): Promise<void> {
    this.credentials.delete(providerId);
  }
}

async function registryWith(initial: Record<string, Credential> = {}) {
  const runtime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(initial),
    modelsPath: null,
    refreshOnCreate: false,
    allowModelNetwork: false,
  });
  return new ModelRegistry(runtime);
}

function withoutEnvironmentKey(t: test.TestContext): void {
  const previous = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  t.after(() => {
    if (previous === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previous;
  });
}

const codexLogin: Credential = {
  type: "oauth",
  access: "codex-access-must-not-be-used",
  refresh: "unused",
  expires: Date.now() + 60 * 60_000,
};

test("Pi's stored openai API key is the live credential", async (t) => {
  withoutEnvironmentKey(t);
  const registry = await registryWith({
    openai: { type: "api_key", key: "sk-stored-fixture" },
    "openai-codex": codexLogin,
  });
  assert.deepEqual(await resolveLiveRegistryCredentials(registry), {
    apiKey: "sk-stored-fixture",
  });
});

test("Pi's OPENAI_API_KEY environment fallback is the live credential", async (t) => {
  withoutEnvironmentKey(t);
  process.env.OPENAI_API_KEY = "sk-environment-fixture";
  const registry = await registryWith();
  assert.deepEqual(await resolveLiveRegistryCredentials(registry), {
    apiKey: "sk-environment-fixture",
  });
});

test("a ChatGPT login alone does not provide a live credential", async (t) => {
  withoutEnvironmentKey(t);
  const registry = await registryWith({ "openai-codex": codexLogin });
  assert.equal(await resolveLiveRegistryCredentials(registry), undefined);
});
