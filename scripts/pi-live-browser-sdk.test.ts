import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  BrowserController,
  BrowserOutcome,
  BrowserRoute,
  BrowserRouter,
} from "../src/browser.ts";
import type { BrowserTool, BrowserToolParams } from "../src/browser-tool.ts";
import type { LiveBrowserMode } from "../src/live.ts";
import {
  createSdkFixture,
  emptyUi,
  waitUntil,
} from "./test-support/live-sdk.ts";
import { fakeProvider } from "./test-support/live-provider.ts";
import { fakeMedia } from "./test-support/live-media.ts";

function recordingBrowser(routes: Array<BrowserRoute | undefined> = []) {
  const commands: Array<{ id: string; command: string }> = [];
  const routed: string[] = [];
  const aborted: string[] = [];
  const pending = new Map<string, (outcome: BrowserOutcome) => void>();
  const controller: BrowserController = {
    page: () => ({ url: "https://www.rolex.com/", title: "Rolex" }),
    run(id, command, signal) {
      commands.push({ id, command });
      return new Promise((resolve) => {
        pending.set(id, resolve);
        signal.addEventListener("abort", () => {
          aborted.push(id);
          resolve(undefined);
        });
      });
    },
  };
  const router: BrowserRouter = {
    route: async (request) => {
      routed.push(request);
      return routes.shift();
    },
  };
  const toolCalls: BrowserToolParams[] = [];
  // Pi's tool sees the tab on screen, which Pi may have changed since the
  // controller last reported.
  const tool: BrowserTool = {
    currentPage: async () => ({
      url: "https://www.google.com/",
      title: "Google",
    }),
    run: async (params) => {
      toolCalls.push(params);
      return { text: 'Current page.\nPage: "Google" https://www.google.com/' };
    },
  };
  const mode: LiveBrowserMode = { controller, router, tool };
  return {
    commands,
    routed,
    aborted,
    toolCalls,
    mode,
    finish(id: string, outcome: BrowserOutcome) {
      pending.get(id)?.(outcome);
    },
  };
}

async function browserCall(
  t: Parameters<typeof createSdkFixture>[0],
  browser: ReturnType<typeof recordingBrowser>,
  provider = fakeProvider(),
  allowedTools?: string[],
) {
  const media = fakeMedia();
  const fixture = await createSdkFixture(t, {
    controls: true,
    resources: media.resources,
    provider: provider.provider,
    browser: () => browser.mode,
    ...(allowedTools ? { allowedTools } : {}),
  });
  await fixture.runtime.session.prompt("/live browser");
  assert.equal(fixture.current().lifecycle.snapshot().state, "active");
  return { provider, media, fixture };
}

test("single browser steps go to the fast controller, not Pi", async (t) => {
  const browser = recordingBrowser(["browser"]);
  const { provider, media, fixture } = await browserCall(t, browser);
  media.request("one", "Go to Wikipedia");
  await waitUntil(() => browser.commands.length === 1, "browser request");
  assert.deepEqual(browser.routed, ["Go to Wikipedia"]);
  assert.deepEqual(browser.commands[0], {
    id: "one",
    command: "Go to Wikipedia",
  });
  browser.finish("one", {
    text: "Done: wikipedia.",
    handOff: false,
  });
  await waitUntil(() => media.finals().length === 1, "spoken outcome");
  assert.equal(media.finals()[0]!.delegation_id, "one");
  assert.ok(JSON.stringify(media.finals()[0]).includes("Done: wikipedia."));
  assert.equal(provider.calls(), 0);
  assert.equal(fixture.abortCalls, 0);
});

test("web tasks go to Pi with its browser tool at low thinking, restored after", async (t) => {
  const browser = recordingBrowser(["browser_task"]);
  const provider = fakeProvider({
    reasoning: true,
    tool: { name: "live_browser", arguments: { action: "look" } },
  });
  const { media, fixture } = await browserCall(t, browser, provider, [
    "live_browser",
  ]);
  const session = fixture.runtime.session;
  // The fixture model supports up to "high".
  session.setThinkingLevel("high");
  media.request("one", "Look into all Rolex models and search for Submariner");
  await waitUntil(() => provider.calls() === 2, "tool call and reply");
  await session.waitForIdle();
  assert.equal(browser.commands.length, 0);
  assert.deepEqual(browser.toolCalls, [{ action: "look" }]);
  const [first, second] = provider.contexts;
  assert.ok(
    first!.includes("Look into all Rolex models and search for Submariner"),
  );
  assert.ok(first!.includes("needs more than one browser step"));
  // The note names the tab on screen, not the controller's last report.
  assert.ok(first!.includes('\\"Google\\" (https://www.google.com/)'));
  assert.ok(first!.includes("Use the live_browser tool"));
  assert.ok(second!.includes("Current page."), "tool result reaches Pi");
  assert.deepEqual(
    provider.requests.map((request) => request.reasoning),
    ["low", "low"],
  );
  await waitUntil(() => session.thinkingLevel === "high", "level restored");
  await waitUntil(
    () => media.frames.some((frame) => frame.includes("Pi final reply")),
    "Pi reply spoken",
  );
});

