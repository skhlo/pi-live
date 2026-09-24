import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";

const root = path.resolve(import.meta.dirname, "..");
const canonicalScript = path.join(root, "scripts/import-pi-live.ts");
const canonicalSnapshot = path.join(root, "upstream/pi-live");
const canonicalLock = path.join(root, "upstream/pi-live.lock.json");
const commit = "39171682343754366439b2c0890f5b0f4c3ed891";
const tree = "3aea19fabc79a2ec8f00469edc97b668b246ec94";

function invokeWithEnvironment(
  fixtureRoot: string,
  environment: NodeJS.ProcessEnv,
  ...args: string[]
) {
  const result = spawnSync(
    process.execPath,
    [path.join(fixtureRoot, "scripts/import-pi-live.ts"), ...args],
    {
      cwd: fixtureRoot,
      encoding: "utf8",
      env: environment,
      timeout: 30_000,
    },
  );
  assert.ifError(result.error);
  return result;
}

function invoke(fixtureRoot: string, ...args: string[]) {
  return invokeWithEnvironment(fixtureRoot, process.env, ...args);
}

function invokeWithPreload(
  fixtureRoot: string,
  preload: string,
  ...args: string[]
) {
  const result = spawnSync(
    process.execPath,
    [
      "--import",
      preload,
      path.join(fixtureRoot, "scripts/import-pi-live.ts"),
      ...args,
    ],
    {
      cwd: fixtureRoot,
      encoding: "utf8",
      env: process.env,
      timeout: 30_000,
    },
  );
  assert.ifError(result.error);
  return result;
}

async function fixture(t: TestContext, withSnapshot = true): Promise<string> {
  const fixtureRoot = await mkdtemp(
    path.join(tmpdir(), "pi-live-import-test-"),
  );
  t.after(async () => rm(fixtureRoot, { recursive: true }));
  await mkdir(path.join(fixtureRoot, "scripts"));
  await mkdir(path.join(fixtureRoot, "upstream"));
  await cp(
    canonicalScript,
    path.join(fixtureRoot, "scripts/import-pi-live.ts"),
  );
  if (withSnapshot) {
    await cp(canonicalSnapshot, path.join(fixtureRoot, "upstream/pi-live"), {
      recursive: true,
    });
    await cp(
      canonicalLock,
      path.join(fixtureRoot, "upstream/pi-live.lock.json"),
    );
  }
  return fixtureRoot;
}

async function isPathMissing(target: string): Promise<boolean> {
  try {
    await lstat(target);
    return false;
  } catch (error) {
    assert.equal((error as NodeJS.ErrnoException).code, "ENOENT");
    return true;
  }
}

async function fingerprint(directory: string): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  async function visit(target: string, relative: string): Promise<void> {
    const info = await lstat(target, { bigint: true });
    if (info.isDirectory()) {
      result.set(
        relative,
        `directory:${info.mode}:${info.mtimeNs}:${info.ctimeNs}`,
      );
      for (const name of (await readdir(target)).sort())
        await visit(path.join(target, name), `${relative}/${name}`);
      return;
    }
    const bytes = info.isFile() ? await readFile(target) : Buffer.alloc(0);
    result.set(
      relative,
      `${info.isFile() ? "file" : info.isSymbolicLink() ? "symlink" : "special"}:${info.mode}:${info.size}:${info.mtimeNs}:${info.ctimeNs}:${createHash("sha256").update(bytes).digest("hex")}`,
    );
  }
  await visit(directory, ".");
  return result;
}

