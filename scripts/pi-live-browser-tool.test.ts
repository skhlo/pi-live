import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createBrowserTool } from "../src/browser-tool.ts";

// Drives a real headless Chrome against a local page. Set PI_LIVE_TEST_CHROME
// to a Chrome binary to run it; CI has no browser, so it skips there.
const chrome = process.env.PI_LIVE_TEST_CHROME;

const PAGES: Record<string, string> = {
  "/": `<!doctype html><title>Watch Shop</title><h1>Watches</h1>
<form action="/results"><label>Search <input name="q" placeholder="Search watches"></label><button>Go</button></form>
<a href="/submariner">Submariner</a> <a href="/daytona" target="_blank">Daytona</a>
<button>Related</button><button>Related</button><a href="/submariner"><img alt=""></a>
<input placeholder="Notes">
<form action="/results"><input placeholder="Guarded search" onkeydown="if (event.key === 'Enter') event.preventDefault()"></form>
<div style="height:3000px"></div><a href="/footer">Footer link</a>`,
  "/results": `<!doctype html><title>Results</title><h1>Results</h1><p id=q></p><script>q.textContent=new URLSearchParams(location.search).get('q')</script>`,
  "/submariner": `<!doctype html><title>Submariner</title><h1>Submariner</h1><p>Oyster steel diver watch.</p>`,
  "/daytona": `<!doctype html><title>Daytona</title><h1>Daytona</h1>`,
};

test(
  "the browser tool acts and reports on a real Chrome",
  { skip: chrome ? false : "set PI_LIVE_TEST_CHROME to a Chrome binary" },
  async (t) => {
    const site = createServer((request, response) => {
      const page = PAGES[new URL(request.url ?? "/", "http://x").pathname];
      response.writeHead(page ? 200 : 404, { "content-type": "text/html" });
      response.end(page ?? "missing");
    });
    await new Promise<void>((resolve) => site.listen(0, "127.0.0.1", resolve));
    const address = site.address();
    assert.ok(address && typeof address === "object");
    const origin = `http://127.0.0.1:${address.port}`;
    const profile = await mkdtemp(path.join(tmpdir(), "pi-live-chrome-"));
    const port = 9_000 + Math.floor(Math.random() * 900);
    const browser = spawn(
      chrome!,
      [
        "--headless=new",
        "--remote-debugging-address=127.0.0.1",
        `--remote-debugging-port=${port}`,
        `--user-data-dir=${profile}`,
        "--no-first-run",
        "--no-default-browser-check",
        "about:blank",
      ],
      { stdio: "ignore" },
    );
    t.after(async () => {
      browser.kill();
      site.close();
      await new Promise((resolve) => setTimeout(resolve, 300));
      await rm(profile, { recursive: true, force: true });
    });
    const devTools = `http://127.0.0.1:${port}`;
    for (let attempt = 0; attempt < 50; attempt++) {
      try {
        if ((await fetch(`${devTools}/json/version`)).ok) break;
      } catch {
        // Chrome is still starting.
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }

    const tool = createBrowserTool(devTools);
    const opened = await tool.run({ action: "open", url: `${origin}/` });
    assert.match(opened.text, /Page: "Watch Shop"/);
    assert.match(opened.text, /\[\d+\] link "Submariner"/);

    const searched = await tool.run({
      action: "type",
      target: "Search watches",
      text: "Submariner",
      submit: true,
    });
    assert.match(searched.text, /Page: "Results" .*\/results\?q=Submariner/);

    // Repeated and unnamed controls are left out of the view.
    const home = await tool.run({ action: "back" });
    assert.equal(home.text.match(/button "Related"/g)?.length, 1);
    assert.doesNotMatch(home.text, /link ""/);

    // A submit is claimed only when the page moved; a blocked Enter falls
    // back to the field's own form.
    const notes = await tool.run({
      action: "type",
      target: "Notes",
      text: "hello",
      submit: true,
    });
    assert.match(
      notes.text,
      /Typed into "Notes" and pressed Enter, but the page address did not change\./,
    );
    const guarded = await tool.run({
      action: "type",
      target: "Guarded search",
      text: "Daytona",
      submit: true,
    });
    assert.match(guarded.text, /and submitted\.\nPage: "Results"/);

    await tool.run({ action: "back" });
    const clicked = await tool.run({ action: "click", target: "Submariner" });
    assert.match(clicked.text, /Clicked "Submariner"/);
    assert.equal(clicked.page?.title, "Submariner");
    assert.match(
      (await tool.run({ action: "read" })).text,
      /Oyster steel diver watch/,
    );

    // A link that would open a new tab stays in this one.
    await tool.run({ action: "back" });
    await tool.run({ action: "click", target: "Daytona" });
    assert.equal(
      (await tool.run({ action: "tabs" })).text.split("\n").length,
      2,
    );
    assert.deepEqual(await tool.currentPage(), {
      url: `${origin}/daytona`,
      title: "Daytona",
    });

    const missing = await tool.run({ action: "click", ref: 999 });
    assert.match(missing.text, /No element matches ref 999/);

    const tabbed = await tool.run({
      action: "new_tab",
      url: `${origin}/submariner`,
    });
    assert.match(tabbed.text, /Opened a new tab\.\nPage: "Submariner"/);
    const switched = await tool.run({ action: "switch_tab", tab: 1 });
    assert.match(switched.text, /Switched to tab 1\.\nPage: "Daytona"/);
  },
);
