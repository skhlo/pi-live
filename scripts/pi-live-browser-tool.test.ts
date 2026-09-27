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
  "/slow-form": `<!doctype html><title>Slow Form</title><form action="/slow"><input placeholder="Slow search"></form>`,
  "/shop": `<!doctype html><title>Shop</title><button>Buy now</button>
<form action="/account"><input placeholder="Username"><input type="password" placeholder="Password"><button>Continue</button></form>`,
};

test(
  "the browser tool acts and reports on a real Chrome",
  { skip: chrome ? false : "set PI_LIVE_TEST_CHROME to a Chrome binary" },
  async (t) => {
    let slowHits = 0;
    const site = createServer((request, response) => {
      const pathname = new URL(request.url ?? "/", "http://x").pathname;
      if (pathname === "/slow") {
        slowHits++;
        setTimeout(() => {
          response.writeHead(200, { "content-type": "text/html" });
          response.end("<!doctype html><title>Slow results</title>");
        }, 1_500);
        return;
      }
      const page = PAGES[pathname];
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

    // A submit is claimed only when the page navigated, and Enter is never
    // pressed twice.
    const notDone =
      /and pressed Enter; the page did not navigate, so it may have updated in place or ignored Enter\.\nPage: "Watch Shop"/;
    const notes = await tool.run({
      action: "type",
      target: "Notes",
      text: "hello",
      submit: true,
    });
    assert.match(notes.text, notDone);
    const guarded = await tool.run({
      action: "type",
      target: "Guarded search",
      text: "Daytona",
      submit: true,
    });
    assert.match(guarded.text, notDone);

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

    // A slow response is waited for, not submitted a second time.
    await tool.run({ action: "open", url: `${origin}/slow-form` });
    const slow = await tool.run({
      action: "type",
      target: "Slow search",
      text: "Explorer",
      submit: true,
    });
    assert.match(slow.text, /and submitted\.\nPage: "Slow results"/);
    assert.equal(slowHits, 1);

    // Voice cannot approve buying or signing in, so those are refused.
    await tool.run({ action: "open", url: `${origin}/shop` });
    const refused =
      /^Refused: ".*" looks like buying, paying, deleting, sending, booking or signing in\..*\nPage: "Shop"/;
    assert.match(
      (await tool.run({ action: "click", target: "Buy now" })).text,
      refused,
    );
    assert.match(
      (await tool.run({ action: "type", target: "Password", text: "x" })).text,
      refused,
    );
    assert.match(
      (
        await tool.run({
          action: "type",
          target: "Username",
          text: "me",
          submit: true,
        })
      ).text,
      refused,
    );
    assert.match(
      (await tool.run({ action: "type", target: "Username", text: "me" })).text,
      /^Typed into "Username"\./,
    );
    assert.match(
      (await tool.run({ action: "press", key: "Enter" })).text,
      refused,
    );
    assert.equal((await tool.currentPage())?.title, "Shop");

    const tabbed = await tool.run({
      action: "new_tab",
      url: `${origin}/submariner`,
    });
    assert.match(tabbed.text, /Opened a new tab\.\nPage: "Submariner"/);
    assert.match(
      (await tool.run({ action: "back" })).text,
      /^There was no earlier page to go back to\.\nPage: "Submariner"/,
    );
    const switched = await tool.run({ action: "switch_tab", tab: 1 });
    assert.match(switched.text, /Switched to tab 1\.\nPage: "Shop"/);
  },
);