function runGit(source: string, args: string[], input?: string): string {
  const result = spawnSync("git", ["-C", source, ...args], {
    encoding: "utf8",
    input,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

const rootTree = `040000 tree f58ef17016187ba241ec96b246c1a0729e860668\t.github
100644 blob ff3881ab0edf44b538c8f33aa181d94243cf403c\t.gitignore
100644 blob 55c15df37b4500cad5c24ce783922140b1b008fa\t.oxfmtrc.json
100644 blob 31e054fe5d4e783a635c7b7d0e07fbdb1c7a8060\t.oxlintrc.json
100644 blob f88909ebff0dede2b521a3cdf6727a439ca0e5fe\tAGENTS.md
100644 blob 14fac913ccf80234b1848540089a3bbcb6e5283d\tLICENSE
100644 blob 784c2488e41d9699572fde0d7d4076cff3a4dfce\tREADME.md
100644 blob 5fa1cc86c8658d0508ff63ce3b168279d4a173c5\tTHIRD_PARTY_NOTICES.md
100644 blob fc273a19294f401f1bc047f3278c9bc06ad31a56\tbun.lock
100644 blob 338a8929ddc9fc5fa18f8eb4ee5b566a3514b76c\tindex.ts
100644 blob 662723354acf97ac8b51e6c2eb3b91dcd3e5d71b\tpackage.json
040000 tree a3fa98e847c8e5c62ccbb1eaa22cf624d99e59d5\tplans
040000 tree 7d402946a8d1641ca09d4f623a4420837d71111e\tsrc
040000 tree b4ae487d3c1eeeb9f643dcc4675d53d478e79089\ttests
100644 blob c94325d5059337a99b168c65e4df2d9fcae4e1b9\ttsconfig.json
`;
const srcTree = `100644 blob 02427650080434e413ff343bb87ac939d054a80f\tcodex-auth.ts
100644 blob 126724b30c4f3e33842a2a856349124d5dc0b4e3\tcodex-models.ts
100644 blob 934688fec2db70ae52b10e071fe96e06ac70fb68\tconfig.ts
100644 blob 34565c2f588398e07ba4fda9d2d63c6356501ab4\tfast-controller.ts
100644 blob 58f3fcedb5f812a0e684307617b17f8abb5aaf4a\tfooter-layout.ts
100644 blob 9ac077696a50fd003f080e77669e853cce4366e8\tformat.ts
100644 blob 32b8e1a770e13fc5d393f13ba06f95003c81ce4e\tidentity.ts
100644 blob b51a9f32a81e07b9f949462def459db199410779\timage.ts
040000 tree 21b705138231f098cecf2c10837f885e79a6d371\tlive
100644 blob 8581eb6d99bc67142d1cd6074ac0861b674c7cb4\tmultiprovider.ts
100644 blob 26c8b29d375bae1f4bef74c475de5d678870b1fd\tpaths.ts
100644 blob ccd61a2b45025b3e6f0cab38b375c7a2ec363d33\tpet-footer-controller.ts
100644 blob 8dca916f18cd63a2c32817fa34d6ab1ac0dbe9e2\tpets.ts
100644 blob 1c273802b480ca3404de4eca3be3e0f099e4c2db\treset-controller.ts
100644 blob e44b342b2b061f9713ea5e25a5bd7fc6a46fb2e3\treset-guard.ts
100644 blob 208d13ebd376fd562a231bea56308a8fc1b169b4\tresets.ts
100644 blob c4fec721bfd12a0c28fa4badf3169fb17acc2495\tusage-controller.ts
100644 blob 2f6fd741945bf7a633264d4debca3fb5fd47a6d6\tusage.ts
100644 blob e3364c7d4556b6c2e4c63d426e4e4be333b9bb3e\twebsearch.ts
`;
const liveTree = `100644 blob d7d32eca25bade27134cb717ad2eac2ab7029dbd\tattestation.ts
100644 blob 0ef7db4b8fa0dbf22dddd6abf6e48648047c0fca\tcontroller.ts
100644 blob 518d56cf528f2bde0d7dd09667b07f5d18c4fecd\tfocus.ts
100644 blob 50c570eae9dd6c466976456ee4bee99aea2f7d27\tindex.ts
100644 blob 10f38324a72122e3ac8fe2499b0ea9cc933b724b\tnative.ts
100644 blob f0983ee7d2d0ffd4d617fa3769af6c0df3d23b89\tprotocol.ts
100644 blob e349fb02db04283df731140e55bab501ca4a4342\tqueue.ts
100644 blob 81e9d2920b106dfc089b2c42447d66554afe268d\ttransport.ts
100644 blob 072ffddad165b2433d4c6e9753d5d87f41122d2b\tvisualizer.ts
100644 blob 8f827cecd9d3ce05a797f026f1cc1999ea672539\tvoices.ts
`;
const testsTree = `100644 blob 73b2aee9b6f3d9ee19f4d5bae39fba848a66836e\tcodex-models.test.ts
100644 blob 536f5a4170f70fa58f708c0215719983e40bec3a\tconfig.test.ts
100644 blob b4bd270f3c61e3cf69477fd0c4d6ddfcb5993f1e\textension-load.test.ts
100644 blob 1b9d414730806129ebb1dde05507cb99e00a3b42\tfast.test.ts
100644 blob 6d50a1317d4ceaad7e50a6d5db60e7ae41216aa5\tfooter-layout.test.ts
100644 blob d9f82186b4799e2225b609a72ba655b8a52ce49a\tfooter.test.ts
100644 blob e29e27d78f8937e8820d24827ce8024787da357f\tformat.test.ts
100644 blob ba71dca5dd9494a65f918e9b90655ebc8317e016\thelpers.ts
100644 blob 6b4a01da23fb2bd69c958c2fb3c6a6b1756d2f49\timage.test.ts
100644 blob 72d5f686f4ba9219be81231ad4f53c28af2427d8\tlive-controller.test.ts
100644 blob 6f3dbd7788c8d4ac595a3ca2c7974a7e479ed5dd\tlive-focus.test.ts
100644 blob 2010cc3d8f51393bb2e849941b66eb3ba57ae7f7\tlive-native.test.ts
100644 blob dffe836a8daf8cc4dbf22590439045dfa960f65d\tlive-protocol.test.ts
100644 blob 399621a6e8f8fec6e4e744b570b77f24de4c7fd4\tlive-queue.test.ts
100644 blob affec6a96d177a65760c940bee77198d3d7e6b70\tlive-registration.test.ts
100644 blob 33beaffa4ec465ec5ac7839e7e4e2d893a353114\tlive-transport.test.ts
100644 blob 04382b127706ec35f36ac9ace9cf9121507064aa\tlive-visualizer.test.ts
100644 blob 3fc3fcf5c4839de6a593a3497d62fab7d742c194\tmultiprovider.test.ts
100644 blob 4a19a950ab1e1dee76ad52613515bd94297b4ef3\tpets.test.ts
100644 blob 0d756077edd1fa5bad88e3dcd4537a1c5192f80f\treset-controller.test.ts
100644 blob 1826aa6498c623da709c1f8bed6b63604760c75a\treset-guard.test.ts
100644 blob 88e370fa2caa58e6184529df9dbdaaee6c599bdb\tresets.test.ts
100644 blob ae3d7915d90be9f0ee2b960d4f94234b2629661f\tusage.test.ts
100644 blob 7e494e5107f7ae804c0c838333573db580effec6\twebsearch.test.ts
`;
const commitObject = `tree 3aea19fabc79a2ec8f00469edc97b668b246ec94
parent 9fc9364088c133b4d5416c67a2da5f75762e19c1
author Tom X Nguyen <tom81094@gmail.com> 1790028600 +0700
committer Tom X Nguyen <tom81094@gmail.com> 1790028600 +0700

chore(release): 0.2.6
`;

async function exactSourceFixture(t: TestContext): Promise<string> {
  const source = await mkdtemp(path.join(tmpdir(), "pi-live-source-test-"));
  t.after(async () => rm(source, { recursive: true }));
  runGit(source, ["init", "--quiet"]);
  for (const relative of await snapshotFiles(canonicalSnapshot)) {
    const expected = JSON.parse(await readFile(canonicalLock, "utf8")).files[
      relative
    ].gitBlobSha1;
    const actual = runGit(source, [
      "hash-object",
      "-w",
      path.join(canonicalSnapshot, relative),
    ]);
    assert.equal(actual, expected);
  }
  assert.equal(
    runGit(source, ["mktree", "--missing"], liveTree),
    "21b705138231f098cecf2c10837f885e79a6d371",
  );
  assert.equal(
    runGit(source, ["mktree", "--missing"], srcTree),
    "7d402946a8d1641ca09d4f623a4420837d71111e",
  );
  assert.equal(
    runGit(source, ["mktree", "--missing"], testsTree),
    "b4ae487d3c1eeeb9f643dcc4675d53d478e79089",
  );
  assert.equal(
    runGit(source, ["mktree", "--missing"], rootTree),
    "3aea19fabc79a2ec8f00469edc97b668b246ec94",
  );
  assert.equal(
    runGit(
      source,
      ["hash-object", "-t", "commit", "-w", "--stdin"],
      commitObject,
    ),
    commit,
  );

  // Dirty worktree bytes must be irrelevant: imports read the pinned Git objects.
  await mkdir(path.join(source, "src/live"), { recursive: true });
  await writeFile(
    path.join(source, "src/live/controller.ts"),
    "dirty worktree\n",
  );
  await writeFile(path.join(source, "package.json"), "dirty worktree\n");
  return source;
}

async function snapshotFiles(
  directory: string,
  relative = "",
): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(path.join(directory, relative), {
    withFileTypes: true,
  })) {
    const child = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory())
      result.push(...(await snapshotFiles(directory, child)));
    else result.push(child);
  }
  return result.sort();
}

