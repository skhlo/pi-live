import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  access,
  mkdir,
  mkdtemp,
  lstat,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";

import {
  createFilePreferenceStore,
  DEFAULT_LIVE_VOICE,
  LIVE_VOICE_VALUES,
  PreferenceError,
} from "../src/preferences.ts";
import { jsonObject, parseJsonObject } from "./test-json.ts";

async function isMissing(target: string): Promise<boolean> {
  try {
    await access(target);
    return false;
  } catch {
    return true;
  }
}

async function preferenceFixture(t: TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), "pi-live-preference-test-"));
  const agentDir = path.join(root, "agent");
  await mkdir(agentDir);
  t.after(async () => rm(root, { recursive: true }));
  return {
    root,
    agentDir,
    configDir: path.join(agentDir, "pi-live"),
    configPath: path.join(agentDir, "pi-live/config.json"),
    store: createFilePreferenceStore(() => agentDir),
  };
}

test("a missing preference defaults to the GPT-Live marin voice without writing", async (t) => {
  const fixture = await preferenceFixture(t);

  assert.deepEqual(LIVE_VOICE_VALUES, [
    "alloy",
    "ash",
    "ballad",
    "beacon",
    "bossa",
    "cedar",
    "cinder",
    "coral",
    "delta",
    "echo",
    "gleam",
    "marin",
    "meridian",
    "quartz",
    "ripple",
    "sage",
    "shimmer",
    "stone",
    "tempo",
    "verse",
    "vesper",
    "willow",
  ]);
  assert.equal(DEFAULT_LIVE_VOICE, "marin");
  assert.deepEqual(await fixture.store.load(), {
    voice: "marin",
    fields: {},
  });
  assert.equal(await isMissing(fixture.configDir), true);
});

test("the real store resolves config.json beneath getAgentDir", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "pi-live-agent-dir-test-"));
  const agentDir = path.join(root, "custom-agent");
  await mkdir(agentDir);
  t.after(async () => rm(root, { recursive: true }));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  t.after(() => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
  });

  await createFilePreferenceStore().setVoice("alloy");

  const config = parseJsonObject(
    await readFile(path.join(agentDir, "pi-live/config.json"), "utf8"),
    "stored preferences",
  );
  assert.equal(config.voice, "alloy");
});

test("valid preferences use the upstream voice enum and retain unknown fields", async (t) => {
  const fixture = await preferenceFixture(t);
  await mkdir(fixture.configDir, { mode: 0o700 });
  await writeFile(
    fixture.configPath,
    '{"voice":"cedar","future":{"enabled":true},"count":2}\n',
    { mode: 0o600 },
  );
  const before = await readFile(fixture.configPath);

  assert.deepEqual(await fixture.store.load(), {
    voice: "cedar",
    fields: {
      voice: "cedar",
      future: { enabled: true },
      count: 2,
    },
  });
  assert.deepEqual(await readFile(fixture.configPath), before);
});

async function expectPreferenceError(
  action: () => Promise<unknown>,
  code: PreferenceError["code"],
): Promise<void> {
  await assert.rejects(action, (error: unknown) => {
    assert.ok(error instanceof PreferenceError);
    assert.equal(error.code, code);
    return true;
  });
}

test("voice writes are same-directory atomic, private, and preserve unknown fields", async (t) => {
  const fixture = await preferenceFixture(t);
  await mkdir(fixture.configDir, { mode: 0o700 });
  await writeFile(
    fixture.configPath,
    '{"future":{"enabled":true},"voice":"ash","count":2}\n',
    { mode: 0o600 },
  );

  await fixture.store.setVoice("shimmer");

  assert.deepEqual(JSON.parse(await readFile(fixture.configPath, "utf8")), {
    future: { enabled: true },
    voice: "shimmer",
    count: 2,
  });
  assert.equal((await stat(fixture.configDir)).mode & 0o777, 0o700);
  assert.equal((await stat(fixture.configPath)).mode & 0o777, 0o600);
  assert.deepEqual(await readdir(fixture.configDir), ["config.json"]);
});

test("broad existing preference modes are refused without repair", async (t) => {
  for (const [name, directoryMode, fileMode] of [
    ["directory", 0o755, 0o600],
    ["file", 0o700, 0o644],
  ] as const) {
    await t.test(name, async (t) => {
      const fixture = await preferenceFixture(t);
      await mkdir(fixture.configDir, { mode: directoryMode });
      await writeFile(fixture.configPath, '{"voice":"marin"}\n', {
        mode: fileMode,
      });
      const beforeDirectoryMode = (await stat(fixture.configDir)).mode & 0o777;
      const beforeFileMode = (await stat(fixture.configPath)).mode & 0o777;

      await expectPreferenceError(() => fixture.store.load(), "unsafe-path");
      await expectPreferenceError(
        () => fixture.store.setVoice("cedar"),
        "unsafe-path",
      );

      assert.equal(
        (await stat(fixture.configDir)).mode & 0o777,
        beforeDirectoryMode,
      );
      assert.equal(
        (await stat(fixture.configPath)).mode & 0o777,
        beforeFileMode,
      );
      assert.equal(
        await readFile(fixture.configPath, "utf8"),
        '{"voice":"marin"}\n',
      );
    });
  }
});

