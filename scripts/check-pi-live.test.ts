import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";

import {
  copyPiLivePayloadFixture,
  inspectPiLivePackagePayload,
} from "./pi-live-package.ts";
import { jsonObject, parseJsonObject } from "./test-json.ts";

const root = path.resolve(import.meta.dirname, "..");
const checker = path.join(root, "scripts/check-pi-live.ts");

function invoke(fixtureRoot = root) {
  return spawnSync(
    process.execPath,
    [path.join(fixtureRoot, "scripts/check-pi-live.ts")],
    {
      cwd: fixtureRoot,
      encoding: "utf8",
      timeout: 30_000,
    },
  );
}

function sha256(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function fixture(t: TestContext): Promise<string> {
  const fixtureParent = await mkdtemp(
    path.join(tmpdir(), "check-pi-live-test-"),
  );
  t.after(async () => rm(fixtureParent, { recursive: true }));
  const fixtureRoot = path.join(fixtureParent, "package");
  copyPiLivePayloadFixture(inspectPiLivePackagePayload(root), fixtureRoot);
  await mkdir(path.join(fixtureRoot, "scripts"), { recursive: true });
  await mkdir(path.join(fixtureRoot, "upstream"));
  for (const name of [
    "check-pi-live.ts",
    "pi-live-package.ts",
    "import-pi-live.ts",
  ])
    await cp(
      path.join(root, "scripts", name),
      path.join(fixtureRoot, "scripts", name),
    );
  await cp(
    path.join(root, "upstream/pi-live"),
    path.join(fixtureRoot, "upstream/pi-live"),
    { recursive: true },
  );
  await cp(
    path.join(root, "upstream/pi-live.lock.json"),
    path.join(fixtureRoot, "upstream/pi-live.lock.json"),
  );
  return fixtureRoot;
}

test("the portable package checker accepts the standalone inert package", () => {
  const result = invoke();
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Verified standalone pi-live package/);
});