test("offline check accepts the exact snapshot without writing", async (t) => {
  const fixtureRoot = await fixture(t);
  const before = await fingerprint(path.join(fixtureRoot, "upstream"));
  const result = invoke(fixtureRoot, "check");
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Verified pi-live.*24 pinned files/);
  assert.deepEqual(
    await fingerprint(path.join(fixtureRoot, "upstream")),
    before,
  );
});

test("offline check rejects restrictive and broad receipt modes", async (t) => {
  for (const [relativePath, mode] of [
    ["upstream/pi-live/src/live/controller.ts", 0o600],
    ["upstream/pi-live.lock.json", 0o666],
  ] as const) {
    const fixtureRoot = await fixture(t);
    await chmod(path.join(fixtureRoot, relativePath), mode);
    const result = invoke(fixtureRoot, "check");
    assert.notEqual(result.status, 0, `${relativePath} at ${mode.toString(8)}`);
    assert.match(result.stderr, /mode.*0644|0644.*mode/i);
  }
});

test("offline check rejects a one-byte pinned-file hash mutation", async (t) => {
  const fixtureRoot = await fixture(t);
  await writeFile(
    path.join(fixtureRoot, "upstream/pi-live/src/live/controller.ts"),
    Buffer.concat([
      await readFile(path.join(canonicalSnapshot, "src/live/controller.ts")),
      Buffer.from("\n"),
    ]),
  );
  const result = invoke(fixtureRoot, "check");
  assert.notEqual(result.status, 0);
  assert.match(
    result.stderr,
    /Pinned SHA-256 mismatch: src\/live\/controller\.ts/,
  );
});