test("an observed competing update is retried before the preference is published", async (t) => {
  const fixture = await preferenceFixture(t);
  await mkdir(fixture.configDir, { mode: 0o700 });
  await writeFile(
    fixture.configPath,
    '{"voice":"marin","initial":{"kept":false}}\n',
    { mode: 0o600 },
  );
  const replacement = path.join(fixture.configDir, ".competing.json");
  await writeFile(
    replacement,
    '{"voice":"cedar","competing":{"kept":true}}\n',
    {
      mode: 0o600,
    },
  );
  const home = path.join(fixture.root, "home");
  await mkdir(home, { mode: 0o700 });
  const eventLog = path.join(fixture.root, "interleaving.json");
  const preload = path.join(fixture.root, "interleave-preferences.mjs");
  await writeFile(
    preload,
    `import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
const configPath = process.env.PI_LIVE_TEST_CONFIG_PATH;
const directory = process.env.PI_LIVE_TEST_CONFIG_DIRECTORY;
const replacement = process.env.PI_LIVE_TEST_REPLACEMENT;
const eventLog = process.env.PI_LIVE_TEST_EVENT_LOG;
if (!configPath || !directory || !replacement || !eventLog) {
  throw new Error("missing deterministic interleaving path");
}
const originalOpen = fs.promises.open.bind(fs.promises);
const events = [];
let configOpens = 0;
let temporaryOpens = 0;
fs.promises.open = async (...args) => {
  const target = String(args[0]);
  if (target === configPath) {
    configOpens += 1;
    events.push(\`config-open-\${configOpens}\`);
  } else if (
    target.startsWith(\`\${directory}/.config.json.\`) &&
    target.endsWith(".tmp")
  ) {
    temporaryOpens += 1;
    events.push(\`temporary-open-\${temporaryOpens}\`);
    if (temporaryOpens === 1) {
      fs.renameSync(replacement, configPath);
      events.push("competing-update");
    }
  }
  return originalOpen(...args);
};
process.on("exit", () => {
  fs.writeFileSync(eventLog, JSON.stringify(events));
});
syncBuiltinESMExports();
`,
  );
  const child = path.join(fixture.root, "set-voice.mjs");
  const preferenceImplementation = path.resolve(
    import.meta.dirname,
    "../src/preferences.ts",
  );
  await writeFile(
    child,
    `import { createFilePreferenceStore } from ${JSON.stringify(pathToFileURL(preferenceImplementation).href)};
const agentDir = process.env.PI_LIVE_TEST_AGENT_DIRECTORY;
if (!agentDir) throw new Error("missing isolated agent directory");
await createFilePreferenceStore(() => agentDir).setVoice("verse");
`,
  );

  const result = spawnSync(process.execPath, ["--import", preload, child], {
    cwd: path.resolve(import.meta.dirname, ".."),
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: home,
      PI_CODING_AGENT_DIR: fixture.agentDir,
      PI_LIVE_TEST_AGENT_DIRECTORY: fixture.agentDir,
      PI_LIVE_TEST_CONFIG_DIRECTORY: fixture.configDir,
      PI_LIVE_TEST_CONFIG_PATH: fixture.configPath,
      PI_LIVE_TEST_EVENT_LOG: eventLog,
      PI_LIVE_TEST_REPLACEMENT: replacement,
    },
    timeout: 30_000,
  });

  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(await readFile(fixture.configPath, "utf8")), {
    voice: "verse",
    competing: { kept: true },
  });
  assert.deepEqual(JSON.parse(await readFile(eventLog, "utf8")), [
    "config-open-1",
    "temporary-open-1",
    "competing-update",
    "config-open-2",
    "config-open-3",
    "temporary-open-2",
    "config-open-4",
  ]);
  assert.equal((await stat(fixture.configPath)).mode & 0o777, 0o600);
  assert.deepEqual(await readdir(fixture.configDir), ["config.json"]);
});

