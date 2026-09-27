import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  createBrowserSidecarSession,
  isSidecarUrl,
  startBrowserSidecar,
  type BrowserSidecarSetup,
} from "../src/browser-sidecar.ts";
import { waitUntil } from "./test-support/live-sdk.ts";

function fakeSidecar(options: { answer?: boolean; failure?: string } = {}) {
  let started = 0;
  let stopped = 0;
  let answer = options.answer ?? false;
  const setup: BrowserSidecarSetup = {
    url: "ws://127.0.0.1:8787",
    directory: "/fixture/voice-browser",
    probe: async () => answer,
    start() {
      started++;
      return {
        logPath: "/fixture/sidecar.log",
        failure: () => options.failure,
        stop: async () => {
          stopped++;
        },
      };
    },
  };
  return {
    setup,
    answer: () => {
      answer = true;
    },
    started: () => started,
    stopped: () => stopped,
  };
}

test("only the sidecar's fixed loopback endpoint is eligible", () => {
  for (const host of ["127.0.0.1", "localhost", "[::1]"])
    assert.equal(isSidecarUrl(`ws://${host}:8787/`), true);
  for (const url of [
    "ws://example.com:8787",
    "wss://localhost:8787",
    "ws://localhost:9000",
    "ws://localhost:8787/other",
    "ws://localhost:8787?x",
    "ws://localhost:8787#x",
    "ws://user@localhost:8787",
  ])
    assert.equal(isSidecarUrl(url), false, url);
});

test("decline is remembered; an existing controller is reused without an offer", async () => {
  const session = createBrowserSidecarSession();
  const fake = fakeSidecar();
  let offers = 0;
  const decline = async () => {
    offers++;
    return false;
  };
  await session.prepare(fake.setup, decline);
  await session.prepare(fake.setup, decline);
  fake.answer();
  await session.prepare(fake.setup, decline);
  await session.stop();
  assert.equal(offers, 1);
  assert.equal(fake.started(), 0);
  assert.equal(fake.stopped(), 0);
});

test("unconfigured checkouts and custom controller URLs are never offered", async () => {
  const fake = fakeSidecar();
  const confirm = async () => {
    assert.fail("unexpected offer");
  };
  await createBrowserSidecarSession().prepare(
    { ...fake.setup, directory: undefined },
    confirm,
  );
  await createBrowserSidecarSession().prepare(
    { ...fake.setup, url: "ws://localhost:9000" },
    confirm,
  );
  assert.equal(fake.started(), 0);
});

test("startup waits for readiness, reuses ownership, and shutdown stops once", async () => {
  const session = createBrowserSidecarSession({ pollMs: 1 });
  const fake = fakeSidecar();
  let ready = false;
  const pending = session
    .prepare(fake.setup, async () => true)
    .then((result) => {
      ready = true;
      return result;
    });
  await waitUntil(() => fake.started() === 1, "sidecar start");
  assert.equal(ready, false);
  fake.answer();
  assert.deepEqual(await pending, { owned: true });
  assert.deepEqual(
    await session.prepare(fake.setup, async () => {
      assert.fail("second offer");
    }),
    { owned: true },
  );
  await Promise.all([session.stop(), session.stop()]);
  assert.equal(fake.started(), 1);
  assert.equal(fake.stopped(), 1);
});

test("early exits and readiness timeout each stop and return one cause with a log", async () => {
  for (const failure of [
    "voice-browser checkout is missing",
    "Chrome is missing",
    "no TypeSafe key is configured",
    "browser sidecar exited early",
    undefined,
  ]) {
    const session = createBrowserSidecarSession({ timeoutMs: 5, pollMs: 1 });
    const fake = fakeSidecar({ failure });
    const result = await session.prepare(fake.setup, async () => true);
    assert.deepEqual(result, {
      owned: false,
      notice: `${failure ?? "browser controller did not answer in time"}. Log: /fixture/sidecar.log`,
    });
    await session.stop();
    assert.equal(fake.stopped(), 1);
  }
});

test("shutdown during confirmation cannot launch; shutdown during startup stops", async () => {
  const session = createBrowserSidecarSession();
  const fake = fakeSidecar();
  let answer!: (value: boolean) => void;
  const pending = session.prepare(
    fake.setup,
    () =>
      new Promise((resolve) => {
        answer = resolve;
      }),
  );
  await waitUntil(() => !!answer, "offer");
  await session.stop();
  answer(true);
  assert.deepEqual(await pending, { owned: false });
  assert.equal(fake.started(), 0);

  const starting = createBrowserSidecarSession();
  const pendingStart = starting.prepare(fake.setup, async () => true);
  await waitUntil(() => fake.started() === 1, "sidecar start");
  await starting.stop();
  assert.deepEqual(await pendingStart, { owned: false });
});

test("the real script reports missing checkout, key and Chrome in a private log", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "pi-live-sidecar-test-"));
  t.after(() => rm(root, { recursive: true }));
  await mkdir(path.join(root, "src"));
  await writeFile(
    path.join(root, "src/server.js"),
    "throw new Error('should not launch');\n",
  );
  const keyFile = path.join(root, ".env");
  await writeFile(keyFile, "");
  for (const [settings, cause] of [
    [
      { VOICE_BROWSER_DIR: path.join(root, "missing") },
      "voice-browser checkout is missing",
    ],
    [{ VOICE_BROWSER_DIR: root }, "no TypeSafe key is configured"],
    [
      {
        VOICE_BROWSER_DIR: root,
        TYPESAFE_API_KEY: "fixture-only",
        SIDECAR_CHROME: path.join(root, "missing-chrome"),
      },
      "Chrome is missing",
    ],
  ] as const) {
    const sidecar = startBrowserSidecar({
      PATH: process.env.PATH,
      HOME: root,
      SIDECAR_KEY_FILE: keyFile,
      ...settings,
    });
    t.after(() => rm(sidecar.logPath));
    await waitUntil(() => !!sidecar.failure(), "script exit");
    assert.equal(sidecar.failure(), cause);
    assert.equal((await stat(sidecar.logPath)).mode & 0o777, 0o600);
    assert.ok((await readFile(sidecar.logPath, "utf8")).length > 0);
    await sidecar.stop();
    await sidecar.stop();
  }
});
