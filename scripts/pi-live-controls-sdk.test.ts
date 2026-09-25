import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createSdkFixture,
  emptyUi,
  waitUntil,
} from "./test-support/live-sdk.ts";
import { fakeProvider } from "./test-support/live-provider.ts";
import { fakeMedia } from "./test-support/live-media.ts";
import { deferred } from "./test-support/live-fixture.ts";
import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { parseJsonObject, jsonObject } from "./test-json.ts";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { PINNED_BETTER_OPENAI_PACKAGE_SOURCES } from "../src/live.ts";
import type { InlineExtension } from "@earendil-works/pi-coding-agent";

function finalText(frames: string[]): string {
  return frames
    .flatMap((encoded) => {
      const frame = parseJsonObject(encoded, "outbound frame");
      if (frame.type === "session.close") return [];
      assert.equal(frame.type, "delegation.context.append");
      assert.equal(frame.channel, undefined);
      assert.equal(frame.delegation_item_id, "one");
      assert.ok(Array.isArray(frame.content));
      return frame.content.map((value: unknown) => {
        const block = jsonObject(value, "final content");
        assert.equal(block.type, "input_text");
        assert.equal(typeof block.text, "string");
        return block.text;
      });
    })
    .join("");
}

for (const scope of ["global", "project"] as const)
  for (const order of ["before", "after"] as const) {
    test(`shipped settings-source observation refuses ${scope} conflict with ${order}-loaded unrelated command`, async (t) => {
      const media = fakeMedia();
      let consents = 0;
      const other: InlineExtension = {
        name: "different-command",
        factory(pi) {
          pi.registerCommand("unrelated", {
            description: "No matching live command",
            handler: async () => {},
          });
        },
      };
      const fixture = await createSdkFixture(t, {
        controls: true,
        configuredSourcesFromSettings: true,
        resources: media.resources,
        [order]: [other],
        ui: emptyUi(async () => {
          consents++;
          return true;
        }),
      });
      const directory =
        scope === "global" ? fixture.agentDir : path.join(fixture.cwd, ".pi");
      await mkdir(directory, { recursive: true });
      const file = path.join(directory, "settings.json");
      const content = JSON.stringify({
        packages: [
          scope === "global"
            ? PINNED_BETTER_OPENAI_PACKAGE_SOURCES[0]
            : {
                source: PINNED_BETTER_OPENAI_PACKAGE_SOURCES[1],
                extensions: [],
              },
        ],
        retained: { value: 1 },
      });
      await writeFile(file, content);
      await fixture.runtime.session.prompt("/live start");
      assert.equal(consents, 0);
      assert.equal(fixture.current().lifecycle.snapshot().lastFailure, "busy");
      assert.equal(media.counts().resourcesCreated, 0);
      assert.equal(await readFile(file, "utf8"), content);
      assert.deepEqual(await readdir(directory), ["settings.json"]);
    });
  }

