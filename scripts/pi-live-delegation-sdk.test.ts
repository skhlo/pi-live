import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createSdkFixture,
  startActive,
  waitUntil,
  prepareMovement,
} from "./test-support/live-sdk.ts";
import { fakeProvider } from "./test-support/live-provider.ts";
import type { LiveOutgoingData } from "../src/live.ts";
import { deferred } from "./test-support/live-fixture.ts";
import type {
  InlineExtension,
  ExtensionAPI,
} from "@earendil-works/pi-coding-agent";

test("a voice request executes through Pi and shares only its owned successful final", async (t) => {
  const outgoing: LiveOutgoingData[] = [];
  let toolExecutions = 0;
  const { provider, calls } = fakeProvider({ tool: true });
  const fixture = await createSdkFixture(t, {
    provider,
    sendData: (data) => outgoing.push(data),
    tools: [
      {
        name: "fixture_tool",
        label: "Fixture",
        description: "Offline tool",
        parameters: { type: "object", properties: {} },
        async execute() {
          toolExecutions++;
          return {
            content: [{ type: "text", text: "private raw tool output" }],
            details: {},
          };
        },
      },
    ],
  });
  await startActive(fixture.current());
  assert.equal(
    fixture
      .current()
      .delegation.request({ id: "one", text: "Inspect the fixture" }),
    true,
  );
  await waitUntil(() => outgoing.length > 0, "owned final delivery");
  assert.deepEqual(outgoing, [{ kind: "final", text: "Owned final result" }]);
  assert.equal(calls(), 2);
  assert.equal(toolExecutions, 1);
  const receipts = fixture.runtime.session.sessionManager
    .getBranch()
    .filter((e) => e.type === "custom_message");
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0]?.customType, "better-openai-live-delegation");
  assert.equal(receipts[0]?.display, true);
  assert.equal(
    receipts[0]?.content,
    "[Voice coding request]\nInspect the fixture",
  );
});

for (const movement of ["tree", "new", "resume", "fork", "reload"] as const) {
  test(`${movement} rejects settlement from a retired voice call`, async (t) => {
    const held = deferred<void>();
    t.after(() => held.resolve());
    const fake = fakeProvider({ hold: held.promise });
    const outgoing: LiveOutgoingData[] = [];
    let treeMove: (() => Promise<unknown>) | undefined;
    const fixture = await createSdkFixture(t, {
      provider: fake.provider,
      sendData: (data) => outgoing.push(data),
      before:
        movement === "tree"
          ? [
              {
                name: "tree-before-settlement",
                factory(pi) {
                  pi.on("agent_settled", async () => {
                    await treeMove?.();
                  });
                },
              },
            ]
          : [],
    });
    const prepared =
      movement === "reload"
        ? undefined
        : await prepareMovement(fixture, movement);
    if (movement === "tree") treeMove = () => prepared!.invoke();
    await startActive(fixture.current());
    const old = fixture.current();
    assert.equal(old.delegation.request({ id: "one", text: "Inspect" }), true);
    await waitUntil(() => fake.calls() === 1, "held request");
    const navigation =
      movement === "tree"
        ? undefined
        : prepared
          ? prepared.invoke()
          : fixture.runtime.session.reload();
    if (movement === "tree") held.resolve();
    await waitUntil(
      () => old.lifecycle.snapshot().state !== "active",
      "navigation fence",
    );
    held.resolve();
    await navigation;
    await (prepared?.oldSession ?? fixture.runtime.session).waitForIdle();
    assert.deepEqual(outgoing, []);
    assert.equal(fixture.abortCalls, 0);
  });
}

for (const elapsed of [4_999, 5_000]) {
  test(`the receipt deadline rejects at five seconds: ${elapsed}ms`, async (t) => {
    const receiptGate = deferred<void>();
    const entered = deferred<void>();
    t.after(() => receiptGate.resolve());
    const outgoing: LiveOutgoingData[] = [];
    const fixture = await createSdkFixture(t, {
      provider: fakeProvider().provider,
      sendData: (data) => outgoing.push(data),
      before: [
        {
          name: "delayed-observation",
          factory(pi) {
            pi.on("message_start", async (event) => {
              if (event.message.role === "custom") {
                entered.resolve();
                await receiptGate.promise;
              }
            });
          },
        },
      ],
    });
    await startActive(fixture.current());
    assert.equal(
      fixture.current().delegation.request({ id: "one", text: "Inspect" }),
      true,
    );
    await entered.promise;
    fixture.clock.advance(elapsed);
    receiptGate.resolve();
    await fixture.runtime.session.waitForIdle();
    assert.equal(outgoing.length, elapsed < 5_000 ? 1 : 0);
  });
}

test("delegated-work expiry stops only voice after thirty minutes", async (t) => {
  const held = deferred<void>();
  t.after(() => held.resolve());
  const fake = fakeProvider({ hold: held.promise });
  const outgoing: LiveOutgoingData[] = [];
  const fixture = await createSdkFixture(t, {
    provider: fake.provider,
    sendData: (data) => outgoing.push(data),
  });
  await startActive(fixture.current());
  fixture.current().delegation.request({ id: "one", text: "Inspect" });
  await waitUntil(() => fake.calls() === 1, "provider hold");
  fixture.clock.advance(30 * 60_000);
  assert.notEqual(fixture.current().lifecycle.snapshot().state, "active");
  held.resolve();
  await fixture.runtime.session.waitForIdle();
  assert.deepEqual(outgoing, []);
  assert.equal(fixture.abortCalls, 0);
});

