import assert from "node:assert/strict";
import { test } from "node:test";
import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import { createSdkFixture, waitUntil } from "./test-support/live-sdk.ts";
import { fakeProvider } from "./test-support/live-provider.ts";
import { fakeMedia } from "./test-support/live-media.ts";
import { deferred } from "./test-support/live-fixture.ts";

// Voice is ordinary Pi input. These tests exercise the complete bridge, not a
// parallel task scheduler or a proof of exclusive ownership of model context.
test("voice joins a busy Pi conversation alongside typed input", async (t) => {
  const held = deferred<void>();
  t.after(() => held.resolve());
  const provider = fakeProvider({ hold: held.promise });
  const media = fakeMedia();
  const fixture = await createSdkFixture(t, {
    controls: true,
    resources: media.resources,
    provider: provider.provider,
  });
  const typed = fixture.runtime.session.prompt("First typed request");
  await waitUntil(() => provider.calls() === 1, "Pi working");
  await fixture.runtime.session.prompt("/live start");
  assert.equal(fixture.current().lifecycle.snapshot().state, "active");
  media.request("one", "First voice request");
  media.request("two", "Voice follow-up");
  await fixture.runtime.session.prompt("Typed clarification", {
    streamingBehavior: "steer",
  });
  held.resolve();
  await typed;
  await fixture.runtime.session.waitForIdle();
  await waitUntil(
    () => media.frames.some((frame) => frame.includes("Agent Final Message")),
    "spoken reply",
  );
  for (const text of [
    "First voice request",
    "Voice follow-up",
    "Typed clarification",
  ])
    assert.ok(
      provider.contexts.some((context) => context.includes(text)),
      text,
    );
  assert.ok(
    media.frames.some((frame) => frame.includes('"delegation_item_id":"two"')),
  );
  assert.equal(fixture.current().lifecycle.snapshot().state, "active");
  assert.equal(fixture.abortCalls, 0);
});

for (const order of ["before", "after"] as const) {
  test(`Pi extensions can enrich context in ${order} load order`, async (t) => {
    const provider = fakeProvider();
    const media = fakeMedia();
    const extension: InlineExtension = {
      name: "normal-context-extension",
      factory(pi) {
        pi.on("context_with_system", (event) => ({
          messages: [
            ...event.messages,
            {
              role: "user",
              content: "Context supplied by an installed extension",
              timestamp: 0,
            },
          ],
        }));
      },
    };
    const fixture = await createSdkFixture(t, {
      controls: true,
      resources: media.resources,
      provider: provider.provider,
      [order]: [extension],
    });
    await fixture.runtime.session.prompt("/live start");
    media.request("one", "Inspect");
    await fixture.runtime.session.waitForIdle();
    await waitUntil(
      () => media.frames.some((frame) => frame.includes("Pi final reply")),
      "Pi reply",
    );
    assert.ok(
      provider.contexts.some((context) =>
        context.includes("Context supplied by an installed extension"),
      ),
    );
    assert.equal(fixture.current().lifecycle.snapshot().state, "active");
  });
}

test("Pi owns retries and voice receives its eventual answer", async (t) => {
  const provider = fakeProvider({ retry: true });
  const media = fakeMedia();
  const fixture = await createSdkFixture(t, {
    controls: true,
    resources: media.resources,
    provider: provider.provider,
    retry: true,
  });
  await fixture.runtime.session.prompt("/live start");
  media.request("one", "Inspect");
  await fixture.runtime.session.waitForIdle();
  await waitUntil(
    () => media.frames.some((frame) => frame.includes("Pi final reply")),
    "retried reply",
  );
  assert.equal(provider.calls(), 2);
  assert.equal(fixture.current().lifecycle.snapshot().state, "active");
  assert.ok(!media.frames.join("").includes("503"));
});

for (const outcome of ["error", "abort"] as const) {
  test(`Pi ${outcome} leaves voice available and uses a plain completion notice`, async (t) => {
    const held = deferred<void>();
    t.after(() => held.resolve());
    const provider = fakeProvider({
      error: outcome === "error",
      hold: held.promise,
    });
    const media = fakeMedia();
    const fixture = await createSdkFixture(t, {
      controls: true,
      resources: media.resources,
      provider: provider.provider,
    });
    await fixture.runtime.session.prompt("/live start");
    media.request("one", "Inspect");
    await waitUntil(() => provider.calls() === 1, "provider request");
    const abort =
      outcome === "abort" ? fixture.runtime.session.abort() : undefined;
    held.resolve();
    await abort;
    await fixture.runtime.session.waitForIdle();
    await waitUntil(
      () =>
        media.frames.some((frame) =>
          frame.includes("Pi finished without a reply"),
        ),
      "completion notice",
    );
    assert.equal(fixture.current().lifecycle.snapshot().state, "active");
    assert.ok(!media.frames.join("").includes("synthetic private failure"));
  });
}

test("Pi work without a voice request does not create a transport error", async (t) => {
  const media = fakeMedia();
  const fixture = await createSdkFixture(t, {
    controls: true,
    resources: media.resources,
    provider: fakeProvider().provider,
  });
  await fixture.runtime.session.prompt("/live start");
  await fixture.runtime.session.prompt("A typed request");
  assert.equal(fixture.current().lifecycle.snapshot().state, "active");
  assert.deepEqual(media.frames, []);
});