test("the package checker rejects payload, policy, lock, and notice mutations", async (t) => {
  await t.test("manifest lifecycle script", async (t) => {
    const fixtureRoot = await fixture(t);
    const manifestPath = path.join(fixtureRoot, "package.json");
    const manifest = parseJsonObject(
      await readFile(manifestPath, "utf8"),
      "package manifest",
    );
    const scripts = jsonObject(manifest.scripts, "package manifest scripts");
    scripts.postinstall = "node install.js";
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    const result = invoke(fixtureRoot);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /manifest differs|lifecycle/i);
  });

  await t.test("package manager pin", async (t) => {
    const fixtureRoot = await fixture(t);
    const manifestPath = path.join(fixtureRoot, "package.json");
    const manifest = parseJsonObject(
      await readFile(manifestPath, "utf8"),
      "package manifest",
    );
    manifest.packageManager = "pnpm@11.9.0";
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    const result = invoke(fixtureRoot);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /manifest differs/i);
  });

  await t.test("lock byte", async (t) => {
    const fixtureRoot = await fixture(t);
    const lockPath = path.join(fixtureRoot, "pnpm-lock.yaml");
    await writeFile(
      lockPath,
      Buffer.concat([await readFile(lockPath), Buffer.from("\n")]),
    );
    const result = invoke(fixtureRoot);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /lock/i);
  });

  await t.test("source and notice modes", async (t) => {
    for (const [relative, mode] of [
      ["src/live.ts", 0o600],
      ["notices/audio/audiopus_sys.LICENSE", 0o666],
    ] as const) {
      const fixtureRoot = await fixture(t);
      await chmod(path.join(fixtureRoot, relative), mode);
      const result = invoke(fixtureRoot);
      assert.notEqual(result.status, 0, `${relative} at ${mode.toString(8)}`);
      assert.match(result.stderr, /mode.*0644|0644.*mode/i);
    }
  });

  await t.test("notice byte", async (t) => {
    const fixtureRoot = await fixture(t);
    const noticePath = path.join(
      fixtureRoot,
      "notices/audio/audiopus_sys.LICENSE",
    );
    const bytes = await readFile(noticePath);
    bytes[0] = bytes[0]! ^ 1;
    await writeFile(noticePath, bytes);
    const result = invoke(fixtureRoot);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /notice.*SHA-256 differs/i);
  });

  await t.test("notice manifest hash", async (t) => {
    const fixtureRoot = await fixture(t);
    const manifestPath = path.join(fixtureRoot, "notices/NOTICE-MANIFEST.json");
    await writeFile(
      manifestPath,
      Buffer.concat([await readFile(manifestPath), Buffer.from("\n")]),
    );
    const result = invoke(fixtureRoot);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /notice manifest differs/i);
  });

  await t.test("notice manifest metadata", async (t) => {
    const fixtureRoot = await fixture(t);
    const manifestPath = path.join(fixtureRoot, "notices/NOTICE-MANIFEST.json");
    const manifest = parseJsonObject(
      await readFile(manifestPath, "utf8"),
      "notice manifest",
    );
    const files = jsonObject(manifest.files, "notice manifest files");
    const notice = jsonObject(
      files["audio/audiopus_sys.LICENSE"],
      "audio notice manifest entry",
    );
    const bytes = notice.bytes;
    assert.ok(typeof bytes === "number");
    notice.bytes = bytes + 1;
    const manifestBytes = `${JSON.stringify(manifest, null, 2)}\n`;
    await writeFile(manifestPath, manifestBytes);
    const policyPath = path.join(fixtureRoot, "scripts/pi-live-package.ts");
    const policy = await readFile(policyPath, "utf8");
    await writeFile(
      policyPath,
      policy.replace(
        "3a674e1b218af8db3630e85dd0c468cdd39f09b4832010ee76e65f811b2bbdf2",
        sha256(manifestBytes),
      ),
    );
    const result = invoke(fixtureRoot);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /notice byte count differs/i);
  });

  await t.test("missing, extra, symlinked, and special notices", async (t) => {
    for (const kind of ["missing", "extra", "symlink", "special"] as const) {
      const fixtureRoot = await fixture(t);
      const noticesRoot = path.join(fixtureRoot, "notices");
      const noticePath = path.join(noticesRoot, "audio/audiopus_sys.LICENSE");
      if (kind === "missing") await unlink(noticePath);
      else if (kind === "extra")
        await writeFile(
          path.join(noticesRoot, "audio/EXTRA.LICENSE"),
          "extra\n",
        );
      else if (kind === "symlink") {
        await unlink(noticePath);
        await symlink("../crypto/ring.LICENSE", noticePath);
      } else {
        await unlink(noticePath);
        const created = spawnSync("mkfifo", [noticePath], { encoding: "utf8" });
        assert.equal(created.status, 0, created.stderr);
      }
      const result = invoke(fixtureRoot);
      assert.notEqual(result.status, 0, kind);
      assert.match(result.stderr, /notice|inventory|regular file/i, kind);
    }
  });

  await t.test("extra runtime payload file", async (t) => {
    const fixtureRoot = await fixture(t);
    await writeFile(path.join(fixtureRoot, "src/pi_natives.node"), "forbidden");
    const result = invoke(fixtureRoot);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /runtime source file.*inventory|inventory/i);
  });

  await t.test("extra native target", async (t) => {
    const fixtureRoot = await fixture(t);
    const manifestPath = path.join(fixtureRoot, "package.json");
    const manifest = parseJsonObject(
      await readFile(manifestPath, "utf8"),
      "package manifest",
    );
    const optionalDependencies = jsonObject(
      manifest.optionalDependencies,
      "package manifest optional dependencies",
    );
    optionalDependencies["@oh-my-pi/pi-natives-linux-x64"] = "17.2.9";
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    const result = invoke(fixtureRoot);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /manifest differs|native target/i);
  });

  await t.test("provenance native identity", async (t) => {
    const fixtureRoot = await fixture(t);
    const provenancePath = path.join(fixtureRoot, "PROVENANCE.md");
    const provenance = await readFile(provenancePath, "utf8");
    await writeFile(
      provenancePath,
      provenance.replace(
        "35bbb69631c88b2691941a1df660eac3416e43cbef6ed0309a4742defde51cf4",
        "missing-native-hash",
      ),
    );
    const result = invoke(fixtureRoot);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /provenance.*missing required record/i);
  });
});

test("development-only root files and ambient dependencies are outside the runtime payload", async (t) => {
  const fixtureRoot = await fixture(t);
  await writeFile(
    path.join(fixtureRoot, ".npmrc"),
    "ignored-by-fixture-copy=true\n",
  );
  await writeFile(
    path.join(fixtureRoot, "DEVELOPMENT-NOTE.md"),
    "local only\n",
  );
  await mkdir(path.join(fixtureRoot, "node_modules"));
  await writeFile(
    path.join(fixtureRoot, "node_modules/ambient-marker"),
    "not payload\n",
  );
  const result = invoke(fixtureRoot);
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
});