test("a successful automatic retry cannot rescue a failed delegation", async (t) => {
  const outgoing: LiveOutgoingData[] = [];
  const fake = fakeProvider({ retry: true });
  const fixture = await createSdkFixture(t, {
    provider: fake.provider,
    retry: true,
    sendData: (data) => outgoing.push(data),
  });
  await startActive(fixture.current());
  fixture.current().delegation.request({ id: "one", text: "Inspect" });
  await fixture.runtime.session.waitForIdle();
  assert.equal(fake.calls(), 2);
  assert.deepEqual(outgoing, []);
  assert.notEqual(fixture.current().lifecycle.snapshot().state, "active");
});

test("a real competing dispatch winning after admission cannot lend its result to voice", async (t) => {
  const held = deferred<void>();
  t.after(() => held.resolve());
  const fake = fakeProvider({ hold: held.promise });
  const outgoing: LiveOutgoingData[] = [];
  let compete = () => {};
  const fixture = await createSdkFixture(t, {
    provider: fake.provider,
    sendData: (data) => outgoing.push(data),
    beforeDispatch: () => compete(),
  });
  let competing: Promise<void> | undefined;
  compete = () => {
    competing = fixture.runtime.session.sendCustomMessage(
      {
        customType: "competing",
        display: true,
        content: "Another real SDK dispatch",
      },
      { triggerTurn: true },
    );
  };
  await startActive(fixture.current());
  fixture.current().delegation.request({ id: "one", text: "Inspect" });
  await waitUntil(() => fake.calls() >= 1, "competing provider request");
  held.resolve();
  await competing;
  await fixture.runtime.session.waitForIdle();
  assert.deepEqual(outgoing, []);
  assert.notEqual(fixture.current().lifecycle.snapshot().state, "active");
  assert.equal(fixture.abortCalls, 0);
});

for (const interference of [
  "competing input",
  "non-trigger append",
  "continuation",
  "context edit",
  "context handler",
  "compaction",
  "error",
  "abort",
  "stop",
] as const) {
  test(`${interference} leaves the coding result in Pi without voice delivery`, async (t) => {
    const held = deferred<void>();
    t.after(() => held.resolve());
    const outgoing: LiveOutgoingData[] = [];
    const fake = fakeProvider({
      hold: held.promise,
      error: interference === "error",
    });
    let otherApi: ExtensionAPI | undefined;
    let used = false;
    const other: InlineExtension = {
      name: "independent-extension",
      factory(pi) {
        otherApi = pi;
        pi.on("context", (event) => {
          if (interference === "context handler")
            return {
              messages: [
                ...event.messages,
                {
                  role: "user",
                  content: "Unpersisted foreign input",
                  timestamp: 0,
                },
              ],
            };
        });
        pi.on("agent_before_settle", (_event, ctx) => {
          if (used) return;
          used = true;
          if (interference === "continuation")
            return {
              continue: true,
              entries: [
                {
                  type: "custom_message",
                  customType: "foreign",
                  display: true,
                  content: "Another request",
                },
              ],
            };
          const receipt = ctx.sessionManager
            .getBranch()
            .find((e) => e.type === "custom_message");
          if (interference === "context edit" && receipt)
            return {
              entries: [
                {
                  type: "context_edit",
                  targetId: receipt.id,
                  replacement: { content: "Changed request" },
                },
              ],
            };
          if (interference === "compaction")
            return {
              entries: [
                {
                  type: "compaction",
                  summary: "Rewritten history",
                  firstKeptEntryId: null,
                },
              ],
            };
        });
      },
    };
    const fixture = await createSdkFixture(t, {
      provider: fake.provider,
      sendData: (data) => outgoing.push(data),
      after: [other],
    });
    await startActive(fixture.current());
    assert.equal(
      fixture
        .current()
        .delegation.request({ id: "one", text: "First request" }),
      true,
    );
    await waitUntil(() => fake.calls() === 1, "provider hold");
    if (interference === "competing input")
      await fixture.runtime.session.prompt("Typed competing request", {
        streamingBehavior: "steer",
      });
    if (interference === "non-trigger append")
      otherApi!.sendMessage(
        { customType: "foreign", display: true, content: "Unreported append" },
        { triggerTurn: false },
      );
    if (interference === "stop") await fixture.current().lifecycle.stop();
    const abort =
      interference === "abort" ? fixture.runtime.session.abort() : undefined;
    held.resolve();
    await abort;
    await fixture.runtime.session.waitForIdle();
    assert.deepEqual(outgoing, []);
    assert.notEqual(fixture.current().lifecycle.snapshot().state, "active");
    assert.equal(fixture.abortCalls, 0);
  });
}

test("a second delegation while coding stops voice and preserves the accepted Pi work", async (t) => {
  const held = deferred<void>();
  t.after(() => held.resolve());
  const fake = fakeProvider({ hold: held.promise });
  const outgoing: LiveOutgoingData[] = [];
  const fixture = await createSdkFixture(t, {
    provider: fake.provider,
    sendData: (data) => outgoing.push(data),
  });
  await startActive(fixture.current());
  assert.equal(
    fixture.current().delegation.request({ id: "one", text: "First" }),
    true,
  );
  await waitUntil(() => fake.calls() === 1, "first request");
  assert.equal(
    fixture.current().delegation.request({ id: "two", text: "Second" }),
    false,
  );
  held.resolve();
  await fixture.runtime.session.waitForIdle();
  assert.equal(fake.calls(), 1);
  assert.equal(fixture.abortCalls, 0);
  assert.deepEqual(outgoing, []);
  assert.ok(
    fixture.runtime.session.sessionManager
      .getBranch()
      .some(
        (e) =>
          e.type === "message" &&
          e.message.role === "assistant" &&
          e.message.stopReason === "stop",
      ),
  );
});
