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
import { parseJsonObject } from "./test-json.ts";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { PINNED_BETTER_OPENAI_PACKAGE_SOURCES } from "../src/live.ts";
import type { InlineExtension } from "@earendil-works/pi-coding-agent";

function finalText(frames: string[]): string {
  return frames
    .flatMap((encoded) => {
      const frame = parseJsonObject(encoded, "outbound frame");
      if (frame.type !== "session.commentary.append") return [];
      assert.equal(frame.delegation_id, "one");
      assert.equal(typeof frame.event_id, "string");
      const content = frame.content;
      assert.ok(typeof content === "string");
      assert.ok(Buffer.byteLength(content) <= 500);
      return [content];
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

test("live controls obtain consent and return Pi replies through the real parser and writer", async (t) => {
  const media = fakeMedia();
  const provider = fakeProvider({ tool: true });
  let toolExecutions = 0;
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
          "OpenAI GPT-Live",
          "API key",
          "progress note",
          "final replies",
          "proxy",
          "shortcut-opened",
          "nested",
          "microtask",
        ])
          assert.ok(text.includes(phrase), phrase);
        assert.equal(media.counts().resourcesCreated, 0);
        return true;
      }),
      setWidget: ((_key: string, widget: unknown) =>
        widgets.push(widget)) as ExtensionUIContext["setWidget"],
    },
  });
  await fixture.runtime.session.prompt("/live start");
  assert.equal(fixture.current().lifecycle.snapshot().state, "active");
  media.sample();
  assert.equal(media.counts().captured, 1);
  media.request("one", "Inspect the fixture");
  await waitUntil(() => media.finals().length > 0, "final frame");
  await fixture.runtime.session.waitForIdle();
  assert.equal(provider.calls(), 2);
  assert.equal(toolExecutions, 1);
  assert.equal(fixture.current().lifecycle.snapshot().state, "active");
  await fixture.runtime.session.prompt("/live stop");
  assert.equal(widgets.at(-1), undefined);
  assert.equal(fixture.clock.timers.size, 0);
  const sent = media.frames.join("\n");
  assert.ok(!sent.includes("private raw tool output"));
  assert.ok(!sent.includes("private thinking"));
  assert.equal(finalText(media.frames), "Pi final reply");
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
    () => media.frames.some((frame) => frame.includes("in the terminal")),
    "truncation marker drain",
  );
  const final = finalText(media.frames);
  assert.ok(final.startsWith('界"\\'));
  assert.ok(Buffer.byteLength(final) <= 1_500);
  assert.match(final, /The rest of Pi's reply is in the terminal\.\]$/);
});

test("/live end and /live off stop the call like /live stop", async (t) => {
  const media = fakeMedia();
  const widgets: unknown[] = [];
  const fixture = await createSdkFixture(t, {
    controls: true,
    resources: media.resources,
    ui: {
      ...emptyUi(async () => true),
      setWidget: ((_key: string, widget: unknown) =>
        widgets.push(widget)) as ExtensionUIContext["setWidget"],
    },
  });
  for (const command of ["end", "off"]) {
    await fixture.runtime.session.prompt("/live start");
    assert.equal(fixture.current().lifecycle.snapshot().state, "active");
    await fixture.runtime.session.prompt(`/live ${command}`);
    assert.equal(fixture.current().lifecycle.snapshot().state, "off", command);
    assert.equal(widgets.at(-1), undefined);
  }
  assert.equal(media.counts().resourcesCreated, 2);
  assert.equal(fixture.clock.timers.size, 0);
});

test("a call refused before setup tells the user to run /live setup", async (t) => {
  const media = fakeMedia();
  const notifications: string[] = [];
  const fixture = await createSdkFixture(t, {
    controls: true,
    resources: media.resources,
    uncertified: true,
    ui: {
      ...emptyUi(async () => true),
      notify: ((message: string) =>
        notifications.push(message)) as ExtensionUIContext["notify"],
    },
  });
  await fixture.runtime.session.prompt("/live start");
  assert.equal(fixture.current().lifecycle.snapshot().state, "off");
  assert.equal(media.counts().resourcesCreated, 0);
  assert.equal(
    notifications.at(-1),
    "Pi Live: off; setup-required. Run /live setup first.",
  );
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
  await fixture.runtime.session.prompt("/live voice cedar");
  assert.equal(fixture.current().lifecycle.snapshot().voice, "marin");
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