test("offline check rejects changed lock fields", async (t) => {
  const fixtureRoot = await fixture(t);
  const lockPath = path.join(fixtureRoot, "upstream/pi-live.lock.json");
  const lock = JSON.parse(await readFile(lockPath, "utf8"));
  lock.nativeReceipt.version = "17.2.10";
  await writeFile(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
  const result = invoke(fixtureRoot, "check");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /lock fields differ/);
});

test("offline check rejects extra, missing, symlink, and special snapshot entries", async (t) => {
  await t.test("extra", async (t) => {
    const fixtureRoot = await fixture(t);
    await writeFile(
      path.join(fixtureRoot, "upstream/pi-live/extra.ts"),
      "extra\n",
    );
    const result = invoke(fixtureRoot, "check");
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /extra: extra\.ts/);
  });
  await t.test("missing", async (t) => {
    const fixtureRoot = await fixture(t);
    await unlink(path.join(fixtureRoot, "upstream/pi-live/src/live/voices.ts"));
    const result = invoke(fixtureRoot, "check");
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /missing: src\/live\/voices\.ts/);
  });
  await t.test("symlink", async (t) => {
    const fixtureRoot = await fixture(t);
    const target = path.join(
      fixtureRoot,
      "upstream/pi-live/src/live/voices.ts",
    );
    await unlink(target);
    await symlink("protocol.ts", target);
    const result = invoke(fixtureRoot, "check");
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /symlink is forbidden: src\/live\/voices\.ts/);
  });
  await t.test("special", async (t) => {
    const fixtureRoot = await fixture(t);
    const target = path.join(
      fixtureRoot,
      "upstream/pi-live/src/live/voices.ts",
    );
    await unlink(target);
    const made = spawnSync("mkfifo", [target], { encoding: "utf8" });
    assert.ifError(made.error);
    assert.equal(made.status, 0, made.stderr);
    const result = invoke(fixtureRoot, "check");
    assert.notEqual(result.status, 0);
    assert.match(
      result.stderr,
      /special file is forbidden: src\/live\/voices\.ts/,
    );
  });
});

