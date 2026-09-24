import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";

import {
  checkPiLiveLoader,
  type PiLiveLoaderReceipt,
} from "./check-pi-live-loader.ts";
import {
  copyPiLivePayloadFixture,
  inspectPiLivePackagePayload,
} from "./pi-live-package.ts";

const root = path.resolve(import.meta.dirname, "..");
const supportedHost = process.platform === "darwin" && process.arch === "arm64";

async function loaderFixture(t: TestContext): Promise<string> {
  const fixtureParent = await mkdtemp(
    path.join(tmpdir(), "pi-live-loader-test-"),
  );
  t.after(async () => rm(fixtureParent, { recursive: true }));
  const packageRoot = path.join(fixtureParent, "package");
  copyPiLivePayloadFixture(inspectPiLivePackagePayload(root), packageRoot);
  return packageRoot;
}

test(
  "the public loader check uses a real isolated Pi loader under the macOS sandbox",
  { skip: !supportedHost },
  () => {
    const result = spawnSync(
      process.execPath,
      [path.join(root, "scripts/check-pi-live-loader.ts")],
      { cwd: root, encoding: "utf8", timeout: 30_000 },
    );
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Verified Pi Live loader receipt/);
  },
);

test(
  "the loader refuses native imports instead of loading an addon",
  { skip: !supportedHost },
  async (t) => {
    const packageRoot = await loaderFixture(t);
    const entry = path.join(packageRoot, "index.ts");
    await writeFile(
      entry,
      `${await readFile(entry, "utf8")}\nimport "@oh-my-pi/pi-natives-darwin-arm64";\n`,
    );
    assert.throws(
      () => checkPiLiveLoader(packageRoot, "absent"),
      /Failed to load extension|Cannot find package|addons/i,
    );
  },
);

test(
  "the loader sandbox blocks child execution attempted during extension loading",
  { skip: !supportedHost },
  async (t) => {
    const packageRoot = await loaderFixture(t);
    const entry = path.join(packageRoot, "index.ts");
    await writeFile(
      entry,
      `${await readFile(entry, "utf8")}\nimport { spawnSync as piLiveForbiddenSpawn } from "node:child_process";\nconst piLiveForbiddenChild = piLiveForbiddenSpawn("/usr/bin/true");\nif (piLiveForbiddenChild.error) throw piLiveForbiddenChild.error;\n`,
    );
    assert.throws(
      () => checkPiLiveLoader(packageRoot, "absent"),
      /Failed to load extension|EPERM/i,
    );
  },
);

test(
  "present-mode loading requires and runs caller closure checks before and after",
  { skip: !supportedHost },
  async (t) => {
    const packageRoot = await loaderFixture(t);
    const nodeModules = path.join(packageRoot, "node_modules");
    await mkdir(nodeModules);
    assert.throws(
      () => checkPiLiveLoader(packageRoot, "present"),
      /require production closure verification/i,
    );

    let verificationCount = 0;
    const receipt: PiLiveLoaderReceipt = checkPiLiveLoader(
      packageRoot,
      "present",
      () => {
        verificationCount += 1;
        assert.deepEqual(readdirSync(nodeModules), []);
      },
    );
    assert.equal(verificationCount, 2);
    assert.equal(receipt.packageNodeModules, "present");
  },
);
