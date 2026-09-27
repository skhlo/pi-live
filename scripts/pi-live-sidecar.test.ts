import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { createServer, type ServerResponse } from "node:http";
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
  for (const host of ["127.0.0.1", "localhost"])
    assert.equal(isSidecarUrl(`ws://${host}:8787/`), true);
  for (const url of [
    "ws://example.com:8787",
    "ws://[::1]:8787",
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
    // A failed start keeps the log its notice names.
    await stat(sidecar.logPath);
  }
});

// The real script with a fake Chrome and a curl that never finds DevTools, so
// no fixed sidecar port or real Chrome is touched.
async function scriptFixture(root: string, chromeBody: string) {
  await mkdir(path.join(root, "src"));
  await writeFile(path.join(root, "src/server.js"), "process.exit(1);\n");
  const bin = path.join(root, "bin");
  await mkdir(bin);
  await writeFile(path.join(bin, "curl"), "#!/bin/sh\nexit 7\n", {
    mode: 0o755,
  });
  const chrome = path.join(root, "chrome");
  const pidFile = path.join(root, "chrome.pid");
  await writeFile(
    chrome,
    `#!/bin/bash\necho $$ > '${pidFile}'\n${chromeBody}`,
    {
      mode: 0o755,
    },
  );
  const environment = {
    PATH: `${bin}:${process.env.PATH}`,
    HOME: root,
    VOICE_BROWSER_DIR: root,
    TYPESAFE_API_KEY: "fixture-only",
    SIDECAR_CHROME: chrome,
    SIDECAR_CHROME_PROFILE: path.join(root, "profile"),
  };
  const chromePid = async () => {
    await waitUntil(() => existsSync(pidFile), "fake Chrome start");
    await waitUntil(
      () => /\n$/.test(readFileSyncText(pidFile)),
      "fake Chrome pid",
    );
    return Number(readFileSyncText(pidFile).trim());
  };
  return { environment, chromePid };
}

const readFileSyncText = (file: string) => readFileSync(file, "utf8");

function running(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test("a clean stop runs the script's cleanup and deletes the log", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "pi-live-sidecar-stop-"));
  t.after(() => rm(root, { recursive: true }));
  const fixture = await scriptFixture(root, "exec sleep 30\n");
  const sidecar = startBrowserSidecar(fixture.environment);
  t.after(() => rm(sidecar.logPath, { force: true }));
  const pid = await fixture.chromePid();
  await sidecar.stop();
  assert.equal(running(pid), false);
  await assert.rejects(stat(sidecar.logPath), { code: "ENOENT" });
});

test("a stop that stalls is forced within its bound and keeps the log", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "pi-live-sidecar-stall-"));
  t.after(() => rm(root, { recursive: true }));
  // Chrome ignores SIGTERM, so the script's cleanup waits for it forever.
  const fixture = await scriptFixture(root, "trap '' TERM\nexec sleep 30\n");
  const sidecar = startBrowserSidecar(fixture.environment, { stopMs: 300 });
  const pid = await fixture.chromePid();
  t.after(() => {
    if (running(pid)) process.kill(pid, "SIGKILL");
    return rm(sidecar.logPath, { force: true });
  });
  const stopped = await Promise.race([
    sidecar.stop().then(() => true),
    new Promise<boolean>((resolve) => setTimeout(resolve, 3_000, false)),
  ]);
  assert.equal(stopped, true, "stop must not wait for a stalled child");
  await waitUntil(() => !running(pid), "fake Chrome killed");
  await stat(sidecar.logPath);
});

test("startup cleanup finishes when Chrome DevTools stalls an HTTP request", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "pi-live-stalled-cdp-"));
  t.after(() => rm(root, { recursive: true }));
  await mkdir(path.join(root, "src"));
  await writeFile(path.join(root, "src/server.js"), "process.exit(1);\n");
  const chrome = path.join(root, "chrome");
  await writeFile(chrome, "#!/bin/sh\nexec sleep 30\n", { mode: 0o755 });
  const bin = path.join(root, "bin");
  await mkdir(bin);
  // Redirect only the URL, preserving the production curl flags. No fixed
  // sidecar port or real Chrome is used by the unit suite.
  await writeFile(
    path.join(bin, "curl"),
    '#!/bin/bash\nargs=("$@")\nargs[${#args[@]}-1]="$SIDECAR_TEST_CDP_URL"\nexec /usr/bin/curl "${args[@]}"\n',
    { mode: 0o755 },
  );
  const responses = new Set<ServerResponse>();
  const server = createServer((_request, response) => responses.add(response));
  t.after(() => {
    for (const response of responses) response.destroy();
    server.close();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  // Release a broken implementation so a regression fails rather than leaving
  // its child behind or hanging the test suite.
  const release = setTimeout(() => {
    for (const response of responses) response.end("late response");
  }, 3000);
  const session = createBrowserSidecarSession({ timeoutMs: 100, pollMs: 10 });
  t.after(async () => {
    clearTimeout(release);
    await session.stop();
  });
  const started = performance.now();
  const result = await session.prepare(
    {
      url: "ws://127.0.0.1:8787",
      directory: root,
      probe: async () => false,
      start: () => {
        const child = startBrowserSidecar({
          PATH: `${bin}:${process.env.PATH}`,
          HOME: root,
          VOICE_BROWSER_DIR: root,
          TYPESAFE_API_KEY: "fixture-only",
          SIDECAR_CHROME: chrome,
          SIDECAR_CHROME_PROFILE: path.join(root, "profile"),
          SIDECAR_TEST_CDP_URL: `http://127.0.0.1:${address.port}`,
        });
        t.after(() => rm(child.logPath));
        return child;
      },
    },
    async () => true,
  );
  assert.ok(responses.size > 0, "the script reached the stalled HTTP endpoint");
  assert.match(result.notice ?? "", /controller did not answer in time.*Log:/);
  assert.ok(
    performance.now() - started < 2500,
    "cleanup must not wait for the stalled HTTP response",
  );
});