test("explicit import reads pinned Git objects, is idempotent, and refuses overwrite", async (t) => {
  const fixtureRoot = await fixture(t, false);
  const source = await exactSourceFixture(t);
  const imported = invoke(fixtureRoot, "import", "--source", source);
  assert.equal(imported.status, 0, imported.stderr);
  assert.match(imported.stdout, /Imported pi-live.*24 pinned files/);
  assert.equal(invoke(fixtureRoot, "check", "--source", source).status, 0);

  const before = await fingerprint(path.join(fixtureRoot, "upstream"));
  const repeated = invoke(fixtureRoot, "import", "--source", source);
  assert.equal(repeated.status, 0, repeated.stderr);
  assert.match(repeated.stdout, /Verified existing pi-live/);
  assert.deepEqual(
    await fingerprint(path.join(fixtureRoot, "upstream")),
    before,
  );

  const target = path.join(fixtureRoot, "upstream/pi-live/src/live/voices.ts");
  await writeFile(target, "do not overwrite\n");
  const refused = invoke(fixtureRoot, "import", "--source", source);
  assert.notEqual(refused.status, 0);
  assert.match(
    refused.stderr,
    /Refusing to overwrite existing pi-live snapshot/,
  );
  assert.equal(await readFile(target, "utf8"), "do not overwrite\n");
});

test("an interrupted publication leaves one exact side and the next import completes it", async (t) => {
  const fixtureRoot = await fixture(t, false);
  const source = await exactSourceFixture(t);
  const preload = path.join(fixtureRoot, "publication-fault.mjs");
  await writeFile(
    preload,
    `import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
const linkSync = fs.linkSync;
fs.linkSync = (source, destination) => {
  if (String(destination).endsWith("pi-live.lock.json")) {
    const error = new Error("injected lock publication failure");
    error.code = "EIO";
    throw error;
  }
  return linkSync(source, destination);
};
syncBuiltinESMExports();
`,
  );

  const interrupted = invokeWithPreload(
    fixtureRoot,
    preload,
    "import",
    "--source",
    source,
  );
  assert.notEqual(interrupted.status, 0);
  assert.equal(
    await isPathMissing(path.join(fixtureRoot, "upstream/pi-live")),
    false,
  );
  assert.equal(
    await isPathMissing(path.join(fixtureRoot, "upstream/pi-live.lock.json")),
    true,
  );
  assert.deepEqual(await readdir(path.join(fixtureRoot, "upstream")), [
    "pi-live",
  ]);

  const completed = invoke(fixtureRoot, "import", "--source", source);
  assert.equal(completed.status, 0, completed.stderr);
  assert.match(completed.stdout, /Imported pi-live/);
  assert.equal(invoke(fixtureRoot, "check", "--source", source).status, 0);
});

test("an exact lock-only state is safely completed after source verification", async (t) => {
  const fixtureRoot = await fixture(t, false);
  const source = await exactSourceFixture(t);
  await cp(canonicalLock, path.join(fixtureRoot, "upstream/pi-live.lock.json"));

  const result = invoke(fixtureRoot, "import", "--source", source);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Imported pi-live/);
  assert.equal(invoke(fixtureRoot, "check", "--source", source).status, 0);
  assert.deepEqual((await readdir(path.join(fixtureRoot, "upstream"))).sort(), [
    "pi-live",
    "pi-live.lock.json",
  ]);
});

test("differing one-sided receipt state is refused without overwrite", async (t) => {
  await t.test("snapshot only", async (t) => {
    const fixtureRoot = await fixture(t, false);
    const source = await exactSourceFixture(t);
    await cp(canonicalSnapshot, path.join(fixtureRoot, "upstream/pi-live"), {
      recursive: true,
    });
    const changed = path.join(
      fixtureRoot,
      "upstream/pi-live/src/live/controller.ts",
    );
    await writeFile(changed, "different snapshot bytes\n");

    const result = invoke(fixtureRoot, "import", "--source", source);

    assert.notEqual(result.status, 0);
    assert.match(
      result.stderr,
      /Refusing to overwrite existing pi-live snapshot/,
    );
    assert.equal(await readFile(changed, "utf8"), "different snapshot bytes\n");
  });

  await t.test("lock only", async (t) => {
    const fixtureRoot = await fixture(t, false);
    const source = await exactSourceFixture(t);
    const changedLock = path.join(fixtureRoot, "upstream/pi-live.lock.json");
    await writeFile(changedLock, '{"different":true}\n', { mode: 0o644 });

    const result = invoke(fixtureRoot, "import", "--source", source);

    assert.notEqual(result.status, 0);
    assert.match(
      result.stderr,
      /Refusing to overwrite existing pi-live snapshot/,
    );
    assert.equal(await readFile(changedLock, "utf8"), '{"different":true}\n');
  });
});

