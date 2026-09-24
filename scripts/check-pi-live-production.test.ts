import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { checkPiLiveProduction } from "./check-pi-live-production.ts";
import { PI_LIVE_PRODUCTION_INSTALL_ARGS } from "./pi-live-package.ts";

const root = path.resolve(import.meta.dirname, "..");
const supportedHost = process.platform === "darwin" && process.arch === "arm64";

test(
  "the production check uses exact frozen-install arguments and a scrubbed fixture environment",
  { skip: !supportedHost },
  async (t) => {
    const testRoot = await mkdtemp(
      path.join(tmpdir(), "pi-live-production-test-"),
    );
    t.after(async () => rm(testRoot, { recursive: true }));
    const log = path.join(testRoot, "pnpm-calls.jsonl");
    const fakePnpm = path.join(testRoot, "pnpm");
    await writeFile(
      fakePnpm,
      `#!${process.execPath}
import fs from "node:fs";
const directoryNames = ["HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "COREPACK_HOME"];
const record = {
  args: process.argv.slice(2),
  cwd: process.cwd(),
  env: process.env,
  empty: Object.fromEntries(directoryNames.map((name) => [name, fs.readdirSync(process.env[name])])),
  userNpmrc: fs.readFileSync(process.env.npm_config_userconfig, "utf8"),
  globalNpmrc: fs.readFileSync(process.env.npm_config_globalconfig, "utf8"),
};
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(record) + "\\n");
if (process.argv[2] === "--version") process.stdout.write("11.8.0\\n");
`,
      { mode: 0o755 },
    );
    await chmod(fakePnpm, 0o755);

    const previousNodeOptions = process.env.NODE_OPTIONS;
    const previousScriptShell = process.env.npm_config_script_shell;
    process.env.NODE_OPTIONS = "--no-warnings";
    process.env.npm_config_script_shell = "/private/invalid-hook";
    try {
      assert.throws(
        () =>
          checkPiLiveProduction({
            repositoryRoot: root,
            pnpmCommand: fakePnpm,
            temporaryParent: testRoot,
          }),
        /production node_modules|node_modules.*real directory/i,
      );
    } finally {
      if (previousNodeOptions === undefined) delete process.env.NODE_OPTIONS;
      else process.env.NODE_OPTIONS = previousNodeOptions;
      if (previousScriptShell === undefined)
        delete process.env.npm_config_script_shell;
      else process.env.npm_config_script_shell = previousScriptShell;
    }

    const calls = (await readFile(log, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    assert.equal(calls.length, 2);
    assert.deepEqual(
      calls.map(({ args }) => args),
      [["--version"], [...PI_LIVE_PRODUCTION_INSTALL_ARGS]],
    );
    assert.equal(calls[0]!.cwd, calls[1]!.cwd);
    assert.equal(
      await readFile(
        path.join(String(calls[0]!.cwd), "package.json"),
        "utf8",
      ).then(
        () => true,
        () => false,
      ),
      false,
      "Disposable production fixture must be removed after failure",
    );

    for (const call of calls) {
      assert.deepEqual(call.empty, {
        HOME: [],
        XDG_CONFIG_HOME: [],
        XDG_CACHE_HOME: [],
        XDG_DATA_HOME: [],
        XDG_STATE_HOME: [],
        COREPACK_HOME: [],
      });
      assert.equal(call.userNpmrc, "");
      assert.equal(call.globalNpmrc, "");
      assert.ok(
        call.env !== null &&
          typeof call.env === "object" &&
          !Array.isArray(call.env),
      );
      const env = call.env as Record<string, unknown>;
      assert.equal(env.NODE_OPTIONS, undefined);
      assert.equal(env.npm_config_script_shell, undefined);
      assert.equal(env.npm_config_registry, "https://registry.npmjs.org/");
      assert.deepEqual(
        Object.keys(env)
          .filter((name) => name.startsWith("npm_config_"))
          .sort(),
        [
          "npm_config_cache",
          "npm_config_globalconfig",
          "npm_config_registry",
          "npm_config_store_dir",
          "npm_config_userconfig",
        ],
      );
    }
  },
);
