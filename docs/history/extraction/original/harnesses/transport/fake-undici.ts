export type FakeResponse = {
  ok: boolean;
  status: number;
  statusText: string;
  text(): Promise<string>;
  headers: { get(name: string): string | null };
};

export const fakeUndici = {
  calls: [] as Array<{ input: string; init: unknown }>,
  response: undefined as FakeResponse | undefined,
};

export async function fetch(input: string, init: unknown): Promise<FakeResponse> {
  fakeUndici.calls.push({ input, init });
  if (!fakeUndici.response) throw new Error("fake undici response was not configured");
  return fakeUndici.response;
}

export class ProxyAgent {
  constructor(_url: string) {}
  async close(): Promise<void> {}
}