test("CLI has no update or force path and import requires an explicit source", async (t) => {
  const fixtureRoot = await fixture(t);
  for (const args of [
    ["update"],
    ["force"],
    ["import"],
    ["import", "--force"],
  ]) {
    const result = invoke(fixtureRoot, ...args);
    assert.notEqual(result.status, 0);
  }
});

test("source check rejects a replacement object with a different upstream tree", async (t) => {
  const fixtureRoot = await fixture(t);
  const source = await exactSourceFixture(t);
  const alternateRootTree = rootTree.replace(
    "784c2488e41d9699572fde0d7d4076cff3a4dfce",
    "ff3881ab0edf44b538c8f33aa181d94243cf403c",
  );
  const alternateTree = runGit(
    source,
    ["mktree", "--missing"],
    alternateRootTree,
  );
  assert.notEqual(alternateTree, tree);
  const replacementCommit = runGit(
    source,
    ["hash-object", "-t", "commit", "-w", "--stdin"],
    commitObject.replace(`tree ${tree}`, `tree ${alternateTree}`),
  );
  runGit(source, ["replace", commit, replacementCommit]);

  const result = invoke(fixtureRoot, "check", "--source", source);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Pinned source tree mismatch/);
});

test("every pinned Git object read disables lazy fetch and terminal prompts", async (t) => {
  const fixtureRoot = await fixture(t);
  const source = await exactSourceFixture(t);
  const shimDirectory = path.join(fixtureRoot, "git-shim");
  const logPath = path.join(fixtureRoot, "git-environment.log");
  await mkdir(shimDirectory);
  await writeFile(
    path.join(shimDirectory, "git"),
    `#!/bin/sh\nprintf '%s,%s\\n' "$GIT_NO_LAZY_FETCH" "$GIT_TERMINAL_PROMPT" >> "$PI_LIVE_GIT_ENV_LOG"\nexec "$PI_LIVE_REAL_GIT" "$@"\n`,
    { mode: 0o755 },
  );
  const resolvedGit = spawnSync("sh", ["-c", "command -v git"], {
    encoding: "utf8",
  });
  assert.ifError(resolvedGit.error);
  assert.equal(resolvedGit.status, 0, resolvedGit.stderr);

  const result = invokeWithEnvironment(
    fixtureRoot,
    {
      ...process.env,
      PATH: `${shimDirectory}${path.delimiter}${process.env.PATH ?? ""}`,
      PI_LIVE_GIT_ENV_LOG: logPath,
      PI_LIVE_REAL_GIT: resolvedGit.stdout.trim(),
    },
    "check",
    "--source",
    source,
  );

  assert.equal(result.status, 0, result.stderr);
  const reads = (await readFile(logPath, "utf8")).trim().split("\n");
  assert.ok(reads.length >= 29);
  assert.equal(
    reads.every((entry) => entry === "1,0"),
    true,
  );
});

test("lock records exact modes and tree and limits ideas-only and provenance-only sources", async () => {
  const lock = JSON.parse(await readFile(canonicalLock, "utf8"));
  assert.equal(lock.snapshot.runtimeLoaded, false);
  for (const record of Object.values(lock.files) as Array<{
    mode?: string;
  }>)
    assert.equal(record.mode, "100644");
  assert.equal(lock.source.commit, commit);
  assert.equal(lock.source.tree, tree);
  for (const selected of ["src/codex-auth.ts", "src/format.ts", "src/paths.ts"])
    assert.equal(lock.files[selected].role, "ideas-only");
  for (const selected of [
    "src/live/focus.ts",
    "src/live/queue.ts",
    "tests/live-focus.test.ts",
    "tests/live-queue.test.ts",
  ])
    assert.equal(lock.files[selected].role, "provenance-only");
  assert.deepEqual(lock.nativeReceipt.disposition.distribution, {
    provisionFromPinnedNpmTarball: true,
    commitBinary: false,
    commitTarball: false,
    mirrorOrRepublish: false,
  });
});