test("a cooperating writer leaves a valid private preference", async (t) => {
  const fixture = await preferenceFixture(t);
  await mkdir(fixture.configDir, { mode: 0o700 });
  await writeFile(fixture.configPath, '{"voice":"marin","before":true}\n', {
    mode: 0o600,
  });
  const worker = new Worker(
    `const fs=require("node:fs");
const {parentPort,workerData}=require("node:worker_threads");
const wait=new Int32Array(new SharedArrayBuffer(4));
parentPort.postMessage("ready");
for(;;){
  const temporary=fs.readdirSync(workerData.directory).find((name)=>name.endsWith(".tmp"));
  if(temporary){
    fs.renameSync(workerData.replacement,workerData.configPath);
    parentPort.postMessage("changed");
    break;
  }
  Atomics.wait(wait,0,0,1);
}`,
    {
      eval: true,
      workerData: {
        directory: fixture.configDir,
        configPath: fixture.configPath,
        replacement: path.join(fixture.root, "cooperating.json"),
      },
    },
  );
  t.after(() => void worker.terminate());
  await writeFile(
    path.join(fixture.root, "cooperating.json"),
    '{"voice":"cedar","cooperating":{"kept":true}}\n',
    { mode: 0o600 },
  );
  await new Promise<void>((resolve, reject) => {
    worker.once("message", (message) => {
      if (message === "ready") resolve();
      else reject(new Error(`Unexpected worker message: ${message}`));
    });
    worker.once("error", reject);
  });
  const changed = new Promise<void>((resolve, reject) => {
    worker.once("message", (message) => {
      if (message === "changed") resolve();
      else reject(new Error(`Unexpected worker message: ${message}`));
    });
    worker.once("error", reject);
  });

  await fixture.store.setVoice("verse");
  await changed;

  const result = parseJsonObject(
    await readFile(fixture.configPath, "utf8"),
    "stored preferences",
  );
  const cooperating =
    result.cooperating === undefined
      ? undefined
      : jsonObject(result.cooperating, "cooperating preference fields");
  assert.ok(
    (result.voice === "verse" && result.before === true) ||
      (result.voice === "verse" && cooperating?.kept === true) ||
      (result.voice === "cedar" && cooperating?.kept === true),
  );
  assert.equal((await stat(fixture.configPath)).mode & 0o777, 0o600);
  assert.deepEqual(await readdir(fixture.configDir), ["config.json"]);
});

test("concurrent stores leave one valid private update and no task artifacts", async (t) => {
  const fixture = await preferenceFixture(t);
  await mkdir(fixture.configDir, { mode: 0o700 });
  await writeFile(fixture.configPath, '{"voice":"marin","retained":3}\n', {
    mode: 0o600,
  });
  const second = createFilePreferenceStore(() => fixture.agentDir);

  await Promise.all([
    fixture.store.setVoice("alloy"),
    second.setVoice("shimmer"),
  ]);

  const result = parseJsonObject(
    await readFile(fixture.configPath, "utf8"),
    "stored preferences",
  );
  assert.ok(result.voice === "alloy" || result.voice === "shimmer");
  assert.equal(result.retained, 3);
  assert.equal((await stat(fixture.configPath)).mode & 0o777, 0o600);
  assert.deepEqual(await readdir(fixture.configDir), ["config.json"]);
});

test("orphaned unique temps and a legacy lock never block a later write", async (t) => {
  const fixture = await preferenceFixture(t);
  await mkdir(fixture.configDir, { mode: 0o700 });
  await writeFile(fixture.configPath, '{"voice":"marin","retained":4}\n', {
    mode: 0o600,
  });
  const orphan = path.join(
    fixture.configDir,
    ".config.json.abandoned-writer.tmp",
  );
  const legacyLock = path.join(fixture.configDir, ".config.json.lock");
  await writeFile(orphan, "partial writer bytes\n", { mode: 0o600 });
  await writeFile(legacyLock, "legacy lock\n", { mode: 0o600 });

  await fixture.store.setVoice("sage");

  assert.deepEqual(JSON.parse(await readFile(fixture.configPath, "utf8")), {
    voice: "sage",
    retained: 4,
  });
  assert.equal(await readFile(orphan, "utf8"), "partial writer bytes\n");
  assert.equal(await readFile(legacyLock, "utf8"), "legacy lock\n");
  assert.deepEqual((await readdir(fixture.configDir)).sort(), [
    ".config.json.abandoned-writer.tmp",
    ".config.json.lock",
    "config.json",
  ]);
});