test("live controls require disclosed consent and connect the real parser to owned final delivery with replay protection", async (t) => {
  const media = fakeMedia();
  const provider = fakeProvider({ tool: true });
  let toolExecutions = 0;
  const notifications: string[] = [];
  const widgets: unknown[] = [];
  const fixture = await createSdkFixture(t, {
    controls: true,
    resources: media.resources,
    provider: provider.provider,
    tools: [
      {
        name: "fixture_tool",
        label: "Fixture",
        description: "Offline",
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
    ui: {
      ...emptyUi(async (title, text) => {
        assert.match(title, /Start Pi Live/);
        for (const phrase of [
          "fixture-host",
          "microphone",
          "speakers",
          "experimental OpenAI",
          "Pi session identifier",
          "final coding result",
          "attestation",
          "proxy",
          "shortcut-opened",
          "nested",
          "microtask",
        ])
          assert.ok(text.includes(phrase), phrase);
        assert.equal(media.counts().resourcesCreated, 0);
        return true;
      }),
      notify: (text) => notifications.push(text),
      setWidget: ((_key: string, widget: unknown) =>
        widgets.push(widget)) as ExtensionUIContext["setWidget"],
    },
  });
  await fixture.runtime.session.prompt("/live start");
  assert.equal(fixture.current().lifecycle.snapshot().state, "active");
  media.sample();
  assert.equal(media.counts().captured, 1);
  media.request("one", "Inspect the fixture");
  await waitUntil(
    () => media.frames.some((f) => f.includes("Agent Final Message")),
    "final frame",
  );
  await fixture.runtime.session.waitForIdle();
  media.request("one", "Inspect the fixture");
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(provider.calls(), 2);
  assert.equal(toolExecutions, 1);
  assert.equal(fixture.current().lifecycle.snapshot().state, "active");
  media.request("one", "Changed request");
  await waitUntil(
    () => fixture.current().lifecycle.snapshot().state === "off",
    "changed-ID stop",
  );
  assert.equal(widgets.at(-1), undefined);
  assert.equal(fixture.clock.timers.size, 0);
  assert.ok(notifications.some((n) => n.includes("protocol")));
  assert.ok(!media.frames.join("\n").includes("private"));
  assert.equal(
    finalText(media.frames),
    '"Agent Final Message":\n\nOwned final result',
  );
});

test("the integrated final frames bound multibyte text and include a visible truncation marker", async (t) => {
  const media = fakeMedia();
  const provider = fakeProvider({ final: '界"\\'.repeat(20_000) });
  const fixture = await createSdkFixture(t, {
    controls: true,
    resources: media.resources,
    provider: provider.provider,
  });
  await fixture.runtime.session.prompt("/live start");
  media.request("one", "Inspect");
  await fixture.runtime.session.waitForIdle();
  await waitUntil(
    () => media.frames.some((frame) => frame.includes("truncated")),
    "truncation marker drain",
  );
  const final = finalText(media.frames);
  assert.ok(final.startsWith('"Agent Final Message":\n\n'));
  assert.ok(
    Buffer.byteLength(final.slice('"Agent Final Message":\n\n'.length)) <=
      64 * 1_024,
  );
  assert.match(final, /truncated/);
});

test("cancelled consent and late Yes perform no call setup", async (t) => {
  for (const late of [false, true])
    await t.test(String(late), async (t) => {
      const consent = deferred<boolean>();
      const opened = deferred<void>();
      const media = fakeMedia();
      const fixture = await createSdkFixture(t, {
        controls: true,
        resources: media.resources,
        ui: emptyUi(async () => {
          opened.resolve();
          return late ? consent.promise : false;
        }),
      });
      const start = fixture.runtime.session.prompt("/live start");
      await opened.promise;
      if (late) {
        await fixture.runtime.session.prompt("/live stop");
        consent.resolve(true);
      }
      await start;
      assert.equal(fixture.current().lifecycle.snapshot().state, "off");
      assert.equal(media.counts().resourcesCreated, 0);
      assert.equal(fixture.acquisitionCalls, 0);
      assert.equal(fixture.clock.timers.size, 0);
    });
});

test("mute stops capture, voice changes require off, and stop never aborts admitted coding", async (t) => {
  const held = deferred<void>();
  t.after(() => held.resolve());
  const media = fakeMedia();
  const provider = fakeProvider({ hold: held.promise });
  const fixture = await createSdkFixture(t, {
    controls: true,
    resources: media.resources,
    provider: provider.provider,
  });
  await fixture.runtime.session.prompt("/live start");
  await fixture.runtime.session.prompt("/live mute");
  media.sample();
  assert.equal(media.counts().captured, 0);
  await fixture.runtime.session.prompt("/live voice vale");
  assert.equal(fixture.current().lifecycle.snapshot().voice, "sol");
  await fixture.runtime.session.prompt("/live unmute");
  media.sample();
  assert.equal(media.counts().captured, 1);
  media.request("one", "Inspect the fixture");
  await waitUntil(() => provider.calls() === 1, "coding start");
  await fixture.runtime.session.prompt("/live stop");
  const stoppedFrames = media.frames.length;
  held.resolve();
  await fixture.runtime.session.waitForIdle();
  assert.equal(media.frames.length, stoppedFrames);
  assert.equal(fixture.abortCalls, 0);
  assert.equal(fixture.clock.timers.size, 0);
});