test("other work goes to Pi unchanged", async (t) => {
  const browser = recordingBrowser(["pi"]);
  const provider = fakeProvider({ reasoning: true });
  const { media, fixture } = await browserCall(t, browser, provider);
  fixture.runtime.session.setThinkingLevel("high");
  media.request("one", "Run the tests");
  await waitUntil(() => provider.calls() === 1, "Pi request");
  await fixture.runtime.session.waitForIdle();
  assert.equal(browser.commands.length, 0);
  assert.ok(!provider.contexts[0]!.includes("[Browser]"));
  assert.equal(provider.requests[0]!.reasoning, "high");
  assert.equal(fixture.runtime.session.thinkingLevel, "high");
});

test("a controller refusal falls back to Pi instead of being spoken", async (t) => {
  // No router answer: the controller is tried first.
  const browser = recordingBrowser([undefined]);
  const { provider, media } = await browserCall(t, browser);
  media.request("one", "Fill in the contact form");
  await waitUntil(() => browser.commands.length === 1, "browser request");
  browser.finish("one", {
    text: "the browser controller did not recognize a browser command (not a browser command)",
    handOff: true,
  });
  await waitUntil(() => provider.calls() === 1, "Pi request");
  const context = provider.contexts.join("\n");
  assert.ok(context.includes("Fill in the contact form"));
  assert.ok(context.includes("tried the fast browser controller first"));
  assert.ok(
    !media.frames.some((frame) => frame.includes("did not recognize")),
    "the refusal is not spoken",
  );
});

test("a newer browser request supersedes one in flight", async (t) => {
  const browser = recordingBrowser(["browser", "browser"]);
  const { media } = await browserCall(t, browser);
  media.request("one", "Open YouTube");
  await waitUntil(() => browser.commands.length === 1, "first request");
  media.request("two", "No, open Wikipedia");
  await waitUntil(() => browser.commands.length === 2, "second request");
  assert.deepEqual(browser.aborted, ["one"]);
  assert.equal(browser.commands[1]!.command, "No, open Wikipedia");
  browser.finish("two", {
    text: "Done: wikipedia.",
    handOff: false,
  });
  await waitUntil(() => media.finals().length === 1, "spoken outcome");
  assert.equal(media.finals()[0]!.delegation_id, "two");
});

test("stopping voice abandons the browser wait without speaking", async (t) => {
  const browser = recordingBrowser(["browser"]);
  const { media, fixture } = await browserCall(t, browser);
  media.request("one", "Scroll down");
  await waitUntil(() => browser.commands.length === 1, "browser request");
  await fixture.runtime.session.prompt("/live stop");
  await waitUntil(() => browser.aborted.length === 1, "browser wait aborted");
  assert.equal(media.finals().length, 0);
});

test("ordinary calls still delegate to Pi, and browser mode needs a usable controller", async (t) => {
  const provider = fakeProvider();
  const media = fakeMedia();
  const browser = recordingBrowser();
  let available = true;
  const notices: string[] = [];
  const fixture = await createSdkFixture(t, {
    controls: true,
    resources: media.resources,
    provider: provider.provider,
    browser: () => (available ? browser.mode : undefined),
    ui: {
      ...emptyUi(),
      notify: (message: string) => {
        notices.push(message);
      },
    },
  });
  await fixture.runtime.session.prompt("/live start");
  await fixture.runtime.session.prompt("/live browser");
  assert.ok(
    notices.includes("Pi Live: stop voice before starting browser mode."),
  );
  media.request("one", "Inspect");
  await waitUntil(
    () => media.frames.some((frame) => frame.includes("Pi final reply")),
    "Pi reply",
  );
  assert.equal(browser.routed.length, 0);
  assert.equal(browser.commands.length, 0);
  assert.ok(
    !provider.contexts.join("\n").includes("live_browser"),
    "the browser tool stays inactive outside browser mode",
  );
  await fixture.runtime.session.prompt("/live stop");

  available = false;
  await fixture.runtime.session.prompt("/live browser");
  assert.ok(
    notices.includes(
      "Pi Live: browser mode needs PI_LIVE_BROWSER_URL to be a ws:// loopback address.",
    ),
  );
  assert.equal(fixture.current().lifecycle.snapshot().state, "off");
});