test("directory and symlink drift are refused before rename", async (t) => {
  for (const kind of ["directory-mode", "config-symlink"] as const) {
    await t.test(kind, async (t) => {
      const fixture = await preferenceFixture(t);
      await mkdir(fixture.configDir, { mode: 0o700 });
      const original = `${JSON.stringify({
        voice: "marin",
        original: true,
        payload: "x".repeat(8_000_000),
      })}\n`;
      await writeFile(fixture.configPath, original, { mode: 0o600 });
      const replacement = path.join(fixture.root, "replacement.json");
      await writeFile(replacement, '{"voice":"cedar","swapped":true}\n', {
        mode: 0o600,
      });
      const worker = new Worker(
        `const fs=require("node:fs");
const {parentPort,workerData}=require("node:worker_threads");
const wait=new Int32Array(new SharedArrayBuffer(4));
parentPort.postMessage("ready");
for(;;){
  const temporary=fs.readdirSync(workerData.directory).find((name)=>name.endsWith(".tmp"));
  if(temporary){
    if(workerData.kind==="directory-mode")fs.chmodSync(workerData.directory,0o755);
    else {
      fs.unlinkSync(workerData.configPath);
      fs.symlinkSync(workerData.replacement,workerData.configPath);
    }
    parentPort.postMessage("changed");
    break;
  }
  Atomics.wait(wait,0,0,1);
}`,
        {
          eval: true,
          workerData: {
            kind,
            directory: fixture.configDir,
            configPath: fixture.configPath,
            replacement,
          },
        },
      );
      t.after(() => void worker.terminate());
      await new Promise<void>((resolve, reject) => {
        worker.once("message", (message) => {
          if (message === "ready") resolve();
          else reject(new Error(`Unexpected worker message: ${message}`));
        });
        worker.once("error", reject);
      });
      const changed = new Promise<void>((resolve, reject) => {
        worker.once("message", (message) => {
          if (message === "changed") resolve();
          else reject(new Error(`Unexpected worker message: ${message}`));
        });
        worker.once("error", reject);
      });

      await expectPreferenceError(
        () => fixture.store.setVoice("verse"),
        "unsafe-path",
      );
      await changed;

      assert.equal(
        await readFile(fixture.configPath, "utf8"),
        kind === "directory-mode"
          ? original
          : '{"voice":"cedar","swapped":true}\n',
      );
      assert.deepEqual(await readdir(fixture.configDir), ["config.json"]);
    });
  }
});

test("malformed, invalid, symlink, and nonregular preferences are refused without repair", async (t) => {
  await t.test("malformed JSON", async (t) => {
    const fixture = await preferenceFixture(t);
    await mkdir(fixture.configDir, { mode: 0o700 });
    const bytes = Buffer.from('{"voice":');
    await writeFile(fixture.configPath, bytes, { mode: 0o600 });
    await expectPreferenceError(() => fixture.store.load(), "malformed");
    await expectPreferenceError(
      () => fixture.store.setVoice("cedar"),
      "malformed",
    );
    assert.deepEqual(await readFile(fixture.configPath), bytes);
  });

  await t.test(
    "any present non-enum voice, including null, is invalid",
    async (t) => {
      for (const value of ["sol", null, false, 3, {}]) {
        const fixture = await preferenceFixture(t);
        await mkdir(fixture.configDir, { mode: 0o700 });
        const bytes = Buffer.from(
          `${JSON.stringify({ voice: value, future: true })}\n`,
        );
        await writeFile(fixture.configPath, bytes, { mode: 0o600 });
        await expectPreferenceError(
          () => fixture.store.load(),
          "invalid-voice",
        );
        await expectPreferenceError(
          () => fixture.store.setVoice("cedar"),
          "invalid-voice",
        );
        assert.deepEqual(await readFile(fixture.configPath), bytes);
      }
    },
  );

  await t.test("symlink", async (t) => {
    const fixture = await preferenceFixture(t);
    await mkdir(fixture.configDir, { mode: 0o700 });
    const target = path.join(fixture.root, "outside.json");
    await writeFile(target, '{"voice":"marin"}\n');
    await symlink(target, fixture.configPath);
    await expectPreferenceError(() => fixture.store.load(), "unsafe-path");
    assert.equal((await lstat(fixture.configPath)).isSymbolicLink(), true);
    assert.equal(await readFile(target, "utf8"), '{"voice":"marin"}\n');
  });

  await t.test("symlinked preference directory", async (t) => {
    const fixture = await preferenceFixture(t);
    const outside = path.join(fixture.root, "outside-directory");
    await mkdir(outside, { mode: 0o700 });
    await writeFile(path.join(outside, "config.json"), '{"voice":"marin"}\n', {
      mode: 0o600,
    });
    await symlink(outside, fixture.configDir);
    await expectPreferenceError(() => fixture.store.load(), "unsafe-path");
    assert.equal((await lstat(fixture.configDir)).isSymbolicLink(), true);
  });

  await t.test("nonregular entry", async (t) => {
    const fixture = await preferenceFixture(t);
    await mkdir(fixture.configDir, { mode: 0o700 });
    await mkdir(fixture.configPath);
    await expectPreferenceError(() => fixture.store.load(), "unsafe-path");
    assert.equal((await lstat(fixture.configPath)).isDirectory(), true);
  });
});
